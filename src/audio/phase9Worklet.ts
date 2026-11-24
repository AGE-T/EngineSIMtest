import { PhysicalEngine } from "./phase9Engine";

// AudioWorklet global declarations (not in standard DOM lib)
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean;
}
declare function registerProcessor(
  name: string,
  processorCtor: new () => AudioWorkletProcessor
): void;

class Phase9Processor extends AudioWorkletProcessor {
  private engine: PhysicalEngine;
  private throttle: number = 0.0;
  private load: number = 0.0;
  private ignition: boolean = true;
  private starter: boolean = false;
  private driveMode: number = 0; // 0 = N, 1 = Automatic D, -1..-6 = M1..M6

  private telemetryCounter: number = 0;
  private readonly telemetryIntervalBlocks: number;

  constructor() {
    super();
    const sr = typeof sampleRate === "number" && sampleRate > 8000 ? sampleRate : 44100;
    this.engine = new PhysicalEngine(sr);
    // Throttle telemetry posts to ~30 Hz (instead of ~345 Hz) to prevent main-thread UI/audio jank
    this.telemetryIntervalBlocks = Math.max(1, Math.round(sr / (128 * 30)));

    this.port.onmessage = (e: MessageEvent) => {
      const data = e.data;
      if (!data) return;

      if (data.type === "init") {
        this.engine = new PhysicalEngine(sr);
        if (data.throttle !== undefined) this.throttle = data.throttle;
        if (data.load !== undefined) this.load = data.load;
        if (data.ignition !== undefined) this.ignition = data.ignition;
        if (data.starter !== undefined) this.starter = data.starter;
        if (data.driveMode !== undefined) this.driveMode = data.driveMode;
      } else if (data.type === "params") {
        if (data.throttle !== undefined) this.throttle = data.throttle;
        if (data.load !== undefined) this.load = data.load;
        if (data.ignition !== undefined) this.ignition = data.ignition;
        if (data.starter !== undefined) this.starter = data.starter;
        if (data.driveMode !== undefined) this.driveMode = data.driveMode;
      }
    };
  }

  process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    _parameters: Record<string, Float32Array>
  ): boolean {
    const out = outputs[0];
    if (!out || out.length === 0) return true;

    const outputL = out[0];
    const outputR = out.length > 1 ? out[1] : null;
    const blockLen = outputL.length;

    let rpm = 0;
    let power = 0;
    let torque = 0;
    let manP = 101325;
    let exPL = 101325;
    let exPR = 101325;
    let gear = 0;
    let speedKmh = 0;

    for (let i = 0; i < blockLen; i++) {
      const res = this.engine.step(this.throttle, this.load, this.ignition, this.starter, this.driveMode);

      // Clean stereo balance: dual exhaust banks + physical intake snorkel + subtle valve-seating tick
      const intakeAndMech = res.intakeAudio * 0.36 + res.mechAudio;
      let sampleL = res.exhaustAudioL * 0.80 + intakeAndMech;
      let sampleR = res.exhaustAudioR * 0.80 + intakeAndMech;

      // Transparent headroom guard: strictly linear below +/-0.82, smooth saturation below +/-0.96
      if (sampleL > 0.82) sampleL = 0.82 + 0.14 * ((sampleL - 0.82) / (0.14 + (sampleL - 0.82)));
      else if (sampleL < -0.82) sampleL = -0.82 + 0.14 * ((sampleL + 0.82) / (0.14 - (sampleL + 0.82)));
      if (sampleR > 0.82) sampleR = 0.82 + 0.14 * ((sampleR - 0.82) / (0.14 + (sampleR - 0.82)));
      else if (sampleR < -0.82) sampleR = -0.82 + 0.14 * ((sampleR + 0.82) / (0.14 - (sampleR + 0.82)));

      outputL[i] = Number.isFinite(sampleL) ? sampleL : 0.0;
      if (outputR) {
        outputR[i] = Number.isFinite(sampleR) ? sampleR : 0.0;
      }

      rpm = res.rpm;
      power = res.powerWatts;
      torque = res.torqueNm;
      manP = res.manifoldP;
      exPL = res.exhaustPL;
      exPR = res.exhaustPR;
      gear = res.gear;
      speedKmh = res.speedKmh;
    }

    this.telemetryCounter++;
    if (this.telemetryCounter >= this.telemetryIntervalBlocks) {
      this.telemetryCounter = 0;
      this.port.postMessage({
        type: "telemetry",
        rpm,
        power,
        torque,
        manP,
        exPL,
        exPR,
        gear,
        speedKmh,
      });
    }

    return true;
  }
}

registerProcessor("phase9-processor", Phase9Processor);
