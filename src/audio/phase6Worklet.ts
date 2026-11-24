export const phase6WorkletCode = `

class DelayLine {
  constructor(length) {
    this.buffer = new Float32Array(length);
    this.ptr = 0;
  }
  read(offset) {
    let p = this.ptr - offset;
    while (p < 0) p += this.buffer.length;
    return this.buffer[Math.floor(p) % this.buffer.length]; // Simple nearest-neighbor for cost
  }
  write(val) {
    this.buffer[this.ptr] = val;
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

class BiquadFilter {
  constructor() {
    this.x1 = 0; this.x2 = 0;
    this.y1 = 0; this.y2 = 0;
    this.b0 = 1; this.b1 = 0; this.b2 = 0;
    this.a1 = 0; this.a2 = 0;
  }
  setLowpass(fc, sr) {
    let w0 = 2 * Math.PI * fc / sr;
    let alpha = Math.sin(w0) / (2 * 0.707);
    let a0 = 1 + alpha;
    this.b0 = (1 - Math.cos(w0)) / 2 / a0;
    this.b1 = (1 - Math.cos(w0)) / a0;
    this.b2 = (1 - Math.cos(w0)) / 2 / a0;
    this.a1 = -2 * Math.cos(w0) / a0;
    this.a2 = (1 - alpha) / a0;
  }
  process(x) {
    let y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x;
    this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

function scatter(pressures) {
  let N = pressures.length;
  let sum = 0;
  for (let i = 0; i < N; i++) sum += pressures[i];
  let p_junc = (2.0 * sum) / N;
  let out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    out[i] = p_junc - pressures[i];
  }
  return out;
}

class Phase6EngineWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sr = sampleRate;
    
    this.crankAngle = 0;
    this.currentOutputRpm = 1000;
    this.speed = 343.0; // Speed of sound m/s

    this.unburntFuel = 0;
    this.popEnergy = [0, 0];
    this.noiseSmoothed = [0, 0];

    // Turbo state
    this.turboRpm = 0;
    this.boostPressure = 0;
    this.bovEnergy = 0;
    this.whinePhase = 0;

    // Resonators
    this.resonatorsX = new Float32Array(4);
    this.resonatorsY = new Float32Array(4);

    this.port.onmessage = (e) => {
      if (e.data.type === "config") {
        this.applyConfig(e.data.config);
      }
    };
  }

  static get parameterDescriptors() {
    return [
      { name: "rpm", defaultValue: 1000, minValue: 0, maxValue: 20000, automationRate: "a-rate" },
      { name: "throttle", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "a-rate" },
      { name: "load", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "a-rate" },
      { name: "turboEnabled", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" }
    ];
  }

  applyConfig(config) {
    this.config = config;
    
    this.delayLines = [];
    this.runners = [];
    this.downpipes = [];
    this.tailpipes = [];
    
    for (let c of config.cylinders) {
       this.runners.push(new Segment());
       this.delayLines.push(new DelayLine(2000)); 
    }
    this.downpipes.push(new Segment(), new Segment());
    this.tailpipes.push(new Segment(), new Segment());
    for(let i = 0; i < 4; i++) this.delayLines.push(new DelayLine(4000));

    // Calculate delay samples
    for (let i = 0; i < this.runners.length; i++) {
       let cyl = config.cylinders.find(c => c.index === i);
       if (cyl) {
          this.runners[i].delaySamples = (cyl.length / this.speed) * this.sr;
       }
    }
    this.downpipes[0].delaySamples = (config.downpipeLength / this.speed) * this.sr;
    this.downpipes[1].delaySamples = (config.downpipeLength / this.speed) * this.sr;
    this.tailpipes[0].delaySamples = (config.tailpipeLength / this.speed) * this.sr;
    this.tailpipes[1].delaySamples = (config.tailpipeLength / this.speed) * this.sr;
    
    this.dcBlockX = [0, 0];
    this.dcBlockY = [0, 0];
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0]; 
    if (!output || !this.config) return true;
    
    const isStereo = output.length > 1;
    const outL = output[0];
    const outR = isStereo ? output[1] : output[0];

    const rpmParam = parameters.rpm;
    const throttleParam = parameters.throttle;
    const loadParam = parameters.load;
    const turboEnabled = parameters.turboEnabled[0] > 0.5;
    const maxRpm = this.config.metadata?.max_rpm || 7000;

    for (let i = 0; i < outL.length; i++) {
      const targetRpm = rpmParam.length > 1 ? rpmParam[i] : rpmParam[0];
      const throttle = throttleParam.length > 1 ? throttleParam[i] : throttleParam[0];
      const load = loadParam ? (loadParam.length > 1 ? loadParam[i] : loadParam[0]) : throttle;
      
      this.currentOutputRpm += (targetRpm - this.currentOutputRpm) * 0.001; 
      const rpm = this.currentOutputRpm;

      let ignitionActive = true;
      if (rpm >= maxRpm) {
          ignitionActive = false; 
          this.unburntFuel += 0.01 * throttle;
      } else if (throttle < 0.1 && rpm > 3500) {
          this.unburntFuel += 0.001; 
      }

      this.unburntFuel -= 0.0002; 
      this.unburntFuel = Math.max(0, Math.min(1.0, this.unburntFuel));

      const degPerSec = rpm * 6.0;
      this.crankAngle += degPerSec / this.sr;
      if (this.crankAngle >= 720.0) this.crankAngle -= 720.0;

      // ---- TURBO DYNAMICS ----
      let exhaustFlow = (rpm / maxRpm) * (0.3 + 0.7 * throttle); // rely more on geometry and revs than actual heavy load
      if (turboEnabled) {
          let targetTurboRpm = exhaustFlow * 150000; // max 150k rpm
          this.turboRpm += (targetTurboRpm - this.turboRpm) * 0.0001; // Spool inertia
          
          let targetBoost = (this.turboRpm / 150000) * (0.5 + 0.5 * throttle);
          
          if (throttle < 0.1 && this.boostPressure > 0.1) {
              // Blow Off Valve triggers!
              this.bovEnergy += this.boostPressure * 0.8;
              this.boostPressure = 0;
          } else {
              this.boostPressure += (targetBoost - this.boostPressure) * 0.02;
          }
      } else {
          this.turboRpm = 0;
          this.boostPressure = 0;
      }
      this.bovEnergy *= 0.993; // Blow off valve realistic decay

      let runner_fwd_in = new Float32Array(this.config.cylinders.length);
      let blockExcitation = 0;

      for(let cyl of this.config.cylinders) {
         let phase = this.crankAngle - cyl.phaseOffset;
         if (phase < 0) phase += 720.0;
         
         let r_engine = 0.95;
         let p_source = 0;
         
         // Smooth Valve Opening
         if (phase >= 130 && phase <= 390) { 
             let valvePhase = (phase - 130) / 260.0; // 0 to 1
             let valveLift = Math.sin(valvePhase * Math.PI); // Half sine
             
             r_engine = 0.95 - (valveLift * 1.45); 
             
             let bd = (phase - 130) / 60.0; 
             if (bd >= 0 && bd < 1.0) {
                // Boost adds amplitude!
                let amp = ignitionActive ? (0.1 + throttle * 0.9 + this.boostPressure * 0.5) : 0.0; 
                let pulse = Math.sin(Math.pow(bd, 0.8) * Math.PI); 
                p_source = pulse * Math.exp(-bd * 4.5) * 1.8 * amp;
                blockExcitation += p_source * 0.3; 
             }
         }
         runner_fwd_in[cyl.index] = p_source + this.runners[cyl.index].p_minus_0 * r_engine;
      }

      // Smooth unburnt fuel pops
      let pops = [0, 0];
      if (this.unburntFuel > 0.05) {
          if (Math.random() < 0.002 + (this.unburntFuel * 0.01)) {
              this.popEnergy[0] = this.unburntFuel * 3.0;
              if (this.config.cylsR.length > 0) {
                  this.popEnergy[1] = this.unburntFuel * 3.0;
              }
              this.unburntFuel *= 0.3; 
          }
      }
      
      this.popEnergy[0] *= 0.85; // Faster decay for quicker thuds
      this.popEnergy[1] *= 0.85;
      
      // Mean-zero, low-passed noise for burst (fixes NaN blow-up)
      let t0 = (Math.random() * 2 - 1) * this.popEnergy[0];
      let t1 = (Math.random() * 2 - 1) * this.popEnergy[1];
      
      // Lowpass filter to avoid high-frequency crackling in the waveguide
      this.noiseSmoothed[0] += (t0 - this.noiseSmoothed[0]) * 0.1;
      this.noiseSmoothed[1] += (t1 - this.noiseSmoothed[1]) * 0.1;

      pops[0] = this.noiseSmoothed[0];
      pops[1] = this.noiseSmoothed[1];

      let colL_in = [];
      for(let idx of this.config.cylsL) colL_in.push(this.runners[idx].p_plus_L);
      colL_in.push(this.downpipes[0].p_minus_0);
      colL_in.push(pops[0]); 
      
      let colL_out = scatter(colL_in);

      let cL = 0;
      for(let idx of this.config.cylsL) {
         this.delayLines[idx].write(colL_out[cL++]);
         let delayed = this.delayLines[idx].read(this.runners[idx].delaySamples);
         this.runners[idx].p_minus_0 = delayed; 
      }
      
      let p_plus_downL = colL_out[cL++];
      let dlL_idx = this.runners.length;
      this.delayLines[dlL_idx].write(p_plus_downL);
      this.downpipes[0].p_plus_L = this.delayLines[dlL_idx].read(this.downpipes[0].delaySamples);

      let p_plus_downR = 0;
      if (this.config.cylsR.length > 0) {
          let colR_in = [];
          for(let idx of this.config.cylsR) colR_in.push(this.runners[idx].p_plus_L);
          colR_in.push(this.downpipes[1].p_minus_0);
          colR_in.push(pops[1]);

          let colR_out = scatter(colR_in);
          let cR = 0;
          for(let idx of this.config.cylsR) {
             this.delayLines[idx].write(colR_out[cR++]);
             let delayed = this.delayLines[idx].read(this.runners[idx].delaySamples);
             this.runners[idx].p_minus_0 = delayed;
          }
          p_plus_downR = colR_out[cR++];
      }

      let dlR_idx = this.runners.length + 1;
      this.delayLines[dlR_idx].write(p_plus_downR);
      this.downpipes[1].p_plus_L = this.delayLines[dlR_idx].read(this.downpipes[1].delaySamples);

      let combine_in = [];
      combine_in.push(this.downpipes[0].p_plus_L);
      if (this.config.cylsR.length > 0) combine_in.push(this.downpipes[1].p_plus_L);
      combine_in.push(this.tailpipes[0].p_minus_0); 

      let combine_out = scatter(combine_in);

      this.downpipes[0].p_minus_0 = combine_out[0];
      let co_idx = 1;

      if (this.config.cylsR.length > 0) {
          this.downpipes[1].p_minus_0 = combine_out[co_idx++];
      } else {
          this.downpipes[1].p_minus_0 = 0; 
      }

      let p_plus_tail = combine_out[co_idx++];
      
      // Turbo physical restrictor dampening
      if (turboEnabled) {
          p_plus_tail *= 0.85; // Turbines muffle exhaust flow a bit, but don't choke it entirely
      }
      
      // Passive lowpass to dampen high frequencies (pipe friction) instead of unstable active resonator
      this.resonatorsY[0] = 0.5 * this.resonatorsY[0] + 0.5 * p_plus_tail;
      p_plus_tail = this.resonatorsY[0];

      let dlT_idx = this.runners.length + 2;
      this.delayLines[dlT_idx].write(p_plus_tail);
      this.tailpipes[0].p_plus_L = this.delayLines[dlT_idx].read(this.tailpipes[0].delaySamples);

      let finalLeft = this.tailpipes[0].p_plus_L;
      // Tailpipe reflection (open end)
      this.tailpipes[0].p_minus_0 = -finalLeft * 0.95;

      for (let i = 0; i < this.runners.length; i++) {
         this.runners[i].p_plus_L = runner_fwd_in[i];
      }

      // Add Engine Block Mechanical Noise & Intake
      let rpmNorm = rpm / 8000.0;
      let mechNoise = (Math.random() - 0.5) * rpmNorm * 0.05;
      
      // Intake Roar (increases with throttle and RPM)
      let intakeRoar = (Math.random() - 0.5) * throttle * rpmNorm * 0.4;
      // Lowpass the intake roar to make it sound hollow
      this.intakeSmoothed = (this.intakeSmoothed || 0) * 0.7 + intakeRoar * 0.3;
      
      // Valvetrain
      let valveTick = blockExcitation * 0.15;
      
      let rawOut = finalLeft * 2.5 + mechNoise + valveTick + this.intakeSmoothed; // Boosted exhaust output
      
      // Soft clipping to avoid digital harshness
      rawOut = 8.0 * Math.tanh(rawOut / 8.0);

      // DC Blocker
      const R = 0.995;
      this.dcBlockY[0] = rawOut - this.dcBlockX[0] + R * this.dcBlockY[0];
      this.dcBlockX[0] = rawOut;
      let filtered = this.dcBlockY[0];


      // ---- TURBO ACOUSTICS ----
      let turboSoundL = 0;
      let turboSoundR = 0;

      if (turboEnabled) {
          // Compressor Whine
          let turboHz = this.turboRpm / 60.0; 
          this.whinePhase += (turboHz * 2.0 * Math.PI) / this.sr;
          if (this.whinePhase > Math.PI * 2) this.whinePhase -= Math.PI * 2;
          
          // Whine requires actual boost pressure and scales with spool RPM
          // But only whine when there's actually load (throttle applied producing exhaust pressure)
          let loadFactor = Math.max(0, throttle - 0.1); 
          let boostFactor = Math.max(0, this.boostPressure) * loadFactor;
          let whineVolume = Math.pow(this.turboRpm / 150000.0, 2.0) * boostFactor * 0.08;
          let hissVolume = Math.pow(this.turboRpm / 150000.0, 2.0) * boostFactor * 0.02;
          
          let whine = Math.sin(this.whinePhase) * whineVolume;
          let whineHarmonic = Math.sin(this.whinePhase * 2.0) * (Math.random() * 0.1 + 0.9) * whineVolume * 0.3;
          let airHiss = (Math.random() * 2 - 1) * hissVolume;
          
          turboSoundL += whine + whineHarmonic + airHiss;
          turboSoundR += whine + whineHarmonic + airHiss;

          // Blow Off Valve (Filtered Noise)
          if (this.bovEnergy > 0.01) {
              let bovNoise = (Math.random() * 2 - 1) * this.bovEnergy * 0.8;
              turboSoundL += bovNoise;
              turboSoundR += bovNoise;
          }
      }

      // Apply soft clipping and gain reduction to ensure output fits in [-1.0, 1.0] securely
      let outL_final = (filtered + turboSoundL) * 0.7;
      let outR_final = (filtered + turboSoundR) * 0.7;

      outL[i] = Math.tanh(outL_final);
      if (isStereo) outR[i] = Math.tanh(outR_final); // Exhaust center, turbo center
    }

    return true;
  }
}

registerProcessor("phase6-engine-worklet", Phase6EngineWorklet);
`;
