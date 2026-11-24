export const phase1WorkletCode = `
class Phase1EngineWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.crankAngle = 0; // 0 to 720 degrees (4-stroke)
    
    // Waveguide buffers
    this.maxDelay = 4096;
    this.forwardDelay = new Float32Array(this.maxDelay);
    this.backwardDelay = new Float32Array(this.maxDelay);
    this.ptr = 0;
    
    // Terminus LPF state
    this.termLpfState = 0;

    // DC Blocker state
    this.dcBlockX = 0;
    this.dcBlockY = 0;
  }

  static get parameterDescriptors() {
    return [
      { name: 'rpm', defaultValue: 1000, minValue: 500, maxValue: 8000 },
      { name: 'pipeLength', defaultValue: 1.5, minValue: 0.1, maxValue: 5.0 }, // meters
    ];
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0][0]; // single output channel
    if (!output) return true;

    const rpmParam = parameters.rpm;
    const pipeParam = parameters.pipeLength;

    const sr = sampleRate; 
    const speedOfSound = 343.0; // m/s (assume constant temp for MVP)

    for (let i = 0; i < output.length; i++) {
      const rpm = rpmParam.length > 1 ? rpmParam[i] : rpmParam[0];
      const pipeLength = pipeParam.length > 1 ? pipeParam[i] : pipeParam[0];

      // 1. Mechanical Simulator (Crank Update)
      const degPerSec = rpm * 6.0;
      this.crankAngle += degPerSec / sr;
      if (this.crankAngle >= 720.0) this.crankAngle -= 720.0;

      // 2. Combustion & Blowdown (Source Excitation)
      let p_source = 0;
      let r_engine = 0.95; // Reflection near 1 when closed

      // Exhaust valve opens around 140 deg, stays open during exhaust stroke
      if (this.crankAngle >= 140.0 && this.crankAngle <= 380.0) {
          r_engine = 0.2; // Impedance drops, absorbs reflected energy

          // Phenomenological Blowdown Spike (First 40 degrees)
          // Scales automatically in time with RPM
          let blowdownPhase = (this.crankAngle - 140.0) / 40.0;
          if (blowdownPhase >= 0.0 && blowdownPhase < 1.0) {
              // Rapid attack, smooth exponential decay
              p_source = Math.sin(blowdownPhase * Math.PI) * Math.exp(-blowdownPhase * 3.5);
              p_source *= 0.6; // Soften raw amplitude
          }
      }

      // 3. Bidirectional Waveguide Math
      const delaySamples = (pipeLength / speedOfSound) * sr;
      
      let readPtr = this.ptr - delaySamples;
      if (readPtr < 0) readPtr += this.maxDelay;
      
      let rIdx = Math.floor(readPtr);
      let rNext = rIdx + 1;
      if (rNext >= this.maxDelay) rNext -= this.maxDelay;
      
      const frac = readPtr - rIdx;

      // Fractional interpolation of wave states
      const p_plus_L = this.forwardDelay[rIdx] * (1 - frac) + this.forwardDelay[rNext] * frac;
      const p_minus_0 = this.backwardDelay[rIdx] * (1 - frac) + this.backwardDelay[rNext] * frac;

      // 4. Terminus (Tailpipe scattering)
      // High frequencies escape (radiate), low frequencies reflect inverted
      const termDampingInit = 0.5; // Simple 1-pole LPF characteristic
      this.termLpfState = this.termLpfState * termDampingInit + p_plus_L * (1 - termDampingInit);
      const r_tailpipe = -0.95 * this.termLpfState;

      // Radiation velocity roughly correlates to acoustic pressure + reflected pressure
      const rad_out = p_plus_L + r_tailpipe;

      // 5. Engine boundary scattering
      // The backward wave hits the closed (or open) exhaust valve and reflects + injects new blowdown
      const p_plus_0 = p_source + p_minus_0 * r_engine;

      // 6. Network Write & Move forward
      this.forwardDelay[this.ptr] = p_plus_0;     
      this.backwardDelay[this.ptr] = r_tailpipe * 0.999; // Passivity Enforcement global decay

      this.ptr++;
      if (this.ptr >= this.maxDelay) this.ptr = 0;

      // 7. Safety DC Blocker
      const r_dcb = 0.995;
      this.dcBlockY = rad_out - this.dcBlockX + r_dcb * this.dcBlockY;
      this.dcBlockX = rad_out;

      // 8. Output Soft Clipping & Scaling
      const finalOut = this.dcBlockY * 2.5; 
      output[i] = Math.max(-1.0, Math.min(1.0, finalOut));
    }
    return true;
  }
}

registerProcessor('phase1-engine-worklet', Phase1EngineWorklet);
`;
