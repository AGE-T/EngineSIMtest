// Attachable 3D/2D Game Vehicle Sound Source for GameLiteEngine.
// Designed to be mounted directly onto a car entity in a 2D or 3D game loop (Three.js, Babylon, Pixi, Canvas2D, or custom engine):
// - Zero-allocation per-frame transform & pedal updates (`setVehicleTransform`, `setListenerTransform`, `setControls`)
// - Physical distance attenuation + distance-dependent -6 dB/octave atmospheric air-absorption filter (4.8 kHz near -> 1.1 kHz far)
// - Front (intake snorkel + engine block) vs. Rear (dual crossplane exhaust tailpipes) radiation directivity cone
// - Stereo azimuth panning + radial velocity Doppler shift factor (c_air = 343 m/s)
// - Supports both WebAudio graph connection AND direct buffer-fill (`processBlock(outL, outR)`) for custom game audio callbacks.

import { EngineStepResult } from "./phase9Engine";
import { GameLiteEngine } from "./gameLiteEngine";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface VehicleControlInputs {
  throttle: number;      // 0.0 .. 1.0
  brakeLoadNm: number;   // 0.0 .. 400.0 Nm (or 0..1 brake pedal * 340)
  ignition: boolean;     // true = run, false = kill
  starter: boolean;      // true = cranking starter motor
  driveMode?: 0 | 1;     // 1 = 6-Speed Auto (D), 0 = Neutral (N)
}

export interface SpatialTelemetry {
  distanceMeters: number;
  dopplerRatio: number;
  radialVelocityMps: number;
  panStereo: number;          // -1.0 (Left) .. +1.0 (Right)
  rearDirectivity: number;    // 0.0 (In front of hood) .. 1.0 (Behind tailpipes)
  distanceGain: number;       // 0.0 .. 1.0
  effectiveHighCutHz: number; // Distance-modulated -6 dB/oct cutoff [Hz]
}

export interface GameVehicleSoundConfig {
  sampleRate?: number;
  seed?: number;
  refDistance?: number;       // Distance [m] at which gain is 1.0 (default: 2.5 m)
  maxDistance?: number;       // Distance [m] beyond which gain clamps to min (default: 140 m)
  rolloffFactor?: number;     // Inverse distance rolloff exponent/factor (default: 1.15)
  nearHighCutHz?: number;     // -6 dB/oct cutoff at <= refDistance (default: 4800 Hz)
  farHighCutHz?: number;      // -6 dB/oct cutoff at >= maxDistance (default: 1050 Hz)
  dopplerStrength?: number;   // 0.0 = off, 1.0 = physical 343 m/s Doppler (default: 1.0)
}

const SPEED_OF_SOUND_AIR = 343.0; // [m/s]

export class GameVehicleSoundSource {
  public readonly engine: GameLiteEngine;
  public readonly sampleRate: number;

  // Spatial configuration
  public refDistance: number;
  public maxDistance: number;
  public rolloffFactor: number;
  public nearHighCutHz: number;
  public farHighCutHz: number;
  public dopplerStrength: number;

  // Vehicle & Listener 3D Transforms
  private carPos: Vec3 = { x: 0, y: 0, z: 0 };
  private carVel: Vec3 = { x: 0, y: 0, z: 0 };
  private carFwd: Vec3 = { x: 0, y: 0, z: 1 };

  private listPos: Vec3 = { x: 0, y: 1.6, z: -3.2 }; // Default: 3.2 m behind car tailpipes
  private listVel: Vec3 = { x: 0, y: 0, z: 0 };
  private listRight: Vec3 = { x: 1, y: 0, z: 0 };

  // Vehicle control state
  private controls: VehicleControlInputs = {
    throttle: 0.0,
    brakeLoadNm: 0.0,
    ignition: true,
    starter: false,
    driveMode: 1,
  };

  // Computed spatial acoustic parameters (smoothed per-sample to prevent zipper clicks)
  private targetGainL: number = 0.85;
  private targetGainR: number = 0.85;
  private smoothGainL: number = 0.85;
  private smoothGainR: number = 0.85;
  private targetExhaustMix: number = 0.85;
  private targetFrontMix: number = 0.36;
  private smoothExhaustMix: number = 0.85;
  private smoothFrontMix: number = 0.36;

  private airLpAlpha: number = 0.55;
  private airLpL: number = 0.0;
  private airLpR: number = 0.0;

  public readonly spatial: SpatialTelemetry = {
    distanceMeters: 3.2,
    dopplerRatio: 1.0,
    radialVelocityMps: 0.0,
    panStereo: 0.0,
    rearDirectivity: 0.88,
    distanceGain: 0.90,
    effectiveHighCutHz: 7800.0,
  };

  constructor(config: GameVehicleSoundConfig = {}) {
    this.sampleRate = config.sampleRate ?? 48000;
    this.engine = new GameLiteEngine(this.sampleRate, config.seed ?? 0x12345678);

    this.refDistance = config.refDistance ?? 2.5;
    this.maxDistance = config.maxDistance ?? 140.0;
    this.rolloffFactor = config.rolloffFactor ?? 1.15;
    this.nearHighCutHz = config.nearHighCutHz ?? 7800.0;
    this.farHighCutHz = config.farHighCutHz ?? 1050.0;
    this.dopplerStrength = config.dopplerStrength ?? 1.0;

    this.recomputeSpatialTargets();
  }

  // Update car pedals, ignition, starter, and transmission mode from the game's car controller
  public setControls(inputs: Partial<VehicleControlInputs>): void {
    if (inputs.throttle !== undefined) this.controls.throttle = Math.max(0.0, Math.min(1.0, inputs.throttle));
    if (inputs.brakeLoadNm !== undefined) this.controls.brakeLoadNm = Math.max(0.0, inputs.brakeLoadNm);
    if (inputs.ignition !== undefined) this.controls.ignition = inputs.ignition;
    if (inputs.starter !== undefined) this.controls.starter = inputs.starter;
    if (inputs.driveMode !== undefined) this.controls.driveMode = inputs.driveMode;
  }

  // Attach to the car entity's 3D world transform & velocity vector once per game frame
  public setVehicleTransform(position: Vec3, velocity?: Vec3, forward?: Vec3): void {
    this.carPos.x = position.x;
    this.carPos.y = position.y;
    this.carPos.z = position.z;
    if (velocity) {
      this.carVel.x = velocity.x;
      this.carVel.y = velocity.y;
      this.carVel.z = velocity.z;
    }
    if (forward) {
      const len = Math.hypot(forward.x, forward.y, forward.z) || 1.0;
      this.carFwd.x = forward.x / len;
      this.carFwd.y = forward.y / len;
      this.carFwd.z = forward.z / len;
    }
    this.recomputeSpatialTargets();
  }

  // Update camera / listener 3D world transform & velocity vector once per game frame
  public setListenerTransform(position: Vec3, velocity?: Vec3, rightVector?: Vec3): void {
    this.listPos.x = position.x;
    this.listPos.y = position.y;
    this.listPos.z = position.z;
    if (velocity) {
      this.listVel.x = velocity.x;
      this.listVel.y = velocity.y;
      this.listVel.z = velocity.z;
    }
    if (rightVector) {
      const len = Math.hypot(rightVector.x, rightVector.y, rightVector.z) || 1.0;
      this.listRight.x = rightVector.x / len;
      this.listRight.y = rightVector.y / len;
      this.listRight.z = rightVector.z / len;
    }
    this.recomputeSpatialTargets();
  }

  // Base -6 dB/octave high-cut filter override (at near-field reference distance)
  public setBaseHighCutHz(cutoffHz: number): void {
    this.nearHighCutHz = Math.max(1000.0, Math.min(18000.0, cutoffHz));
    this.recomputeSpatialTargets();
  }

  private recomputeSpatialTargets(): void {
    const dx = this.carPos.x - this.listPos.x;
    const dy = this.carPos.y - this.listPos.y;
    const dz = this.carPos.z - this.listPos.z;
    const dist = Math.max(0.25, Math.hypot(dx, dy, dz));
    const invDist = 1.0 / dist;
    const dirX = dx * invDist;
    const dirY = dy * invDist;
    const dirZ = dz * invDist;

    // 1. Inverse-distance attenuation
    const clampedDist = Math.max(this.refDistance, Math.min(this.maxDistance, dist));
    const distGain =
      this.refDistance /
      (this.refDistance + this.rolloffFactor * (clampedDist - this.refDistance));

    // 2. Distance-dependent -6 dB/octave atmospheric air absorption filter
    const distNorm = Math.min(
      1.0,
      Math.max(0.0, (dist - this.refDistance) / Math.max(1.0, this.maxDistance - this.refDistance))
    );
    const airHighCutHz = Math.max(
      900.0,
      Math.min(
        18000.0,
        this.nearHighCutHz * Math.pow(this.farHighCutHz / this.nearHighCutHz, Math.pow(distNorm, 0.65))
      )
    );
    const dt = 1.0 / this.sampleRate;
    const rc = 1.0 / (2.0 * Math.PI * airHighCutHz);
    this.airLpAlpha = dt / (rc + dt);

    // 3. Front (intake/engine hood) vs. Rear (exhaust tailpipes) radiation directivity cone
    // Vector from car to listener is (-dirX, -dirY, -dirZ)
    const dotCarForwardToListener = -(
      this.carFwd.x * dirX +
      this.carFwd.y * dirY +
      this.carFwd.z * dirZ
    );
    // rearDirectivity = 1.0 when listener is behind the car (dot = -1), 0.0 when in front of hood (dot = +1)
    const rearDirectivity = 0.5 * (1.0 - dotCarForwardToListener);
    this.targetExhaustMix = 0.45 + 0.45 * rearDirectivity;
    this.targetFrontMix = 0.24 + 0.34 * (1.0 - rearDirectivity);

    // 4. Stereo panning from listener's right-ear axis
    const pan = Math.max(
      -0.92,
      Math.min(0.92, dirX * this.listRight.x + dirY * this.listRight.y + dirZ * this.listRight.z)
    );
    const panAngle = (pan + 1.0) * 0.25 * Math.PI; // Equal-power pan law [0 .. PI/2]
    this.targetGainL = distGain * Math.cos(panAngle) * 1.25;
    this.targetGainR = distGain * Math.sin(panAngle) * 1.25;

    // 5. Physical Doppler shift from relative radial velocity
    const relVx = this.carVel.x - this.listVel.x;
    const relVy = this.carVel.y - this.listVel.y;
    const relVz = this.carVel.z - this.listVel.z;
    // Positive radialVel = receding away from listener; Negative = approaching listener
    const radialVel = (relVx * dirX + relVy * dirY + relVz * dirZ) * this.dopplerStrength;
    const clampedRadial = Math.max(-120.0, Math.min(120.0, radialVel));
    const dopplerRatio = SPEED_OF_SOUND_AIR / (SPEED_OF_SOUND_AIR + clampedRadial);

    this.spatial.distanceMeters = dist;
    this.spatial.dopplerRatio = dopplerRatio;
    this.spatial.radialVelocityMps = radialVel;
    this.spatial.panStereo = pan;
    this.spatial.rearDirectivity = rearDirectivity;
    this.spatial.distanceGain = distGain;
    this.spatial.effectiveHighCutHz = airHighCutHz;
  }

  // Synthesize and spatialize a stereo audio block (zero allocations; ready for AudioWorklet or custom game audio thread)
  public processBlock(outL: Float32Array, outR: Float32Array): EngineStepResult {
    const n = outL.length;
    const { throttle, brakeLoadNm, ignition, starter, driveMode } = this.controls;
    const lpAlpha = this.airLpAlpha;
    let lastRes = this.engine.result;

    for (let i = 0; i < n; i++) {
      lastRes = this.engine.step(throttle, brakeLoadNm, ignition, starter, driveMode ?? 1);

      this.smoothGainL += 0.008 * (this.targetGainL - this.smoothGainL);
      this.smoothGainR += 0.008 * (this.targetGainR - this.smoothGainR);
      this.smoothExhaustMix += 0.008 * (this.targetExhaustMix - this.smoothExhaustMix);
      this.smoothFrontMix += 0.008 * (this.targetFrontMix - this.smoothFrontMix);

      const frontMono = (lastRes.intakeAudio + lastRes.mechAudio * 0.85) * this.smoothFrontMix;
      let sL = (lastRes.exhaustAudioL * this.smoothExhaustMix + frontMono) * this.smoothGainL;
      let sR = (lastRes.exhaustAudioR * this.smoothExhaustMix + frontMono) * this.smoothGainR;

      this.airLpL += lpAlpha * (sL - this.airLpL);
      this.airLpR += lpAlpha * (sR - this.airLpR);
      sL = this.airLpL;
      sR = this.airLpR;

      if (sL > 0.82) sL = 0.82 + 0.14 * ((sL - 0.82) / (0.14 + (sL - 0.82)));
      else if (sL < -0.82) sL = -0.82 + 0.14 * ((sL + 0.82) / (0.14 - (sL + 0.82)));
      if (sR > 0.82) sR = 0.82 + 0.14 * ((sR - 0.82) / (0.14 + (sR - 0.82)));
      else if (sR < -0.82) sR = -0.82 + 0.14 * ((sR + 0.82) / (0.14 - (sR + 0.82)));

      outL[i] = sL;
      outR[i] = sR;
    }

    return lastRes;
  }
}
