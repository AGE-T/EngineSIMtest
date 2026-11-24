import { synthConfig } from "../data/synthConfig";

export const phase8WorkletCode = `
${synthConfig}

class DelayLine {
  constructor(length) {
    this.buffer = new Float32Array(length);
    this.ptr = 0;
    this.lastVal = 0;
  }
  read(offset) {
    let p = this.ptr - offset;
    while (p < 0) p += this.buffer.length;
    let index1 = Math.floor(p) % this.buffer.length;
    let index2 = (index1 + 1) % this.buffer.length;
    let frac = p - Math.floor(p);
    return this.buffer[index1] * (1.0 - frac) + this.buffer[index2] * frac;
  }
  write(val) {
    // Light low-pass filter to dampen high frequencies (simulates pipe wall friction)
    let filtered = val * 0.8 + this.lastVal * 0.2;
    this.lastVal = filtered;
    this.buffer[this.ptr] = filtered;
    this.ptr = (this.ptr + 1) % this.buffer.length;
  }
}

class Segment {
  constructor() {
    this.p_plus_L = 0;
    this.p_minus_0 = 0;
    this.delaySamples = 10;
  }
}

function scatterInto(pressures, areas, len, out) {
  let sumPA = 0;
  let sumA = 0;
  for (let i = 0; i < len; i++) {
    sumPA += pressures[i] * areas[i];
    sumA += areas[i];
  }
  const p_junc = sumA > 0 ? (2.0 * sumPA) / sumA : 0;
  for (let i = 0; i < len; i++) {
    out[i] = p_junc - pressures[i];
  }
}

class Phase8EngineWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sr = sampleRate;
    
    this.crankAngle = 0;
    this.currentOutputRpm = 1000;
    this.speed = 343.0;

    this.unburntFuel = 0;
    this.popEnergy = [0, 0];
    this.noiseSmoothed = [0, 0];

    // Turbo state
    this.turboRpm = 0;
    this.boostPressure = 0;
    this.surgeEnergy = 0;
    this.whinePhase = 0;

    this.resonatorsY = new Float32Array(5);
    this.intakeSmoothed = 0;
    this.popTotalSamples = [1, 1];
    this.popsBuf = new Float32Array(2);

    // Clean damped modal resonator for valve-train tap (replaces harsh fixed-sine oscillators)
    const fc = 1550.0;
    const Q = 4.0;
    const w0 = (2.0 * Math.PI * fc) / this.sr;
    const alpha = Math.sin(w0) / (2.0 * Q);
    const a0 = 1.0 + alpha;
    this.valveB0 = alpha / a0;
    this.valveB2 = -alpha / a0;
    this.valveA1 = (-2.0 * Math.cos(w0)) / a0;
    this.valveA2 = (1.0 - alpha) / a0;
    this.valveX1 = 0; this.valveX2 = 0;
    this.valveY1 = 0; this.valveY2 = 0;

    this.port.onmessage = (e) => {
      if (e.data.type === "config") {
        this.applyConfig(e.data.config);
      } else if (e.data.type === "updatePipes") {
        if (this.config && this.downpipes.length >= 2 && this.tailpipes.length >= 2) {
           this.downpipes[0].delaySamples = (e.data.downpipeLength / this.speed) * this.sr;
           this.downpipes[1].delaySamples = (e.data.downpipeLength / this.speed) * this.sr;
           this.tailpipes[0].delaySamples = (e.data.tailpipeLength / this.speed) * this.sr;
           this.tailpipes[1].delaySamples = (e.data.tailpipeLength / this.speed) * this.sr;
           this.config.downpipeLength = e.data.downpipeLength;
           this.config.tailpipeLength = e.data.tailpipeLength;
           this.config.downpipeDiameter = e.data.downpipeDiameter || 0.08;
           this.config.tailpipeDiameter = e.data.tailpipeDiameter || 0.1;
        }
      }
    };
  }

  static get parameterDescriptors() {
    return [
      { name: "rpm", defaultValue: 1000, minValue: 0, maxValue: 50000, automationRate: "a-rate" },
      { name: "throttle", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "a-rate" },
      { name: "load", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "a-rate" },
      { name: "ignition", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "a-rate" },
      { name: "turboType", defaultValue: 0, minValue: 0, maxValue: 3, automationRate: "k-rate" }, // 0: NA, 1: Small, 2: Big, 3: Twin
      { name: "volExhaust", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "panExhaust", defaultValue: 0, minValue: -1, maxValue: 1, automationRate: "k-rate" },
      { name: "volIntake", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "panIntake", defaultValue: 0, minValue: -1, maxValue: 1, automationRate: "k-rate" },
      { name: "volEngine", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "panEngine", defaultValue: 0, minValue: -1, maxValue: 1, automationRate: "k-rate" },
      { name: "volWhine", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "volFlutter", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "panTurbo", defaultValue: 0, minValue: -1, maxValue: 1, automationRate: "k-rate" },
      { name: "enablePops", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "volPops", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "panPops", defaultValue: 0, minValue: -1, maxValue: 1, automationRate: "k-rate" }
    ];
  }

  applyConfig(config) {
    let delayLines = [];
    let runners = [];
    let downpipes = [];
    let tailpipes = [];
    
    for (let c of config.cylinders) {
       runners.push(new Segment());
    }
    downpipes.push(new Segment(), new Segment());
    tailpipes.push(new Segment(), new Segment());
    for(let i = 0; i < runners.length * 2 + 8; i++) {
        delayLines.push(new DelayLine(4000));
    }

    for (let i = 0; i < runners.length; i++) {
       let cyl = config.cylinders.find(c => c.index === i);
       if (cyl) {
          runners[i].delaySamples = (cyl.length / this.speed) * this.sr;
       }
    }
    downpipes[0].delaySamples = (config.downpipeLength / this.speed) * this.sr;
    downpipes[1].delaySamples = (config.downpipeLength / this.speed) * this.sr;
    tailpipes[0].delaySamples = (config.tailpipeLength / this.speed) * this.sr;
    tailpipes[1].delaySamples = (config.tailpipeLength / this.speed) * this.sr;

    this.isWankel = config.layout === "Rotary";
    this.isTurbine = config.layout === "Turbine" || config.layout === "Turbofan";
    this.delayLines = delayLines;
    this.runners = runners;
    this.downpipes = downpipes;
    this.tailpipes = tailpipes;
    this.config = config;

    // Pre-allocate scratch buffers for zero per-sample GC allocations in process()
    this.runnerFwdIn = new Float32Array(config.cylinders.length);
    const lenL = config.cylsL.length + 1;
    this.colLIn = new Float32Array(lenL);
    this.colLAreas = new Float32Array(lenL);
    this.scatterLOut = new Float32Array(lenL);
    const lenR = Math.max(1, config.cylsR.length + 1);
    this.colRIn = new Float32Array(lenR);
    this.colRAreas = new Float32Array(lenR);
    this.scatterROut = new Float32Array(lenR);
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0]; 
    if (!output || !this.config) return true;
    
    const isStereo = output.length > 1;
    const outL = output[0];
    const outR = isStereo ? output[1] : output[0];

    // Params map array indexing
    const getP = (p, i, def = 0) => (p && p.length > 0 ? (p.length > 1 ? p[i] : p[0]) : def);

    for (let i = 0; i < outL.length; i++) {
      const targetRpm = getP(parameters.rpm, i, 1000);
      const throttle = getP(parameters.throttle, i, 0);
      const load = parameters.load ? getP(parameters.load, i, 0) : throttle;
      const ignitionParam = parameters.ignition ? getP(parameters.ignition, i, 1.0) : 1.0;
      
      const panExhaust = getP(parameters.panExhaust, i, 0);
      const panIntake = getP(parameters.panIntake, i, 0);
      const panEngine = getP(parameters.panEngine, i, 0);
      const panTurbo = getP(parameters.panTurbo, i, 0);

      const enablePops = getP(parameters.enablePops, i, 1) > 0.5;
      const vPops = getP(parameters.volPops, i, 1);
      const panPopsParam = getP(parameters.panPops, i, 0);
      
      const vExh = getP(parameters.volExhaust, i, 1);
      const vInt = getP(parameters.volIntake, i, 1) * 0.5;
      const vEng = getP(parameters.volEngine, i, 1) * 0.5;
      const vWhine = getP(parameters.volWhine, i, 1);
      const vFlutter = getP(parameters.volFlutter, i, 1);
      const turboType = Math.round(getP(parameters.turboType, i, 0));

      const turboEnabled = turboType > 0;
      const maxRpm = this.config.metadata?.max_rpm || 7000;

      this.currentOutputRpm += (targetRpm - this.currentOutputRpm) * 0.001; 
      const rpm = this.currentOutputRpm;

      if (this.prevThrottle === undefined) this.prevThrottle = throttle;
      let throttleDrop = this.prevThrottle - throttle;
      
      if (ignitionParam < 0.5) {
          if (enablePops && throttle > 0) this.unburntFuel += 0.01 * throttle;
      } else if (throttleDrop > 0.05 && rpm > 3000) {
          // Add unburnt fuel when the user drops the throttle
          if (enablePops) this.unburntFuel += throttleDrop * 1.5; 
      }
      
      this.ignitionAmp = (this.ignitionAmp ?? 1.0);
      // Smooth out the rev limiter cut to avoid harsh clipping clicks
      this.ignitionAmp += (ignitionParam - this.ignitionAmp) * 0.1;
      
      this.prevThrottle = throttle;

      this.unburntFuel -= 0.00002; // Very slow decay (lasts ~1s) so it has time to trigger random pops
      this.unburntFuel = Math.max(0, Math.min(1.0, this.unburntFuel));

      const degPerSec = rpm * 6.0;
      this.crankAngle += degPerSec / this.sr;
      // Wankel 720 cycle mapped 1-to-1 here but it acts differently via config phase offsets
      if (this.crankAngle >= 720.0) this.crankAngle -= 720.0;

      // ---- TURBO DYNAMICS ----
      let exhaustFlow = (rpm / maxRpm) * (0.05 + 0.95 * load);
      if (turboEnabled) {
          let spoolRate = 0.0001;
          let blowOffTriggerPressure = 0.1;
          let surgeDecay = 0.993; // standard decay
          let targetBoostMult = 0.5 + 0.5 * load;

          if (turboType === 1) { // Small Turbo
              spoolRate = 0.0003; 
              blowOffTriggerPressure = 0.05;
              surgeDecay = 0.95; // fast pssht
              targetBoostMult *= 2.5; // Make small turbo louder
          } else if (turboType === 2) { // Big Turbo
              spoolRate = 0.00005; // huge lag
              blowOffTriggerPressure = 0.15;
              surgeDecay = 0.998; // long stututu
          } else if (turboType === 3) { // Twin Turbo
              spoolRate = 0.0002;
              blowOffTriggerPressure = 0.08;
              surgeDecay = 0.98;
              targetBoostMult *= 1.2;
          }

          let targetTurboRpm = exhaustFlow * 150000;
          this.turboRpm += (targetTurboRpm - this.turboRpm) * spoolRate;
          
          let targetBoost = (this.turboRpm / 150000) * targetBoostMult;
          
          if (throttle < 0.1 && this.boostPressure > blowOffTriggerPressure) {
              if (!this.isTurbine) this.surgeEnergy += this.boostPressure * 0.8;
              this.boostPressure = 0;
          } else {
              this.boostPressure += (targetBoost - this.boostPressure) * 0.02;
          }

          this.surgeEnergy *= surgeDecay;
      } else {
          this.turboRpm = 0;
          this.boostPressure = 0;
          this.surgeEnergy *= 0.9;
      }

      const runner_fwd_in = this.runnerFwdIn;
      let blockExcitation = 0;

      for(let cyl of this.config.cylinders) {
         let phase = this.crankAngle - cyl.phaseOffset;
         if (phase < 0) phase += 720.0;
         
         let r_engine = 0.95;
         let p_source = 0;
         
         // 260 degrees of exhaust valve lift, but rotary has massive sudden exhaust blowdown.
         // Smooth Valve Opening
         let exhaustStart = 130;
         let exhaustDur = 260;

         if (this.isWankel) {
             exhaustStart = 60; // earlier peripheral exhaust opening
             exhaustDur = 300; // huge overlap
         }

         if (this.isTurbine) {
             let amp = 0.5 + throttle * 1.5;
             let roar = (Math.random() - 0.5) * 0.4;
             let bpfPhase = (this.crankAngle * 30.0 + phase) * Math.PI / 180.0;
             let bladePassing = Math.sin(bpfPhase) * 0.15;
             p_source = (roar + bladePassing) * amp;
             r_engine = 0.0; // fully open passage
             blockExcitation += p_source * 0.1;
         } else if (phase >= exhaustStart && phase <= (exhaustStart + exhaustDur)) { 
             let valvePhase = (phase - exhaustStart) / exhaustDur; // 0 to 1
             
             let valveLift = Math.sin(valvePhase * Math.PI); 
             if (this.isWankel) {
                 // sharp sudden port opening!
                 valveLift = Math.pow(Math.sin(valvePhase * Math.PI), 0.3);
             }

             r_engine = 0.95 - (valveLift * 1.45); 
             
             let bdDuration = this.isWankel ? 30.0 : 60.0; // steeper blowdown for rotary
             let bd = (phase - exhaustStart) / bdDuration; 

             if (bd >= 0 && bd < 1.0) {
                let baseAmp = 0.35 + (rpm / maxRpm) * 0.45; // much louder during engine braking
                let fullAmp = baseAmp + throttle * (1.2 - baseAmp + this.boostPressure * 0.5);
                let cutAmp = baseAmp * 0.4;
                let amp = cutAmp + (fullAmp - cutAmp) * this.ignitionAmp; 
                
                // Phase 6 style smooth, resonant exhaust pulse:
                // Half-sine pressure wave upon valve opening, followed by decay
                let pulse = Math.sin(Math.pow(bd, 0.8) * Math.PI); 
                p_source = pulse * Math.exp(-bd * 4.5) * 2.5 * amp;
                
                // Add a tiny bit of hiss at high RPM for realism, but keep it mostly pure tone
                let raspyNoise = (Math.random() - 0.5) * 0.05 * Math.exp(-bd * 10.0) * (rpm/maxRpm);
                p_source += raspyNoise * amp;
                
                if (this.isWankel) p_source *= 1.5; // Louder rotary brap
                blockExcitation += p_source * 0.35; 
             }
         }
         runner_fwd_in[cyl.index] = p_source + this.runners[cyl.index].p_minus_0 * r_engine;
      }

      // Gunshot-like unburnt fuel pops
      const pops = this.popsBuf;
      pops[0] = 0;
      pops[1] = 0;
      
      this.popSamplesRemaining = this.popSamplesRemaining || [0, 0];
      this.popAmpState = this.popAmpState || [0.0, 0.0];
      this.prevPopInput = this.prevPopInput || [0.0, 0.0];
      this.prevPopOutput = this.prevPopOutput || [0.0, 0.0];
      this.popFreqState = this.popFreqState || [52.0, 52.0];
      
      if (this.unburntFuel > 0.01) {
          // Probability scales with unburnt fuel but also higher chance to create bursts
          let popChance = 0.0003 + (this.unburntFuel * 0.003);
          if (Math.random() < popChance) {
              // Dynamic scaling based on RPM and throttle
              let rpmFactor = Math.min(1.0, rpm / maxRpm);
              // Non-linear scaling: subtle at low RPM, aggressive backfires at high RPM
              let popMultiplier = 0.2 + Math.pow(rpmFactor, 3.0) * 4.5; 
              
              if (throttle > 0.8) popMultiplier *= 1.5; // Throttle open -> louder
              else if (throttle < 0.1) popMultiplier *= 0.3; // Throttle closed -> quieter

              // Randomize pop length
              let popLengthMs = 0.015 + Math.random() * 0.06; // 15ms to 75ms
              let fuelConsumed = popLengthMs * 1.5; // Consume proportional fuel
              
              if (this.unburntFuel > fuelConsumed) {
                 this.unburntFuel -= fuelConsumed;
              } else {
                 this.unburntFuel *= 0.1;
                 popMultiplier *= 0.5; // Weaker pop
              }

              // Trigger pop identically on both banks to prevent extreme stereo separation
              let samples = Math.max(1, Math.floor(popLengthMs * this.sr));
              let amp = popMultiplier * (0.6 + Math.random() * 0.6);
              let freq = 45.0 + Math.random() * 20.0;
              
              this.popTotalSamples[0] = samples;
              this.popSamplesRemaining[0] = samples;
              this.popAmpState[0] = amp; 
              this.popFreqState[0] = freq;
              
              if (this.config.cylsR.length > 0) {
                  let delaySamps = Math.floor(Math.random() * 0.005 * this.sr); // up to 5ms delay
                  this.popTotalSamples[1] = samples + delaySamps;
                  this.popSamplesRemaining[1] = samples + delaySamps;
                  this.popAmpState[1] = amp * (0.8 + Math.random() * 0.4);
                  this.popFreqState[1] = freq;
              }
          }
      }
      
      let sharedNoise = Math.random() * 2.0 - 1.0;
      let sharedSpikeFreqOffset = Math.random() * 200.0;
      
      for (let b = 0; b < 2; b++) {
          if (this.popSamplesRemaining[b] > 0) {
              // Exact elapsed time from actual pop length (fixes silent short pops!)
              let t_elapsed = (this.popTotalSamples[b] - this.popSamplesRemaining[b]) / this.sr;
              if (t_elapsed < 0) t_elapsed = 0;
              
              let freqHz = this.popFreqState[b]; 
              
              // Decay envelope: very fast and punchy
              let env = Math.exp(-60.0 * t_elapsed); 
              
              // 1. Decaying low-frequency pressure bounce
              let body = Math.sin(2.0 * Math.PI * freqHz * t_elapsed) * env;
              
              // 2. Extremely sharp, highly distorted initial shockwave transient
              let transient = 0.0;
              if (t_elapsed < 0.004) {
                  let tEnv = Math.exp(-900.0 * t_elapsed);
                  let spike = Math.sin(2.0 * Math.PI * (350.0 + sharedSpikeFreqOffset) * t_elapsed) * 1.8 + sharedNoise * 1.2;
                  transient = spike * tEnv;
              }
              
              // Combined raw wave
              let rawPop = (transient * 1.8 + body * 1.2) * this.popAmpState[b];
              
              // 1-pole high-pass filter to prevent DC drift and eliminate mud
              let hpOutput = rawPop - this.prevPopInput[b] + 0.985 * this.prevPopOutput[b];
              this.prevPopInput[b] = rawPop;
              this.prevPopOutput[b] = hpOutput;
              
              let distorted = hpOutput;
              if (distorted > 0) {
                  distorted = Math.min(1.5, distorted / (1.0 + distorted * 0.2));
              } else {
                  distorted = Math.max(-1.5, distorted / (1.0 - distorted * 0.35));
              }
              
              pops[b] = distorted * 0.65; // Well-bounded amplitude
              this.popSamplesRemaining[b]--;
          } else {
              pops[b] = 0.0;
              this.prevPopInput[b] *= 0.995;
              this.prevPopOutput[b] *= 0.995;
          }
      }

      let areaRunner = Math.PI * Math.pow(0.05 / 2, 2);
      let areaDownpipe = Math.PI * Math.pow((this.config.downpipeDiameter || 0.08) / 2, 2);

      const cylsL = this.config.cylsL;
      const lenL = cylsL.length + 1;
      for (let k = 0; k < cylsL.length; k++) {
          this.colLIn[k] = this.runners[cylsL[k]].p_plus_L;
          this.colLAreas[k] = areaRunner;
      }
      this.colLIn[cylsL.length] = this.downpipes[0].p_minus_0;
      this.colLAreas[cylsL.length] = areaDownpipe;
      scatterInto(this.colLIn, this.colLAreas, lenL, this.scatterLOut);
      
      for (let k = 0; k < cylsL.length; k++) {
          this.runners[cylsL[k]].p_minus_L = this.scatterLOut[k];
      }
      this.downpipes[0].p_plus_0 = this.scatterLOut[cylsL.length] + pops[0] * 2.5 * vPops;

      const cylsR = this.config.cylsR;
      if (cylsR.length > 0) {
         const lenR = cylsR.length + 1;
         for (let k = 0; k < cylsR.length; k++) {
             this.colRIn[k] = this.runners[cylsR[k]].p_plus_L;
             this.colRAreas[k] = areaRunner;
         }
         this.colRIn[cylsR.length] = this.downpipes[1].p_minus_0;
         this.colRAreas[cylsR.length] = areaDownpipe;
         scatterInto(this.colRIn, this.colRAreas, lenR, this.scatterROut);
         
         for (let k = 0; k < cylsR.length; k++) {
             this.runners[cylsR[k]].p_minus_L = this.scatterROut[k];
         }
         this.downpipes[1].p_plus_0 = this.scatterROut[cylsR.length] + (pops[1] || pops[0]) * 2.5 * vPops;
      }

      for (let j = 0; j < this.runners.length; j++) {
         let idx = j;
         this.runners[j].p_minus_0 = this.delayLines[idx].read(this.runners[j].delaySamples);
         this.delayLines[idx].write(this.runners[j].p_minus_L);
         
         let idxPlus = j + this.runners.length;
         this.runners[j].p_plus_L = this.delayLines[idxPlus].read(this.runners[j].delaySamples);
         this.delayLines[idxPlus].write(runner_fwd_in[j]);
      }

      let dpL_idx = this.runners.length * 2;
      this.downpipes[0].p_minus_0 = this.delayLines[dpL_idx].read(this.downpipes[0].delaySamples);
      this.delayLines[dpL_idx].write(this.downpipes[0].p_minus_L || 0);
      
      let dpL_plus_idx = dpL_idx + 1;
      this.downpipes[0].p_plus_L = this.delayLines[dpL_plus_idx].read(this.downpipes[0].delaySamples);
      this.delayLines[dpL_plus_idx].write(this.downpipes[0].p_plus_0);

      if (this.config.cylsR.length > 0) {
         let dpR_idx = dpL_plus_idx + 1;
         this.downpipes[1].p_minus_0 = this.delayLines[dpR_idx].read(this.downpipes[1].delaySamples);
         this.delayLines[dpR_idx].write(this.downpipes[1].p_minus_L || 0);

         let dpR_plus_idx = dpR_idx + 1;
         this.downpipes[1].p_plus_L = this.delayLines[dpR_plus_idx].read(this.downpipes[1].delaySamples);
         this.delayLines[dpR_plus_idx].write(this.downpipes[1].p_plus_0);
      }

      let outPL = this.downpipes[0].p_plus_L;
      let outPR = this.config.cylsR.length > 0 ? this.downpipes[1].p_plus_L : 0;

      let areaTailpipe = Math.PI * Math.pow((this.config.tailpipeDiameter || 0.1) / 2, 2);
      let r_junction = (areaTailpipe - areaDownpipe) / (areaTailpipe + areaDownpipe);
      
      // X-pipe / H-pipe cross section
      if (this.config.crossPipe === "collector" && this.config.cylsR.length > 0) {
          // Collector blends the two banks 100% into a single mono-like output
          let mix = (outPL + outPR) * 0.5;
          outPL = mix;
          outPR = mix;
          
          this.downpipes[0].p_minus_L = mix * r_junction;
          this.downpipes[1].p_minus_L = mix * r_junction;
      } else if (this.config.crossPipe === "x-pipe" && this.config.cylsR.length > 0) {
          // X-pipe blends exhaust pulses intensely to create the high-pitched harmonic wail
          let origL = outPL;
          let origR = outPR;
          outPL = origL * 0.55 + origR * 0.45;
          outPR = origR * 0.55 + origL * 0.45;
          
          this.downpipes[0].p_minus_L = outPL * r_junction;
          this.downpipes[1].p_minus_L = outPR * r_junction;
      } else {
          this.downpipes[0].p_minus_L = outPL * r_junction; 
          if (this.config.cylsR.length > 0) this.downpipes[1].p_minus_L = outPR * r_junction;
      }
      
      let p_plus_tail_L = outPL * 1.5;
      let p_plus_tail_R = outPR * 1.5;
      
      // Turbo physical restrictor dampening
      if (turboEnabled) {
          p_plus_tail_L *= 0.85; 
          p_plus_tail_R *= 0.85;
      }
      
      // Symmetric lowpass pre-conditioning on BOTH left and right tailpipes
      this.resonatorsY[0] = 0.5 * this.resonatorsY[0] + 0.5 * p_plus_tail_L;
      p_plus_tail_L = this.resonatorsY[0];
      this.resonatorsY[4] = 0.5 * this.resonatorsY[4] + 0.5 * p_plus_tail_R;
      p_plus_tail_R = this.resonatorsY[4];

      // Tailpipe Resonance (feedback delay)
      let dlT_idx = this.delayLines.length - 4;
      
      let tailOutL = this.delayLines[dlT_idx+1].read(this.tailpipes[0].delaySamples);
      this.tailpipes[0].p_plus_L = tailOutL;
      // Strong negative reflection open to atmosphere
      let tailReflectionL = -tailOutL * 0.65;
      this.delayLines[dlT_idx+1].write(p_plus_tail_L + tailReflectionL);
      
      // Mix the output of the pipe
      let finalLeft = tailOutL + p_plus_tail_L * 0.5;

      let finalRight = 0;
      if (this.config.cylsR.length > 0) {
          let tailOutR = this.delayLines[dlT_idx+3].read(this.tailpipes[1].delaySamples);
          this.tailpipes[1].p_plus_L = tailOutR;
          let tailReflectionR = -tailOutR * 0.65;
          this.delayLines[dlT_idx+3].write(p_plus_tail_R + tailReflectionR);
          finalRight = tailOutR + p_plus_tail_R * 0.5;
      } else {
          finalRight = finalLeft; // Single bank engine emits to both pseudo channels
      }

       // Add Engine Block Mechanical Noise & Intake
       let rpmNorm = rpm / 8000.0;
       
       // Timing-chain mechanical rustle (differentiated white noise modulated by crank rotation)
       this.chainNoiseState = (this.chainNoiseState || 0) * 0.6 + (Math.random() * 2.0 - 1.0) * 0.4;
       let chainMod = 0.35 + 0.65 * Math.pow(Math.abs(Math.sin(this.crankAngle * Math.PI / 180.0 * 0.5)), 3.0);
       let chainRustle = (this.chainNoiseState - (this.prevChainNoise || 0)) * chainMod * CONFIG.VOL_MULTIPLIERS.CHAIN;
       this.prevChainNoise = this.chainNoiseState;

       // Clean damped modal valvetrain tap (replaces harsh fixed-frequency metallic sine oscillators)
       let valveExc = 0.0;
       for (let cyl of this.config.cylinders) {
           let phase = this.crankAngle - cyl.phaseOffset;
           if (phase < 0) phase += 720.0;
           
           // Subtle impulse on exhaust/intake valve seating events
           if ((phase >= 129 && phase <= 131) || (phase >= 349 && phase <= 351) || (phase >= 499 && phase <= 501) || (phase >= 549 && phase <= 551)) {
               valveExc += 0.35;
           }
       }
       let valveClack = this.valveB0 * valveExc + this.valveB2 * this.valveX2 - this.valveA1 * this.valveY1 - this.valveA2 * this.valveY2;
       this.valveX2 = this.valveX1;
       this.valveX1 = valveExc;
       this.valveY2 = this.valveY1;
       this.valveY1 = valveClack;
       
       // Subtle mechanical block rumble tied to actual firing excitation (no raw white-noise buzz)
       let grittyVibe = blockExcitation * 0.25 * CONFIG.VOL_MULTIPLIERS.GRITTY_VIBE;
       let mechNoise = (chainRustle + valveClack * CONFIG.VOL_MULTIPLIERS.VALVE_TICK + grittyVibe) * (0.2 + 0.8 * rpmNorm) * CONFIG.VOL_MULTIPLIERS.MECH;
       
       let intakeBaseRate = (rpm / 60.0) * (this.config.cylinders.length / 2.0) * Math.PI * 2.0 / this.sr;
       // Drastically pitch up the resonance by up to 13 semitones (2.15x frequency ratio) under load
       let intakePhaseRate = intakeBaseRate * (1.0 + load * 1.15); 
       
       this.intakePhase = ((this.intakePhase || 0) + intakePhaseRate) % (2.0 * Math.PI);
       let intakePulsation = this.isTurbine ? 1.0 : (Math.sin(this.intakePhase) * 0.8 + 0.2); // Modulate air pulses
       
       // Completely silent under low load (throttle < 0.05), squaring load creates exponential transition
       let intakeLoad = Math.max(0, (load - 0.05) / 0.95);
       let intakeLoadFactor = Math.pow(intakeLoad, 2.0); 
       let intakeRoar = (Math.random() - 0.5) * intakeLoadFactor * rpmNorm * 2.5 * intakePulsation * CONFIG.VOL_MULTIPLIERS.INTAKE;
       
       // Much stronger 4-pole cascaded low-pass resonant filtering to eliminate high-frequency white-noise hiss
       // Cutoff frequency dynamically yawns open as load and RPM increase (more air, more treble)
       let cutoff = CONFIG.FILTERS.INTAKE_BASE_CUTOFF + (rpmNorm * 0.22) * intakeLoadFactor + (intakeLoadFactor * 0.38);
       cutoff = Math.max(0.012, Math.min(0.92, cutoff));
       let res = CONFIG.FILTERS.INTAKE_RESONANCE + (intakeLoadFactor * 0.45); // highly resonant hollow pipe
       
       this.intakeA = (this.intakeA || 0);
       this.intakeB = (this.intakeB || 0);
       this.intakeC = (this.intakeC || 0);
       this.intakeD = (this.intakeD || 0);
       
       // Cascade 1 (Standard 2-pole)
       this.intakeA += cutoff * (intakeRoar - this.intakeA + res * (this.intakeA - this.intakeB));
       this.intakeB += cutoff * (this.intakeA - this.intakeB);
       
       // Cascade 2 (Damps and rounds remaining harsh white hiss, creating a heavy hollow resonance)
       this.intakeC += cutoff * (this.intakeB - this.intakeC + res * (this.intakeC - this.intakeD));
       this.intakeD += cutoff * (this.intakeC - this.intakeD);
       
       // Anti-explosion bounds
       this.intakeA = Math.max(-10.0, Math.min(10.0, this.intakeA));
       this.intakeB = Math.max(-10.0, Math.min(10.0, this.intakeB));
       this.intakeC = Math.max(-10.0, Math.min(10.0, this.intakeC));
       this.intakeD = Math.max(-10.0, Math.min(10.0, this.intakeD));
       
       this.intakeSmoothed = this.intakeD * 1.9; // Scale up to compensate for double-stage loss (Halved from 3.8)
      
      let valveTick = blockExcitation * 0.15; 

      // Sub-bass boost for engine rumbling
      this.engineBass = (this.engineBass || 0) * 0.98 + blockExcitation * 0.02;

      // Helper for panning formulas (Constant Power)
      const applyPan = (pan, signalL, signalR, vol) => {
         let pL = Math.cos((pan + 1) * Math.PI / 4) * Math.SQRT2;
         let pR = Math.sin((pan + 1) * Math.PI / 4) * Math.SQRT2;
         return { l: signalL * pL * vol, r: signalR * pR * vol };
      };
      
      // SPATIAL MIXING STAGE 
      let ex = applyPan(panExhaust, finalLeft * 2.5, finalRight * 2.5, vExh);
      let mixedEngine = (mechNoise + valveTick + this.engineBass * 2.5) * 0.8;
      let en = applyPan(panEngine, mixedEngine, mixedEngine, vEng);
      let mixedIntake = this.intakeSmoothed * 1.5;
      let intk = applyPan(panIntake, mixedIntake * 0.5, mixedIntake, vInt); 

      let exhL = ex.l;
      let exhR = ex.r; 
      let engL = en.l;
      let engR = en.r;
      let intL = intk.l;
      let intR = intk.r;

      // Lowpass exhaust for natural sound
      this.resonatorsY[1] = 0.8 * this.resonatorsY[1] + 0.2 * exhL;
      let filteredExhL = this.resonatorsY[1];
      
      this.resonatorsY[2] = 0.8 * this.resonatorsY[2] + 0.2 * exhR;
      let filteredExhR = this.resonatorsY[2];

      let turboSoundL = 0;
      let turboSoundR = 0;

      if (this.isTurbine) {
          let isTurbofan = this.config.layout === "Turbofan";
          
          let spoolHz = rpm / (isTurbofan ? 30.0 : 20.0); 
          this.turbineWhinePhase = ((this.turbineWhinePhase || 0) + (spoolHz * 2.0 * Math.PI) / this.sr) % (2.0 * Math.PI);
          
          let bladeCount = isTurbofan ? 24.0 : 18.0;
          let bladeHz = spoolHz * bladeCount; 
          this.turbineBladePhase = ((this.turbineBladePhase || 0) + (bladeHz * 2.0 * Math.PI) / this.sr) % (2.0 * Math.PI);
          
          let rpmRatio = rpm / maxRpm;
          let spoolWhine = Math.sin(this.turbineWhinePhase) * rpmRatio * 0.4;
          let bladeWhine = Math.sin(this.turbineBladePhase) * Math.pow(rpmRatio, 2.0) * (isTurbofan ? 0.1 : 0.2);
          
          // Turbofans have a massive low-end rumble from the bypass fan
          let fanRumble = 0;
          if (isTurbofan) {
              let fanHz = rpm / 40.0;
              this.fanPhase = ((this.fanPhase || 0) + (fanHz * 2.0 * Math.PI) / this.sr) % (2.0 * Math.PI);
              fanRumble = Math.sin(this.fanPhase) * rpmRatio * 0.8;
          }
          
          let airHiss = (Math.random() - 0.5) * rpmRatio * (0.2 + throttle * 0.8) * (isTurbofan ? 0.8 : 0.5);
          
          let totalTurbine = (spoolWhine + bladeWhine + airHiss + fanRumble) * vWhine * (isTurbofan ? 2.0 : 2.5);
          turboSoundL += totalTurbine;
          turboSoundR += totalTurbine;
      } else if (turboEnabled) {
          let turboHz = this.turboRpm / 60.0;
          this.whinePhase = (this.whinePhase + (turboHz * 2.0 * Math.PI) / this.sr) % (2.0 * Math.PI);
          
          let loadFactor = Math.max(0, throttle - 0.1); 
          let maxBoost = turboType === 2 ? 150000.0 : 120000.0;
          let boostFactor = Math.max(0, this.boostPressure) * loadFactor * vWhine;
          let whineVolume = Math.pow(this.turboRpm / maxBoost, 2.0) * boostFactor * (turboType === 2 ? 0.12 : 0.05); // Scale up for Big turbo
          let hissVolume = Math.pow(this.turboRpm / maxBoost, 2.0) * boostFactor * 0.02;
          
          // Different turbos have different harmonics
          let hMult = turboType === 1 ? 3.0 : (turboType === 2 ? 1.0 : 2.0); // small is screechy, big is throaty
          let whine = Math.sin(this.whinePhase) * whineVolume;
          let whineHarmonic = Math.sin(this.whinePhase * hMult) * (Math.random() * 0.1 + 0.9) * whineVolume * 0.3;
          let airHiss = (Math.random() * 2 - 1) * hissVolume;
          
          let tbWhine = applyPan(panTurbo, whine + whineHarmonic + airHiss, (whine + whineHarmonic + airHiss) * 0.6, vWhine);
          let rawTurboL = tbWhine.l;
          let rawTurboR = tbWhine.r;

          // Blow Off Valve (Filtered Noise & Flutter)
          if (this.surgeEnergy > 0.005) {
              let energyScaled = this.surgeEnergy * vFlutter;
              let bovNoise = 0;

              if (turboType === 2 || turboType === 3) {
                  // FLUTTER (Stututu)
                  let time = this.crankAngle / (rpm * 6.0 + 0.0001); 
                  let pitchBend = Math.min(1.0, this.surgeEnergy * 2.0); // pitch bend based on boost
                  
                  let flutterFreq = (turboType === 3 ? 16.0 : 12.0) * (0.8 + 0.4 * pitchBend);
                  
                  this.flutterPhase = ((this.flutterPhase || 0) + (flutterFreq * 2.0 * Math.PI) / this.sr) % (2.0 * Math.PI);
                  
                  // Twin turbo (3) has less defined wobble
                  let flutterMod = turboType === 3 
                      ? 0.8 + 0.2 * Math.sin(this.flutterPhase)
                      : 0.5 + 0.5 * Math.sin(this.flutterPhase);
                      
                  bovNoise = (Math.random() * 2 - 1) * energyScaled * flutterMod * 2.25; // Increased 50%
                  
                  // filter flutter slightly so it sounds hollow instead of white noise
                  // modulate filter frequency by pitchbend
                  let filterAlpha = 0.6 + 0.2 * pitchBend;
                  this.resonatorsY[3] = filterAlpha * this.resonatorsY[3] + (1.0 - filterAlpha) * bovNoise;
                  bovNoise = this.resonatorsY[3] * 1.5;
              } else {
                  // Standard quick PSSHH
                  bovNoise = (Math.random() * 2 - 1) * energyScaled * 1.2; // Increased 50%
              }

              let tbSurge = applyPan(panTurbo, bovNoise, bovNoise, 1.0);
              rawTurboL += tbSurge.l;
              rawTurboR += tbSurge.r;
          }

          // Intake Pipe Resonator (Comb Filter)
          if (!this.turboTubeBufferL) {
              this.turboTubeBufferL = new Float32Array(500); 
              this.turboTubeBufferR = new Float32Array(500); 
              this.tubePtr = 0;
          }
          
          let tubeDelaySamples = turboType === 2 ? 400 : 250; // bigger turbo = longer pipe/lower resonance
          let readPtr = this.tubePtr - tubeDelaySamples;
          if (readPtr < 0) readPtr += 500;
          
          let delayedL = this.turboTubeBufferL[readPtr];
          let delayedR = this.turboTubeBufferR[readPtr];

          let mixedTurboL = rawTurboL + delayedL * 0.35; 
          let mixedTurboR = rawTurboR + delayedR * 0.35;

          this.turboTubeBufferL[this.tubePtr] = mixedTurboL;
          this.turboTubeBufferR[this.tubePtr] = mixedTurboR;
          this.tubePtr = (this.tubePtr + 1) % 500;

          // Lowpass the tube output slightly for an enclosed pipe acoustic
          this.tubeLpL = (this.tubeLpL || 0) * 0.5 + mixedTurboL * 0.5;
          this.tubeLpR = (this.tubeLpR || 0) * 0.5 + mixedTurboR * 0.5;

          turboSoundL = this.tubeLpL * 0.6;
          turboSoundR = this.tubeLpR * 0.6;
      }

      let outTailL = filteredExhL * 0.7;
      let outTailR = filteredExhR * 0.7;
      
      if (isNaN(outTailL)) outTailL = 0;
      if (isNaN(outTailR)) outTailR = 0;

      // Channels 0/1: Tailpipe
      outL[i] = Math.tanh(outTailL);
      if (isStereo) outR[i] = Math.tanh(outTailR); 
      
      // Channels 2/3: Pops (Street Reverb mapped in UI later)
      if (output.length > 2) {
          let popL = pops[0];
          let popR = pops[1] || pops[0];
          let monoPop = (popL + popR) * 0.5;
          // Mix 70% towards center for a tighter, punchier sound
          let popPanMix = applyPan(panPopsParam, popL * 0.3 + monoPop * 0.7, popR * 0.3 + monoPop * 0.7, vPops);
          output[2][i] = Math.tanh(popPanMix.l); 
          if(output.length > 3) output[3][i] = Math.tanh(popPanMix.r);
      }

      // Channels 4/5: Engine Block / Mech
      if (output.length > 4) {
          output[4][i] = Math.tanh(engL);
          if(output.length > 5) output[5][i] = Math.tanh(engR);
      }

      // Channels 6/7: Intake
      if (output.length > 6) {
          output[6][i] = Math.tanh(intL);
          if(output.length > 7) output[7][i] = Math.tanh(intR);
      }

      // Channels 8/9: Turbo (Whine & Surge)
      if (output.length > 8) {
          output[8][i] = Math.tanh(turboSoundL * 0.7);
          if(output.length > 9) output[9][i] = Math.tanh(turboSoundR * 0.7);
      }
    }
    return true;
  }
}

registerProcessor("phase8-engine-worklet", Phase8EngineWorklet);

`;
