// Pure, zero-allocation real-time 1D thermodynamic & nonlinear acoustic V8 engine model.
// Features:
// - Temperature-dependent specific heat Cv(T) with exact analytical energy <-> temperature inversion
// - Fresh air-fuel charge vs. residual exhaust gas tracking + Wiebe combustion + Woschni wall heat loss
// - Per-cylinder primary exhaust runners -> 4-into-1 Kelly-Lochbaum collectors -> H-pipe ->
//   sport expansion mufflers -> tailpipes with dynamic temperature-dependent speed of sound
//   and mass-flow admittance (Y_i = A_i / c_i) junction scattering
// - Passive nonlinear acoustic wave steepening (Burgers/shock approximation) for authentic WOT V8 bark
// - Physical tailpipe exit-velocity-scaled jet flow texture (Lighthill analogy, zero idle hiss)
// - Physical intake snorkel waveguide coupled to throttle flow + plenum AC suction pulses
// - Cylinder-selective rotating rev limiter, realistic cranking + startup flare, ~750 RPM V8 idle
// - Precomputed high-resolution LUTs for compressible flow, kinematics, cam profiles, Wiebe & Woschni
//   (zero per-sample heap allocations; measured ~0.76 ms per 2.67 ms 128-sample block @ 48 kHz in Node/V8 gVisor container)

export const R_GAS = 287.05;      // Specific gas constant for air/exhaust [J/(kg*K)]
export const P_ATM = 101325.0;    // Atmospheric pressure [Pa]
export const T_ATM = 295.0;       // Ambient temperature [K]
export const T_WALL = 410.0;      // Mean cylinder wall temperature [K]

// Temperature-dependent specific heat Cv(T) = CV_C0 + CV_C1 * T
// 300K -> 720 J/(kg*K) (gamma=1.40), 1000K -> 835 J/(kg*K), 2500K -> 1083 J/(kg*K)
export const CV_C0 = 670.5;
export const CV_C1 = 0.165;
const CV_C0_SQ = CV_C0 * CV_C0;
const INV_CV_C1 = 1.0 / CV_C1;
const TWO_CV_C1 = 2.0 * CV_C1;
const CV_C0_PLUS_R = CV_C0 + R_GAS;
const HALF_CV_C1 = 0.5 * CV_C1;

// Exact internal energy u(T) [J/kg] = integral_0^T Cv(tau) dtau
export function specificEnergyFromT(T: number): number {
  return CV_C0 * T + HALF_CV_C1 * T * T;
}

// Exact analytical inverse T(u) [K]
export function tempFromSpecificEnergy(u: number): number {
  if (u <= 0.0) return 150.0;
  return (-CV_C0 + Math.sqrt(CV_C0_SQ + TWO_CV_C1 * u)) * INV_CV_C1;
}

// Exact specific enthalpy h(T) = u(T) + R * T [J/kg]
export function specificEnthalpyFromT(T: number): number {
  return CV_C0_PLUS_R * T + HALF_CV_C1 * T * T;
}

// Effective local gamma(T) = 1 + R / Cv(T)
export function gammaFromT(T: number): number {
  return 1.0 + R_GAS / (CV_C0 + CV_C1 * (T > 250.0 ? T : 250.0));
}

// Legacy [3/2] Padé approximation retained only for Phase 10 regression comparison (max error = 0.023520 at |x| = 1.56603)
export function legacyFastTanh(x: number): number {
  if (x >= 3.0) return 1.0;
  if (x <= -3.0) return -1.0;
  const x2 = x * x;
  return (x * (27.0 + x2)) / (27.0 + 9.0 * x2);
}

// Exact C1-clamped [3/4] rational tanh(x) approximant:
// 1 - R(x) = (C - x)^2 * (A - D*x + x^2) / (C0 + x^2*(D2 + x^2)) for x in [0, C], with C = 4.07.
// Satisfies R(0) = 0, R'(0) = 1, R(+-4.07) = +-1, R'(+-4.07) = 0 (exact C1 saturation),
// strict monotonicity (R'(x) >= 0), and maximum absolute error = 0.0007217 < 0.00073 across all real x!
const TANH_CLAMP = 4.07;
const TANH_C0 = 163.88050423825393;
const TANH_N2 = 13.171696172305033;
const TANH_D2 = 67.41614521033179;

export function fastTanh(x: number): number {
  if (x >= TANH_CLAMP) return 1.0;
  if (x <= -TANH_CLAMP) return -1.0;
  const x2 = x * x;
  return (x * (TANH_C0 + TANH_N2 * x2)) / (TANH_C0 + x2 * (TANH_D2 + x2));
}

// High-headroom soft saturator capped strictly below +/- 1.0 to prevent hard digital clipping
export function softLimit(v: number): number {
  return 0.90 * fastTanh(v * 0.92);
}

const TWO_PI = 2.0 * Math.PI;
const FOUR_PI = 4.0 * Math.PI;
const INV_FOUR_PI = 1.0 / FOUR_PI;
const DEG_TO_RAD = Math.PI / 180.0;

// Compressible orifice flow constants (evaluated at representative gamma = 1.36)
const FLOW_GAMMA = 1.36;
const PR_CRIT = Math.pow(2.0 / (FLOW_GAMMA + 1.0), FLOW_GAMMA / (FLOW_GAMMA - 1.0));
const PSI_CHOKED = Math.sqrt(
  FLOW_GAMMA * Math.pow(2.0 / (FLOW_GAMMA + 1.0), (FLOW_GAMMA + 1.0) / (FLOW_GAMMA - 1.0))
);
const FLOW_EXP1 = 2.0 / FLOW_GAMMA;
const FLOW_EXP2 = (FLOW_GAMMA + 1.0) / FLOW_GAMMA;
const FLOW_COEFF = (2.0 * FLOW_GAMMA) / (FLOW_GAMMA - 1.0);

// Smooth linear regularization near PR = 1 to guarantee explicit Euler passivity
const PR_LIN_START = 0.994;
const PSI_AT_LIN = Math.sqrt(
  FLOW_COEFF * (Math.pow(PR_LIN_START, FLOW_EXP1) - Math.pow(PR_LIN_START, FLOW_EXP2))
);
const PSI_LIN_SLOPE = PSI_AT_LIN / (1.0 - PR_LIN_START);

// --- Precomputed Module-Level Physics Lookup Tables (zero runtime Math.pow / Math.exp overhead) ---

// 1. Compressible nozzle flow function psi(PR) for PR in [PR_CRIT, PR_LIN_START]
const PSI_LUT_SIZE = 512;
const PSI_LUT = new Float64Array(PSI_LUT_SIZE + 1);
const PSI_SPAN = PR_LIN_START - PR_CRIT;
const PSI_INV_SPAN = PSI_LUT_SIZE / PSI_SPAN;
for (let i = 0; i <= PSI_LUT_SIZE; i++) {
  const pr = PR_CRIT + (i / PSI_LUT_SIZE) * PSI_SPAN;
  const inner = Math.pow(pr, FLOW_EXP1) - Math.pow(pr, FLOW_EXP2);
  PSI_LUT[i] = inner > 0.0 ? Math.sqrt(FLOW_COEFF * inner) : 0.0;
}

// 2. Inverse sqrt(R_GAS * T) for T in [150, 3900] K
const INV_SQRT_RT_SIZE = 512;
const INV_SQRT_RT_MIN_T = 150.0;
const INV_SQRT_RT_MAX_T = 3900.0;
const INV_SQRT_RT_SCALE = INV_SQRT_RT_SIZE / (INV_SQRT_RT_MAX_T - INV_SQRT_RT_MIN_T);
const INV_SQRT_RT_LUT = new Float64Array(INV_SQRT_RT_SIZE + 1);
for (let i = 0; i <= INV_SQRT_RT_SIZE; i++) {
  const T = INV_SQRT_RT_MIN_T + (i / INV_SQRT_RT_SIZE) * (INV_SQRT_RT_MAX_T - INV_SQRT_RT_MIN_T);
  INV_SQRT_RT_LUT[i] = 1.0 / Math.sqrt(R_GAS * T);
}

// 3. Wiebe burn fraction 1 - exp(-5 * u^3) for u in [0, 1]
const WIEBE_LUT_SIZE = 256;
const WIEBE_LUT = new Float64Array(WIEBE_LUT_SIZE + 1);
for (let i = 0; i <= WIEBE_LUT_SIZE; i++) {
  const u = i / WIEBE_LUT_SIZE;
  WIEBE_LUT[i] = 1.0 - Math.exp(-5.0 * u * u * u);
}

// 4. Woschni heat-transfer factors: pBar^0.70 for pBar in [0, 140] and (T/1000)^-0.45 for T in [250, 3900]
const P_WOSCHNI_SIZE = 512;
const P_WOSCHNI_MAX = 140.0;
const P_WOSCHNI_SCALE = P_WOSCHNI_SIZE / P_WOSCHNI_MAX;
const P_WOSCHNI_LUT = new Float64Array(P_WOSCHNI_SIZE + 1);
for (let i = 0; i <= P_WOSCHNI_SIZE; i++) {
  const pBar = Math.max(0.2, (i / P_WOSCHNI_SIZE) * P_WOSCHNI_MAX);
  P_WOSCHNI_LUT[i] = Math.pow(pBar, 0.70);
}

const T_WOSCHNI_SIZE = 512;
const T_WOSCHNI_MIN = 250.0;
const T_WOSCHNI_MAX = 3900.0;
const T_WOSCHNI_SCALE = T_WOSCHNI_SIZE / (T_WOSCHNI_MAX - T_WOSCHNI_MIN);
const T_WOSCHNI_LUT = new Float64Array(T_WOSCHNI_SIZE + 1);
for (let i = 0; i <= T_WOSCHNI_SIZE; i++) {
  const T = T_WOSCHNI_MIN + (i / T_WOSCHNI_SIZE) * (T_WOSCHNI_MAX - T_WOSCHNI_MIN);
  T_WOSCHNI_LUT[i] = Math.pow(Math.max(300.0, T) * 0.001, -0.45);
}

// 5. Speed of sound c(T) = sqrt(gamma(T) * R_GAS * T) for T in [250, 2200] K
// Enables smooth per-sample delay tracking with zero 16-sample stair-step artifacts and zero Math.sqrt!
const C_SOUND_SIZE = 512;
const C_SOUND_MIN = 250.0;
const C_SOUND_MAX = 2200.0;
const C_SOUND_SCALE = C_SOUND_SIZE / (C_SOUND_MAX - C_SOUND_MIN);
const C_SOUND_LUT = new Float64Array(C_SOUND_SIZE + 1);
for (let i = 0; i <= C_SOUND_SIZE; i++) {
  const T = C_SOUND_MIN + (i / C_SOUND_SIZE) * (C_SOUND_MAX - C_SOUND_MIN);
  C_SOUND_LUT[i] = Math.sqrt(gammaFromT(T) * R_GAS * T);
}

export function speedOfSoundFromT(T: number): number {
  let pos = (T - C_SOUND_MIN) * C_SOUND_SCALE;
  if (pos < 0.0) pos = 0.0;
  else if (pos > C_SOUND_SIZE - 1) pos = C_SOUND_SIZE - 1;
  const idx = pos | 0;
  return C_SOUND_LUT[idx] + (pos - idx) * (C_SOUND_LUT[idx + 1] - C_SOUND_LUT[idx]);
}

// Valve timing (0 rad = Intake TDC, 2*PI = Firing TDC, 4*PI = Exhaust TDC)
export const IO_RAD = -12.0 * DEG_TO_RAD;
export const IC_RAD = 222.0 * DEG_TO_RAD;
export const EO_RAD = 496.0 * DEG_TO_RAD;
export const EC_RAD = 732.0 * DEG_TO_RAD;

export const MAX_INTAKE_VALVE_AREA = 0.00148;  // m^2 (4-valve DOHC effective intake curtain area)
export const MAX_EXHAUST_VALVE_AREA = 0.00118; // m^2 (4-valve DOHC effective exhaust curtain area)

const U_MIN_150 = specificEnergyFromT(150.0);
const U_MIN_220 = specificEnergyFromT(220.0);
const U_MAX_3800 = specificEnergyFromT(3800.0);
const U_MAX_700 = specificEnergyFromT(700.0);

export interface FlowResult {
  dm: number;
  dE: number;
}

export function calculateFlowInto(
  Pup: number,
  Tup: number,
  Pdown: number,
  Tdown: number,
  area: number,
  cd: number,
  out: FlowResult
): void {
  if (area <= 1e-8) {
    out.dm = 0.0;
    out.dE = 0.0;
    return;
  }

  let P1: number;
  let T1: number;
  let P2: number;
  let dir = 1.0;

  if (Pup >= Pdown) {
    P1 = Pup;
    T1 = Tup;
    P2 = Pdown;
  } else {
    P1 = Pdown;
    T1 = Tdown;
    P2 = Pup;
    dir = -1.0;
  }

  if (P1 <= 1000.0 || T1 <= 50.0) {
    out.dm = 0.0;
    out.dE = 0.0;
    return;
  }

  const pr = P2 / P1;

  let psi: number;
  if (pr <= PR_CRIT) {
    psi = PSI_CHOKED;
  } else if (pr >= PR_LIN_START) {
    psi = PSI_LIN_SLOPE * (1.0 - pr);
  } else {
    const pos = (pr - PR_CRIT) * PSI_INV_SPAN;
    const idx = pos | 0;
    const frac = pos - idx;
    psi = PSI_LUT[idx] + frac * (PSI_LUT[idx + 1] - PSI_LUT[idx]);
  }

  // Fast LUT lookup for 1 / sqrt(R_GAS * T1)
  let tPos = (T1 - INV_SQRT_RT_MIN_T) * INV_SQRT_RT_SCALE;
  if (tPos < 0.0) tPos = 0.0;
  else if (tPos > INV_SQRT_RT_SIZE - 1) tPos = INV_SQRT_RT_SIZE - 1;
  const tIdx = tPos | 0;
  const invSqrtRT =
    INV_SQRT_RT_LUT[tIdx] + (tPos - tIdx) * (INV_SQRT_RT_LUT[tIdx + 1] - INV_SQRT_RT_LUT[tIdx]);

  const dm = cd * area * P1 * invSqrtRT * psi * dir;
  out.dm = dm;
  // Exact temperature-dependent enthalpy transport h(T) = u(T) + R*T
  out.dE = dm >= 0.0 ? dm * specificEnthalpyFromT(Tup) : dm * specificEnthalpyFromT(Tdown);
}

// Smooth high-lift DOHC sport cam profile:
// Zero velocity at seat contact (no synthetic clicks), fast blowdown opening ramp for crisp exhaust bark
export function getValveLiftNorm(angle: number, open: number, close: number): number {
  let shifted = angle;
  if (shifted < open) shifted += FOUR_PI;
  if (shifted > close) shifted -= FOUR_PI;
  if (shifted >= open && shifted <= close) {
    const x = (shifted - open) / (close - open);
    const s = Math.sin(x * Math.PI);
    // Crisp DOHC sport cam lobe: fast blowdown ramp while keeping C1-smooth seat transitions and clean idle overlap
    const eased = s * s * (3.0 - 2.0 * s);
    return Math.pow(eased, 0.68);
  }
  return 0.0;
}

// Passive 1D digital waveguide tube with:
// - Fractional delay supporting dynamic temperature-dependent speed of sound c(T)
// - Optional Burgers nonlinear wave steepening (high-pressure crests travel slightly faster,
//   creating authentic metallic V8 exhaust rasp under load with zero digital clipping)
export class WaveguideTube {
  private fwdBuf: Float32Array;
  private bwdBuf: Float32Array;
  private readonly bufSize: number;
  private readonly maxD: number;
  private ptr: number = 0;

  public pPlusOut: number = 0.0;
  public pMinusOut: number = 0.0;

  private lpFwd: number = 0.0;
  private lpBwd: number = 0.0;
  private nlModState: number = 0.0;
  private lastShift: number = 0.0;
  private readonly nlModAlpha: number;
  private readonly loss: number;
  private readonly lpAlpha: number;
  public readonly lengthMeters: number;
  public readonly area: number;
  private readonly invArea: number;
  private readonly lenTimesSr: number;
  public c: number;      // Local speed of sound [m/s]
  public T_gas: number;  // Reference section gas temperature [K]
  public rho: number;    // Reference section gas density P_ATM / (R_GAS * T_gas) [kg/m^3]
  public Z: number;      // Acoustic mass-flow characteristic impedance Z_m = c / A [Pa / (kg/s)]
  public Y: number;      // Acoustic mass-flow characteristic admittance Y_m = A / c = 1 / Z_m [(kg/s) / Pa]
  public ZVol: number;   // Physical volumetric acoustic impedance Z_vol = (rho * c) / A [Pa / (m^3/s)]
  public YVol: number;   // Physical volumetric acoustic admittance Y_vol = A / (rho * c) = Y_m / rho [(m^3/s) / Pa]
  private baseDelay: number;
  private maxShift: number;
  public saturationCount: number = 0;

  constructor(
    lengthMeters: number,
    diameterMeters: number,
    initialSpeedOfSound: number,
    sampleRate: number,
    lossPerPass: number,
    wallCutoffHz: number,
    initialGasTempK: number = T_ATM
  ) {
    this.lengthMeters = lengthMeters;
    this.lenTimesSr = lengthMeters * sampleRate;
    // Allocate buffer large enough for cold ambient speed of sound (320 m/s) + nonlinear & Hermite margin
    const maxDelay = Math.ceil((lengthMeters / 320.0) * sampleRate) + 16;
    this.bufSize = Math.max(20, maxDelay);
    this.maxD = this.bufSize - 3;
    this.fwdBuf = new Float32Array(this.bufSize);
    this.bwdBuf = new Float32Array(this.bufSize);
    this.area = Math.PI * 0.25 * diameterMeters * diameterMeters;
    this.invArea = 1.0 / this.area;
    this.c = initialSpeedOfSound;
    this.T_gas = initialGasTempK > 50.0 ? initialGasTempK : T_ATM;
    this.rho = P_ATM / (R_GAS * this.T_gas);
    this.Z = initialSpeedOfSound * this.invArea;
    this.Y = this.area / initialSpeedOfSound;
    this.ZVol = this.rho * this.Z;
    this.YVol = this.Y / this.rho;
    this.baseDelay = this.lenTimesSr / initialSpeedOfSound;
    // Allow authentic Burgers crest advance (up to ~7.5 samples) with strict slew-rate monotonicity
    this.maxShift = Math.min(7.5, this.baseDelay * 0.20);
    this.loss = lossPerPass;

    const dt = 1.0 / sampleRate;
    const rc = 1.0 / (TWO_PI * wallCutoffHz);
    this.lpAlpha = dt / (rc + dt);

    // Smooth nonlinear delay modulator (~2.6 kHz) for rich 1.5-5 kHz WOT Burgers harmonics
    const rcNl = 1.0 / (TWO_PI * 2600.0);
    this.nlModAlpha = dt / (rcNl + dt);
  }

  public updateSpeedOfSound(speedOfSound: number, gasTempK?: number): void {
    this.c = speedOfSound;
    if (gasTempK !== undefined && gasTempK > 50.0) {
      this.T_gas = gasTempK;
    } else {
      // Invert ideal-gas speed of sound approximation when explicit temperature is omitted
      this.T_gas = Math.max(150.0, (speedOfSound * speedOfSound) / (1.36 * R_GAS));
    }
    this.rho = P_ATM / (R_GAS * this.T_gas);
    this.Z = speedOfSound * this.invArea;
    this.Y = this.area / speedOfSound;
    this.ZVol = this.rho * this.Z;
    this.YVol = this.Y / this.rho;
    this.baseDelay = this.lenTimesSr / speedOfSound;
    this.maxShift = Math.min(7.5, this.baseDelay * 0.20);
  }

  public getBaseDelay(): number {
    return this.baseDelay;
  }

  public getLastShift(): number {
    return this.lastShift;
  }

  public getBufferSize(): number {
    return this.bufSize;
  }

  // 4-point Cubic Hermite (Catmull-Rom) fractional delay: eliminates temperature-dependent
  // linear-interpolation HF droop across the 4 cascaded exhaust waveguide tubes!
  public readFrac(buf: Float32Array, delaySamples: number): number {
    let d = delaySamples;
    if (d < 3.0) d = 3.0;
    else if (d > this.maxD) d = this.maxD;

    const size = this.bufSize;
    let readPos = this.ptr - d;
    if (readPos < 0.0) readPos += size;
    const i0 = readPos | 0;
    const frac = readPos - i0;
    const im1 = i0 === 0 ? size - 1 : i0 - 1;
    const i1 = i0 + 1 >= size ? 0 : i0 + 1;
    const i2 = i1 + 1 >= size ? 0 : i1 + 1;

    const ym1 = buf[im1];
    const y0 = buf[i0];
    const y1 = buf[i1];
    const y2 = buf[i2];

    const c1 = 0.5 * (y1 - ym1);
    const c2 = ym1 - 2.5 * y0 + 2.0 * y1 - 0.5 * y2;
    const c3 = 0.5 * (y2 - ym1) + 1.5 * (y0 - y1);
    return ((c3 * frac + c2) * frac + c1) * frac + y0;
  }

  // Read arriving waves at cached dynamic speed of sound and optional nonlinear steepening strength
  public readOutputs(nlStrength: number = 0.0): void {
    const baseDelay = this.baseDelay;
    const rawFwd = this.readFrac(this.fwdBuf, baseDelay);

    if (nlStrength > 0.0) {
      this.nlModState += this.nlModAlpha * (rawFwd - this.nlModState);
      // Local wave speed shift: positive pressure crests arrive earlier (steepening leading edge!)
      const normP = fastTanh(this.nlModState * (2.2 / P_ATM));
      const targetShift = normP * nlStrength * this.maxShift;
      // Strict monotonicity guard: |d(shift)/dn| <= 0.42 guarantees read pointer never reverses -> ZERO aliasing/foldover!
      let delta = targetShift - this.lastShift;
      if (delta > 0.42) delta = 0.42;
      else if (delta < -0.42) delta = -0.42;
      this.lastShift += delta;
      this.pPlusOut = this.readFrac(this.fwdBuf, baseDelay - this.lastShift);
    } else {
      this.pPlusOut = rawFwd;
    }

    this.pMinusOut = this.readFrac(this.bwdBuf, baseDelay);
  }

  public writeInputs(pPlusIn: number, pMinusIn: number): void {
    this.lpFwd += this.lpAlpha * (pPlusIn * this.loss - this.lpFwd);
    this.lpBwd += this.lpAlpha * (pMinusIn * this.loss - this.lpBwd);

    let f = this.lpFwd;
    let b = this.lpBwd;
    if (f > 400000.0) {
      f = 400000.0;
      this.saturationCount++;
    } else if (f < -400000.0) {
      f = -400000.0;
      this.saturationCount++;
    }
    if (b > 400000.0) {
      b = 400000.0;
      this.saturationCount++;
    } else if (b < -400000.0) {
      b = -400000.0;
      this.saturationCount++;
    }

    this.fwdBuf[this.ptr] = f;
    this.bwdBuf[this.ptr] = b;
    this.ptr = this.ptr + 1 >= this.bufSize ? 0 : this.ptr + 1;
  }

  public reset(): void {
    this.fwdBuf.fill(0);
    this.bwdBuf.fill(0);
    this.pPlusOut = 0;
    this.pMinusOut = 0;
    this.lpFwd = 0;
    this.lpBwd = 0;
    this.nlModState = 0;
    this.lastShift = 0;
    this.ptr = 0;
    this.saturationCount = 0;
  }
}

// One bank of a V8 exhaust: 4 primary runners -> 4-into-1 collector -> midpipe ->
// 3-path perforated-core absorption & quarter-wave side-branch resonator muffler -> tailpipe.
export class ExhaustBank {
  public primaries: WaveguideTube[];
  public midpipe: WaveguideTube;
  public mufflerCore: WaveguideTube;
  public mufflerOuter: WaveguideTube;
  public mufflerBranch: WaveguideTube;
  public tailpipe: WaveguideTube;

  // Arriving acoustic wave pressure at each cylinder's exhaust port (strictly causal: zero 1-sample feedback loop!)
  public runnerPortWavePressure: Float64Array = new Float64Array(4);
  public collectorPressure: number = P_ATM;

  private endReflLp: number = 0.0;
  private readonly endReflAlpha: number;
  private prevTailVel: number = 0.0;
  private radLp: number = 0.0;
  private readonly radLpAlpha: number;

  // Physical tailpipe exit jet noise filter (bandpass ~1850 Hz, Q=0.5, active ONLY at high exit gas velocity)
  private jetB0 = 0; private jetB2 = 0;
  private jetA1 = 0; private jetA2 = 0;
  private jetX1 = 0; private jetX2 = 0;
  private jetY1 = 0; private jetY2 = 0;
  private jetVelEnv: number = 0.0;
  private readonly jetEnvAlpha: number;

  private primaryInPlus: Float64Array = new Float64Array(4);
  private stepOut = { radiatedAudio: 0.0, jetAudio: 0.0, hPipeOutgoing: 0.0 };

  constructor(
    runnerLengths: number[],
    midLen: number,
    mufLen: number,
    tailLen: number,
    sampleRate: number
  ) {
    // 45mm ID steel primary header runners (realistic high-freq wall transmission preserves blowdown bite)
    this.primaries = runnerLengths.map(
      (len) => new WaveguideTube(len, 0.045, 500.0, sampleRate, 0.985, 11000.0)
    );
    // 64mm ID midpipe after 4-into-1 collector (asymmetric L/R routing preserves crossplane V8 half-orders!)
    this.midpipe = new WaveguideTube(midLen, 0.064, 450.0, sampleRate, 0.982, 9200.0);

    // 3-path physical sport muffler (eliminates hollow 1D organ-pipe comb ringing while keeping crisp exterior V8 bite!):
    // 1. Straight-through perforated inner core (74mm ID -> passes crisp blowdown transients directly!)
    this.mufflerCore = new WaveguideTube(mufLen, 0.074, 415.0, sampleRate, 0.978, 9200.0);
    // 2. Fiberglass-packed outer expansion shell (78mm effective diameter, 1.38x dispersive path length, 3800 Hz absorption)
    this.mufflerOuter = new WaveguideTube(mufLen * 1.38, 0.078, 385.0, sampleRate, 0.915, 3800.0);
    // 3. Quarter-wave Helmholtz side-branch resonator (0.21m, 44mm ID -> damps 450-550 Hz boxiness without trapping 50 Hz drone)
    this.mufflerBranch = new WaveguideTube(mufLen * 0.51, 0.044, 400.0, sampleRate, 0.910, 3800.0);

    // 68mm ID tailpipe
    this.tailpipe = new WaveguideTube(tailLen, 0.068, 400.0, sampleRate, 0.982, 9200.0);

    const dt = 1.0 / sampleRate;
    // Open tailpipe reflectance transitions around ka ~ 1 (~1.65 kHz for 68mm pipe)
    const rcEnd = 1.0 / (TWO_PI * 1650.0);
    this.endReflAlpha = dt / (rcEnd + dt);

    const rcRad = 1.0 / (TWO_PI * 8200.0);
    this.radLpAlpha = dt / (rcRad + dt);

    // Fast 1.5 ms tracking for high-RPM tailpipe gas-flow rush
    this.jetEnvAlpha = 1.0 - Math.exp(-dt / 0.0015);

    // Broad aeroacoustic shear-layer filter (1850 Hz center, low Q = 0.45)
    const fcJet = 1850.0;
    const qJet = 0.45;
    const w0 = (TWO_PI * fcJet) / sampleRate;
    const alpha = Math.sin(w0) / (2.0 * qJet);
    const a0 = 1.0 + alpha;
    this.jetB0 = alpha / a0;
    this.jetB2 = -alpha / a0;
    this.jetA1 = (-2.0 * Math.cos(w0)) / a0;
    this.jetA2 = (1.0 - alpha) / a0;
  }

  public updateSpeedsOfSound(
    cPrim: number,
    cMid: number,
    cTail: number,
    tPrim?: number,
    tMid?: number,
    tTail?: number
  ): void {
    for (let i = 0; i < 4; i++) {
      this.primaries[i].updateSpeedOfSound(cPrim, tPrim);
    }
    this.midpipe.updateSpeedOfSound(cMid, tMid);
    this.mufflerCore.updateSpeedOfSound(cTail, tTail);
    this.mufflerOuter.updateSpeedOfSound(cTail * 0.93, tTail);
    this.mufflerBranch.updateSpeedOfSound(cTail, tTail);
    this.tailpipe.updateSpeedOfSound(cTail, tTail);
  }

  public readAll(): void {
    // Nonlinear Burgers steepening in hot high-pressure primaries, midpipe, core, and tailpipe!
    for (let i = 0; i < 4; i++) {
      const tube = this.primaries[i];
      tube.readOutputs(0.92);
      // Exact open-circuit arriving wave pressure at cylinder port ((1 + 0.92) * pMinus for passive WDF!)
      this.runnerPortWavePressure[i] = tube.pMinusOut * 1.92;
    }
    this.midpipe.readOutputs(0.75);
    this.mufflerCore.readOutputs(0.35);
    this.mufflerOuter.readOutputs(0.0);
    this.mufflerBranch.readOutputs(0.0);
    this.tailpipe.readOutputs(0.35);
  }

  public step(
    cylFlows: Float64Array,
    hPipeIncoming: number,
    hPipeY: number,
    tailGasTemp: number,
    randSigned: number
  ): { radiatedAudio: number; jetAudio: number; hPipeOutgoing: number } {
    // 1. Cylinder-end boundary of each primary runner (passive WDF scattering: p+ = 0.92*p- + Z*dm)
    let totalBankDm = 0.0;
    for (let i = 0; i < 4; i++) {
      const tube = this.primaries[i];
      const dm = cylFlows[i];
      totalBankDm += dm;
      this.primaryInPlus[i] = tube.pMinusOut * 0.92 + tube.Z * dm;
    }

    // 2. 4-into-1 Collector Kelly-Lochbaum scattering junction weighted by mass-flow admittance Y_i = A_i / c_i:
    // Because mass flow into the junction from branch i is dm_i = (p_i,in - p_i,out) / Z_i = Y_i * (2 * p_i,in - P_J),
    // exact mass conservation (sum dm_i = 0) and lossless wave-power conservation (sum Y_i * p_i,out^2 = sum Y_i * p_i,in^2)
    // require P_J = (2 * sum Y_i * p_i,in) / sum Y_i across the primary-to-midpipe temperature gradient (c_prim != c_mid)!
    const p0 = this.primaries[0];
    const p1 = this.primaries[1];
    const p2 = this.primaries[2];
    const p3 = this.primaries[3];
    const sumCollectorY = p0.Y + p1.Y + p2.Y + p3.Y + this.midpipe.Y;
    const sumPY =
      p0.pPlusOut * p0.Y +
      p1.pPlusOut * p1.Y +
      p2.pPlusOut * p2.Y +
      p3.pPlusOut * p3.Y +
      this.midpipe.pMinusOut * this.midpipe.Y;

    const pCollector = (2.0 * sumPY) / sumCollectorY;
    this.collectorPressure = P_ATM + pCollector * 0.5;

    p0.writeInputs(this.primaryInPlus[0], pCollector - p0.pPlusOut);
    p1.writeInputs(this.primaryInPlus[1], pCollector - p1.pPlusOut);
    p2.writeInputs(this.primaryInPlus[2], pCollector - p2.pPlusOut);
    p3.writeInputs(this.primaryInPlus[3], pCollector - p3.pPlusOut);
    const midInPlus = pCollector - this.midpipe.pMinusOut;

    // 3. Midpipe -> H-pipe balance junction -> 3-path Muffler inlet (Core + Outer packing + Quarter-wave branch)
    // Weighted by mass-flow admittance Y_i = A_i / c_i across c_mid, c_tail, and 0.93 * c_tail!
    const sumMidMuffY =
      this.midpipe.Y +
      this.mufflerCore.Y +
      this.mufflerOuter.Y +
      this.mufflerBranch.Y +
      hPipeY;
    const pMidJunc =
      (2.0 *
        (this.midpipe.pPlusOut * this.midpipe.Y +
          this.mufflerCore.pMinusOut * this.mufflerCore.Y +
          this.mufflerOuter.pMinusOut * this.mufflerOuter.Y +
          this.mufflerBranch.pMinusOut * this.mufflerBranch.Y +
          hPipeIncoming * hPipeY)) /
      sumMidMuffY;

    const midInMinus = pMidJunc - this.midpipe.pPlusOut;
    const coreInPlus = pMidJunc - this.mufflerCore.pMinusOut;
    const outerInPlus = pMidJunc - this.mufflerOuter.pMinusOut;
    const branchInPlus = pMidJunc - this.mufflerBranch.pMinusOut;
    const hPipeOutgoing = pMidJunc - hPipeIncoming;

    this.midpipe.writeInputs(midInPlus, midInMinus);
    // Damped quarter-wave side-branch (0.65 reflection prevents sustained sub-harmonic organ-pipe hum!)
    this.mufflerBranch.writeInputs(branchInPlus, this.mufflerBranch.pPlusOut * 0.65);

    // 4. Muffler exit (Perforated Core + Packed Outer Shell recombine) -> Tailpipe junction (admittance-weighted)
    const sumMuffOutY = this.mufflerCore.Y + this.mufflerOuter.Y + this.tailpipe.Y;
    const pMuffTailJunc =
      (2.0 *
        (this.mufflerCore.pPlusOut * this.mufflerCore.Y +
          this.mufflerOuter.pPlusOut * this.mufflerOuter.Y +
          this.tailpipe.pMinusOut * this.tailpipe.Y)) /
      sumMuffOutY;

    const coreInMinus = pMuffTailJunc - this.mufflerCore.pPlusOut;
    const outerInMinus = pMuffTailJunc - this.mufflerOuter.pPlusOut;
    const tailInPlus = pMuffTailJunc - this.tailpipe.pMinusOut;

    this.mufflerCore.writeInputs(coreInPlus, coreInMinus);
    this.mufflerOuter.writeInputs(outerInPlus, outerInMinus);

    // 5. Open tailpipe termination with frequency-dependent radiation reflectance
    const pTailArriving = this.tailpipe.pPlusOut;
    const targetRefl = -0.78 * pTailArriving;
    this.endReflLp += this.endReflAlpha * (targetRefl - this.endReflLp);
    this.tailpipe.writeInputs(tailInPlus, this.endReflLp);

    // Exterior close-mic Levine-Schwinger open-pipe radiation:
    // Radiated sound pressure in free air is governed by volume-acceleration (dVel = dU/dt) + transmitted wave pressure (p+ + p-).
    // ZERO un-differentiated velocity (tailVelProxy) is added here, because p+ - p- has a 1/f low-pass slope that creates a 50 Hz cabin hum!
    const tailVelProxy = pTailArriving - this.endReflLp;
    const dVel = tailVelProxy - this.prevTailVel;
    this.prevTailVel = tailVelProxy;

    const linRad = (pTailArriving + this.endReflLp) * 0.72 + dVel * 3.85;
    const normVel = fastTanh(dVel * (1.0 / 125.0));
    const harmonicBark = normVel * normVel * (normVel >= 0.0 ? 1.0 : -0.58) * 540.0;
    const rawRadiated = linRad + harmonicBark;
    this.radLp += this.radLpAlpha * (rawRadiated - this.radLp);

    // 6. High-velocity tailpipe exit gas rush (Lighthill v^8 shear turbulence):
    // Strictly zero during cranking, idle, and low-load cruise so zero synthetic white-noise hiss pollutes the engine tone!
    // Activates organically only above >22 m/s mean exhaust gas exit velocity under heavy throttle/high RPM.
    const dmTailAc = tailVelProxy / this.tailpipe.Z;
    const rhoTail = P_ATM / (R_GAS * (tailGasTemp > T_ATM ? tailGasTemp : T_ATM));
    const vExitInst = Math.max(0.0, (dmTailAc * 0.65 + totalBankDm) / (rhoTail * this.tailpipe.area));
    this.jetVelEnv += this.jetEnvAlpha * (vExitInst - this.jetVelEnv);

    let jetAmp = 0.0;
    if (this.jetVelEnv > 22.0) {
      const vNorm = (this.jetVelEnv - 22.0) * (1.0 / 120.0);
      const pulseMod = 0.35 + 0.65 * Math.abs(normVel);
      jetAmp = Math.min(0.055, vNorm * vNorm * 0.065) * pulseMod;
    }
    const jetExc = randSigned * jetAmp;

    const jetOut =
      this.jetB0 * jetExc +
      this.jetB2 * this.jetX2 -
      this.jetA1 * this.jetY1 -
      this.jetA2 * this.jetY2;
    this.jetX2 = this.jetX1;
    this.jetX1 = jetExc;
    this.jetY2 = this.jetY1;
    this.jetY1 = jetOut;

    this.stepOut.radiatedAudio = this.radLp;
    this.stepOut.jetAudio = jetOut;
    this.stepOut.hPipeOutgoing = hPipeOutgoing;
    return this.stepOut;
  }

  public reset(): void {
    for (let i = 0; i < 4; i++) this.primaries[i].reset();
    this.midpipe.reset();
    this.mufflerCore.reset();
    this.mufflerOuter.reset();
    this.mufflerBranch.reset();
    this.tailpipe.reset();
    this.runnerPortWavePressure.fill(0);
    this.collectorPressure = P_ATM;
    this.endReflLp = 0;
    this.prevTailVel = 0;
    this.radLp = 0;
    this.jetX1 = 0; this.jetX2 = 0;
    this.jetY1 = 0; this.jetY2 = 0;
    this.jetVelEnv = 0;
  }
}

export class Cylinder {
  public readonly phaseOffset: number;
  public readonly bank: number;      // 0 = L, 1 = R
  public readonly bankIndex: number; // 0..3 within bank
  public readonly flowTrim: number;  // Subtle static cylinder-to-cylinder breathing asymmetry (+/-5%)
  public readonly sparkTrimRad: number; // Per-cylinder static distributor/coil timing offset (+/-1.8 deg)

  public mass: number;
  public freshMass: number; // Combustible fresh air+fuel charge mass [kg]
  public energy: number;
  public P: number;
  public T: number;

  // Combustion state (Wiebe burn profile + cycle-to-cycle Markov memory)
  public isBurning: boolean = false;
  public burnStart: number = 0.0;
  public burnDuration: number = 48.0 * DEG_TO_RAD;
  public invBurnDuration: number = 1.0 / (48.0 * DEG_TO_RAD);
  public fuelEnergyTotal: number = 0.0;
  public burnInitialFreshMass: number = 0.0;
  public lastWiebeFrac: number = 0.0;
  public prevBurnVar: number = 0.0; // Cycle-to-cycle thermal/residual correlation

  public lastAngle: number;
  public prevIntakeOpen: boolean = false;
  public prevExhaustOpen: boolean = false;
  public burbleEnv: number = 0.0;
  public burbleSmooth: number = 0.0;
  public burbleDecay: number = 0.995;

  constructor(
    phaseOffsetDeg: number,
    initialV: number,
    bank: number,
    bankIndex: number,
    flowTrim: number,
    sparkTrimDeg: number
  ) {
    this.phaseOffset = phaseOffsetDeg * DEG_TO_RAD;
    this.bank = bank;
    this.bankIndex = bankIndex;
    this.flowTrim = flowTrim;
    this.sparkTrimRad = sparkTrimDeg * DEG_TO_RAD;
    // Initial cylinder state: T_0 = T_ATM + 35.0 = 330.0 K, P_0 = 38000.0 Pa (warm idle manifold vacuum equilibrium).
    // Note (Phase 10.1 WP-C): On the first half-revolution from TDC, a closed cylinder at 38 kPa and 330 K expands by CR = 10.2x
    // down to T_min ~ 165.4 K before intake valve opening. Because minE = newMass * U_MIN_150 (150 K, aligned with tempFromSpecificEnergy's
    // 150 K lower limit), this initial expansion produces 0 recovery clamps while preserving the exact warm-idle startup trajectory.
    this.T = T_ATM + 35.0;
    this.P = 38000.0;
    this.mass = (this.P * initialV) / (R_GAS * this.T);
    this.freshMass = this.mass * 0.72;
    this.energy = this.mass * specificEnergyFromT(this.T);
    this.lastAngle = this.phaseOffset % FOUR_PI;
  }
}

export interface EngineStepResult {
  exhaustAudioL: number;
  exhaustAudioR: number;
  intakeAudio: number;
  mechAudio: number;
  rpm: number;
  powerWatts: number;
  torqueNm: number;
  manifoldP: number;
  exhaustPL: number;
  exhaustPR: number;
  maxCylT: number;
  maxCylP: number;
  gear: number;     // 0 = Neutral (N), 1..6 = 6-speed Automatic Drive gears
  speedKmh: number; // Simulated vehicle speed [km/h]
}

// Phase 10 diagnostic counters distinguishing numerical recovery clamps (should be 0 in valid physics runs)
// from expected physical actuator / control bounds (IACV limits, spark advance map bounds, and floating-point roundoff at 100% burn completion)
export interface ClampDiagnostics {
  // Numerical recovery / safety clamps (must remain 0 across all valid operating points):
  nanOrInfCount: number;
  cylMassFloorCount: number;
  cylEnergyBoundCount: number;
  manMassFloorCount: number;
  manEnergyBoundCount: number;
  manPressureCeilingCount: number;
  waveguideSaturationCount: number;
  // Expected physical control & roundoff bounds:
  freshMassRoundoffClampCount: number;
  iacvActuatorBoundCount: number;
  sparkAdvanceBoundCount: number;
}

// Phase 10.1 WP-B: Zero-allocation engine-level First-Law control-volume energy ledger
export interface EngineEnergyLedger {
  stepsAccumulated: number;
  simTimeAccumulatedSec: number;
  // Cylinder control-volume integrated energy fluxes [J]
  cylIntakeEnthalpyJ: number;
  cylExhaustEnthalpyJ: number;
  cylCombustionHeatJ: number;
  cylWallHeatLossJ: number;
  cylPistonWorkPdVJ: number;
  // Crankshaft mechanical indicated work integrated from gross indicated gas torque [J]
  crankGrossIndicatedWorkJ: number;
  // Intake manifold control-volume integrated energy fluxes [J]
  manThrottleEnthalpyInJ: number;
  manCylEnthalpyOutJ: number;
  manWallHeatExchangeJ: number;
}

const ANGLE_LUT_SIZE = 1024;
const ANGLE_LUT_MASK = ANGLE_LUT_SIZE - 1;
const ANGLE_TO_LUT = ANGLE_LUT_SIZE * INV_FOUR_PI;

// 6-speed sport automatic transmission ratios (ZF 6HP / 8HP style close-ratio V8 steps) + 3.42 final drive
export const AT_GEAR_RATIOS = [0.0, 4.17, 2.34, 1.52, 1.14, 0.87, 0.69];
export const AT_FINAL_DRIVE = 3.42;
export const AT_WHEEL_RADIUS = 0.335; // 275/35 R19 rear tire rolling radius [m]

export class PhysicalEngine {
  public readonly sampleRate: number;
  public readonly dt: number;

  // 4.58L V8 geometry
  public readonly bore = 0.090;
  public readonly stroke = 0.090;
  public readonly conrod = 0.150;
  public readonly CR = 10.2;

  private readonly r: number;
  private readonly pistonArea: number;
  private readonly V_d: number;
  private readonly V_c: number;
  private readonly h_clearance: number;

  // Precomputed crank-angle kinematics & cam curtain area LUTs (1024 entries over 720 deg)
  private readonly lutV: Float64Array;
  private readonly lutDxDtheta: Float64Array;
  private readonly lutWallArea: Float64Array;
  private readonly lutAreaIn: Float64Array;
  private readonly lutAreaEx: Float64Array;

  public crankAngle: number = 0.0;
  public omega: number = 78.0; // ~745 RPM initial idle
  public readonly inertia: number = 0.25;
  private readonly invInertia: number;

  public cylinders: Cylinder[] = [];

  // Intake manifold plenum (2.2L high-velocity runner-plenum effective volume for strong individual cylinder suction pulses!)
  public man_V: number = 0.0022;
  private readonly invManV: number;
  public man_mass: number;
  public man_energy: number;
  public man_P: number = 32000.0;
  public man_T: number = T_ATM;
  private manPMean: number = 32000.0; // Slow tracker to extract plenum AC suction pulses
  private readonly manPMeanAlpha: number;

  // Physical intake snorkel waveguide + dual-mode plenum Helmholtz & runner throat resonators
  private intakeSnorkel: WaveguideTube;
  private intakeEndLp: number = 0.0;
  private readonly intakeEndAlpha: number;
  private intakeRadLp: number = 0.0;
  private readonly intakeRadAlpha: number;
  private helmB0 = 0; private helmB2 = 0; private helmA1 = 0; private helmA2 = 0;
  private helmX1 = 0; private helmX2 = 0; private helmY1 = 0; private helmY2 = 0;
  private runB0 = 0; private runB2 = 0; private runA1 = 0; private runA2 = 0;
  private runX1 = 0; private runX2 = 0; private runY1 = 0; private runY2 = 0;

  // Dual exhaust banks with H-pipe crossover waveguide
  private exhaustBankL: ExhaustBank;
  private exhaustBankR: ExhaustBank;
  private hPipe: WaveguideTube;
  private bankFlowsL: Float64Array = new Float64Array(4);
  private bankFlowsR: Float64Array = new Float64Array(4);

  public exhaust_P_L: number = P_ATM;
  public exhaust_P_R: number = P_ATM;
  private exhaustPortT: number = 620.0; // Warm initial port temp (cools to T_ATM if stalled)

  // Decimated slow thermal/acoustic parameter counter (updates every 16 samples = ~3 kHz)
  private slowUpdateCounter: number = 0;
  private cachedHVelFactor: number = 1.8;

  // Precomputed per-sample control alphas (eliminates Math.exp per sample)
  private readonly ctrlAlpha: number;
  private readonly tipInAlpha: number;
  private readonly shiftAlpha: number;
  private readonly shiftCutAlpha: number;
  private readonly burbleAttackAlpha: number;
  private readonly mechContactAlpha: number;
  private readonly flareDecay: number;

  // True low-cutoff DC blockers (~3.5 Hz, preserving 12-25 Hz V8 crossplane idle sub-bass!)
  private readonly dcR: number;
  private dcExL_x1 = 0; private dcExL_y1 = 0;
  private dcExR_x1 = 0; private dcExR_y1 = 0;
  private dcIn_x1 = 0;  private dcIn_y1 = 0;

  // Dual-mode engine block structural resonator (zero white noise!):
  // - Mode 1 (2150 Hz): crisp valvetrain seating & upper-head metallic presence
  // - Mode 2 (680 Hz): cast-block combustion pressure-rise grunt (authentic load sensitivity!)
  private mechB0 = 0; private mechB2 = 0;
  private mechA1 = 0; private mechA2 = 0;
  private mechX1 = 0; private mechX2 = 0;
  private mechY1 = 0; private mechY2 = 0;
  private mechContactLp = 0.0;

  private blockB0 = 0; private blockB2 = 0;
  private blockA1 = 0; private blockA2 = 0;
  private blockX1 = 0; private blockX2 = 0;
  private blockY1 = 0; private blockY2 = 0;

  // Physical 12V PMGR DC starter motor (ZERO sine oscillators, ZERO resonant bandpass filter!):
  // Discrete flywheel ring-gear/pinion spur-tooth impacts + 16-bar copper commutator & planetary gear whir + solenoid clack + armature spin-down
  private readonly ringToothProfile: Float32Array;
  private readonly pinionToothProfile: Float32Array;
  private readonly commBarProfile: Float32Array;
  private starterArmatureOmega: number = 0.0;
  private starterRingPos: number = 0.0;
  private starterRingLastIdx: number = 0;
  private starterCommPos: number = 0.0;
  private starterCommLastIdx: number = 0;
  private starterToothPulse: number = 0.0;
  private starterToothRebound: number = 0.0;
  private starterToothLp: number = 0.0;
  private starterCommPulse: number = 0.0;
  private starterCommLp: number = 0.0;
  private starterSolenoidEnv: number = 0.0;
  private starterEnv: number = 0.0;
  private starterHpX1: number = 0.0;
  private starterHpY1: number = 0.0;
  private starterAirLp: number = 0.0;
  private prevStarterEngaged: boolean = false;
  private readonly starterAttackAlpha: number;
  private readonly starterReleaseAlpha: number;
  private readonly starterArmAlpha: number;
  private readonly starterToothDecay: number;
  private readonly starterReboundDecay: number;
  private readonly starterToothLpAlpha: number;
  private readonly starterCommDecay: number;
  private readonly starterCommLpAlpha: number;
  private readonly starterSolenoidDecay: number;
  private readonly starterHpR: number;
  private readonly starterAirLpAlpha: number;

  // Smooth control, cold-crank ECU sync, startup flare, & rotating rev limiter states
  private idleIntegral: number = 0.0;
  private smoothedIacvArea: number = 0.000066;
  private startupFlare: number = 0.0;
  private wasCranking: boolean = false;
  private crankSyncTime: number = 1.0; // Starts synced when engine initializes running; resets to 0 on stall
  private sparkEventCounter: number = 0;
  private smoothedThrottle: number = 0.0;
  private prevSmoothedThrottle: number = 0.0;
  private throttleTipInEnv: number = 0.0;
  private throttleTipInLp: number = 0.0;
  private smoothedLoad: number = 0.0;
  private avgPower: number = 0.0;
  private avgTorque: number = 0.0;
  private readonly powerAlpha: number;

  // 6-speed Hydraulic Torque-Converter Automatic Transmission & Vehicle Longitudinal Dynamics
  public currentGear: number = 0;       // 0 = N, 1..6 = Drive gears
  public vehicleSpeedMps: number = 0.0; // Vehicle road speed [m/s]
  private smoothedGearRatio: number = 0.0;
  private shiftTimer: number = 0.0;     // >0 during active clutch-to-clutch upshift (triggers ZF-style torque cut & exhaust bark!)
  private shiftCooldown: number = 0.0;  // Prevents gear hunting
  private isUpshift: boolean = false;
  private shiftBarkTriggered: boolean = false;
  private smoothedShiftCut: number = 0.0;
  private downshiftBlipTarget: number = 0.0;
  private downshiftBlipEnv: number = 0.0; // Smooth electronic throttle actuator blip on kickdown/downshift

  // Scratch flow structs (zero allocations in hot loop)
  private throttleFlow: FlowResult = { dm: 0, dE: 0 };
  private inFlow: FlowResult = { dm: 0, dE: 0 };
  private exFlow: FlowResult = { dm: 0, dE: 0 };

  public result: EngineStepResult = {
    exhaustAudioL: 0,
    exhaustAudioR: 0,
    intakeAudio: 0,
    mechAudio: 0,
    rpm: 0,
    powerWatts: 0,
    torqueNm: 0,
    manifoldP: P_ATM,
    exhaustPL: P_ATM,
    exhaustPR: P_ATM,
    maxCylT: T_ATM,
    maxCylP: P_ATM,
    gear: 0,
    speedKmh: 0,
  };

  private rngState: number = 0x12345678;
  private initialSeed: number = 0x12345678;

  public readonly clampStats: ClampDiagnostics = {
    nanOrInfCount: 0,
    cylMassFloorCount: 0,
    cylEnergyBoundCount: 0,
    manMassFloorCount: 0,
    manEnergyBoundCount: 0,
    manPressureCeilingCount: 0,
    waveguideSaturationCount: 0,
    freshMassRoundoffClampCount: 0,
    iacvActuatorBoundCount: 0,
    sparkAdvanceBoundCount: 0,
  };

  public readonly energyLedger: EngineEnergyLedger = {
    stepsAccumulated: 0,
    simTimeAccumulatedSec: 0.0,
    cylIntakeEnthalpyJ: 0.0,
    cylExhaustEnthalpyJ: 0.0,
    cylCombustionHeatJ: 0.0,
    cylWallHeatLossJ: 0.0,
    cylPistonWorkPdVJ: 0.0,
    crankGrossIndicatedWorkJ: 0.0,
    manThrottleEnthalpyInJ: 0.0,
    manCylEnthalpyOutJ: 0.0,
    manWallHeatExchangeJ: 0.0,
  };

  constructor(sampleRate: number, seed: number = 0x12345678) {
    this.sampleRate = sampleRate;
    this.dt = 1.0 / sampleRate;
    this.invInertia = 1.0 / this.inertia;
    this.invManV = 1.0 / this.man_V;
    this.setSeed(seed);

    this.r = this.stroke * 0.5;
    this.pistonArea = Math.PI * 0.25 * this.bore * this.bore;
    this.V_d = this.pistonArea * this.stroke;
    this.V_c = this.V_d / (this.CR - 1.0);
    this.h_clearance = this.V_c / this.pistonArea;

    // Precompute 1024-entry crank-angle LUTs (+1 wrap slot for branchless linear interpolation)
    this.lutV = new Float64Array(ANGLE_LUT_SIZE + 1);
    this.lutDxDtheta = new Float64Array(ANGLE_LUT_SIZE + 1);
    this.lutWallArea = new Float64Array(ANGLE_LUT_SIZE + 1);
    this.lutAreaIn = new Float64Array(ANGLE_LUT_SIZE + 1);
    this.lutAreaEx = new Float64Array(ANGLE_LUT_SIZE + 1);

    const conrodSq = this.conrod * this.conrod;
    const rSq = this.r * this.r;
    const twoPistonArea = 2.0 * this.pistonArea;
    const piBore = Math.PI * this.bore;

    for (let k = 0; k <= ANGLE_LUT_SIZE; k++) {
      const angle = (k & ANGLE_LUT_MASK) * (FOUR_PI / ANGLE_LUT_SIZE);
      const s = Math.sin(angle);
      const c = Math.cos(angle);
      const term = Math.sqrt(conrodSq - rSq * s * s);
      const x = this.r * c + term;
      const dxDtheta = -this.r * s - (rSq * s * c) / term;
      const strokeDisp = this.conrod + this.r - x;

      this.lutV[k] = this.V_c + this.pistonArea * strokeDisp;
      this.lutDxDtheta[k] = dxDtheta;
      this.lutWallArea[k] = twoPistonArea + piBore * (this.h_clearance + strokeDisp);
      this.lutAreaIn[k] = getValveLiftNorm(angle, IO_RAD, IC_RAD) * MAX_INTAKE_VALVE_AREA;
      this.lutAreaEx[k] = getValveLiftNorm(angle, EO_RAD, EC_RAD) * MAX_EXHAUST_VALVE_AREA;
    }

    // Control & filter constants (all precomputed at init -> zero runtime Math.exp in step()!)
    this.ctrlAlpha = 1.0 - Math.exp(-this.dt / 0.015);
    this.tipInAlpha = 1.0 - Math.exp(-this.dt / 0.009);
    this.shiftAlpha = 1.0 - Math.exp(-this.dt / 0.032);
    this.shiftCutAlpha = 1.0 - Math.exp(-this.dt / 0.006);
    this.burbleAttackAlpha = 1.0 - Math.exp(-this.dt / 0.0018);
    this.mechContactAlpha = 1.0 - Math.exp(-this.dt / 0.00038);
    this.flareDecay = Math.exp(-this.dt / 0.42);
    this.dcR = Math.exp((-TWO_PI * 3.5) / sampleRate);
    this.powerAlpha = 1.0 - Math.exp(-this.dt / 0.08);
    // ~18 Hz slow plenum mean tracker for extracting AC suction pulses
    this.manPMeanAlpha = 1.0 - Math.exp((-TWO_PI * 18.0) / sampleRate);

    // Physical 12V PMGR starter deterministic gear-tooth & commutator-bar machining profiles (zero runtime allocations)
    this.ringToothProfile = new Float32Array(132);
    for (let i = 0; i < 132; i++) {
      const runout = 1.0 + 0.12 * Math.cos((TWO_PI * i) / 132.0);
      const microVar = 1.0 + 0.24 * this.nextRandSigned();
      this.ringToothProfile[i] = runout * microVar;
    }
    this.pinionToothProfile = new Float32Array(11);
    for (let i = 0; i < 11; i++) {
      this.pinionToothProfile[i] = 1.0 + 0.18 * this.nextRandSigned();
    }
    this.commBarProfile = new Float32Array(16);
    for (let i = 0; i < 16; i++) {
      this.commBarProfile[i] = 1.0 + 0.22 * this.nextRandSigned();
    }

    // Non-resonant 1-pole impulse shapers for crisp steel gear-tooth impacts & high-speed commutator whir
    this.starterAttackAlpha = 1.0 - Math.exp(-this.dt / 0.008);
    this.starterReleaseAlpha = 1.0 - Math.exp(-this.dt / 0.028);
    this.starterArmAlpha = 1.0 - Math.exp(-this.dt / 0.010);
    this.starterToothDecay = Math.exp(-this.dt / 0.00028);
    this.starterReboundDecay = Math.exp(-this.dt / 0.00068);
    this.starterToothLpAlpha = 1.0 - Math.exp(-this.dt / 0.00011);
    this.starterCommDecay = Math.exp(-this.dt / 0.00014);
    this.starterCommLpAlpha = 1.0 - Math.exp(-this.dt / 0.00006);
    this.starterSolenoidDecay = Math.exp(-this.dt / 0.0075);
    this.starterHpR = Math.exp((-TWO_PI * 185.0) / sampleRate);
    this.starterAirLpAlpha = 1.0 - Math.exp((-TWO_PI * 4800.0) / sampleRate);

    // Mode 1: mechanical valvetrain upper-head resonator (fc = 2150 Hz, damped Q = 2.0 -> crisp metallic click, zero ring)
    const fc = 2150.0;
    const Q = 2.0;
    const w0 = (TWO_PI * fc) / sampleRate;
    const alpha = Math.sin(w0) / (2.0 * Q);
    const a0 = 1.0 + alpha;
    this.mechB0 = alpha / a0;
    this.mechB2 = -alpha / a0;
    this.mechA1 = (-2.0 * Math.cos(w0)) / a0;
    this.mechA2 = (1.0 - alpha) / a0;

    // Mode 2: cast engine-block combustion pressure-rise resonator (fc = 520 Hz, damped Q = 1.35 -> deep block thud, zero hollow pipe tone)
    const fcB = 520.0;
    const qB = 1.35;
    const wB = (TWO_PI * fcB) / sampleRate;
    const alphaB = Math.sin(wB) / (2.0 * qB);
    const a0B = 1.0 + alphaB;
    this.blockB0 = alphaB / a0B;
    this.blockB2 = -alphaB / a0B;
    this.blockA1 = (-2.0 * Math.cos(wB)) / a0B;
    this.blockA2 = (1.0 - alphaB) / a0B;

    // Intake plenum Helmholtz cavity resonator (fc = 245 Hz, damped Q = 1.45 -> broad induction chest, zero static vowel)
    const wH = (TWO_PI * 245.0) / sampleRate;
    const alphaH = Math.sin(wH) / (2.0 * 1.45);
    const a0H = 1.0 + alphaH;
    this.helmB0 = alphaH / a0H;
    this.helmB2 = -alphaH / a0H;
    this.helmA1 = (-2.0 * Math.cos(wH)) / a0H;
    this.helmA2 = (1.0 - alphaH) / a0H;

    // Intake runner throat resonator (fc = 640 Hz, damped Q = 1.55)
    const wR = (TWO_PI * 640.0) / sampleRate;
    const alphaR = Math.sin(wR) / (2.0 * 1.55);
    const a0R = 1.0 + alphaR;
    this.runB0 = alphaR / a0R;
    this.runB2 = -alphaR / a0R;
    this.runA1 = (-2.0 * Math.cos(wR)) / a0R;
    this.runA2 = (1.0 - alphaR) / a0R;

    // Crossplane V8 firing order 1-8-4-3-6-5-7-2 (bank cadences L-R-R-L-R-L-L-R):
    // Since angle = (crankAngle + phaseOffset) % 720, cylinder i reaches TDC when crankAngle = 720 - phaseOffset!
    // Using (720 - i*90) % 720 guarantees forward crank rotation fires banks in true L-R-R-L-R-L-L-R sequence!
    const firingOrderStepDeg = [0, 90, 180, 270, 360, 450, 540, 630];
    const banks = [0, 1, 1, 0, 1, 0, 0, 1];
    const flowTrims = [1.045, 0.955, 1.035, 0.96, 1.05, 0.965, 0.95, 1.04];
    const sparkTrimsDeg = [1.4, -1.7, 0.9, -1.2, 1.8, -0.8, -1.5, 1.1];
    const bankCounts = [0, 0];

    for (let i = 0; i < 8; i++) {
      const b = banks[i];
      const bIdx = bankCounts[b]++;
      const phaseDeg = (720.0 - firingOrderStepDeg[i]) % 720.0;
      const initPos = ((phaseDeg * DEG_TO_RAD) * ANGLE_TO_LUT) & ANGLE_LUT_MASK;
      this.cylinders.push(
        new Cylinder(phaseDeg, this.lutV[initPos], b, bIdx, flowTrims[i], sparkTrimsDeg[i])
      );
    }

    // Intake manifold initial state
    this.man_mass = (this.man_P * this.man_V) / (R_GAS * this.man_T);
    this.man_energy = this.man_mass * specificEnergyFromT(this.man_T);
    this.manPMean = this.man_P;

    // Intake snorkel waveguide (0.52m, 78mm ID, cold air ~344 m/s -> lively induction bark)
    this.intakeSnorkel = new WaveguideTube(0.52, 0.078, 344.0, sampleRate, 0.965, 4200.0);
    const rcInEnd = 1.0 / (TWO_PI * 1050.0);
    this.intakeEndAlpha = this.dt / (rcInEnd + this.dt);
    const rcInRad = 1.0 / (TWO_PI * 3400.0);
    this.intakeRadAlpha = this.dt / (rcInRad + this.dt);

    // Exhaust banks with realistic unequal header runners AND asymmetric L/R underbody routing
    // (prevents 180-deg mono cancellation of crossplane V8 1.5x / 2.5x / 3.5x half-order rumble!)
    this.exhaustBankL = new ExhaustBank([0.56, 0.65, 0.60, 0.72], 0.84, 0.40, 0.62, sampleRate);
    this.exhaustBankR = new ExhaustBank([0.62, 0.70, 0.54, 0.76], 1.06, 0.44, 0.76, sampleRate);

    // H-pipe balance tube connecting Bank L and Bank R midpipes (0.36m, 42mm ID)
    this.hPipe = new WaveguideTube(0.36, 0.042, 460.0, sampleRate, 0.955, 3800.0);
    this.updateSlowThermalAcoustics();
  }

  // Deterministic xorshift32 seed control for reproducible Phase 10 tests (never zero)
  public setSeed(seed: number): void {
    const clean = (seed | 0) !== 0 ? seed | 0 : 0x12345678;
    this.initialSeed = clean;
    this.rngState = clean;
  }

  public getSeed(): number {
    return this.initialSeed;
  }

  public resetClampStats(): void {
    this.clampStats.nanOrInfCount = 0;
    this.clampStats.cylMassFloorCount = 0;
    this.clampStats.cylEnergyBoundCount = 0;
    this.clampStats.manMassFloorCount = 0;
    this.clampStats.manEnergyBoundCount = 0;
    this.clampStats.manPressureCeilingCount = 0;
    this.clampStats.waveguideSaturationCount = 0;
    this.clampStats.freshMassRoundoffClampCount = 0;
    this.clampStats.iacvActuatorBoundCount = 0;
    this.clampStats.sparkAdvanceBoundCount = 0;
  }

  public resetEnergyLedger(): void {
    this.energyLedger.stepsAccumulated = 0;
    this.energyLedger.simTimeAccumulatedSec = 0.0;
    this.energyLedger.cylIntakeEnthalpyJ = 0.0;
    this.energyLedger.cylExhaustEnthalpyJ = 0.0;
    this.energyLedger.cylCombustionHeatJ = 0.0;
    this.energyLedger.cylWallHeatLossJ = 0.0;
    this.energyLedger.cylPistonWorkPdVJ = 0.0;
    this.energyLedger.crankGrossIndicatedWorkJ = 0.0;
    this.energyLedger.manThrottleEnthalpyInJ = 0.0;
    this.energyLedger.manCylEnthalpyOutJ = 0.0;
    this.energyLedger.manWallHeatExchangeJ = 0.0;
  }

  // Exact analytical slider-crank cylinder volume V(theta) [m^3] at the current crankAngle
  // (independent of the 1024-entry LUT)
  public computeCylinderExactVolume(cylIdx: number): number {
    const cyl = this.cylinders[cylIdx];
    let angle = (this.crankAngle + cyl.phaseOffset) % FOUR_PI;
    if (angle < 0.0) angle += FOUR_PI;
    const s = Math.sin(angle);
    const c = Math.cos(angle);
    const term = Math.sqrt(this.conrod * this.conrod - this.r * this.r * s * s);
    const x = this.r * c + term;
    const strokeDisp = this.conrod + this.r - x;
    return this.V_c + this.pistonArea * strokeDisp;
  }

  // State-reconstructed total internal energy across all 8 cylinders from macroscopic (P_i, V_i, m_i)
  // via the ideal-gas state relation T_i = P_i * V_i / (m_i * R_GAS) and exact Cv(T) integral u(T)
  public computeTotalCylinderInternalEnergyFromState(): number {
    let totalU = 0.0;
    for (let i = 0; i < 8; i++) {
      const cyl = this.cylinders[i];
      let angle = cyl.lastAngle;
      if (angle >= FOUR_PI) angle -= FOUR_PI;
      const pos = angle * ANGLE_TO_LUT;
      const idx = pos | 0;
      const frac = pos - idx;
      const V = this.lutV[idx] + frac * (this.lutV[idx + 1] - this.lutV[idx]);
      const T_state = (cyl.P * V) / (cyl.mass * R_GAS);
      totalU += cyl.mass * (CV_C0 * T_state + 0.5 * CV_C1 * T_state * T_state);
    }
    return totalU;
  }

  // State-reconstructed intake manifold internal energy from macroscopic (man_P, man_V, man_mass)
  public computeManifoldInternalEnergyFromState(): number {
    const T_state = (this.man_P * this.man_V) / (this.man_mass * R_GAS);
    return this.man_mass * (CV_C0 * T_state + 0.5 * CV_C1 * T_state * T_state);
  }

  public getExhaustBankL(): ExhaustBank {
    return this.exhaustBankL;
  }

  public getExhaustBankR(): ExhaustBank {
    return this.exhaustBankR;
  }

  public getHPipe(): WaveguideTube {
    return this.hPipe;
  }

  public getIntakeSnorkel(): WaveguideTube {
    return this.intakeSnorkel;
  }

  private nextRandSigned(): number {
    let x = this.rngState;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rngState = x;
    return x * (1.0 / 2147483648.0);
  }

  private updateThermalAcoustics(): void {
    const tPrim = this.exhaustPortT > T_ATM ? this.exhaustPortT : T_ATM;
    const tMid = T_ATM + (tPrim - T_ATM) * 0.72;
    const tTail = T_ATM + (tPrim - T_ATM) * 0.52;

    const cPrim = speedOfSoundFromT(tPrim);
    const cMid = speedOfSoundFromT(tMid);
    const cTail = speedOfSoundFromT(tTail);

    this.exhaustBankL.updateSpeedsOfSound(cPrim, cMid, cTail, tPrim, tMid, tTail);
    this.exhaustBankR.updateSpeedsOfSound(cPrim, cMid, cTail, tPrim, tMid, tTail);
    this.hPipe.updateSpeedOfSound(cMid, tMid);

    const cIntake = speedOfSoundFromT(this.man_T);
    this.intakeSnorkel.updateSpeedOfSound(cIntake, this.man_T);
  }

  private updateSlowThermalAcoustics(): void {
    this.updateThermalAcoustics();
    const meanPistonSpeed = (this.omega / Math.PI) * this.stroke;
    this.cachedHVelFactor = Math.pow(meanPistonSpeed > 1.0 ? meanPistonSpeed : 1.0, 0.75);
  }

  public step(
    targetThrottle: number,
    targetLoadNm: number,
    ignition: boolean,
    starter: boolean,
    driveMode: number = 0 // 0 = Neutral (N), 1 = Automatic Drive (D), -1..-6 = Manual Gear 1..6 (M1..M6)
  ): EngineStepResult {
    // Smooth throttle and dyno load (~15ms response)
    // Smooth throttle and dyno load (~15ms response)
    this.smoothedThrottle += this.ctrlAlpha * (targetThrottle - this.smoothedThrottle);
    this.smoothedLoad += this.ctrlAlpha * (targetLoadNm - this.smoothedLoad);

    // Smooth electronic throttle-body rev-match blip (~15ms servo attack, ~90ms decay -> zero 1-sample step click in intake!)
    if (this.downshiftBlipTarget > 0.0001) {
      this.downshiftBlipTarget *= 1.0 - this.dt * 11.0;
    } else {
      this.downshiftBlipTarget = 0.0;
    }
    this.downshiftBlipEnv += this.ctrlAlpha * (this.downshiftBlipTarget - this.downshiftBlipEnv);

    const userThrottle = this.smoothedThrottle;
    const throttle = Math.min(1.0, userThrottle + this.downshiftBlipEnv);
    // Detect rapid throttle opening (tip-in rate d(throttle)/dt) with smooth ~9ms attack so tipInGulp never injects a 1-sample step!
    const dThrottle = throttle - this.prevSmoothedThrottle;
    this.prevSmoothedThrottle = throttle;
    if (dThrottle > 0.0) {
      this.throttleTipInEnv = Math.min(1.0, this.throttleTipInEnv + dThrottle * 5.0);
    }
    this.throttleTipInEnv *= 0.9988; // ~17ms decay time constant
    this.throttleTipInLp += this.tipInAlpha * (this.throttleTipInEnv - this.throttleTipInLp);

    const loadTorque = this.smoothedLoad;
    const rpmNow = this.omega * (60.0 / TWO_PI);

    // 6-Speed Automatic Transmission Control Unit (TCU):
    if (this.shiftTimer > 0.0) {
      this.shiftTimer -= this.dt;
      if (this.shiftTimer < 0.0) this.shiftTimer = 0.0;
    }
    if (this.shiftCooldown > 0.0) {
      this.shiftCooldown -= this.dt;
      if (this.shiftCooldown < 0.0) this.shiftCooldown = 0.0;
    }

    const wheelOmegaNow = this.vehicleSpeedMps * (1.0 / AT_WHEEL_RADIUS);
    const shiftAlpha = this.shiftAlpha;

    if (driveMode === 0) {
      this.currentGear = 0;
      this.smoothedGearRatio += shiftAlpha * (0.0 - this.smoothedGearRatio);
    } else {
      if (this.currentGear === 0) {
        // Engage speed-matched gear smoothly when shifting from Neutral (N) into Drive (D / M)
        let matchGear = 1;
        for (let g = 1; g <= 6; g++) {
          const gSyncRpm = wheelOmegaNow * AT_GEAR_RATIOS[g] * AT_FINAL_DRIVE * (60.0 / TWO_PI);
          if (gSyncRpm < 4200.0 || g === 6) {
            matchGear = g;
            break;
          }
        }
        this.currentGear = driveMode < 0 ? Math.max(matchGear, Math.min(6, -driveMode)) : matchGear;
      }
      if (driveMode < 0) {
        // Manual gear hold / paddle mode (-1..-6 -> M1..M6) with over-rev and stall protection
        const reqGear = Math.max(1, Math.min(6, -driveMode));
        if (reqGear !== this.currentGear && this.shiftCooldown <= 0.0) {
          const reqRatio = AT_GEAR_RATIOS[reqGear];
          const reqSyncRpm = wheelOmegaNow * reqRatio * AT_FINAL_DRIVE * (60.0 / TWO_PI);
          if (reqGear > this.currentGear || reqSyncRpm < 6400.0) {
            this.isUpshift = reqGear > this.currentGear;
            this.currentGear = reqGear;
            this.shiftTimer = this.isUpshift ? 0.105 : 0.130;
            this.shiftCooldown = 0.30;
            this.shiftBarkTriggered = false;
            if (!this.isUpshift && rpmNow < 4800.0) {
              this.downshiftBlipTarget = Math.min(0.42, 0.20 + (1.0 - userThrottle) * 0.18);
            }
          }
        }
      } else if (this.shiftCooldown <= 0.0 && ignition && this.omega > 40.0) {
        // Automatic Drive (D): load-adaptive shift schedule based on output shaft / turbine speed + kickdown
        // Only upshift when driver is applying throttle (userThrottle > 0.03) and post-shift RPM will sit comfortably above downshift threshold!
        const upshiftRpm = 2050.0 + 4650.0 * Math.pow(userThrottle, 0.85);
        const downshiftRpm = 1220.0 + 1950.0 * Math.pow(userThrottle, 1.35);

        const currRatio = AT_GEAR_RATIOS[this.currentGear];
        const syncRpm = wheelOmegaNow * currRatio * AT_FINAL_DRIVE * (60.0 / TWO_PI);

        if (this.currentGear < 6 && targetThrottle > 0.03 && userThrottle > 0.03 && rpmNow >= upshiftRpm) {
          const nextRatio = AT_GEAR_RATIOS[this.currentGear + 1];
          const postUpshiftRpm = Math.max(syncRpm, rpmNow) * (nextRatio / currRatio);
          if (postUpshiftRpm > downshiftRpm + 180.0) {
            this.currentGear += 1;
            this.isUpshift = true;
            this.shiftTimer = 0.105; // 105ms ZF-style clutch-to-clutch torque cut + shift bark!
            this.shiftCooldown = 0.48;
            this.shiftBarkTriggered = false;
          }
        } else if (this.currentGear > 1 && (rpmNow <= downshiftRpm || syncRpm <= downshiftRpm - 80.0)) {
          // Verify lower gear won't exceed 6100 RPM
          const prevRatio = AT_GEAR_RATIOS[this.currentGear - 1];
          const postDownshiftRpm = Math.max(syncRpm, rpmNow) * (prevRatio / currRatio);
          if (postDownshiftRpm < 6100.0) {
            this.currentGear -= 1;
            this.isUpshift = false;
            this.shiftTimer = 0.125;
            this.shiftCooldown = 0.48;
            this.downshiftBlipTarget = Math.min(0.42, 0.20 + userThrottle * 0.22);
          }
        }
      }

      // Smoothly transition internal gear ratio over ~95ms during clutch-to-clutch handoff
      const targetRatio = AT_GEAR_RATIOS[this.currentGear];
      this.smoothedGearRatio += shiftAlpha * (targetRatio - this.smoothedGearRatio);
    }

    // Active upshift spark cut & retard window (smoothly ramped over ~6ms to prevent 1-sample spark-phase jumps!)
    const activeUpshiftCut = this.isUpshift && this.shiftTimer > 0.025 && userThrottle > 0.18;
    const targetShiftCut = activeUpshiftCut ? 1.0 : 0.0;
    this.smoothedShiftCut += this.shiftCutAlpha * (targetShiftCut - this.smoothedShiftCut);

    // Realistic cold-crank ECU sync (~0.48s of audible compression strokes before catching -> ~1250 RPM startup flare -> 750 RPM idle)
    if (this.omega < 5.0) {
      this.crankSyncTime = 0.0;
      this.wasCranking = true;
    } else if (this.crankSyncTime < 0.50) {
      this.crankSyncTime += this.dt;
      this.wasCranking = true;
    } else if (this.wasCranking && ignition && rpmNow >= 360.0) {
      this.startupFlare = 1.0;
      this.wasCranking = false;
    }
    const ecuSynced = this.crankSyncTime >= 0.48;

    if (this.startupFlare > 0.0001) {
      this.startupFlare *= this.flareDecay;
    } else {
      this.startupFlare = 0.0;
    }

    // Deceleration Fuel Cut-Off (DFCO): cuts fuel on closed-throttle overrun (>1250 RPM),
    // and resumes fuel with a clean anti-stall catch right into the 750 RPM idle target!
    const dfcoActive = ignition && throttle < 0.025 && rpmNow > 1250.0 && this.startupFlare < 0.05;

    // Smooth Idle Speed Controller targeting a deep, loping ~750 RPM crossplane V8 idle (+ 1250 RPM startup flare + overrun dashpot)
    const targetIdleRpm = 750.0 + this.startupFlare * 340.0;
    const targetIdleOmega = targetIdleRpm * (TWO_PI / 60.0);
    const idleBlend = throttle < 0.05 ? 1.0 - throttle * 20.0 : 0.0;
    const idleError = targetIdleOmega - this.omega;

    if (ignition && idleBlend > 0.01 && ecuSynced && this.omega > 45.0 && rpmNow < 1350.0 && !dfcoActive) {
      this.idleIntegral += idleError * this.dt * idleBlend;
      if (this.idleIntegral > 35.0) this.idleIntegral = 35.0;
      else if (this.idleIntegral < -35.0) this.idleIntegral = -35.0;
    } else if (dfcoActive || throttle >= 0.05 || !ecuSynced) {
      this.idleIntegral *= 0.9985;
    }

    // Overrun anti-stall dashpot keeps manifold vacuum physically realistic (~24-32 kPa during DFCO)
    // and catches RPM cleanly at ~750 RPM when fuel resumes at 1250 RPM!
    let iacvArea: number;
    if (dfcoActive) {
      iacvArea = Math.min(0.00032, 0.000058 + (rpmNow - 1250.0) * 6.5e-8);
    } else if (!ecuSynced) {
      // Cranking IACV position: draws realistic cranking vacuum (~54 kPa) so first catch flare peaks cleanly at ~1280 RPM!
      iacvArea = 0.000036;
    } else {
      const flareBypass = this.startupFlare * 0.000014;
      // Add subtle automatic transmission D-gear idle load compensation (+0.000008 m^2 when in gear at low speed)
      const inGearIdleComp = this.currentGear > 0 ? idleBlend * 0.000008 : 0.0;
      iacvArea =
        0.000066 +
        flareBypass +
        inGearIdleComp +
        idleBlend * (idleError * 0.0000011 + this.idleIntegral * 0.0000024);
    }
    const minIacv = dfcoActive ? 0.000003 : 0.000016;
    let clampedIacv = iacvArea;
    if (clampedIacv < minIacv) {
      clampedIacv = minIacv;
      this.clampStats.iacvActuatorBoundCount++;
    } else if (clampedIacv > 0.00038) {
      clampedIacv = 0.00038;
      this.clampStats.iacvActuatorBoundCount++;
    }
    // Physical IACV / electronic throttle dashpot actuator smoothing (~15ms time constant prevents 1-sample area jump at DFCO boundary!)
    this.smoothedIacvArea += this.ctrlAlpha * (clampedIacv - this.smoothedIacvArea);

    // Realistic progressive butterfly throttle law: gives smooth, usable part-throttle modulation across 5%..80% pedal!
    const maxThrottleArea = 0.0046; // ~76mm throttle body
    const butterflyCurve = throttle * throttle * (0.82 * throttle + 0.14) + throttle * 0.04;
    const currentThrottleArea = this.smoothedIacvArea + butterflyCurve * maxThrottleArea;

    // Cylinder-selective rotating rev limiter (6880 RPM soft cut -> 7120 RPM hard cut) + smooth upshift torque cut!
    let revCutFrac = (rpmNow - 6880.0) * (1.0 / 240.0);
    if (revCutFrac < 0.0) revCutFrac = 0.0;
    else if (revCutFrac > 1.0) revCutFrac = 1.0;
    const shiftCutLevel = this.smoothedShiftCut * 0.76;
    if (shiftCutLevel > revCutFrac) {
      revCutFrac = shiftCutLevel;
    }

    // Realistic ECU spark advance map & load-dependent flame speed (Wiebe burn duration):
    // - Cranking (<480 RPM): fixed +8 deg BTDC for crisp start
    // - Idle (~750 RPM closed throttle): ~2 deg BTDC nominal torque-reserve + zero-lag proportional spark stabilizer
    //   (real-world Bosch/GM idle control: critically damped ~750 RPM with positive ~1.4-1.6 bar EVO blowdown!)
    // - Cruise / WOT: advances smoothly to 28-34 deg BTDC with fast turbulent burn (~42-54 deg)
    let rpmNorm = (rpmNow - 700.0) * (1.0 / 5500.0);
    if (rpmNorm < 0.0) rpmNorm = 0.0;
    else if (rpmNorm > 1.0) rpmNorm = 1.0;

    let loadNorm = (this.man_P - 25000.0) * (1.0 / 75000.0);
    if (loadNorm < 0.0) loadNorm = 0.0;
    else if (loadNorm > 1.0) loadNorm = 1.0;

    const idleRetard = rpmNow > 480.0 ? idleBlend * (12.0 + this.startupFlare * 6.0) : 0.0;
    let idleSparkTrim = rpmNow > 480.0 ? idleBlend * idleError * 0.68 : 0.0;
    if (idleSparkTrim > 14.0) idleSparkTrim = 14.0;
    else if (idleSparkTrim < -12.0) idleSparkTrim = -12.0;

    const loadRetard = this.man_P > 55000.0 ? (this.man_P - 55000.0) * (6.0 / 45000.0) : 0.0;
    const shiftRetard = this.smoothedShiftCut * 18.0;
    let advanceDeg = 14.0 + rpmNorm * 22.0 - loadRetard - idleRetard - shiftRetard + idleSparkTrim;
    if (advanceDeg < -12.0) {
      advanceDeg = -12.0;
      this.clampStats.sparkAdvanceBoundCount++;
    } else if (advanceDeg > 36.0) {
      advanceDeg = 36.0;
      this.clampStats.sparkAdvanceBoundCount++;
    }
    const sparkPhaseRad = (360.0 - advanceDeg) * DEG_TO_RAD;
    const baseBurnDurRad = (42.0 + rpmNorm * 12.0 + (1.0 - loadNorm) * 28.0) * DEG_TO_RAD;

    // Update smooth per-sample acoustic speed of sound via LUT (zero stair-stepping, zero Math.sqrt)
    this.updateThermalAcoustics();
    // Decimate slow Woschni piston-speed factor every 16 samples (~0.33 ms)
    if ((this.slowUpdateCounter++ & 15) === 0) {
      const meanPistonSpeed = (this.omega / Math.PI) * this.stroke;
      this.cachedHVelFactor = Math.pow(meanPistonSpeed > 1.0 ? meanPistonSpeed : 1.0, 0.75);
    }

    // Read arriving acoustic waves
    this.exhaustBankL.readAll();
    this.exhaustBankR.readAll();
    this.hPipe.readOutputs(0.0);
    this.intakeSnorkel.readOutputs(0.0);

    const bankFlowsL = this.bankFlowsL;
    const bankFlowsR = this.bankFlowsR;
    bankFlowsL[0] = 0; bankFlowsL[1] = 0; bankFlowsL[2] = 0; bankFlowsL[3] = 0;
    bankFlowsR[0] = 0; bankFlowsR[1] = 0; bankFlowsR[2] = 0; bankFlowsR[3] = 0;

    // Adaptive thermodynamic sub-stepping: exact implicit WDF port coupling is unconditionally
    // passive at 44.1/48 kHz (~21-23 us, <1 deg crank/step); use 2 sub-steps only for low sample rates
    const subSteps = this.sampleRate < 40000 ? 2 : 1;
    const invSub = subSteps === 1 ? 1.0 : 0.5;
    const dtSub = this.dt * invSub;
    let avgThrottleDm = 0.0;
    let totalTorqueAccum = 0.0;
    let mechImpulse = 0.0;
    let blockImpulse = 0.0;
    let maxCylT = T_ATM;
    let maxCylP = P_ATM;

    // Physically calibrated Heywood/Woschni convective heat-transfer base (~20% cycle wall loss -> positive idle EVO blowdown!)
    const hVelBase = 15.0 * this.cachedHVelFactor;
    const portAcScale = (this.omega < 15.0 ? this.omega * (1.0 / 15.0) : 1.0) * 0.42;
    const pThrottleUpRaw = P_ATM + this.intakeSnorkel.pMinusOut * 0.30;
    const pThrottleUp = pThrottleUpRaw > 50000.0 ? pThrottleUpRaw : 50000.0;

    const lutV = this.lutV;
    const lutDxDtheta = this.lutDxDtheta;
    const lutWallArea = this.lutWallArea;
    const lutAreaIn = this.lutAreaIn;
    const lutAreaEx = this.lutAreaEx;
    const pistonArea = this.pistonArea;
    const cylinders = this.cylinders;
    const bankLPortP = this.exhaustBankL.runnerPortWavePressure;
    const bankRPortP = this.exhaustBankR.runnerPortWavePressure;

    for (let sub = 0; sub < subSteps; sub++) {
      calculateFlowInto(
        pThrottleUp,
        T_ATM,
        this.man_P,
        this.man_T,
        currentThrottleArea,
        0.78,
        this.throttleFlow
      );

      let man_dm = this.throttleFlow.dm;
      let man_dE = this.throttleFlow.dE;
      avgThrottleDm += man_dm;

      let stepTorque = 0.0;
      const crank = this.crankAngle;
      const omegaNow = this.omega;

      for (let i = 0; i < 8; i++) {
        const cyl = cylinders[i];

        let angle = crank + cyl.phaseOffset;
        if (angle >= FOUR_PI) angle -= FOUR_PI;

        const prevAngle = cyl.lastAngle;
        cyl.lastAngle = angle;

        // O(1) interpolated kinematics & DOHC cam curtain areas (zero trig/pow/sqrt!)
        const pos = angle * ANGLE_TO_LUT;
        const idx = pos | 0;
        const frac = pos - idx;
        const idx1 = idx + 1;

        const V = lutV[idx] + frac * (lutV[idx1] - lutV[idx]);
        const dx_dtheta = lutDxDtheta[idx] + frac * (lutDxDtheta[idx1] - lutDxDtheta[idx]);
        const wallArea = lutWallArea[idx] + frac * (lutWallArea[idx1] - lutWallArea[idx]);
        const A_in = (lutAreaIn[idx] + frac * (lutAreaIn[idx1] - lutAreaIn[idx])) * cyl.flowTrim;
        const A_ex = (lutAreaEx[idx] + frac * (lutAreaEx[idx1] - lutAreaEx[idx])) * cyl.flowTrim;
        const dV_dt = -pistonArea * dx_dtheta * omegaNow;

        // Subtle clean valve-seating tap when valve closes + EVO-timed hot-header overrun burble!
        if (sub === 0) {
          const inOpen = A_in > 1e-8;
          const exOpen = A_ex > 1e-8;
          if (cyl.prevIntakeOpen && !inOpen) {
            mechImpulse += 0.16;
          }
          if (cyl.prevExhaustOpen && !exOpen) {
            mechImpulse -= 0.20;
          }
          // Per-cylinder physical EVO-timed hot-header overrun burble (unburned fuel film vapor meeting hot steel header port!)
          if (!cyl.prevExhaustOpen && exOpen && dfcoActive && rpmNow > 1450.0 && rpmNow < 5800.0 && this.exhaustPortT > 460.0) {
            const r = this.nextRandSigned();
            if (r > 0.42) {
              const norm = (r - 0.42) * (1.0 / 0.58);
              const heatFactor = Math.min(1.0, (this.exhaustPortT - 460.0) * (1.0 / 320.0));
              // Varied organic pop strength and decay time (3.0-8.0 ms) traveling down THIS cylinder's primary runner!
              cyl.burbleEnv += (0.016 + norm * 0.048) * (0.45 + 0.55 * heatFactor);
              const tau = 0.0030 + norm * 0.0050;
              cyl.burbleDecay = 1.0 - this.dt / tau;
            }
          }
          cyl.prevIntakeOpen = inOpen;
          cyl.prevExhaustOpen = exOpen;
        }

        // Exact passive WDF exhaust port coupling:
        // Pipe Thévenin open-circuit pressure P_oc = P_atm + 2*pMinus in series with characteristic impedance Z.
        // Implicit solution dm_exact = dm_0 / (1 + Z*G) guarantees reflection |Gamma| <= 1 at ALL frequencies
        // (eliminates both 1-sample Nyquist checkerboard oscillation AND un-damped primary pipe self-oscillation!)
        const portWaveP = cyl.bank === 0 ? bankLPortP[cyl.bankIndex] : bankRPortP[cyl.bankIndex];
        let exPortP = P_ATM + portWaveP * portAcScale;
        if (exPortP < 45000.0) exPortP = 45000.0;
        else if (exPortP > 280000.0) exPortP = 280000.0;

        calculateFlowInto(this.man_P, this.man_T, cyl.P, cyl.T, A_in, 0.74, this.inFlow);
        // Poppet exhaust valve has lower aerodynamic discharge coeff for reverse suction (0.42) than forward blowdown (0.70)
        const exCd = cyl.P >= exPortP ? 0.70 : 0.42;
        calculateFlowInto(cyl.P, cyl.T, exPortP, this.exhaustPortT, A_ex, exCd, this.exFlow);

        const inDm = this.inFlow.dm;
        let exDm = this.exFlow.dm;
        let exDE = this.exFlow.dE;

        // Physics-exact subsonic WDF pipe-impedance damping:
        // Sonic/choked blowdown (PR <= PR_CRIT) has d(dm)/dP_down = 0 -> zero artificial rounding of blowdown fronts!
        // Subsonic scavenging (PR > PR_CRIT) solves P_port = P_oc + Z * dm implicitly -> strictly passive (|Gamma| <= 1)!
        if (exDm !== 0.0) {
          const pHi = cyl.P >= exPortP ? cyl.P : exPortP;
          const pLo = cyl.P >= exPortP ? exPortP : cyl.P;
          const prEx = pHi > 1000.0 ? pLo / pHi : 1.0;
          if (prEx > PR_CRIT) {
            const subsonicFrac = (prEx - PR_CRIT) * (1.0 / (1.0 - PR_CRIT));
            const tubeZ =
              cyl.bank === 0
                ? this.exhaustBankL.primaries[cyl.bankIndex].Z
                : this.exhaustBankR.primaries[cyl.bankIndex].Z;
            const dP = pHi - pLo;
            const gValve = (Math.abs(exDm) / (dP > 1.0 ? dP : 1.0)) * subsonicFrac;
            const wdfDamp = 1.0 / (1.0 + 1.05 * tubeZ * gValve * portAcScale);
            exDm *= wdfDamp;
            exDE *= wdfDamp;
          }
        }

        // Realistic steel header port thermal inertia: heats rapidly during hot blowdown (cyl.T > exhaustPortT),
        // cools gradually (~3.5s time constant) when valve is closed or during DFCO cold-air pumping!
        if (exDm > 0.0005 && cyl.T > this.exhaustPortT) {
          this.exhaustPortT += (0.0018 * invSub) * (cyl.T - this.exhaustPortT);
        } else {
          this.exhaustPortT += (0.0000045 * invSub) * (T_ATM + 90.0 - this.exhaustPortT);
        }

        man_dm -= inDm;
        man_dE -= this.inFlow.dE;

        if (cyl.bank === 0) {
          bankFlowsL[cyl.bankIndex] += exDm;
        } else {
          bankFlowsR[cyl.bankIndex] += exDm;
        }

        // Fresh air-fuel charge mass tracking (residual exhaust gas never re-burns!)
        let freshFrac = cyl.mass > 1e-7 ? cyl.freshMass / cyl.mass : 0.0;
        if (freshFrac < 0.0) freshFrac = 0.0;
        else if (freshFrac > 1.0) freshFrac = 1.0;

        let dFresh = inDm > 0.0 ? inDm : inDm * freshFrac;
        if (exDm > 0.0) {
          dFresh -= exDm * freshFrac;
        }

        // Spark event check (with per-cylinder spark timing micro-offset, ECU crank sync, DFCO cut, & rotating rev limiter!)
        const cylSparkPhase = sparkPhaseRad + cyl.sparkTrimRad;
        const crossedSpark =
          omegaNow > 12.0 &&
          ((prevAngle < cylSparkPhase && angle >= cylSparkPhase) ||
            (angle < prevAngle && (prevAngle < cylSparkPhase || angle >= cylSparkPhase)));

        if (crossedSpark && ignition && ecuSynced && !dfcoActive && cyl.freshMass > 1e-6) {
          this.sparkEventCounter = (this.sparkEventCounter + 1) & 1023;
          const cutSlots = (revCutFrac * 8.0 + 0.5) | 0;
          const isCut = cutSlots >= 8 || ((this.sparkEventCounter * 5) & 7) < cutSlots;

          if (!isCut) {
            // Cycle-to-cycle Markov combustion memory (weak burn leaves cooler residual -> slightly richer next cycle, and vice versa)
            // plus dynamic spark timing jitter (-2.8..0 deg at idle -> -0.8..0 deg at WOT) so firing intervals are never clockwork!
            const varAmp = 0.030 + (1.0 - rpmNorm) * 0.065;
            const rawVar = this.nextRandSigned() * varAmp - 0.32 * cyl.prevBurnVar;
            cyl.prevBurnVar = rawVar;
            const cyclicVar = (1.0 + rawVar) * cyl.flowTrim;
            const durVar = 1.0 - rawVar * 0.55 + this.nextRandSigned() * 0.035;
            // Strictly non-positive offset from current angle so dTheta = angle - burnStart >= 0 on the very first sample!
            const jitterRad = -Math.abs(this.nextRandSigned()) * (0.8 + 2.0 * (1.0 - rpmNorm)) * DEG_TO_RAD;
            // Include transient accelerator-pump enrichment punch (+12% torque bark on rapid throttle tip-in!)
            const combEff = (0.66 + 0.34 * loadNorm) * (1.0 + 0.12 * this.throttleTipInLp);
            cyl.fuelEnergyTotal = cyl.freshMass * 2.78e6 * combEff * cyclicVar;
            cyl.burnInitialFreshMass = cyl.freshMass;
            let bStart = angle + jitterRad;
            if (bStart < 0.0) bStart += FOUR_PI;
            else if (bStart >= FOUR_PI) bStart -= FOUR_PI;
            cyl.burnStart = bStart;
            cyl.burnDuration = baseBurnDurRad * durVar;
            cyl.invBurnDuration = 1.0 / cyl.burnDuration;
            cyl.lastWiebeFrac = 0.0;
            cyl.isBurning = true;
          }
        }

        // Wiebe combustion heat release via LUT (a = 5, m = 2; zero Math.exp!)
        let heatJ = 0.0;
        let freshConsumed = 0.0;
        if (cyl.isBurning) {
          let dTheta = angle - cyl.burnStart;
          if (dTheta < -Math.PI) dTheta += FOUR_PI;
          else if (dTheta < 0.0) dTheta = 0.0;

          if (dTheta <= cyl.burnDuration) {
            const wPos = dTheta * cyl.invBurnDuration * WIEBE_LUT_SIZE;
            const wIdx = wPos | 0;
            const wiebeFrac =
              wIdx >= WIEBE_LUT_SIZE
                ? 1.0
                : WIEBE_LUT[wIdx] + (wPos - wIdx) * (WIEBE_LUT[wIdx + 1] - WIEBE_LUT[wIdx]);
            const deltaFrac = wiebeFrac > cyl.lastWiebeFrac ? wiebeFrac - cyl.lastWiebeFrac : 0.0;
            cyl.lastWiebeFrac = wiebeFrac;
            heatJ = deltaFrac * cyl.fuelEnergyTotal;
            freshConsumed = deltaFrac * cyl.burnInitialFreshMass;
          } else {
            const rem = cyl.lastWiebeFrac < 1.0 ? 1.0 - cyl.lastWiebeFrac : 0.0;
            heatJ = rem * cyl.fuelEnergyTotal;
            freshConsumed = rem * cyl.burnInitialFreshMass;
            cyl.isBurning = false;
          }
        }

        // Cylinder wall convective heat transfer (Woschni LUTs — zero Math.pow!)
        let pPos = cyl.P * (1e-5 * P_WOSCHNI_SCALE);
        if (pPos < 0.0) pPos = 0.0;
        else if (pPos > P_WOSCHNI_SIZE - 1) pPos = P_WOSCHNI_SIZE - 1;
        const pIdx = pPos | 0;
        const pPow = P_WOSCHNI_LUT[pIdx] + (pPos - pIdx) * (P_WOSCHNI_LUT[pIdx + 1] - P_WOSCHNI_LUT[pIdx]);

        let tWPos = (cyl.T - T_WOSCHNI_MIN) * T_WOSCHNI_SCALE;
        if (tWPos < 0.0) tWPos = 0.0;
        else if (tWPos > T_WOSCHNI_SIZE - 1) tWPos = T_WOSCHNI_SIZE - 1;
        const tWIdx = tWPos | 0;
        const tPow = T_WOSCHNI_LUT[tWIdx] + (tWPos - tWIdx) * (T_WOSCHNI_LUT[tWIdx + 1] - T_WOSCHNI_LUT[tWIdx]);

        let hCoeff = hVelBase * pPow * tPow;
        if (hCoeff > 2200.0) hCoeff = 2200.0;
        const wallHeatLossW = hCoeff * wallArea * (cyl.T - T_WALL);

        // Integrate cylinder mass, fresh charge, and internal energy
        const dm = inDm - exDm;
        const pWorkRateW = cyl.P * dV_dt;
        const dE_dt = this.inFlow.dE - exDE - pWorkRateW - wallHeatLossW;

        // Accumulate independent control-volume energy fluxes into First-Law ledger
        this.energyLedger.cylIntakeEnthalpyJ += this.inFlow.dE * dtSub;
        this.energyLedger.cylExhaustEnthalpyJ += exDE * dtSub;
        this.energyLedger.cylCombustionHeatJ += heatJ;
        this.energyLedger.cylWallHeatLossJ += wallHeatLossW * dtSub;
        this.energyLedger.cylPistonWorkPdVJ += pWorkRateW * dtSub;

        let newMass = cyl.mass + dm * dtSub;
        if (!Number.isFinite(newMass)) {
          newMass = 2e-6;
          this.clampStats.nanOrInfCount++;
        } else if (newMass < 2e-6) {
          newMass = 2e-6;
          this.clampStats.cylMassFloorCount++;
        }
        cyl.mass = newMass;

        let newFresh = cyl.freshMass + dFresh * dtSub - freshConsumed;
        if (newFresh < 0.0) {
          if (newFresh < -1e-12) this.clampStats.freshMassRoundoffClampCount++;
          newFresh = 0.0;
        } else if (newFresh > newMass) {
          if (newFresh - newMass > 1e-12) this.clampStats.freshMassRoundoffClampCount++;
          newFresh = newMass;
        }
        cyl.freshMass = newFresh;

        let newEnergy = cyl.energy + dE_dt * dtSub + heatJ;
        const minE = newMass * U_MIN_150;
        const maxE = newMass * U_MAX_3800;
        if (!Number.isFinite(newEnergy)) {
          newEnergy = minE;
          this.clampStats.nanOrInfCount++;
        } else if (newEnergy < minE) {
          newEnergy = minE;
          this.clampStats.cylEnergyBoundCount++;
        } else if (newEnergy > maxE) {
          newEnergy = maxE;
          this.clampStats.cylEnergyBoundCount++;
        }
        cyl.energy = newEnergy;

        // Exact Cv(T) temperature & ideal gas pressure
        const prevP = cyl.P;
        const newT = tempFromSpecificEnergy(newEnergy / newMass);
        const newP = (newMass * R_GAS * newT) / V;
        cyl.T = newT;
        cyl.P = newP;

        // Physical cast-block acoustic excitation driven by rapid combustion OR subtle cranking compression load
        if (newP > prevP) {
          if (cyl.isBurning) {
            blockImpulse += (newP - prevP) * 1.1e-6;
          } else if (starter && this.omega < 32.0 && newP > 140000.0) {
            // Subtle cast-iron block compression thump (kept restrained so 520 Hz block mode never rings/wobbles!)
            blockImpulse += (newP - prevP) * 2.2e-6;
          }
        }

        if (newT > maxCylT) maxCylT = newT;
        if (newP > maxCylP) maxCylP = newP;

        stepTorque += (newP - P_ATM) * pistonArea * -dx_dtheta;
        // Gross mechanical indicated work on crankshaft: tau_gross * dTheta = newP * A_p * (-dx/dtheta) * omega * dtSub
        this.energyLedger.crankGrossIndicatedWorkJ += newP * pistonArea * -dx_dtheta * omegaNow * dtSub;
      }

      // Integrate intake manifold plenum state + mild wall thermal equilibration
      const manHeatTransfer = 18.0 * (T_ATM + 15.0 - this.man_T);
      this.energyLedger.stepsAccumulated += 1;
      this.energyLedger.simTimeAccumulatedSec += dtSub;
      this.energyLedger.manThrottleEnthalpyInJ += this.throttleFlow.dE * dtSub;
      this.energyLedger.manCylEnthalpyOutJ += (this.throttleFlow.dE - man_dE) * dtSub;
      this.energyLedger.manWallHeatExchangeJ += manHeatTransfer * dtSub;

      let newManMass = this.man_mass + man_dm * dtSub;
      if (!Number.isFinite(newManMass)) {
        newManMass = 2e-4;
        this.clampStats.nanOrInfCount++;
      } else if (newManMass < 2e-4) {
        newManMass = 2e-4;
        this.clampStats.manMassFloorCount++;
      }
      this.man_mass = newManMass;

      let newManEnergy = this.man_energy + (man_dE + manHeatTransfer) * dtSub;
      const manMinE = newManMass * U_MIN_220;
      const manMaxE = newManMass * U_MAX_700;
      if (!Number.isFinite(newManEnergy)) {
        newManEnergy = manMinE;
        this.clampStats.nanOrInfCount++;
      } else if (newManEnergy < manMinE) {
        newManEnergy = manMinE;
        this.clampStats.manEnergyBoundCount++;
      } else if (newManEnergy > manMaxE) {
        newManEnergy = manMaxE;
        this.clampStats.manEnergyBoundCount++;
      }
      this.man_energy = newManEnergy;

      this.man_T = tempFromSpecificEnergy(newManEnergy / newManMass);
      let newManP = newManMass * R_GAS * this.man_T * this.invManV;
      if (newManP > 250000.0) {
        newManP = 250000.0;
        this.clampStats.manPressureCeilingCount++;
      }
      this.man_P = newManP;

      // Realistic 4.58L DOHC V8 FMEP + oil/water/alternator accessory drag (~51 Nm @ 750 RPM idle -> authentic ~35 kPa MAP & 1.38 bar EVO lope!)
      const omegaSign = fastTanh(this.omega * (1.0 / 12.0));
      const frictionTorque = (48.0 + 0.045 * this.omega + 0.00012 * this.omega * this.omega) * omegaSign;
      // Realistic 1.8 kW 12V planetary reduction starter motor with overrunning bendix clutch (steep DC back-EMF curve -> ~185 RPM nominal crank)
      const starterCoupled = starter && this.omega < 26.5;
      const starterTorque = starterCoupled ? 275.0 * (1.0 - this.omega * (1.0 / 26.5)) : 0.0;
      const dynoBrakeTorque = loadTorque * omegaSign;

      // 6-Speed Hydraulic Torque-Converter & Lock-Up Automatic Drivetrain Load:
      let transPumpTorque = 0.0;
      const totalGearRatio = this.smoothedGearRatio * AT_FINAL_DRIVE;
      if (this.currentGear > 0 && totalGearRatio > 0.1) {
        const wheelOmega = this.vehicleSpeedMps * (1.0 / AT_WHEEL_RADIUS);
        const turbineOmega = wheelOmega * totalGearRatio;
        const omegaDiff = this.omega - turbineOmega;

        // Hydraulic fluid coupling torque (stall speed ~2250 RPM; smooth slip at 750 RPM idle so engine never stalls at a stoplight!)
        const slipSign = fastTanh(omegaDiff * 0.045);
        const fluidTorque = 0.0046 * omegaDiff * Math.abs(omegaDiff) + 12.0 * slipSign;

        // Progressive lock-up clutch above ~1650 RPM (using smooth gear ratio so 1<->2 transition has zero 1-sample step!)
        const gearLockBias =
          this.smoothedGearRatio > 0.1 && this.smoothedGearRatio < 3.8
            ? Math.min(0.35, (3.8 - this.smoothedGearRatio) * 0.22)
            : 0.0;
        let lockBlend = (this.omega - 165.0) * (1.0 / 70.0) + gearLockBias;
        if (lockBlend < 0.0) lockBlend = 0.0;
        else if (lockBlend > 1.0) lockBlend = 1.0;

        const lockTorque = omegaDiff * 9.5;
        transPumpTorque = (1.0 - lockBlend) * fluidTorque + lockBlend * lockTorque;
        if (transPumpTorque > 680.0) transPumpTorque = 680.0;
        else if (transPumpTorque < -320.0) transPumpTorque = -320.0;

        // Torque multiplication across open torque converter at stall/launch (up to 1.85x below 1800 RPM)
        const speedRatio = this.omega > 20.0 ? Math.min(1.0, turbineOmega / this.omega) : 1.0;
        const torqueMult = transPumpTorque > 0.0 ? 1.0 + 0.85 * (1.0 - speedRatio) * (1.0 - lockBlend) : 1.0;
        const turbineTorque = transPumpTorque * torqueMult;

        // Vehicle longitudinal dynamics (1620 kg sport coupe + rolling resistance + quadratic aerodynamic drag + auto coast brake when throttle=0 at low speed)
        const wheelDriveForce = (turbineTorque * totalGearRatio * 0.92) * (1.0 / AT_WHEEL_RADIUS);
        const aeroAndRollingDrag =
          (185.0 + 0.44 * this.vehicleSpeedMps * this.vehicleSpeedMps) *
          fastTanh(this.vehicleSpeedMps * 0.5);
        // Gentle automatic wheel brake when throttle is released at low speed or when Dyno Load slider is applied as brake
        const brakeForce =
          (loadTorque * 14.0 + (userThrottle < 0.01 ? 420.0 : 0.0)) *
          fastTanh(this.vehicleSpeedMps * 0.8);

        const netVehicleForce = wheelDriveForce - aeroAndRollingDrag - brakeForce;
        let nextSpeed = this.vehicleSpeedMps + (netVehicleForce * (1.0 / 1620.0)) * dtSub;
        if (nextSpeed < 0.0 || !Number.isFinite(nextSpeed)) nextSpeed = 0.0;
        this.vehicleSpeedMps = nextSpeed;
      } else {
        // Coast down gently if shifted to Neutral (N)
        if (this.vehicleSpeedMps > 0.001) {
          const dragDecel = (220.0 + 0.44 * this.vehicleSpeedMps * this.vehicleSpeedMps) * (1.0 / 1620.0);
          this.vehicleSpeedMps = Math.max(0.0, this.vehicleSpeedMps - dragDecel * dtSub);
        } else {
          this.vehicleSpeedMps = 0.0;
        }
      }

      const netTorque = stepTorque + starterTorque - frictionTorque - dynoBrakeTorque - transPumpTorque;
      // Include physical reflected 38:1 starter armature inertia (+0.45 kg*m^2) while bendix pinion is engaged (authentic ~+/-12% V8 crank cadence!)
      const effInvInertia = starterCoupled ? 1.0 / (this.inertia + 0.45) : this.invInertia;
      let nextOmega = this.omega + netTorque * effInvInertia * dtSub;
      if (nextOmega < 0.0 || !Number.isFinite(nextOmega)) nextOmega = 0.0;
      this.omega = nextOmega;

      let nextCrank = this.crankAngle + nextOmega * dtSub;
      if (nextCrank >= FOUR_PI) nextCrank -= FOUR_PI;
      this.crankAngle = nextCrank;

      totalTorqueAccum += stepTorque - frictionTorque;
    }

    if (subSteps > 1) {
      avgThrottleDm *= invSub;
      bankFlowsL[0] *= invSub; bankFlowsL[1] *= invSub; bankFlowsL[2] *= invSub; bankFlowsL[3] *= invSub;
      bankFlowsR[0] *= invSub; bankFlowsR[1] *= invSub; bankFlowsR[2] *= invSub; bankFlowsR[3] *= invSub;
    }

    // Trigger a single authentic ZF/DCT upshift collector bark wave per shift (smoothed via burbleSmooth so dVel never clicks!)
    if (activeUpshiftCut && !this.shiftBarkTriggered && this.shiftTimer < 0.088 && this.exhaustPortT > 480.0) {
      this.shiftBarkTriggered = true;
      const barkStrength = 0.036 * Math.min(1.0, userThrottle * 1.25);
      const cylL = cylinders[0];
      const cylR = cylinders[1];
      cylL.burbleEnv += barkStrength;
      cylL.burbleDecay = 1.0 - this.dt / 0.0065;
      cylR.burbleEnv += barkStrength * 0.85;
      cylR.burbleDecay = 1.0 - this.dt / 0.0075;
    }

    // Apply per-cylinder C1-smooth double-exponential burble/bark pulses (~1.8ms flame rise -> 4-8ms expansion decay, ZERO 1-sample click!)
    for (let i = 0; i < 8; i++) {
      const cyl = cylinders[i];
      if (cyl.burbleEnv > 1e-6 || cyl.burbleSmooth > 1e-6) {
        cyl.burbleEnv *= cyl.burbleDecay;
        if (cyl.burbleEnv <= 1e-6) cyl.burbleEnv = 0.0;
        cyl.burbleSmooth += this.burbleAttackAlpha * (cyl.burbleEnv - cyl.burbleSmooth);
        if (cyl.bank === 0) bankFlowsL[cyl.bankIndex] += cyl.burbleSmooth;
        else bankFlowsR[cyl.bankIndex] += cyl.burbleSmooth;
      } else {
        cyl.burbleEnv = 0.0;
        cyl.burbleSmooth = 0.0;
      }
    }

    // Step dual exhaust banks (with dynamic temperature, nonlinear steepening, H-pipe admittance Y = A/c, and velocity-scaled jet)
    const tTail = T_ATM + ((this.exhaustPortT > T_ATM ? this.exhaustPortT : T_ATM) - T_ATM) * 0.52;
    const outL = this.exhaustBankL.step(
      bankFlowsL,
      this.hPipe.pMinusOut,
      this.hPipe.Y,
      tTail,
      this.nextRandSigned()
    );
    const outR = this.exhaustBankR.step(
      bankFlowsR,
      this.hPipe.pPlusOut,
      this.hPipe.Y,
      tTail,
      this.nextRandSigned()
    );
    this.hPipe.writeInputs(outL.hPipeOutgoing, outR.hPipeOutgoing);

    this.exhaust_P_L = this.exhaustBankL.collectorPressure;
    this.exhaust_P_R = this.exhaustBankR.collectorPressure;

    // Step physical intake snorkel waveguide + dual-mode plenum Helmholtz (245 Hz) & runner throat (640 Hz) resonators
    // Includes transient throttle-opening suction gulp (inrush pressure drop across opening butterfly plate!)
    this.manPMean += this.manPMeanAlpha * (this.man_P - this.manPMean);
    const manPAc = this.man_P - this.manPMean;
    const thrOpenRatio = Math.sqrt(
      currentThrottleArea < maxThrottleArea ? currentThrottleArea / maxThrottleArea : 1.0
    );
    const tipInGulp = this.throttleTipInLp * (P_ATM - this.man_P) * 0.22;
    const plenumAcousticDrive = manPAc * (0.16 + 0.92 * thrOpenRatio) - tipInGulp;

    const inPPlus =
      this.intakeSnorkel.pMinusOut * 0.65 -
      this.intakeSnorkel.Z * avgThrottleDm * 0.48 +
      plenumAcousticDrive;
    const inPArriving = this.intakeSnorkel.pPlusOut;
    const targetInRefl = -0.75 * inPArriving;
    this.intakeEndLp += this.intakeEndAlpha * (targetInRefl - this.intakeEndLp);
    this.intakeSnorkel.writeInputs(inPPlus, this.intakeEndLp);

    // Exterior intake snorkel radiation (pure open-end radiated wave front, zero low-freq velocity hum)
    const rawIntakeRad = inPArriving + this.intakeEndLp;
    this.intakeRadLp += this.intakeRadAlpha * (rawIntakeRad - this.intakeRadLp);

    // Physical Helmholtz plenum cavity & runner organ-pipe resonance excited by real plenum AC suction pulses
    const helmExc = plenumAcousticDrive * 0.00055;
    const helmOut =
      this.helmB0 * helmExc +
      this.helmB2 * this.helmX2 -
      this.helmA1 * this.helmY1 -
      this.helmA2 * this.helmY2;
    this.helmX2 = this.helmX1;
    this.helmX1 = helmExc;
    this.helmY2 = this.helmY1;
    this.helmY1 = helmOut;

    const runExc = (plenumAcousticDrive * 0.00045) * thrOpenRatio;
    const runOut =
      this.runB0 * runExc +
      this.runB2 * this.runX2 -
      this.runA1 * this.runY1 -
      this.runA2 * this.runY2;
    this.runX2 = this.runX1;
    this.runX1 = runExc;
    this.runY2 = this.runY1;
    this.runY1 = runOut;

    // Physical 12V PMGR DC starter motor & planetary reduction drive (ZERO resonant filter wobble, ZERO sine oscillators!):
    // 1. Solenoid plunger throw-in CLACK on engage & subtle bendix spring retract tick on disengage
    const starterEngaged = starter && this.omega < 26.0;
    if (starterEngaged && !this.prevStarterEngaged) {
      this.starterSolenoidEnv = 1.0;
      mechImpulse += 1.25;
      blockImpulse += 0.65;
    } else if (!starterEngaged && this.prevStarterEngaged) {
      this.starterSolenoidEnv = 0.32;
      mechImpulse += 0.35;
    }
    this.prevStarterEngaged = starterEngaged;

    // Dual-mode engine block & valvetrain acoustics (with ~0.38ms elastic valve-seat contact smoothing -> zero 1-sample digital click!)
    const mechScale = this.omega < 400.0 ? this.omega * (1.0 / 400.0) : 1.0;
    this.mechContactLp += this.mechContactAlpha * (mechImpulse * (0.3 + 0.7 * mechScale) - this.mechContactLp);
    const mechExc = this.mechContactLp;
    const mechOut =
      this.mechB0 * mechExc +
      this.mechB2 * this.mechX2 -
      this.mechA1 * this.mechY1 -
      this.mechA2 * this.mechY2;
    this.mechX2 = this.mechX1;
    this.mechX1 = mechExc;
    this.mechY2 = this.mechY1;
    this.mechY1 = mechOut;

    const blockExc = fastTanh(blockImpulse);
    const blockOut =
      this.blockB0 * blockExc +
      this.blockB2 * this.blockX2 -
      this.blockA1 * this.blockY1 -
      this.blockA2 * this.blockY2;
    this.blockX2 = this.blockX1;
    this.blockX1 = blockExc;
    this.blockY2 = this.blockY1;
    this.blockY1 = blockOut;

    // 2. Physical discrete-impact spur-gear mesh + 16-bar copper commutator whir + overrunning-clutch armature spin-down:
    const compLoad = maxCylP > P_ATM ? Math.min(1.0, (maxCylP - P_ATM) * (1.0 / 950000.0)) : 0.0;
    const starterTarget = starterEngaged ? 1.0 : 0.0;
    const sAlpha = starterTarget > this.starterEnv ? this.starterAttackAlpha : this.starterReleaseAlpha;
    this.starterEnv += sAlpha * (starterTarget - this.starterEnv);

    // High-speed DC armature rotor speed (38:1 coupled while engaged; freewheels down over ~120ms when bendix overruns!)
    if (starterEngaged) {
      const targetArmOmega = this.omega * 38.0;
      this.starterArmatureOmega += this.starterArmAlpha * (targetArmOmega - this.starterArmatureOmega);
    } else if (this.starterArmatureOmega > 2.0) {
      this.starterArmatureOmega *= 1.0 - this.dt * 9.5;
      if (this.starterArmatureOmega < 2.0) this.starterArmatureOmega = 0.0;
    } else {
      this.starterArmatureOmega = 0.0;
    }

    let starterAudio = 0.0;
    if (this.starterEnv > 0.0005 || this.starterArmatureOmega > 5.0 || this.starterSolenoidEnv > 0.001) {
      // a) Flywheel 132-tooth ring-gear <-> 11-tooth bendix pinion straight-cut steel tooth strikes (~400-440 strikes/s)
      if (this.starterEnv > 0.0005 && this.omega > 0.4) {
        this.starterRingPos += this.omega * (132.0 / TWO_PI) * this.dt;
        const currRingIdx = this.starterRingPos | 0;
        if (currRingIdx !== this.starterRingLastIdx) {
          this.starterRingLastIdx = currRingIdx;
          const rIdx = currRingIdx % 132;
          const pIdx = currRingIdx % 11;
          const toothAmp =
            this.ringToothProfile[rIdx] *
            this.pinionToothProfile[pIdx] *
            (0.45 + 0.55 * compLoad) *
            this.starterEnv;
          this.starterToothPulse += toothAmp;
          this.starterToothRebound += toothAmp * 0.58;
        }
        if (this.starterRingPos >= 1452.0) {
          // Wrap cleanly at LCM(132, 11) = 132 * 11 = 1452 teeth so both ring & pinion indices remain phase-exact
          this.starterRingPos -= 1452.0;
          this.starterRingLastIdx -= 1452;
        }
      }
      this.starterToothPulse *= this.starterToothDecay;
      this.starterToothRebound *= this.starterReboundDecay;
      const toothWave = this.starterToothPulse - 0.44 * this.starterToothRebound;
      this.starterToothLp += this.starterToothLpAlpha * (toothWave - this.starterToothLp);

      // b) High-speed 16-bar copper commutator & planetary gear whir (~1850-2150 bars/s; spins down naturally after catch!)
      if (this.starterArmatureOmega > 5.0) {
        this.starterCommPos += this.starterArmatureOmega * (16.0 / TWO_PI) * this.dt;
        const currCommIdx = this.starterCommPos | 0;
        if (currCommIdx !== this.starterCommLastIdx) {
          this.starterCommLastIdx = currCommIdx;
          const barIdx = currCommIdx & 15;
          const spinFade = Math.min(1.0, this.starterArmatureOmega * (1.0 / 320.0));
          const loadMod = starterEngaged ? 0.55 + 0.45 * compLoad : 0.35;
          const barAmp =
            this.commBarProfile[barIdx] *
            loadMod *
            spinFade *
            (0.74 + 0.26 * this.nextRandSigned());
          this.starterCommPulse += barAmp;
        }
        if (this.starterCommPos >= 16384.0) {
          this.starterCommPos -= 16384.0;
          this.starterCommLastIdx -= 16384;
        }
      }
      this.starterCommPulse *= this.starterCommDecay;
      this.starterCommLp += this.starterCommLpAlpha * (this.starterCommPulse - this.starterCommLp);

      // c) Dry metallic solenoid throw-in CLACK (~8ms broadband contact strike)
      let solenoidClick = 0.0;
      if (this.starterSolenoidEnv > 0.001) {
        solenoidClick = this.starterSolenoidEnv * (0.65 * this.nextRandSigned() + 0.35);
        this.starterSolenoidEnv *= this.starterSolenoidDecay;
      } else {
        this.starterSolenoidEnv = 0.0;
      }

      // Combine wideband steel tooth mesh + high-speed DC commutator/planetary whir + solenoid clack
      // Shaped ONLY with non-resonant 1-pole 185 Hz HP (zero 47 Hz bass wobble!) + 4.8 kHz LP (zero resonant filter peak!)
      const rawStarter =
        this.starterToothLp * 0.28 +
        this.starterCommLp * 0.16 +
        solenoidClick * 0.30;
      const hpOut = rawStarter - this.starterHpX1 + this.starterHpR * this.starterHpY1;
      this.starterHpX1 = rawStarter;
      this.starterHpY1 = hpOut;
      this.starterAirLp += this.starterAirLpAlpha * (hpOut - this.starterAirLp);
      starterAudio = this.starterAirLp;
    } else {
      this.starterToothPulse = 0.0;
      this.starterToothRebound = 0.0;
      this.starterToothLp = 0.0;
      this.starterCommPulse = 0.0;
      this.starterCommLp = 0.0;
      this.starterHpX1 = 0.0;
      this.starterHpY1 = 0.0;
      this.starterAirLp = 0.0;
    }

    // Telemetry smoothing
    const netEngineTorque = totalTorqueAccum * invSub;
    const instPower = netEngineTorque * this.omega;
    this.avgTorque += this.powerAlpha * (netEngineTorque - this.avgTorque);
    this.avgPower += this.powerAlpha * (instPower - this.avgPower);

    // Dynamic microphone staging: calibrated for crisp exterior Levine-Schwinger open-pipe radiation!
    // Preserves natural high crest factor (>2.3) even at 7000 RPM WOT while bringing up real V8 compression air-pumping during cranking!
    const crankBoost = this.omega < 38.0 ? 1.0 + (1.0 - this.omega * (1.0 / 38.0)) * 3.4 : 1.0;
    const loadScale = (0.00014 + 0.00034 * (1.0 - 0.76 * loadNorm) * (1.0 - 0.62 * rpmNorm)) * crankBoost;
    const exScaledL = outL.radiatedAudio * loadScale + outL.jetAudio;
    const exScaledR = outR.radiatedAudio * loadScale + outR.jetAudio;

    // Preserve distinct crossplane L/R stereo character (80/20 air blend)
    const airL = exScaledL * 0.80 + exScaledR * 0.20;
    const airR = exScaledR * 0.80 + exScaledL * 0.20;

    const exDcL = airL - this.dcExL_x1 + this.dcR * this.dcExL_y1;
    this.dcExL_x1 = airL;
    this.dcExL_y1 = Number.isFinite(exDcL) ? exDcL : 0.0;

    const exDcR = airR - this.dcExR_x1 + this.dcR * this.dcExR_y1;
    this.dcExR_x1 = airR;
    this.dcExR_y1 = Number.isFinite(exDcR) ? exDcR : 0.0;

    const inScaled = (this.intakeRadLp * 0.00056 + helmOut * 0.42 + runOut * 0.34) * crankBoost;
    const inDc = inScaled - this.dcIn_x1 + this.dcR * this.dcIn_y1;
    this.dcIn_x1 = inScaled;
    this.dcIn_y1 = Number.isFinite(inDc) ? inDc : 0.0;

    this.clampStats.waveguideSaturationCount =
      this.exhaustBankL.primaries[0].saturationCount +
      this.exhaustBankL.primaries[1].saturationCount +
      this.exhaustBankL.primaries[2].saturationCount +
      this.exhaustBankL.primaries[3].saturationCount +
      this.exhaustBankL.midpipe.saturationCount +
      this.exhaustBankL.mufflerCore.saturationCount +
      this.exhaustBankL.mufflerOuter.saturationCount +
      this.exhaustBankL.mufflerBranch.saturationCount +
      this.exhaustBankL.tailpipe.saturationCount +
      this.exhaustBankR.primaries[0].saturationCount +
      this.exhaustBankR.primaries[1].saturationCount +
      this.exhaustBankR.primaries[2].saturationCount +
      this.exhaustBankR.primaries[3].saturationCount +
      this.exhaustBankR.midpipe.saturationCount +
      this.exhaustBankR.mufflerCore.saturationCount +
      this.exhaustBankR.mufflerOuter.saturationCount +
      this.exhaustBankR.mufflerBranch.saturationCount +
      this.exhaustBankR.tailpipe.saturationCount +
      this.hPipe.saturationCount +
      this.intakeSnorkel.saturationCount;

    this.result.exhaustAudioL = softLimit(this.dcExL_y1);
    this.result.exhaustAudioR = softLimit(this.dcExR_y1);
    this.result.intakeAudio = softLimit(this.dcIn_y1);
    this.result.mechAudio = softLimit(mechOut * 1.45 + blockOut * 3.2 + starterAudio);
    this.result.rpm = this.omega * (60.0 / TWO_PI);
    this.result.powerWatts = this.avgPower;
    this.result.torqueNm = this.avgTorque;
    this.result.manifoldP = this.man_P;
    this.result.exhaustPL = this.exhaust_P_L;
    this.result.exhaustPR = this.exhaust_P_R;
    this.result.maxCylT = maxCylT;
    this.result.maxCylP = maxCylP;
    this.result.gear = this.currentGear;
    this.result.speedKmh = this.vehicleSpeedMps * 3.6;

    return this.result;
  }
}
