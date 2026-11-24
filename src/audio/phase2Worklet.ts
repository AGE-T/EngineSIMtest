export const phase2WorkletCode = `
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

class Phase2EngineWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.crankAngle = 0;
    this.sr = sampleRate;
    this.speed = 343.0; // m/s
    
    // Waveguide graph
    this.runners = [];
    for(let i=0; i<8; i++) this.runners.push(new Segment(2048));
    this.downpipes = [new Segment(2048), new Segment(2048)];
    this.tailpipes = [new Segment(8192), new Segment(8192)];

    this.termLpf = [0, 0];
    this.dcBlockX = [0, 0];
    this.dcBlockY = [0, 0];
    
    this.config = null;

    this.port.onmessage = (e) => {
       if (e.data.type === 'config') {
          this.applyConfig(e.data.config);
       }
    };
  }

  static get parameterDescriptors() {
    return [
      { name: 'rpm', defaultValue: 1500, minValue: 500, maxValue: 9000 },
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

    for (let i = 0; i < outL.length; i++) {
      const rpm = rpmParam.length > 1 ? rpmParam[i] : rpmParam[0];
      const degPerSec = rpm * 6.0;
      this.crankAngle += degPerSec / this.sr;
      if (this.crankAngle >= 720.0) this.crankAngle -= 720.0;

      // 1. Cylinders Blowdown & Boundary
      let runner_fwd_in = new Float32Array(8);
      for(let cyl of this.config.cylinders) {
         let phase = this.crankAngle - cyl.phaseOffset;
         if (phase < 0) phase += 720.0;
         
         let r_engine = 0.95;
         let p_source = 0;
         if (phase >= 140 && phase <= 380) {
            r_engine = -0.5; // open valve impedance drops
            let bd = (phase - 140) / 40.0;
            if (bd >= 0 && bd < 1.0) {
               p_source = Math.sin(bd * Math.PI) * Math.exp(-bd * 3.5) * 0.7;
            }
         }
         runner_fwd_in[cyl.index] = p_source + this.runners[cyl.index].p_minus_0 * r_engine;
      }

      // 2. Collector L
      let colL_in = [];
      for(let idx of this.config.cylsL) colL_in.push(this.runners[idx].p_plus_L);
      colL_in.push(this.downpipes[0].p_minus_0);
      let colL_out = scatter(colL_in);
      for(let j=0; j<this.config.cylsL.length; j++) {
         this.runners[this.config.cylsL[j]].inject_backward(colL_out[j] * 0.999);
      }
      let dpL_fwd_in = colL_out[colL_out.length - 1];

      // 3. Collector R
      let dpR_fwd_in = 0;
      if (this.config.cylsR.length > 0) {
         let colR_in = [];
         for(let idx of this.config.cylsR) colR_in.push(this.runners[idx].p_plus_L);
         colR_in.push(this.downpipes[1].p_minus_0);
         let colR_out = scatter(colR_in);
         for(let j=0; j<this.config.cylsR.length; j++) {
            this.runners[this.config.cylsR[j]].inject_backward(colR_out[j] * 0.999);
         }
         dpR_fwd_in = colR_out[colR_out.length - 1];
      }

      // 4. X-Pipe Junction
      let tpL_fwd_in = 0;
      let tpR_fwd_in = 0;
      let dpL_bwd_in = 0;
      let dpR_bwd_in = 0;

      if (this.config.crossPipe === "x-pipe" && this.config.cylsR.length > 0) {
         let x_in = [
            this.downpipes[0].p_plus_L, 
            this.downpipes[1].p_plus_L,
            this.tailpipes[0].p_minus_0,
            this.tailpipes[1].p_minus_0
         ];
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

      // 5. Tailpipe Radiation
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

      // 6. Inject writes
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

      // 7. DC Blocker
      let r_dcb = 0.995;
      this.dcBlockY[0] = radL - this.dcBlockX[0] + r_dcb * this.dcBlockY[0];
      this.dcBlockX[0] = radL;

      if (this.config.cylsR.length > 0) {
          this.dcBlockY[1] = radR - this.dcBlockX[1] + r_dcb * this.dcBlockY[1];
          this.dcBlockX[1] = radR;
      } else {
          // If I4 mono, copy L to R
          this.dcBlockY[1] = this.dcBlockY[0];
      }

      let gain = 3.0;
      outL[i] = Math.max(-1.0, Math.min(1.0, this.dcBlockY[0] * gain));
      if (isStereo) outR[i] = Math.max(-1.0, Math.min(1.0, this.dcBlockY[1] * gain));
    }
    return true;
  }
}

registerProcessor('phase2-engine-worklet', Phase2EngineWorklet);
`
