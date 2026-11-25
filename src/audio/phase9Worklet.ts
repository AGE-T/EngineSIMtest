import { PhysicalEngine } from "./phase9Engine";
import { GameLiteEngine } from "./gameLiteEngine";
import { GameVehicleSoundSource } from "./gameVehicleSoundSource";

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

const getNowMs: () => number =
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? () => performance.now()
    : () => Date.now();

class Phase9Processor extends AudioWorkletProcessor {
  private fullEngine: PhysicalEngine;
  private liteEngine: GameLiteEngine;
  private vehicleSource: GameVehicleSoundSource;
  private engineMode: "lite" | "full" = "lite";

  private throttle: number = 0.0;
  private load: number = 0.0;
  private ignition: boolean = true;
  private starter: boolean = false;
  private driveMode: number = 1; // Default: 1 = 6-Speed Automatic Drive (D)

  // Configurable final -6 dB/octave (1-pole) high-cut filter, tailpipe radiation LPF, mixer & 3D Vehicle Sound Source state
  private highCutEnabled: boolean = true;
  private highCutHz: number = 7800.0;
  private highCutAlpha: number = 0.55;
  private radCutoffHz: number = 8200.0;
  private jetNoiseScale: number = 0.75;
  private exhaustLevel: number = 0.82;
  private intakeLevel: number = 0.36;
  private mechLevel: number = 0.95;
  private outLpL: number = 0.0;
  private outLpR: number = 0.0;
  private spatialMode: boolean = false;

  private telemetryCounter: number = 0;
  private readonly telemetryIntervalBlocks: number;
  private readonly sr: number;

  // CPU load measurement accumulators & 1,500-block AudioWorklet percentile profiler (zero per-block allocation)
  private accumElapsedMs: number = 0.0;
  private accumBlocks: number = 0;
  private maxBlockMs: number = 0.0;
  private smoothedCpuPct: number = 0.0;
  private smoothedBlockMs: number = 0.0;

  private readonly profWindowSize: number = 1500;
  private readonly profRing: Float32Array = new Float32Array(1500);
  private readonly profScratch: Float32Array = new Float32Array(1500);
  private profWriteIdx: number = 0;
  private profCount: number = 0;
  private profOverruns: number = 0;

  private resetProfiler(): void {
    this.accumElapsedMs = 0.0;
    this.accumBlocks = 0;
    this.maxBlockMs = 0.0;
    this.smoothedCpuPct = 0.0;
    this.smoothedBlockMs = 0.0;
    this.profWriteIdx = 0;
    this.profCount = 0;
    this.profOverruns = 0;
  }

  private updateHighCutFilter(cutoffHz: number, enabled: boolean = this.highCutEnabled): void {
    const clamped = Math.max(800.0, Math.min(18000.0, cutoffHz));
    this.highCutHz = clamped;
    this.highCutEnabled = enabled;
    const dt = 1.0 / this.sr;
    const rc = 1.0 / (2.0 * Math.PI * clamped);
    this.highCutAlpha = dt / (rc + dt);
    // Keep internal GameLiteEngine highCut disabled during direct worklet mixing so it is NEVER double-applied!
    this.liteEngine.setHighCutHz(clamped, false);
    this.vehicleSource.setBaseHighCutHz(clamped);
  }

  private updateRadiationFilter(cutoffHz: number): void {
    const clamped = Math.max(1200.0, Math.min(18000.0, cutoffHz));
    this.radCutoffHz = clamped;
    this.liteEngine.setRadiationCutoffHz(clamped);
    // Also update PhysicalEngine exhaustBankL/R radiation filter alpha at runtime without altering phase9Engine.ts defaults
    const dt = 1.0 / this.sr;
    const rc = 1.0 / (2.0 * Math.PI * clamped);
    const alpha = dt / (rc + dt);
    const fullAny = this.fullEngine as unknown as {
      exhaustBankL?: { radLpAlpha?: number };
      exhaustBankR?: { radLpAlpha?: number };
    };
    if (fullAny.exhaustBankL) fullAny.exhaustBankL.radLpAlpha = alpha;
    if (fullAny.exhaustBankR) fullAny.exhaustBankR.radLpAlpha = alpha;
  }

  private updateJetNoiseScale(scale: number): void {
    const clamped = Math.max(0.0, Math.min(2.5, scale));
    this.jetNoiseScale = clamped;
    this.liteEngine.setJetNoiseScale(clamped);
    // Also scale PhysicalEngine jet filter B0/B2 coefficients proportionally at runtime
    const fullAny = this.fullEngine as unknown as {
      exhaustBankL?: { jetB0?: number; jetB2?: number };
      exhaustBankR?: { jetB0?: number; jetB2?: number };
    };
    const w0 = (2.0 * Math.PI * 1850.0) / this.sr;
    const alpha = Math.sin(w0) / (2.0 * 0.45);
    const baseB0 = alpha / (1.0 + alpha);
    if (fullAny.exhaustBankL) {
      fullAny.exhaustBankL.jetB0 = baseB0 * clamped;
      fullAny.exhaustBankL.jetB2 = -baseB0 * clamped;
    }
    if (fullAny.exhaustBankR) {
      fullAny.exhaustBankR.jetB0 = baseB0 * clamped;
      fullAny.exhaustBankR.jetB2 = -baseB0 * clamped;
    }
  }

  private applyFilterParams(data: Record<string, unknown>): void {
    if (typeof data.highCutHz === "number" || typeof data.highCutEnabled === "boolean") {
      this.updateHighCutFilter(
        typeof data.highCutHz === "number" ? data.highCutHz : this.highCutHz,
        typeof data.highCutEnabled === "boolean" ? data.highCutEnabled : this.highCutEnabled
      );
    }
    if (typeof data.radCutoffHz === "number") {
      this.updateRadiationFilter(data.radCutoffHz);
    }
    if (typeof data.jetNoiseScale === "number") {
      this.updateJetNoiseScale(data.jetNoiseScale);
    }
    if (typeof data.exhaustLevel === "number") {
      this.exhaustLevel = Math.max(0.0, Math.min(2.0, data.exhaustLevel));
    }
    if (typeof data.intakeLevel === "number") {
      this.intakeLevel = Math.max(0.0, Math.min(2.0, data.intakeLevel));
    }
    if (typeof data.mechLevel === "number") {
      this.mechLevel = Math.max(0.0, Math.min(2.0, data.mechLevel));
    }
  }

  constructor() {
    super();
    const sr = typeof sampleRate === "number" && sampleRate > 8000 ? sampleRate : 48000;
    this.sr = sr;
    this.fullEngine = new PhysicalEngine(sr);
    this.vehicleSource = new GameVehicleSoundSource({ sampleRate: sr, nearHighCutHz: 7800.0 });
    this.liteEngine = this.vehicleSource.engine;
    this.updateHighCutFilter(7800.0, true);
    this.updateRadiationFilter(8200.0);
    this.updateJetNoiseScale(0.75);

    // Throttle telemetry posts to ~30 Hz (instead of ~345 Hz) to prevent main-thread UI/audio jank
    this.telemetryIntervalBlocks = Math.max(1, Math.round(sr / (128 * 30)));

    this.port.onmessage = (e: MessageEvent) => {
      const data = e.data;
      if (!data) return;

      if (data.type === "init") {
        this.fullEngine = new PhysicalEngine(sr);
        this.vehicleSource = new GameVehicleSoundSource({
          sampleRate: sr,
          nearHighCutHz: typeof data.highCutHz === "number" ? data.highCutHz : this.highCutHz,
        });
        this.liteEngine = this.vehicleSource.engine;
        if (data.engineMode === "lite" || data.engineMode === "full") {
          this.engineMode = data.engineMode;
        }
        if (data.throttle !== undefined) this.throttle = data.throttle;
        if (data.load !== undefined) this.load = data.load;
        if (data.ignition !== undefined) this.ignition = data.ignition;
        if (data.starter !== undefined) this.starter = data.starter;
        if (data.driveMode !== undefined) this.driveMode = data.driveMode;
        if (data.spatialMode !== undefined) this.spatialMode = Boolean(data.spatialMode);
        this.applyFilterParams(data);
        this.resetProfiler();
      } else if (data.type === "resetProfiler") {
        this.resetProfiler();
      } else if (data.type === "filters") {
        this.applyFilterParams(data);
      } else if (data.type === "spatial") {
        if (data.spatialMode !== undefined) this.spatialMode = Boolean(data.spatialMode);
        if (data.carPos) {
          this.vehicleSource.setVehicleTransform(data.carPos, data.carVel, data.carFwd);
        }
        if (data.listenerPos) {
          this.vehicleSource.setListenerTransform(data.listenerPos, data.listenerVel, data.listenerRight);
        }
      } else if (data.type === "params") {
        if (
          (data.engineMode === "lite" || data.engineMode === "full") &&
          data.engineMode !== this.engineMode
        ) {
          // Seamless live state handoff between Full 1D Sim and Game Lite Direct Synth
          if (data.engineMode === "lite") {
            this.liteEngine.omega = this.fullEngine.omega;
            this.liteEngine.crankAngle = this.fullEngine.crankAngle;
            this.liteEngine.man_P = this.fullEngine.man_P;
            this.liteEngine.currentGear = this.fullEngine.currentGear;
            this.liteEngine.vehicleSpeedMps = this.fullEngine.vehicleSpeedMps;
          } else {
            this.fullEngine.omega = this.liteEngine.omega;
            this.fullEngine.crankAngle = this.liteEngine.crankAngle;
            this.fullEngine.man_P = this.liteEngine.man_P;
            this.fullEngine.currentGear = this.liteEngine.currentGear;
            this.fullEngine.vehicleSpeedMps = this.liteEngine.vehicleSpeedMps;
          }
          this.engineMode = data.engineMode;
          this.resetProfiler();
        }
        if (data.throttle !== undefined) this.throttle = data.throttle;
        if (data.load !== undefined) this.load = data.load;
        if (data.ignition !== undefined) this.ignition = data.ignition;
        if (data.starter !== undefined) this.starter = data.starter;
        if (data.driveMode !== undefined) this.driveMode = data.driveMode;
        if (data.spatialMode !== undefined) this.spatialMode = Boolean(data.spatialMode);
        this.applyFilterParams(data);
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
    const outputR = out.length > 1 ? out[1] : outputL;
    const blockLen = outputL.length;

    const t0 = getNowMs();

    let rpm = 0;
    let power = 0;
    let torque = 0;
    let manP = 101325;
    let exPL = 101325;
    let exPR = 101325;
    let gear = 0;
    let speedKmh = 0;

    if (this.engineMode === "lite" && this.spatialMode) {
      // Attachable 3D/2D GameVehicleSoundSource path (with distance attenuation, -6 dB/oct air absorption, directivity & panning)
      this.vehicleSource.setControls({
        throttle: this.throttle,
        brakeLoadNm: this.load,
        ignition: this.ignition,
        starter: this.starter,
        driveMode: this.driveMode === 0 ? 0 : 1,
      });
      const res = this.vehicleSource.processBlock(outputL, outputR);
      rpm = res.rpm;
      power = res.powerWatts;
      torque = res.torqueNm;
      manP = res.manifoldP;
      exPL = res.exhaustPL;
      exPR = res.exhaustPR;
      gear = res.gear;
      speedKmh = res.speedKmh;
    } else {
      const activeEngine = this.engineMode === "lite" ? this.liteEngine : this.fullEngine;
      const hcEnabled = this.highCutEnabled;
      const hcAlpha = this.highCutAlpha;
      const exGain = this.exhaustLevel;
      const inGain = this.intakeLevel;
      const mGain = this.mechLevel;

      for (let i = 0; i < blockLen; i++) {
        const res = activeEngine.step(
          this.throttle,
          this.load,
          this.ignition,
          this.starter,
          this.driveMode
        );

        // Configurable source balance: dual exhaust banks + physical intake snorkel + engine block/valvetrain
        const intakeAndMech = res.intakeAudio * inGain + res.mechAudio * mGain;
        let sampleL = res.exhaustAudioL * exGain + intakeAndMech;
        let sampleR = res.exhaustAudioR * exGain + intakeAndMech;

        // Final -6 dB/octave (1-pole) high-cut filter stage (optional bypass)
        if (hcEnabled) {
          this.outLpL += hcAlpha * (sampleL - this.outLpL);
          this.outLpR += hcAlpha * (sampleR - this.outLpR);
          sampleL = this.outLpL;
          sampleR = this.outLpR;
        }

        // Transparent headroom guard: strictly linear below +/-0.82, smooth saturation below +/-0.96
        if (sampleL > 0.82) sampleL = 0.82 + 0.14 * ((sampleL - 0.82) / (0.14 + (sampleL - 0.82)));
        else if (sampleL < -0.82) sampleL = -0.82 + 0.14 * ((sampleL + 0.82) / (0.14 - (sampleL + 0.82)));
        if (sampleR > 0.82) sampleR = 0.82 + 0.14 * ((sampleR - 0.82) / (0.14 + (sampleR - 0.82)));
        else if (sampleR < -0.82) sampleR = -0.82 + 0.14 * ((sampleR + 0.82) / (0.14 - (sampleR + 0.82)));

        outputL[i] = Number.isFinite(sampleL) ? sampleL : 0.0;
        if (outputR !== outputL) {
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
    }

    const elapsedMs = Math.max(0.0, getNowMs() - t0);
    const blockBudgetMs = (blockLen / this.sr) * 1000.0;

    this.accumElapsedMs += elapsedMs;
    this.accumBlocks += 1;
    if (elapsedMs > this.maxBlockMs) {
      this.maxBlockMs = elapsedMs;
    }

    // Record into 1,500-block rolling percentile buffer
    this.profRing[this.profWriteIdx] = elapsedMs;
    this.profWriteIdx = (this.profWriteIdx + 1) % this.profWindowSize;
    if (this.profCount < this.profWindowSize) {
      this.profCount++;
    }
    if (elapsedMs > blockBudgetMs) {
      this.profOverruns++;
    }

    this.telemetryCounter++;
    if (this.telemetryCounter >= this.telemetryIntervalBlocks) {
      this.telemetryCounter = 0;

      const winAvgMs = this.accumBlocks > 0 ? this.accumElapsedMs / this.accumBlocks : 0.0;
      const winCpuPct = blockBudgetMs > 0 ? (winAvgMs / blockBudgetMs) * 100.0 : 0.0;

      if (this.smoothedBlockMs <= 0.0001) {
        this.smoothedBlockMs = winAvgMs;
        this.smoothedCpuPct = winCpuPct;
      } else {
        this.smoothedBlockMs += 0.25 * (winAvgMs - this.smoothedBlockMs);
        this.smoothedCpuPct += 0.25 * (winCpuPct - this.smoothedCpuPct);
      }

      // Compute percentiles over current profiler window
      const n = this.profCount;
      let profAvgMs = 0.0;
      let profMedianMs = 0.0;
      let profP95Ms = 0.0;
      let profP99Ms = 0.0;
      let profMaxMs = 0.0;
      if (n > 0) {
        let sum = 0.0;
        for (let i = 0; i < n; i++) {
          const v = this.profRing[i];
          this.profScratch[i] = v;
          sum += v;
        }
        const sub = this.profScratch.subarray(0, n);
        sub.sort();
        profAvgMs = sum / n;
        profMedianMs = sub[Math.floor(n * 0.50)];
        profP95Ms = sub[Math.floor(n * 0.95)];
        profP99Ms = sub[Math.floor(n * 0.99)];
        profMaxMs = sub[n - 1];
      }

      this.port.postMessage({
        type: "telemetry",
        engineMode: this.engineMode,
        sampleRate: this.sr,
        rpm,
        power,
        torque,
        manP,
        exPL,
        exPR,
        gear,
        speedKmh,
        blockAvgMs: this.smoothedBlockMs,
        blockMaxMs: this.maxBlockMs,
        blockBudgetMs,
        cpuLoadPct: this.smoothedCpuPct,
        spatial: this.vehicleSource.spatial,
        workletProfile: {
          blocksRecorded: n,
          avgMs: profAvgMs,
          medianMs: profMedianMs,
          p95Ms: profP95Ms,
          p99Ms: profP99Ms,
          maxMs: profMaxMs,
          overruns: this.profOverruns,
        },
      });

      this.accumElapsedMs = 0.0;
      this.accumBlocks = 0;
      this.maxBlockMs *= 0.85;
    }

    return true;
  }
}

registerProcessor("phase9-processor", Phase9Processor);
