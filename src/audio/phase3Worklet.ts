export const phase3WorkletCode = `
class DelayLine {
  constructor(maxDelay) {
    this.buffer = new Float32Array(maxDelay);
    this.ptr = 0;
    this.maxDelay = maxDelay;
  }
  read(delay) {
    let readPtr = this.ptr - delay;
    if (readPtr < 0) readPtr += this.maxDelay;
    
    let rIdx = Math.floor(readPtr);
    let rNext = rIdx + 1;
    if (rNext >= this.maxDelay) rNext -= this.maxDelay;
    
    let frac = readPtr - rIdx;
    return this.buffer[rIdx] * (1 - frac) + this.buffer[rNext] * frac;
  }
  write(val) {
    this.buffer[this.ptr] = val;
  }
  tick() {
    this.ptr++;
    if (this.ptr >= this.maxDelay) this.ptr = 0;
  }
}

class Segment {
  constructor(maxDelay) {
    this.forwardDelay = new DelayLine(maxDelay);
    this.backwardDelay = new DelayLine(maxDelay);
    this.delaySamples = 10;
  }
  get p_plus_L() { return this.forwardDelay.read(this.delaySamples); }
  get p_minus_0() { return this.backwardDelay.read(this.delaySamples); }
  
  inject_forward(val) { this.forwardDelay.write(Math.max(-10, Math.min(10, val))); }
  inject_backward(val) { this.backwardDelay.write(Math.max(-10, Math.min(10, val))); }
  
  tick() { 
    this.forwardDelay.tick();
    this.backwardDelay.tick();
  }
}

class Biquad {
  constructor() {
    this.b0 = 1; this.b1 = 0; this.b2 = 0;
    this.a1 = 0; this.a2 = 0;
    this.x1 = 0; this.x2 = 0;
    this.y1 = 0; this.y2 = 0;
  }
  setBPF(fc, Q, sr) {
    let w0 = 2 * Math.PI * fc / sr;
    let alpha = Math.sin(w0) / (2 * Q);
    let a0 = 1 + alpha;
    this.b0 = alpha / a0;
    this.b1 = 0;
    this.b2 = -alpha / a0;
    this.a1 = (-2 * Math.cos(w0)) / a0;
    this.a2 = (1 - alpha) / a0;
  }
  process(x) {
    let y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

class ResonatorBank {
  constructor(sr) {
    this.filters = [];
    const freqs = [150, 320, 500, 850, 1200, 2400];
    const Qs = [5, 8, 10, 12, 15, 10];
    for(let i=0; i<freqs.length; i++) {
        let f = new Biquad();
        f.setBPF(freqs[i], Qs[i], sr);
        this.filters.push(f);
    }
  }
  process(x) {
    let y = 0;
    for(let f of this.filters) {
        y += f.process(x);
    }
    return y;
  }
}

function scatter(in_waves) {
  let sum = 0;
  for(let i=0; i<in_waves.length; i++) sum += in_waves[i];
  let PJ = (2.0 * sum) / in_waves.length;
  let out_waves = [];
  for(let i=0; i<in_waves.length; i++) {
     out_waves.push(PJ - in_waves[i]);
  }
  return out_waves;
}

class Phase3EngineWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.crankAngle = 0;
    this.sr = sampleRate;
    this.speed = 343.0;
    
    this.runners = [];
    for(let i=0; i<8; i++) this.runners.push(new Segment(2048));
    this.downpipes = [new Segment(2048), new Segment(2048)];
    this.tailpipes = [new Segment(8192), new Segment(8192)];

    this.termLpf = [0, 0];
    this.dcBlockX = [0, 0];
    this.dcBlockY = [0, 0];
    
    this.blockResonator = new ResonatorBank(this.sr);

    this.config = null;
    this.unburntFuel = 0.0;
    
    // Smooth internal RPM state
    this.currentOutputRpm = 1000;

    this.port.onmessage = (e) => {
       if (e.data.type === 'config') {
          this.applyConfig(e.data.config);
       }
    };
  }

  static get parameterDescriptors() {
    return [
      { name: 'rpm', defaultValue: 1500, minValue: 500, maxValue: 12000 },
      { name: 'throttle', defaultValue: 1.0, minValue: 0.0, maxValue: 1.0 },
    ];
  }

  applyConfig(config) {
    this.config = config;
    for(let i=0; i<8; i++) {
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
    const maxRpm = this.config.metadata?.max_rpm || 7000;

    for (let i = 0; i < outL.length; i++) {
      const targetRpm = rpmParam.length > 1 ? rpmParam[i] : rpmParam[0];
      const throttle = throttleParam.length > 1 ? throttleParam[i] : throttleParam[0];
      
      // Very basic internal physics smoother
      this.currentOutputRpm += (targetRpm - this.currentOutputRpm) * 0.0005;
      const rpm = this.currentOutputRpm;

      let ignitionActive = true;
      if (rpm >= maxRpm) {
          ignitionActive = false; // Fuel/ignition cut
          this.unburntFuel += 0.005 * throttle;
      } else if (throttle < 0.1 && rpm > 3500) {
          this.unburntFuel += 0.0005; // Overrun
      }

      this.unburntFuel -= 0.0001; 
      this.unburntFuel = Math.max(0, Math.min(1.0, this.unburntFuel));

      const degPerSec = rpm * 6.0;
      this.crankAngle += degPerSec / this.sr;
      if (this.crankAngle >= 720.0) this.crankAngle -= 720.0;

      let runner_fwd_in = new Float32Array(8);
      let blockExcitation = 0;

      for(let cyl of this.config.cylinders) {
         let phase = this.crankAngle - cyl.phaseOffset;
         if (phase < 0) phase += 720.0;
         
         let r_engine = 0.95;
         let p_source = 0;
         
         if (phase >= 140 && phase <= 380) {
            r_engine = -0.5;
            let bd = (phase - 140) / 40.0;
            if (bd >= 0 && bd < 1.0) {
               let amp = ignitionActive ? (0.1 + throttle * 0.9) : 0.0; 
               p_source = Math.sin(bd * Math.PI) * Math.exp(-bd * 3.5) * 0.8 * amp;
               blockExcitation += p_source * 0.3; 
            }
         }
         runner_fwd_in[cyl.index] = p_source + this.runners[cyl.index].p_minus_0 * r_engine;
      }

      let pops = [0, 0];
      if (this.unburntFuel > 0.1) {
          if (Math.random() < 0.001 + (this.unburntFuel * 0.01)) {
              pops[0] = (Math.random() * 2 - 1) * this.unburntFuel * 4.0;
              if (this.config.cylsR.length > 0) pops[1] = (Math.random() * 2 - 1) * this.unburntFuel * 4.0;
              this.unburntFuel *= 0.5; 
          }
      }

      let colL_in = [];
      for(let idx of this.config.cylsL) colL_in.push(this.runners[idx].p_plus_L);
      colL_in.push(this.downpipes[0].p_minus_0);
      colL_in.push(pops[0]); 
      
      let colL_out = scatter(colL_in);
      for(let j=0; j<this.config.cylsL.length; j++) {
         this.runners[this.config.cylsL[j]].inject_backward(colL_out[j] * 0.999);
      }
      let dpL_fwd_in = colL_out[this.config.cylsL.length]; // next after runners

      let dpR_fwd_in = 0;
      if (this.config.cylsR.length > 0) {
         let colR_in = [];
         for(let idx of this.config.cylsR) colR_in.push(this.runners[idx].p_plus_L);
         colR_in.push(this.downpipes[1].p_minus_0);
         colR_in.push(pops[1]);
         let colR_out = scatter(colR_in);
         for(let j=0; j<this.config.cylsR.length; j++) {
            this.runners[this.config.cylsR[j]].inject_backward(colR_out[j] * 0.999);
         }
         dpR_fwd_in = colR_out[this.config.cylsR.length];
      }

      let tpL_fwd_in = 0;
      let tpR_fwd_in = 0;
      let dpL_bwd_in = 0;
      let dpR_bwd_in = 0;

      if (this.config.crossPipe === "x-pipe" && this.config.cylsR.length > 0) {
         let x_in = [this.downpipes[0].p_plus_L, this.downpipes[1].p_plus_L, this.tailpipes[0].p_minus_0, this.tailpipes[1].p_minus_0];
         let x_out = scatter(x_in);
         dpL_bwd_in = x_out[0];
         dpR_bwd_in = x_out[1];
         tpL_fwd_in = x_out[2];
         tpR_fwd_in = x_out[3];
      } else {
         let l_in = [this.downpipes[0].p_plus_L, this.tailpipes[0].p_minus_0];
         let l_out = scatter(l_in);
         dpL_bwd_in = l_out[0];
         tpL_fwd_in = l_out[1];
         
         if (this.config.cylsR.length > 0) {
            let r_in = [this.downpipes[1].p_plus_L, this.tailpipes[1].p_minus_0];
            let r_out = scatter(r_in);
            dpR_bwd_in = r_out[0];
            tpR_fwd_in = r_out[1];
         }
      }

      const LPF = 0.6;
      this.termLpf[0] = this.termLpf[0] * LPF + this.tailpipes[0].p_plus_L * (1-LPF);
      let tpL_bwd_in = -0.95 * this.termLpf[0];
      let radL = this.tailpipes[0].p_plus_L + tpL_bwd_in;

      let radR = 0;
      let tpR_bwd_in = 0;
      if (this.config.cylsR.length > 0) {
          this.termLpf[1] = this.termLpf[1] * LPF + this.tailpipes[1].p_plus_L * (1-LPF);
          tpR_bwd_in = -0.95 * this.termLpf[1];
          radR = this.tailpipes[1].p_plus_L + tpR_bwd_in;
      }

      for(let cyl of this.config.cylinders) {
         this.runners[cyl.index].inject_forward(runner_fwd_in[cyl.index]);
         this.runners[cyl.index].tick();
      }
      this.downpipes[0].inject_forward(dpL_fwd_in);
      this.downpipes[0].inject_backward(dpL_bwd_in);
      this.downpipes[0].tick();
      
      this.tailpipes[0].inject_forward(tpL_fwd_in);
      this.tailpipes[0].inject_backward(tpL_bwd_in);
      this.tailpipes[0].tick();

      if (this.config.cylsR.length > 0) {
         this.downpipes[1].inject_forward(dpR_fwd_in);
         this.downpipes[1].inject_backward(dpR_bwd_in);
         this.downpipes[1].tick();
         
         this.tailpipes[1].inject_forward(tpR_fwd_in);
         this.tailpipes[1].inject_backward(tpR_bwd_in);
         this.tailpipes[1].tick();
      }
      
      let blockBody = this.blockResonator.process(blockExcitation) * 1.5;

      let r_dcb = 0.995;
      this.dcBlockY[0] = radL - this.dcBlockX[0] + r_dcb * this.dcBlockY[0];
      this.dcBlockX[0] = radL;

      if (this.config.cylsR.length > 0) {
          this.dcBlockY[1] = radR - this.dcBlockX[1] + r_dcb * this.dcBlockY[1];
          this.dcBlockX[1] = radR;
      } else {
          this.dcBlockY[1] = this.dcBlockY[0];
      }

      let gain = 3.0;
      let finalL = this.dcBlockY[0] * gain + blockBody;
      let finalR = this.dcBlockY[1] * gain + blockBody;

      // Soft limiting
      outL[i] = Math.max(-1.0, Math.min(1.0, Math.tanh(finalL)));
      if (isStereo) outR[i] = Math.max(-1.0, Math.min(1.0, Math.tanh(finalR)));
    }
    
    return true;
  }
}

registerProcessor('phase3-engine-worklet', Phase3EngineWorklet);
`
