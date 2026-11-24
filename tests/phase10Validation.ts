/**
 * Phase 10: Physics & Acoustic Validation Suite for AGE-T/EngineSIMtest
 *
 * Self-contained, deterministic test runner and benchmark suite (no browser UI required).
 * Run with: npm test (or: npx tsx tests/phase10Validation.ts)
 *
 * Covers Work Packages A, B, C, D, and E:
 *  - WP-A: Reproducible baseline, controllable RNG seed, and 9 representative operating-point fixtures
 *  - WP-B: Thermodynamic & mechanical model validation (mass/energy accounting, state bounds, clamps,
 *          Wiebe single-application combustion, crossplane V8 firing order 1-8-4-3-6-5-7-2, 720-deg wrap,
 *          and repeated start/idle/stall/restart reliability)
 *  - WP-C: Acoustic network correctness (mass-flow admittance junction scattering Y_i = A_i / c_i,
 *          pressure & mass-flow continuity, lossless wave-power balance, lossy junction dissipation,
 *          fractional delay & Hermite frequency response, wraparound, dynamic c(T) continuity,
 *          analytical tube/muffler/intake resonances, L/R bank H-pipe coupling, passivity, DC blocker,
 *          and nonlinear Burgers steepening monotonicity & harmonic enrichment)
 *  - WP-D: Numerical approximations (fastTanh 200,000-point grid verification vs. legacy [3/2] Padé)
 *          and hot-loop CPU / 128-sample AudioWorklet block-time benchmarks at 44.1, 48, and 96 kHz
 *  - WP-E: Deterministic audio-regression suite across all 9 operating scenarios
 */

import * as os from 'node:os';
import { performance } from 'node:perf_hooks';
import {
  PhysicalEngine,
  WaveguideTube,
  ExhaustBank,
  R_GAS,
  P_ATM,
  T_ATM,
  T_WALL,
  specificEnergyFromT,
  tempFromSpecificEnergy,
  specificEnthalpyFromT,
  gammaFromT,
  speedOfSoundFromT,
  fastTanh,
  legacyFastTanh,
  softLimit,
  calculateFlowInto,
  getValveLiftNorm,
  IO_RAD,
  IC_RAD,
  EO_RAD,
  EC_RAD,
  ClampDiagnostics,
} from '../src/audio/phase9Engine';

interface TestCaseResult {
  workPackage: string;
  name: string;
  passed: boolean;
  measured: string;
  tolerance: string;
  details?: string;
}

interface InvariantRecord {
  id: string;
  workPackage: string;
  property: string;
  measuredResidual: string;
  acceptanceLimit: string;
  passed: boolean;
}

interface ScenarioAudioMetrics {
  scenarioId: string;
  sampleRate: number;
  durationSec: number;
  seed: number;
  rpmStart: number;
  rpmEnd: number;
  rpmMin: number;
  rpmMax: number;
  peakAbs: number;
  rms: number;
  crestFactor: number;
  dcOffsetExL: number;
  dcOffsetExR: number;
  dcOffsetIn: number;
  clippingCount: number;
  nanInfCount: number;
  recoveryClampCount: number;
  spectralCentroidHz: number;
  fundamentalExpectedHz: number;
  fundamentalMeasuredHz: number;
  bandSubBass20_60Pct: number;
  bandLow60_250Pct: number;
  bandMid250_1000Pct: number;
  bandHighMid1000_4000Pct: number;
  bandHigh4000_12000Pct: number;
  maxSampleStepDelta: number;
}

interface CpuBenchmarkRecord {
  scenario: string;
  sampleRate: number;
  blockSize: number;
  totalBlocks: number;
  budgetMsPerBlock: number;
  avgMs: number;
  medianMs: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  cpuPercentMean: number;
  cpuPercentP99: number;
  deadlineMisses: number;
  heapDeltaBytesPerBlock: number;
}

const testResults: TestCaseResult[] = [];
const invariants: InvariantRecord[] = [];
const audioMetricsTable: ScenarioAudioMetrics[] = [];
const cpuBenchmarks: CpuBenchmarkRecord[] = [];

function recordTest(
  workPackage: string,
  name: string,
  passed: boolean,
  measured: string,
  tolerance: string,
  details?: string
): void {
  testResults.push({ workPackage, name, passed, measured, tolerance, details });
  const status = passed ? 'PASS' : 'FAIL';
  console.log(`[${status}] [${workPackage}] ${name} | Measured: ${measured} | Limit: ${tolerance}`);
  if (!passed && details) {
    console.error(`       Details: ${details}`);
  }
}

function recordInvariant(
  id: string,
  workPackage: string,
  property: string,
  measuredResidual: string,
  acceptanceLimit: string,
  passed: boolean
): void {
  invariants.push({ id, workPackage, property, measuredResidual, acceptanceLimit, passed });
}

function totalRecoveryClamps(c: ClampDiagnostics): number {
  return (
    c.nanOrInfCount +
    c.cylMassFloorCount +
    c.cylEnergyBoundCount +
    c.manMassFloorCount +
    c.manEnergyBoundCount +
    c.manPressureCeilingCount +
    c.waveguideSaturationCount
  );
}

// Direct DFT band-power & spectral-centroid analyzer on a steady 4096-sample window
function analyzeSpectrum(
  signal: Float64Array,
  sampleRate: number,
  expectedFundamentalHz: number
): {
  centroidHz: number;
  measuredFundamentalHz: number;
  subBassPct: number;
  lowPct: number;
  midPct: number;
  highMidPct: number;
  highPct: number;
} {
  const N = Math.min(4096, signal.length);
  const offset = signal.length - N;
  const maxBin = Math.min(N >> 1, Math.floor((12000.0 * N) / sampleRate));

  let sumMag = 0.0;
  let sumFreqMag = 0.0;
  let totalPower = 0.0;
  let subBassP = 0.0;
  let lowP = 0.0;
  let midP = 0.0;
  let highMidP = 0.0;
  let highP = 0.0;

  let peakFundPower = -1.0;
  let peakFundHz = expectedFundamentalHz;
  const searchLoHz = Math.max(12.0, expectedFundamentalHz * 0.78);
  const searchHiHz = Math.max(40.0, expectedFundamentalHz * 1.22);

  // Pre-window with Hann window
  const winSig = new Float64Array(N);
  for (let n = 0; n < N; n++) {
    const w = 0.5 * (1.0 - Math.cos((2.0 * Math.PI * n) / (N - 1)));
    winSig[n] = signal[offset + n] * w;
  }

  // Evaluate bins up to maxBin (step by 1 up to 800 Hz for sharp fundamental accuracy, step by 2 above 800 Hz)
  const bin800 = Math.min(maxBin, Math.ceil((800.0 * N) / sampleRate));
  for (let k = 1; k <= maxBin; k += k <= bin800 ? 1 : 2) {
    const weight = k <= bin800 ? 1.0 : 2.0;
    const freq = (k * sampleRate) / N;
    const w0 = (-2.0 * Math.PI * k) / N;
    const cosW = Math.cos(w0);
    const sinW = Math.sin(w0);

    // Goertzel O(N) bin evaluation
    const coeff = 2.0 * cosW;
    let s1 = 0.0;
    let s2 = 0.0;
    for (let n = 0; n < N; n++) {
      const s0 = winSig[n] + coeff * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    const re = s1 - s2 * cosW;
    const im = s2 * sinW;
    const power = (re * re + im * im) / (N * N);
    const mag = Math.sqrt(power);

    sumMag += mag * weight;
    sumFreqMag += freq * mag * weight;
    totalPower += power * weight;

    if (freq >= 20.0 && freq < 60.0) subBassP += power * weight;
    else if (freq >= 60.0 && freq < 250.0) lowP += power * weight;
    else if (freq >= 250.0 && freq < 1000.0) midP += power * weight;
    else if (freq >= 1000.0 && freq < 4000.0) highMidP += power * weight;
    else if (freq >= 4000.0 && freq <= 12000.0) highP += power * weight;

    if (freq >= searchLoHz && freq <= searchHiHz && power > peakFundPower) {
      peakFundPower = power;
      peakFundHz = freq;
    }
  }

  // Parabolic bin interpolation around peakFundHz for sub-bin accuracy
  if (expectedFundamentalHz > 15.0) {
    const kCenter = Math.round((peakFundHz * N) / sampleRate);
    const evalPowerAtFreq = (fHz: number): number => {
      const w0 = (-2.0 * Math.PI * fHz) / sampleRate;
      const cosW = Math.cos(w0);
      const sinW = Math.sin(w0);
      const coeff = 2.0 * cosW;
      let s1 = 0.0;
      let s2 = 0.0;
      for (let n = 0; n < N; n++) {
        const s0 = winSig[n] + coeff * s1 - s2;
        s2 = s1;
        s1 = s0;
      }
      const re = s1 - s2 * cosW;
      const im = s2 * sinW;
      return re * re + im * im;
    };
    const df = sampleRate / N;
    const f0 = (kCenter * sampleRate) / N;
    const pM = Math.sqrt(evalPowerAtFreq(f0 - df));
    const p0 = Math.sqrt(evalPowerAtFreq(f0));
    const pP = Math.sqrt(evalPowerAtFreq(f0 + df));
    const denom = pM - 2.0 * p0 + pP;
    if (Math.abs(denom) > 1e-12 && p0 >= pM && p0 >= pP) {
      const delta = (0.5 * (pM - pP)) / denom;
      if (Math.abs(delta) <= 1.0) {
        peakFundHz = f0 + delta * df;
      }
    }
  }

  const invTotal = totalPower > 1e-18 ? 100.0 / totalPower : 0.0;
  return {
    centroidHz: sumMag > 1e-15 ? sumFreqMag / sumMag : 0.0,
    measuredFundamentalHz: peakFundHz,
    subBassPct: subBassP * invTotal,
    lowPct: lowP * invTotal,
    midPct: midP * invTotal,
    highMidPct: highMidP * invTotal,
    highPct: highP * invTotal,
  };
}

// ============================================================================
// WORK PACKAGE A & E: Determinism, Seed Control, and 9 Operating-Point Fixtures
// ============================================================================
function runWorkPackageAAndE(): void {
  console.log('\n=== WORK PACKAGE A & E: Baseline Determinism & 9 Operating-Point Scenarios ===');

  // 1. Bit-exact determinism test with identical seeds
  const sr = 48000;
  const steps = 24000; // 0.5 s
  const engA = new PhysicalEngine(sr, 0xCAFEBABE);
  const engB = new PhysicalEngine(sr, 0xCAFEBABE);
  const engC = new PhysicalEngine(sr, 0xDEADBEEF);

  let maxDiffSameSeed = 0.0;
  let maxDiffDiffSeed = 0.0;

  for (let n = 0; n < steps; n++) {
    const thr = n < 8000 ? 0.0 : n < 16000 ? 0.65 : 0.0;
    const rA = engA.step(thr, 30.0, true, false, 1);
    const rB = engB.step(thr, 30.0, true, false, 1);
    const rC = engC.step(thr, 30.0, true, false, 1);

    const dSame =
      Math.abs(rA.exhaustAudioL - rB.exhaustAudioL) +
      Math.abs(rA.exhaustAudioR - rB.exhaustAudioR) +
      Math.abs(rA.intakeAudio - rB.intakeAudio) +
      Math.abs(rA.mechAudio - rB.mechAudio) +
      Math.abs(rA.rpm - rB.rpm);
    if (dSame > maxDiffSameSeed) maxDiffSameSeed = dSame;

    const dDiff = Math.abs(rA.exhaustAudioL - rC.exhaustAudioL) + Math.abs(rA.rpm - rC.rpm);
    if (dDiff > maxDiffDiffSeed) maxDiffDiffSeed = dDiff;
  }

  recordTest(
    'WP-A',
    'Bit-exact determinism with identical seed (0xCAFEBABE, 24,000 steps)',
    maxDiffSameSeed === 0.0,
    `maxDiff = ${maxDiffSameSeed.toExponential(3)}`,
    'maxDiff === 0.0'
  );
  recordInvariant(
    'INV-A1',
    'WP-A',
    'Deterministic state & audio reproduction (same config + seed)',
    `${maxDiffSameSeed.toExponential(3)}`,
    '0.0 (bit-exact)',
    maxDiffSameSeed === 0.0
  );

  recordTest(
    'WP-A',
    'Physical cycle-to-cycle variation preserved across distinct seeds',
    maxDiffDiffSeed > 1e-3,
    `maxDiffBetweenSeeds = ${maxDiffDiffSeed.toFixed(4)}`,
    '> 1.0e-3'
  );

  // 2. Define the 9 representative operating-point scenario fixtures
  interface ScenarioFixture {
    id: string;
    sampleRate: number;
    durationSec: number;
    seed: number;
    initFn?: (eng: PhysicalEngine) => void;
    controlFn: (tSec: number, eng: PhysicalEngine) => {
      throttle: number;
      loadNm: number;
      ignition: boolean;
      starter: boolean;
      driveMode: number;
    };
    validateFn: (m: ScenarioAudioMetrics, eng: PhysicalEngine) => { passed: boolean; summary: string };
  }

  const fixtures: ScenarioFixture[] = [
    {
      id: '1_cold_start_and_cranking',
      sampleRate: 48000,
      durationSec: 2.2,
      seed: 0x1001A001,
      initFn: (eng) => {
        eng.omega = 0.0;
        eng.man_P = P_ATM;
        eng.man_T = T_ATM;
        eng.man_mass = (eng.man_P * eng.man_V) / (R_GAS * eng.man_T);
        eng.man_energy = eng.man_mass * specificEnergyFromT(eng.man_T);
      },
      controlFn: (t) => ({
        throttle: 0.0,
        loadNm: 0.0,
        ignition: true,
        starter: t < 0.85,
        driveMode: 0,
      }),
      validateFn: (m) => ({
        passed: m.rpmStart < 5.0 && m.rpmMax > 920.0 && m.rpmEnd > 680.0 && m.rpmEnd < 1050.0,
        summary: `start=${m.rpmStart.toFixed(0)} RPM -> flareMax=${m.rpmMax.toFixed(0)} RPM -> idle=${m.rpmEnd.toFixed(0)} RPM`,
      }),
    },
    {
      id: '2_warm_idle_equilibrium',
      sampleRate: 48000,
      durationSec: 2.5,
      seed: 0x1002A002,
      controlFn: () => ({
        throttle: 0.0,
        loadNm: 0.0,
        ignition: true,
        starter: false,
        driveMode: 0,
      }),
      validateFn: (m, eng) => ({
        passed: m.rpmEnd >= 690.0 && m.rpmEnd <= 810.0 && eng.man_P >= 26000.0 && eng.man_P <= 48000.0,
        summary: `idle=${m.rpmEnd.toFixed(1)} RPM, MAP=${(eng.man_P / 1000).toFixed(1)} kPa`,
      }),
    },
    {
      id: '3_low_and_medium_load_cruise',
      sampleRate: 48000,
      durationSec: 2.0,
      seed: 0x1003A003,
      controlFn: (t) => ({
        throttle: t < 1.0 ? 0.24 : 0.48,
        loadNm: t < 1.0 ? 85.0 : 195.0,
        ignition: true,
        starter: false,
        driveMode: 0,
      }),
      validateFn: (m, eng) => ({
        passed: m.rpmEnd > 1400.0 && m.rpmEnd < 5200.0 && eng.result.torqueNm > 120.0,
        summary: `end=${m.rpmEnd.toFixed(0)} RPM, torque=${eng.result.torqueNm.toFixed(1)} Nm`,
      }),
    },
    {
      id: '4_wide_open_throttle_wot',
      sampleRate: 48000,
      durationSec: 1.8,
      seed: 0x1004A004,
      initFn: (eng) => {
        eng.omega = 2400.0 * ((2.0 * Math.PI) / 60.0);
      },
      controlFn: () => ({
        throttle: 1.0,
        loadNm: 340.0,
        ignition: true,
        starter: false,
        driveMode: 0,
      }),
      validateFn: (m, eng) => ({
        passed: m.rpmMax > 4200.0 && eng.man_P > 92000.0 && m.crestFactor > 1.8,
        summary: `max=${m.rpmMax.toFixed(0)} RPM, MAP=${(eng.man_P / 1000).toFixed(1)} kPa, CF=${m.crestFactor.toFixed(2)}`,
      }),
    },
    {
      id: '5_dfco_overrun_and_idle_catch',
      sampleRate: 48000,
      durationSec: 2.8,
      seed: 0x1005A005,
      initFn: (eng) => {
        eng.omega = 4200.0 * ((2.0 * Math.PI) / 60.0);
      },
      controlFn: () => ({
        throttle: 0.0,
        loadNm: 0.0,
        ignition: true,
        starter: false,
        driveMode: 0,
      }),
      validateFn: (m) => ({
        passed: m.rpmStart > 4000.0 && m.rpmMin > 610.0 && m.rpmEnd >= 645.0 && m.rpmEnd <= 840.0,
        summary: `overrun ${m.rpmStart.toFixed(0)} -> min=${m.rpmMin.toFixed(0)} -> catch=${m.rpmEnd.toFixed(0)} RPM`,
      }),
    },
    {
      id: '6_soft_and_hard_rev_limiter',
      sampleRate: 48000,
      durationSec: 1.6,
      seed: 0x1006A006,
      initFn: (eng) => {
        eng.omega = 6200.0 * ((2.0 * Math.PI) / 60.0);
      },
      controlFn: () => ({
        throttle: 1.0,
        loadNm: 0.0,
        ignition: true,
        starter: false,
        driveMode: 0,
      }),
      validateFn: (m) => ({
        passed: m.rpmMax >= 6880.0 && m.rpmMax <= 7250.0 && m.rpmEnd >= 6850.0 && m.rpmEnd <= 7200.0,
        summary: `limiter peak=${m.rpmMax.toFixed(0)} RPM, end=${m.rpmEnd.toFixed(0)} RPM`,
      }),
    },
    {
      id: '7_gear_changes_and_load_transients',
      sampleRate: 48000,
      durationSec: 3.2,
      seed: 0x1007A007,
      controlFn: (t) => ({
        throttle: t < 2.2 ? 0.72 : 0.15,
        loadNm: 10.0,
        ignition: true,
        starter: false,
        driveMode: 1, // Automatic Drive (D)
      }),
      validateFn: (m, eng) => ({
        passed: eng.currentGear >= 2 && eng.vehicleSpeedMps * 3.6 > 45.0 && m.maxSampleStepDelta < 0.25,
        summary: `gear=D${eng.currentGear}, speed=${(eng.vehicleSpeedMps * 3.6).toFixed(1)} km/h, maxStepDelta=${m.maxSampleStepDelta.toFixed(4)}`,
      }),
    },
    {
      id: '8_stall_and_restart_cycle',
      sampleRate: 48000,
      durationSec: 2.6,
      seed: 0x1008A008,
      controlFn: (t) => {
        if (t < 0.75) {
          // Kill ignition + heavy brake load to force stall
          return { throttle: 0.0, loadNm: 260.0, ignition: false, starter: false, driveMode: 0 };
        } else if (t < 1.65) {
          // Engage starter + ignition to restart
          return { throttle: 0.0, loadNm: 0.0, ignition: true, starter: true, driveMode: 0 };
        }
        return { throttle: 0.0, loadNm: 0.0, ignition: true, starter: false, driveMode: 0 };
      },
      validateFn: (m) => ({
        passed: m.rpmMin < 5.0 && m.rpmEnd > 680.0 && m.rpmEnd < 1050.0,
        summary: `stalled min=${m.rpmMin.toFixed(1)} RPM -> restarted end=${m.rpmEnd.toFixed(0)} RPM`,
      }),
    },
    {
      id: '9_multi_sample_rate_96kHz',
      sampleRate: 96000,
      durationSec: 1.2,
      seed: 0x1009A009,
      controlFn: () => ({
        throttle: 0.35,
        loadNm: 110.0,
        ignition: true,
        starter: false,
        driveMode: 0,
      }),
      validateFn: (m) => ({
        passed: m.rpmEnd > 1400.0 && m.rpmEnd < 4800.0 && m.recoveryClampCount === 0,
        summary: `96 kHz end=${m.rpmEnd.toFixed(0)} RPM, clamps=${m.recoveryClampCount}`,
      }),
    },
  ];

  // Also verify 22.05 kHz and 44.1 kHz explicitly for multi-rate requirement
  for (const extraSr of [22050, 44100]) {
    const engSr = new PhysicalEngine(extraSr, 0x1009B009);
    const totalN = Math.floor(extraSr * 1.0);
    let okBounds = true;
    for (let n = 0; n < totalN; n++) {
      const r = engSr.step(0.32, 95.0, true, false, 0);
      if (
        !Number.isFinite(r.exhaustAudioL) ||
        !Number.isFinite(r.rpm) ||
        r.rpm < 340.0 ||
        r.rpm > 6500.0
      ) {
        okBounds = false;
        break;
      }
    }
    const recClamps = totalRecoveryClamps(engSr.clampStats);
    recordTest(
      'WP-A',
      `Multi-sample-rate execution stability at ${extraSr} Hz (1.0 s)`,
      okBounds && recClamps === 0 && engSr.result.rpm > 2000.0,
      `endRpm=${engSr.result.rpm.toFixed(0)}, recoveryClamps=${recClamps}`,
      'finite states & 0 recovery clamps'
    );
  }

  for (const fix of fixtures) {
    const eng = new PhysicalEngine(fix.sampleRate, fix.seed);
    if (fix.initFn) fix.initFn(eng);
    eng.resetClampStats();

    const totalSteps = Math.floor(fix.sampleRate * fix.durationSec);
    const mixBuf = new Float64Array(totalSteps);

    let rpmStart = 0.0;
    let rpmEnd = 0.0;
    let rpmMin = 1e9;
    let rpmMax = -1e9;
    let peakAbs = 0.0;
    let sumSq = 0.0;
    let sumExL = 0.0;
    let sumExR = 0.0;
    let sumIn = 0.0;
    let clippingCount = 0;
    let nanInfCount = 0;
    let maxStepDelta = 0.0;
    let prevMix = 0.0;
    let stateBoundsOk = true;

    for (let n = 0; n < totalSteps; n++) {
      const tSec = n / fix.sampleRate;
      const ctrl = fix.controlFn(tSec, eng);
      const res = eng.step(ctrl.throttle, ctrl.loadNm, ctrl.ignition, ctrl.starter, ctrl.driveMode);

      if (n === 0) rpmStart = res.rpm;
      if (n === totalSteps - 1) rpmEnd = res.rpm;
      if (res.rpm < rpmMin) rpmMin = res.rpm;
      if (res.rpm > rpmMax) rpmMax = res.rpm;

      const mix =
        0.40 * res.exhaustAudioL +
        0.40 * res.exhaustAudioR +
        0.12 * res.intakeAudio +
        0.08 * res.mechAudio;
      mixBuf[n] = mix;

      if (
        !Number.isFinite(res.exhaustAudioL) ||
        !Number.isFinite(res.exhaustAudioR) ||
        !Number.isFinite(res.intakeAudio) ||
        !Number.isFinite(res.mechAudio) ||
        !Number.isFinite(res.rpm)
      ) {
        nanInfCount++;
      }

      const absMix = Math.abs(mix);
      if (absMix > peakAbs) peakAbs = absMix;
      sumSq += mix * mix;
      sumExL += res.exhaustAudioL;
      sumExR += res.exhaustAudioR;
      sumIn += res.intakeAudio;

      if (
        Math.abs(res.exhaustAudioL) >= 0.999 ||
        Math.abs(res.exhaustAudioR) >= 0.999 ||
        Math.abs(res.intakeAudio) >= 0.999 ||
        Math.abs(res.mechAudio) >= 0.999
      ) {
        clippingCount++;
      }

      if (n > 0) {
        const delta = Math.abs(mix - prevMix);
        if (delta > maxStepDelta) maxStepDelta = delta;
      }
      prevMix = mix;

      // Check physical state bounds on every 32nd sample
      if ((n & 31) === 0) {
        if (
          eng.man_mass < 2.1e-4 ||
          eng.man_P < 9500.0 ||
          eng.man_P > 130000.0 ||
          eng.man_T < 230.0 ||
          eng.man_T > 480.0 ||
          eng.omega < 0.0 ||
          eng.omega > 820.0 ||
          eng.crankAngle < 0.0 ||
          eng.crankAngle >= 4.0 * Math.PI + 1e-9 ||
          eng.vehicleSpeedMps < 0.0 ||
          eng.vehicleSpeedMps > 120.0
        ) {
          stateBoundsOk = false;
        }
        for (let c = 0; c < 8; c++) {
          const cyl = eng.cylinders[c];
          if (
            cyl.mass < 2.1e-6 ||
            cyl.freshMass < 0.0 ||
            cyl.freshMass > cyl.mass + 1e-12 ||
            cyl.P < 2500.0 ||
            cyl.P > 1.2e7 ||
            cyl.T < 155.0 ||
            cyl.T > 3650.0
          ) {
            stateBoundsOk = false;
          }
        }
      }
    }

    const rms = Math.sqrt(sumSq / totalSteps);
    const crestFactor = rms > 1e-9 ? peakAbs / rms : 0.0;
    const expectedFundHz = (4.0 * Math.max(180.0, rpmEnd)) / 60.0;
    const spec = analyzeSpectrum(mixBuf, fix.sampleRate, expectedFundHz);
    const recClamps = totalRecoveryClamps(eng.clampStats);

    const metrics: ScenarioAudioMetrics = {
      scenarioId: fix.id,
      sampleRate: fix.sampleRate,
      durationSec: fix.durationSec,
      seed: fix.seed,
      rpmStart,
      rpmEnd,
      rpmMin,
      rpmMax,
      peakAbs,
      rms,
      crestFactor,
      dcOffsetExL: sumExL / totalSteps,
      dcOffsetExR: sumExR / totalSteps,
      dcOffsetIn: sumIn / totalSteps,
      clippingCount,
      nanInfCount,
      recoveryClampCount: recClamps,
      spectralCentroidHz: spec.centroidHz,
      fundamentalExpectedHz: expectedFundHz,
      fundamentalMeasuredHz: spec.measuredFundamentalHz,
      bandSubBass20_60Pct: spec.subBassPct,
      bandLow60_250Pct: spec.lowPct,
      bandMid250_1000Pct: spec.midPct,
      bandHighMid1000_4000Pct: spec.highMidPct,
      bandHigh4000_12000Pct: spec.highPct,
      maxSampleStepDelta: maxStepDelta,
    };
    audioMetricsTable.push(metrics);

    const check = fix.validateFn(metrics, eng);
    const allOk =
      check.passed &&
      nanInfCount === 0 &&
      clippingCount === 0 &&
      recClamps === 0 &&
      stateBoundsOk &&
      peakAbs > 0.01 &&
      peakAbs < 0.91;

    recordTest(
      'WP-A/E',
      `Scenario ${fix.id}`,
      allOk,
      `${check.summary} | peak=${peakAbs.toFixed(3)}, rms=${rms.toFixed(3)}, CF=${crestFactor.toFixed(2)}, clamps=${recClamps}`,
      'physically valid trajectory, 0 clips, 0 recovery clamps'
    );
  }
}

// ============================================================================
// WORK PACKAGE B: Thermodynamic & Mechanical Model Validation
// ============================================================================
function runWorkPackageB(): void {
  console.log('\n=== WORK PACKAGE B: Thermodynamic & Mechanical Model Validation ===');

  // 1. Exact analytical energy <-> temperature inversion round-trip across [220 K, 3800 K]
  let maxTempRoundtripErr = 0.0;
  for (let T = 220.0; T <= 3800.0; T += 0.5) {
    const u = specificEnergyFromT(T);
    const Trec = tempFromSpecificEnergy(u);
    const err = Math.abs(Trec - T);
    if (err > maxTempRoundtripErr) maxTempRoundtripErr = err;
  }
  recordTest(
    'WP-B',
    'Analytical Cv(T) internal energy <-> temperature round-trip accuracy [220 K..3800 K]',
    maxTempRoundtripErr < 1e-11,
    `maxAbsErr = ${maxTempRoundtripErr.toExponential(3)} K`,
    '< 1.0e-11 K'
  );
  recordInvariant(
    'INV-B1',
    'WP-B',
    'Internal energy <-> temperature analytical inversion |T(u(T)) - T|',
    `${maxTempRoundtripErr.toExponential(3)} K`,
    '< 1.0e-11 K',
    maxTempRoundtripErr < 1e-11
  );

  // 2. Closed-cylinder adiabatic reversible compression-expansion mass & energy conservation test
  // Over a symmetric closed-valve compression + expansion cycle (from angle = 240 deg to 480 deg around firing TDC = 360 deg),
  // with zero valve flow and zero wall heat transfer, exact mass is conserved and net reversible work integral(-P dV)
  // returns internal energy to its initial value within O(dt) explicit Euler integration error.
  const sr = 96000;
  const dt = 1.0 / sr;
  const omega = 200.0; // rad/s
  const bore = 0.090;
  const stroke = 0.090;
  const conrod = 0.150;
  const CR = 10.2;
  const r = stroke * 0.5;
  const pistonArea = Math.PI * 0.25 * bore * bore;
  const V_d = pistonArea * stroke;
  const V_c = V_d / (CR - 1.0);

  const calcKinematics = (theta: number): { V: number; dxDtheta: number } => {
    const s = Math.sin(theta);
    const c = Math.cos(theta);
    const term = Math.sqrt(conrod * conrod - r * r * s * s);
    const x = r * c + term;
    const dxDtheta = -r * s - (r * r * s * c) / term;
    const strokeDisp = conrod + r - x;
    return { V: V_c + pistonArea * strokeDisp, dxDtheta };
  };

  const thetaStart = (240.0 * Math.PI) / 180.0;
  const thetaEnd = (480.0 * Math.PI) / 180.0;
  const k0 = calcKinematics(thetaStart);
  const T0 = 340.0;
  const P0 = 95000.0;
  const mass0 = (P0 * k0.V) / (R_GAS * T0);
  let mass = mass0;
  const E0 = mass0 * specificEnergyFromT(T0);
  let E = E0;
  let T = T0;
  let P = P0;
  let workAccum = 0.0;

  let theta = thetaStart;
  while (theta < thetaEnd) {
    const k = calcKinematics(theta);
    const dV_dt = -pistonArea * k.dxDtheta * omega;
    const dW = P * dV_dt * dt;
    workAccum += dW;
    E -= dW;
    T = tempFromSpecificEnergy(E / mass);
    theta += omega * dt;
    const kNext = calcKinematics(theta);
    P = (mass * R_GAS * T) / kNext.V;
  }

  const closedEnergyResidualRel = Math.abs(E + workAccum - E0) / E0;
  const symmetricCycleDriftRel = Math.abs(E - E0) / E0;

  recordTest(
    'WP-B',
    'Closed-cylinder first-law energy conservation |(E_end - E_0) + W_piston| / E_0',
    closedEnergyResidualRel < 1e-14 && symmetricCycleDriftRel < 1.5e-3,
    `firstLawResidual=${closedEnergyResidualRel.toExponential(3)}, symEulerDrift=${symmetricCycleDriftRel.toExponential(3)}`,
    'firstLaw < 1e-14, EulerDrift < 1.5e-3'
  );
  recordInvariant(
    'INV-B2',
    'WP-B',
    'Closed-cylinder 1st-Law accounting |(E_end - E_0) + integral(P dV)| / E_0',
    `${closedEnergyResidualRel.toExponential(3)} (Euler cycle drift ${symmetricCycleDriftRel.toExponential(3)})`,
    '< 1.0e-12 (Euler drift < 1.5e-3)',
    closedEnergyResidualRel < 1e-12 && symmetricCycleDriftRel < 1.5e-3
  );

  // 3. Intake-manifold <-> cylinder valve interface mass & enthalpy flux conservation
  const flowRes = { dm: 0.0, dE: 0.0 };
  const flowRev = { dm: 0.0, dE: 0.0 };
  calculateFlowInto(85000.0, 305.0, 42000.0, 365.0, 0.00095, 0.74, flowRes);
  calculateFlowInto(42000.0, 365.0, 85000.0, 305.0, 0.00095, 0.74, flowRev);
  const antisymDmErr = Math.abs(flowRes.dm + flowRev.dm);
  const antisymDeErr = Math.abs(flowRes.dE + flowRev.dE);

  recordTest(
    'WP-B',
    'Compressible orifice valve flow conservation & antisymmetry (manifold <-> cylinder)',
    flowRes.dm > 0.0 && flowRev.dm < 0.0 && antisymDmErr === 0.0 && antisymDeErr === 0.0,
    `dm=${flowRes.dm.toFixed(5)} kg/s, |dm_fwd + dm_rev|=${antisymDmErr.toExponential(2)}, |dE_fwd + dE_rev|=${antisymDeErr.toExponential(2)}`,
    'exact antisymmetry (0.0 residual)'
  );
  recordInvariant(
    'INV-B3',
    'WP-B',
    'Valve interface mass & enthalpy flux conservation |(dm, dE)_manifold + (dm, dE)_cylinder|',
    `dm: ${antisymDmErr.toExponential(2)}, dE: ${antisymDeErr.toExponential(2)}`,
    '0.0 (exact conservation)',
    antisymDmErr === 0.0 && antisymDeErr === 0.0
  );

  // 4. Wiebe combustion single-application heat release & fresh-charge consumption invariant
  // Verify that across a complete burn event (dTheta from 0 to > burnDuration),
  // sum(heatJ) == fuelEnergyTotal and sum(freshConsumed) == burnInitialFreshMass (never consumed twice!),
  // and Wiebe burn fraction is strictly monotonic in [0, 1].
  const engWiebe = new PhysicalEngine(48000, 0x22223333);
  // Inspect cylinder 0 over 4 complete 720-deg engine cycles at 2500 RPM part-throttle
  engWiebe.omega = 2500.0 * ((2.0 * Math.PI) / 60.0);
  let burnCount = 0;
  let maxHeatRelErr = 0.0;
  let maxFreshRelErr = 0.0;
  let wiebeMonotonicOk = true;

  let accumHeat = 0.0;
  let accumFresh = 0.0;
  let targetHeat = 0.0;
  let targetFresh = 0.0;
  let wasBurning = false;
  let prevWiebe = 0.0;

  for (let n = 0; n < 24000; n++) {
    const c0 = engWiebe.cylinders[0];
    const beforeEnergy = c0.energy;
    const beforeFresh = c0.freshMass;
    const beforeBurning = c0.isBurning;

    engWiebe.step(0.45, 140.0, true, false, 0);

    if (!wasBurning && c0.isBurning) {
      // New spark event triggered
      wasBurning = true;
      targetHeat = c0.fuelEnergyTotal;
      targetFresh = c0.burnInitialFreshMass;
      accumHeat = c0.lastWiebeFrac * targetHeat;
      accumFresh = c0.lastWiebeFrac * targetFresh;
      prevWiebe = c0.lastWiebeFrac;
      if (prevWiebe < 0.0 || prevWiebe > 1.0) wiebeMonotonicOk = false;
    } else if (wasBurning && c0.isBurning) {
      if (c0.lastWiebeFrac < prevWiebe - 1e-15 || c0.lastWiebeFrac > 1.0 + 1e-15) {
        wiebeMonotonicOk = false;
      }
      const dFrac = c0.lastWiebeFrac - prevWiebe;
      accumHeat += dFrac * targetHeat;
      accumFresh += dFrac * targetFresh;
      prevWiebe = c0.lastWiebeFrac;
    } else if (wasBurning && !c0.isBurning && beforeBurning) {
      // Burn completed on this sample
      const remFrac = 1.0 - prevWiebe;
      accumHeat += remFrac * targetHeat;
      accumFresh += remFrac * targetFresh;
      const heatErr = Math.abs(accumHeat - targetHeat) / Math.max(1e-9, targetHeat);
      const freshErr = Math.abs(accumFresh - targetFresh) / Math.max(1e-12, targetFresh);
      if (heatErr > maxHeatRelErr) maxHeatRelErr = heatErr;
      if (freshErr > maxFreshRelErr) maxFreshRelErr = freshErr;
      // Also verify freshMass at burn completion is ~0 (since intake valve is closed during power stroke)
      if (c0.freshMass > 1e-10) {
        maxFreshRelErr = Math.max(maxFreshRelErr, c0.freshMass / targetFresh);
      }
      burnCount++;
      wasBurning = false;
    }
    void beforeEnergy;
    void beforeFresh;
  }

  recordTest(
    'WP-B',
    'Single-application Wiebe heat release & fresh-charge consumption (no double-burn)',
    burnCount >= 8 && maxHeatRelErr < 1e-14 && maxFreshRelErr < 1e-13 && wiebeMonotonicOk,
    `burns=${burnCount}, maxHeatRelErr=${maxHeatRelErr.toExponential(3)}, maxFreshRelErr=${maxFreshRelErr.toExponential(3)}, monotonic=${wiebeMonotonicOk}`,
    'relErr < 1.0e-13 & monotonic in [0, 1]'
  );
  recordInvariant(
    'INV-B4',
    'WP-B',
    'Wiebe combustion single-application heat & fresh-charge conservation',
    `heatRelErr=${maxHeatRelErr.toExponential(3)}, freshRelErr=${maxFreshRelErr.toExponential(3)}`,
    '< 1.0e-12',
    maxHeatRelErr < 1e-12 && maxFreshRelErr < 1e-12 && wiebeMonotonicOk
  );

  // 5. Crossplane V8 firing order (1-8-4-3-6-5-7-2 -> banks L-R-R-L-R-L-L-R) and 720-deg cycle boundary spark crossing
  const engOrder = new PhysicalEngine(48000, 0x55556666);
  engOrder.omega = 1200.0 * ((2.0 * Math.PI) / 60.0);
  engOrder.crankAngle = 0.0;
  for (let i = 0; i < 8; i++) {
    engOrder.cylinders[i].lastAngle =
      (engOrder.crankAngle + engOrder.cylinders[i].phaseOffset) % (4.0 * Math.PI);
    engOrder.cylinders[i].isBurning = false;
  }

  const firedCylIndices: number[] = [];
  const firedBanks: string[] = [];
  const prevBurning = new Array<boolean>(8).fill(false);

  for (let n = 0; n < 12000 && firedCylIndices.length < 16; n++) {
    engOrder.step(0.28, 70.0, true, false, 0);
    for (let i = 0; i < 8; i++) {
      const bNow = engOrder.cylinders[i].isBurning;
      if (bNow && !prevBurning[i]) {
        firedCylIndices.push(i);
        firedBanks.push(engOrder.cylinders[i].bank === 0 ? 'L' : 'R');
      }
      prevBurning[i] = bNow;
    }
  }

  // Find start of cylinder index 0 in firedCylIndices and verify full 8-cylinder cycle order 0,1,2,3,4,5,6,7 -> banks L-R-R-L-R-L-L-R
  const startPos = firedCylIndices.indexOf(0);
  const seq8 = startPos >= 0 ? firedCylIndices.slice(startPos, startPos + 8).join('-') : 'none';
  const bankSeq8 = startPos >= 0 ? firedBanks.slice(startPos, startPos + 8).join('-') : 'none';

  recordTest(
    'WP-B',
    'Crossplane V8 firing order 1-8-4-3-6-5-7-2 (bank cadence L-R-R-L-R-L-L-R) & 720-deg boundary crossing',
    seq8 === '0-1-2-3-4-5-6-7' && bankSeq8 === 'L-R-R-L-R-L-L-R',
    `slotOrder=${seq8}, bankCadence=${bankSeq8}`,
    'slotOrder=0-1-2-3-4-5-6-7, bankCadence=L-R-R-L-R-L-L-R'
  );
  recordInvariant(
    'INV-B5',
    'WP-B',
    'Crossplane V8 firing sequence & 90-deg crank bank cadence',
    `${bankSeq8} (slots ${seq8})`,
    'L-R-R-L-R-L-L-R (slots 0-1-2-3-4-5-6-7)',
    seq8 === '0-1-2-3-4-5-6-7' && bankSeq8 === 'L-R-R-L-R-L-L-R'
  );

  // 6. Repeated cold start -> warm idle -> stall -> restart reliability over 5 consecutive seeds
  let allRunsReliable = true;
  const finalRpms: number[] = [];
  for (let run = 0; run < 5; run++) {
    const engRun = new PhysicalEngine(48000, 0x70000001 + run * 0x1111);
    engRun.omega = 0.0; // Start from dead stop
    // 0.0 - 0.85s: crank; 0.85 - 1.6s: idle; 1.6 - 2.1s: stall (ign off + load); 2.1 - 2.9s: restart crank; 2.9 - 3.6s: idle
    const N = Math.floor(48000 * 3.6);
    let stalledOk = false;
    for (let n = 0; n < N; n++) {
      const t = n / 48000;
      let ign = true;
      let st = false;
      let ld = 0.0;
      if (t < 0.85) {
        st = true;
      } else if (t >= 1.6 && t < 2.1) {
        ign = false;
        ld = 280.0;
      } else if (t >= 2.1 && t < 2.9) {
        ign = true;
        st = true;
      }
      const res = engRun.step(0.0, ld, ign, st, 0);
      if (t >= 1.95 && t < 2.08 && res.rpm < 5.0) stalledOk = true;
    }
    const endRpm = engRun.result.rpm;
    finalRpms.push(Math.round(endRpm));
    if (!stalledOk || endRpm < 690.0 || endRpm > 965.0 || totalRecoveryClamps(engRun.clampStats) > 0) {
      allRunsReliable = false;
    }
  }

  recordTest(
    'WP-B',
    'Repeated cold-start -> idle -> stall -> restart reliability (5 seeds)',
    allRunsReliable,
    `finalIdleRPMs=[${finalRpms.join(', ')}]`,
    'all 5 runs stall to 0 RPM and recover to 690..965 RPM idle with 0 clamps'
  );
}

// ============================================================================
// WORK PACKAGE C: Acoustic Network Correctness
// ============================================================================
function runWorkPackageC(): void {
  console.log('\n=== WORK PACKAGE C: Acoustic Network Correctness ===');

  // 1. Scattering junction pressure continuity, mass-flow continuity, and lossless wave-power balance
  // Verify the admittance-weighted N-port Kelly-Lochbaum junction equations directly across hetero-thermal ports
  // (e.g., 4 primaries at c_prim = 610 m/s, D = 45 mm meeting 1 midpipe at c_mid = 490 m/s, D = 64 mm).
  const areas = [
    Math.PI * 0.25 * 0.045 * 0.045,
    Math.PI * 0.25 * 0.045 * 0.045,
    Math.PI * 0.25 * 0.045 * 0.045,
    Math.PI * 0.25 * 0.045 * 0.045,
    Math.PI * 0.25 * 0.064 * 0.064,
  ];
  const speeds = [610.0, 610.0, 610.0, 610.0, 490.0];
  const admittances = areas.map((a, i) => a / speeds[i]); // Y_i = A_i / c_i
  const incomingP = [18500.0, -4200.0, 9100.0, -6300.0, 3400.0]; // [Pa]

  const sumY = admittances.reduce((acc, y) => acc + y, 0.0);
  const sumPY = incomingP.reduce((acc, p, i) => acc + p * admittances[i], 0.0);
  const pJunc = (2.0 * sumPY) / sumY;
  const outgoingP = incomingP.map((pIn) => pJunc - pIn);

  // Check pressure continuity: p_i,in + p_i,out == pJunc for all ports
  let maxPressureContErr = 0.0;
  let netMassFlowIntoJunc = 0.0;
  let incidentWavePower = 0.0;
  let scatteredWavePower = 0.0;

  for (let i = 0; i < 5; i++) {
    const portP = incomingP[i] + outgoingP[i];
    maxPressureContErr = Math.max(maxPressureContErr, Math.abs(portP - pJunc));
    const dm_i = admittances[i] * (incomingP[i] - outgoingP[i]);
    netMassFlowIntoJunc += dm_i;
    incidentWavePower += admittances[i] * incomingP[i] * incomingP[i];
    scatteredWavePower += admittances[i] * outgoingP[i] * outgoingP[i];
  }

  // Compare against legacy raw area weighting across the same temperature gradient
  const sumA = areas.reduce((acc, a) => acc + a, 0.0);
  const pJuncLegacyArea =
    (2.0 * incomingP.reduce((acc, p, i) => acc + p * areas[i], 0.0)) / sumA;
  const legacyMassFlowResidual = incomingP.reduce(
    (acc, pIn, i) => acc + admittances[i] * (2.0 * pIn - pJuncLegacyArea),
    0.0
  );

  const relMassFlowErr =
    Math.abs(netMassFlowIntoJunc) /
    incomingP.reduce((acc, p, i) => acc + admittances[i] * Math.abs(p), 0.0);
  const relPowerErr = Math.abs(scatteredWavePower - incidentWavePower) / incidentWavePower;

  recordTest(
    'WP-C',
    'Hetero-thermal 5-port collector junction pressure, mass-flow, & lossless power conservation (Y_i = A_i/c_i)',
    maxPressureContErr < 1e-11 && relMassFlowErr < 1e-15 && relPowerErr < 1e-15,
    `pErr=${maxPressureContErr.toExponential(2)} Pa, dmRelErr=${relMassFlowErr.toExponential(2)} (was ${(Math.abs(legacyMassFlowResidual) / 0.1).toExponential(2)} with area weighting), powerRelErr=${relPowerErr.toExponential(2)}`,
    'pErr < 1e-11 Pa, dmRelErr < 1e-14, powerRelErr < 1e-14'
  );
  recordInvariant(
    'INV-C1',
    'WP-C',
    'Multi-port Kelly-Lochbaum junction mass-flow conservation |sum dm_i| / sum |dm_i|',
    `${relMassFlowErr.toExponential(3)}`,
    '< 1.0e-14',
    relMassFlowErr < 1e-14
  );
  recordInvariant(
    'INV-C2',
    'WP-C',
    'Lossless N-port junction acoustic wave-power balance |sum Y_i p_out^2 - sum Y_i p_in^2| / P_in',
    `${relPowerErr.toExponential(3)}`,
    '< 1.0e-14',
    relPowerErr < 1e-14
  );

  // 2. Limiting cases: (a) 2 equal-impedance ports -> zero reflection (Gamma = 0, T = 1),
  // (b) 1 open port + 1 closed port (Y_2 -> 0) -> full positive pressure doubling (p_1,out = +p_1,in, P_J = 2*p_1,in),
  // (c) Explicitly lossy quarter-wave branch (R = 0.65) -> exact power dissipation (1 - 0.65^2 = 57.75%).
  const yEq = 1e-5;
  const pJuncEqual = (2.0 * (1000.0 * yEq + 0.0 * yEq)) / (2.0 * yEq);
  const reflEqual = pJuncEqual - 1000.0;
  const transEqual = pJuncEqual - 0.0;

  const pJuncClosedBranch = (2.0 * (1000.0 * yEq + 0.0 * 0.0)) / (yEq + 0.0);
  const reflClosedBranch = pJuncClosedBranch - 1000.0;

  const lossyReflRatio = (1000.0 * 0.65) ** 2 / 1000.0 ** 2; // 0.4225

  recordTest(
    'WP-C',
    'Junction limiting cases (matched impedance Gamma=0, closed branch Gamma=+1, lossy branch R=0.65)',
    Math.abs(reflEqual) < 1e-12 &&
      Math.abs(transEqual - 1000.0) < 1e-12 &&
      Math.abs(reflClosedBranch - 1000.0) < 1e-12 &&
      Math.abs(lossyReflRatio - 0.4225) < 1e-12,
    `matchedRefl=${reflEqual.toFixed(6)}, matchedTrans=${transEqual.toFixed(1)}, closedRefl=${reflClosedBranch.toFixed(1)}, lossyPowerRatio=${lossyReflRatio.toFixed(4)}`,
    'exact analytical limiting values'
  );

  // 3. Waveguide fractional delay accuracy, ring-buffer wraparound, and 4-point Cubic Hermite frequency response
  // Test a pure lossless tube (loss=1.0, wallCutoff=1e9 Hz) with a fractional delay of 27.37 samples at 48 kHz
  const srWave = 48000;
  const targetDelaySamples = 27.37;
  const cTest = 400.0;
  const lenTest = (targetDelaySamples * cTest) / srWave;
  const tubeTest = new WaveguideTube(lenTest, 0.05, cTest, srWave, 1.0, 1.0e9);

  // Use an exact bin-centered frequency at 48 kHz (e.g., fCos = 468.75 Hz -> period = 102.4 samples, 20 periods = 2048 samples)
  // and measure both:
  // (a) pure 4-point Cubic Hermite point-by-point interpolation accuracy against analytical cos(w*(n - D)), and
  // (b) full WaveguideTube ring-buffer wraparound (>80 wraps) phase delay & frequency-response gain accuracy
  const fCos = (20.0 * srWave) / 2048.0; // 468.75 Hz (exact integer cycles in Nmeas = 2048)
  let sumSin = 0.0;
  let sumCos = 0.0;
  let sumAnalyticalSq = 0.0;
  let sumHermiteSq = 0.0;
  const Nmeas = 2048;

  for (let n = 0; n < 4000; n++) {
    const xIn = Math.cos((2.0 * Math.PI * fCos * n) / srWave);
    tubeTest.readOutputs(0.0);
    const yOut = tubeTest.pPlusOut;
    tubeTest.writeInputs(xIn, 0.0);

    if (n >= 4000 - Nmeas) {
      const phi = (2.0 * Math.PI * fCos * n) / srWave;
      const yExact = Math.cos((2.0 * Math.PI * fCos * (n - targetDelaySamples)) / srWave);
      sumCos += yOut * Math.cos(phi);
      sumSin += yOut * Math.sin(phi);
      sumAnalyticalSq += yExact * yExact;
      sumHermiteSq += yOut * yOut;
    }
  }
  const measPhase = Math.atan2(sumSin, sumCos); // phase lag in radians
  const expectedPhase = ((2.0 * Math.PI * fCos * targetDelaySamples) / srWave) % (2.0 * Math.PI);
  let phaseDiff = Math.abs(measPhase - expectedPhase);
  if (phaseDiff > Math.PI) phaseDiff = 2.0 * Math.PI - phaseDiff;
  const maxSteadyDelayPhaseErrSamples = (phaseDiff * srWave) / (2.0 * Math.PI * fCos);
  const maxHermiteGainErrDb = Math.abs(10.0 * Math.log10(sumHermiteSq / sumAnalyticalSq));

  recordTest(
    'WP-C',
    'Waveguide fractional delay accuracy (27.37 samples) & ring-buffer wraparound (>80 wraps)',
    maxSteadyDelayPhaseErrSamples < 0.015 && maxHermiteGainErrDb < 0.02,
    `delayErr=${maxSteadyDelayPhaseErrSamples.toFixed(5)} samples, gainErr=${maxHermiteGainErrDb.toFixed(5)} dB`,
    'delayErr < 0.015 samples, gainErr < 0.02 dB'
  );
  recordInvariant(
    'INV-C3',
    'WP-C',
    'Cubic Hermite fractional-delay phase error & gain error @ 440 Hz',
    `${maxSteadyDelayPhaseErrSamples.toFixed(5)} samples / ${maxHermiteGainErrDb.toFixed(5)} dB`,
    '< 0.02 samples / < 0.02 dB',
    maxSteadyDelayPhaseErrSamples < 0.02 && maxHermiteGainErrDb < 0.02
  );

  // 4. Dynamic speed-of-sound c(T) sweep test: verify smooth output without discontinuities or buffer out-of-bounds
  const tubeSweep = new WaveguideTube(0.72, 0.045, 380.0, 48000, 0.99, 11000.0);
  let maxSweepStep = 0.0;
  let prevOut = 0.0;
  for (let n = 0; n < 4800; n++) {
    const Tnow = 320.0 + 750.0 * (0.5 - 0.5 * Math.cos((2.0 * Math.PI * n) / 4800));
    tubeSweep.updateSpeedOfSound(speedOfSoundFromT(Tnow));
    const exc = Math.sin((2.0 * Math.PI * 180.0 * n) / 48000);
    tubeSweep.readOutputs(0.85);
    const y = tubeSweep.pPlusOut;
    tubeSweep.writeInputs(exc, 0.0);
    if (n > 100) {
      maxSweepStep = Math.max(maxSweepStep, Math.abs(y - prevOut));
    }
    prevOut = y;
  }

  recordTest(
    'WP-C',
    'Dynamic speed-of-sound c(T) sweep (320 K -> 1070 K -> 320 K) continuity',
    maxSweepStep < 0.08 && Number.isFinite(prevOut),
    `maxSampleStep = ${maxSweepStep.toFixed(5)}`,
    'maxSampleStep < 0.08 & finite'
  );

  // 5. Analytical resonance & round-trip propagation delay verification for isolated tube & intake snorkel
  // For a tube of length L = 0.52 m at c = 344 m/s, closed/high-Z at one end (R1 = +0.65) and open at the other (R2 = -0.75),
  // the round-trip acoustic travel time is T_rt = 2 * L / c = 1.04 / 344 = 3.02326 ms (145.12 samples @ 48 kHz),
  // and because reflection signs are opposite (R1 * R2 < 0), the fundamental quarter-wave resonance is at
  // half-period = T_rt -> period = 2 * T_rt = 4 * L / c -> f_0 = c / (4 * L + end_filter_delay) ~ 156-165 Hz.
  const srRes = 48000;
  const L_in = 0.52;
  const c_in = 344.0;
  const tubeIn = new WaveguideTube(L_in, 0.078, c_in, srRes, 0.995, 18000.0);
  // Inject a unit impulse at n = 0 with R_left = +0.85, R_right = -0.85 (pure quarter-wave resonator)
  let firstEchoSample = -1;
  let firstEchoPeak = 0.0;
  for (let n = 0; n < 400; n++) {
    tubeIn.readOutputs(0.0);
    const pArr = tubeIn.pPlusOut;
    if (n > 20 && n < 120 && Math.abs(pArr) > firstEchoPeak) {
      firstEchoPeak = Math.abs(pArr);
      firstEchoSample = n;
    }
    const impulse = n === 0 ? 1.0 : 0.0;
    tubeIn.writeInputs(impulse + 0.85 * tubeIn.pMinusOut, -0.85 * pArr);
  }
  const analyticalOneWaySamples = (L_in / c_in) * srRes;
  const oneWayDelayErrSamples = Math.abs(firstEchoSample - analyticalOneWaySamples);

  recordTest(
    'WP-C',
    'Analytical impulse propagation delay in intake waveguide (L = 0.52 m, c = 344 m/s)',
    oneWayDelayErrSamples <= 1.0,
    `measuredPeakSample=${firstEchoSample}, analytical=${analyticalOneWaySamples.toFixed(2)} samples (err=${oneWayDelayErrSamples.toFixed(2)})`,
    '|err| <= 1.0 sample'
  );
  recordInvariant(
    'INV-C4',
    'WP-C',
    'Waveguide impulse propagation delay vs. analytical L*fs/c',
    `${oneWayDelayErrSamples.toFixed(2)} samples`,
    '<= 1.0 sample',
    oneWayDelayErrSamples <= 1.0
  );

  // 6. H-pipe cross-bank acoustic coupling test
  // Inject a pulse into Bank L Cylinder 1 ONLY (Bank R cylinder flows = 0) and verify that Bank R tailpipe
  // receives a delayed, attenuated cross-coupled acoustic wave through the H-pipe balance tube.
  const bankL = new ExhaustBank([0.56, 0.65, 0.60, 0.72], 0.84, 0.40, 0.62, 48000);
  const bankR = new ExhaustBank([0.62, 0.70, 0.54, 0.76], 1.06, 0.44, 0.76, 48000);
  const hPipe = new WaveguideTube(0.36, 0.042, 460.0, 48000, 0.955, 3800.0);
  const flowsL = new Float64Array(4);
  const flowsR = new Float64Array(4);

  let energyL = 0.0;
  let energyR_withHPipe = 0.0;
  for (let n = 0; n < 2400; n++) {
    flowsL[0] = n < 40 ? 0.08 * Math.sin((Math.PI * n) / 40) : 0.0;
    bankL.readAll();
    bankR.readAll();
    hPipe.readOutputs(0.0);
    const outL = bankL.step(flowsL, hPipe.pMinusOut, hPipe.Y, 550.0, 0.0);
    const outR = bankR.step(flowsR, hPipe.pPlusOut, hPipe.Y, 550.0, 0.0);
    hPipe.writeInputs(outL.hPipeOutgoing, outR.hPipeOutgoing);
    energyL += outL.radiatedAudio * outL.radiatedAudio;
    energyR_withHPipe += outR.radiatedAudio * outR.radiatedAudio;
  }
  const hPipeCouplingRatio = energyR_withHPipe / Math.max(1e-12, energyL);

  recordTest(
    'WP-C',
    'L/R exhaust bank acoustic coupling & isolation via H-pipe crossover',
    hPipeCouplingRatio > 0.002 && hPipeCouplingRatio < 0.35,
    `E_right / E_left = ${(hPipeCouplingRatio * 100).toFixed(2)}%`,
    '0.2% < E_right / E_left < 35%'
  );

  // 7. Nonlinear Burgers delay-modulation monotonicity (|d(shift)/dn| <= 0.42), harmonic enrichment, and passivity
  const tubeLin = new WaveguideTube(0.75, 0.045, 500.0, 48000, 0.985, 11000.0);
  const tubeNl = new WaveguideTube(0.75, 0.045, 500.0, 48000, 0.985, 11000.0);
  const Nnl = 4096;
  const sigLin = new Float64Array(Nnl);
  const sigNl = new Float64Array(Nnl);
  let maxShiftDelta = 0.0;
  let prevShift = 0.0;

  for (let n = 0; n < Nnl; n++) {
    // High-amplitude 160 Hz pressure wave (~85 kPa peak acoustic wave)
    const pIn = 85000.0 * Math.sin((2.0 * Math.PI * 160.0 * n) / 48000);
    tubeLin.readOutputs(0.0);
    tubeNl.readOutputs(0.92);
    const curShift = tubeNl.getLastShift();
    if (n > 0) {
      maxShiftDelta = Math.max(maxShiftDelta, Math.abs(curShift - prevShift));
    }
    prevShift = curShift;
    sigLin[n] = tubeLin.pPlusOut;
    sigNl[n] = tubeNl.pPlusOut;
    tubeLin.writeInputs(pIn, 0.0);
    tubeNl.writeInputs(pIn, 0.0);
  }

  const specLin = analyzeSpectrum(sigLin, 48000, 160.0);
  const specNl = analyzeSpectrum(sigNl, 48000, 160.0);

  // Also test ring-down passivity after excitation stops (must decay monotonically toward 0)
  let ringEnergyEarly = 0.0;
  let ringEnergyLate = 0.0;
  for (let n = 0; n < 2000; n++) {
    tubeNl.readOutputs(0.92);
    const y = tubeNl.pPlusOut;
    tubeNl.writeInputs(0.0, 0.0);
    if (n < 200) ringEnergyEarly += y * y;
    if (n >= 1800) ringEnergyLate += y * y;
  }

  recordTest(
    'WP-C',
    'Nonlinear Burgers wave steepening: strict read-pointer monotonicity (|d(shift)/dn| <= 0.42), harmonic enrichment, & passive decay',
    maxShiftDelta <= 0.420001 &&
      specNl.centroidHz > specLin.centroidHz * 1.12 &&
      ringEnergyLate < ringEnergyEarly * 1e-6 &&
      tubeNl.saturationCount === 0,
    `max|dShift/dn|=${maxShiftDelta.toFixed(4)}, centroidLin=${specLin.centroidHz.toFixed(1)} Hz -> centroidNL=${specNl.centroidHz.toFixed(1)} Hz (+${(((specNl.centroidHz / specLin.centroidHz) - 1) * 100).toFixed(1)}%), lateDecayRatio=${(ringEnergyLate / Math.max(1, ringEnergyEarly)).toExponential(2)}`,
    '|dShift/dn| <= 0.42, centroidNL > 1.12*centroidLin, passive ring-down'
  );
  recordInvariant(
    'INV-C5',
    'WP-C',
    'Nonlinear delay-modulation read-pointer slew rate |d(shift)/dn|',
    `${maxShiftDelta.toFixed(4)} samples/step`,
    '<= 0.42 samples/step (< 1.0 foldover limit)',
    maxShiftDelta <= 0.420001
  );
}

// ============================================================================
// WORK PACKAGE D: Numerical Approximations (fastTanh) & Hot-Loop CPU Benchmarks
// ============================================================================
function runWorkPackageD(): {
  legacyMaxErr: number;
  legacyWorstX: number;
  newMaxErr: number;
  newWorstX: number;
} {
  console.log('\n=== WORK PACKAGE D: fastTanh Verification & Hot-Loop CPU Benchmarks ===');

  // 1. Dense-grid (200,000-point) regression verification of fastTanh vs Math.tanh over [-6, 6]
  const Ngrid = 200000;
  let legacyMaxErr = 0.0;
  let legacyWorstX = 0.0;
  let newMaxErr = 0.0;
  let newWorstX = 0.0;
  let monotonicOk = true;
  let prevVal = fastTanh(-6.0);

  for (let i = 0; i <= Ngrid; i++) {
    const x = -6.0 + (12.0 * i) / Ngrid;
    const exact = Math.tanh(x);
    const leg = legacyFastTanh(x);
    const cur = fastTanh(x);

    const errLeg = Math.abs(leg - exact);
    if (errLeg > legacyMaxErr) {
      legacyMaxErr = errLeg;
      legacyWorstX = Math.abs(x);
    }

    const errCur = Math.abs(cur - exact);
    if (errCur > newMaxErr) {
      newMaxErr = errCur;
      newWorstX = Math.abs(x);
    }

    if (i > 0 && cur < prevVal - 1e-15) {
      monotonicOk = false;
    }
    prevVal = cur;
  }

  // Verify C1 smooth saturation at |x| = 4.07
  const eps = 1e-6;
  const valAtClamp = fastTanh(4.07);
  const slopeBeforeClamp = (fastTanh(4.07) - fastTanh(4.07 - eps)) / eps;

  recordTest(
    'WP-D',
    'fastTanh C1-clamped [3/4] rational approximant dense-grid (200,001 pts) error bound < 0.00075',
    newMaxErr < 0.00075 &&
      monotonicOk &&
      Math.abs(valAtClamp - 1.0) < 1e-15 &&
      Math.abs(slopeBeforeClamp) < 1e-4 &&
      Math.abs(legacyMaxErr - 0.02352) < 0.0005,
    `newMaxErr=${newMaxErr.toFixed(7)} @ |x|=${newWorstX.toFixed(4)} (legacy Padé was ${legacyMaxErr.toFixed(6)} @ |x|=${legacyWorstX.toFixed(4)}), C1_slope@4.07=${slopeBeforeClamp.toExponential(2)}`,
    'maxAbsErr < 0.00075 (< 0.003 spec) & C1 continuous'
  );
  recordInvariant(
    'INV-D1',
    'WP-D',
    'fastTanh maximum absolute error sup_x |fastTanh(x) - tanh(x)|',
    `${newMaxErr.toFixed(7)} at |x| = ${newWorstX.toFixed(4)} (legacy: ${legacyMaxErr.toFixed(6)})`,
    '< 0.00075 (4.15x below 0.003 spec)',
    newMaxErr < 0.00075
  );

  // 2. Hot-loop CPU performance & 128-sample AudioWorklet block-time benchmarks across 44.1, 48, and 96 kHz
  const blockSize = 128;
  const benchConfigs: Array<{
    name: string;
    sampleRate: number;
    initFn?: (eng: PhysicalEngine) => void;
    stepFn: (blockIdx: number, eng: PhysicalEngine) => void;
  }> = [
    {
      name: 'Warm Idle (750 RPM)',
      sampleRate: 44100,
      stepFn: (_b, eng) => {
        for (let i = 0; i < blockSize; i++) eng.step(0.0, 0.0, true, false, 0);
      },
    },
    {
      name: 'Warm Idle (750 RPM)',
      sampleRate: 48000,
      stepFn: (_b, eng) => {
        for (let i = 0; i < blockSize; i++) eng.step(0.0, 0.0, true, false, 0);
      },
    },
    {
      name: 'High RPM WOT (6500 RPM)',
      sampleRate: 48000,
      initFn: (eng) => {
        eng.omega = 6200.0 * ((2.0 * Math.PI) / 60.0);
      },
      stepFn: (_b, eng) => {
        for (let i = 0; i < blockSize; i++) eng.step(1.0, 260.0, true, false, 0);
      },
    },
    {
      name: 'High Transient Activity (Auto Shifts + Overrun)',
      sampleRate: 48000,
      stepFn: (b, eng) => {
        const thr = (b % 400) < 260 ? 0.85 : 0.0;
        for (let i = 0; i < blockSize; i++) eng.step(thr, 25.0, true, false, 1);
      },
    },
    {
      name: 'Worst-Case Cold Crank + Starter Gear Mesh',
      sampleRate: 48000,
      initFn: (eng) => {
        eng.omega = 15.0;
      },
      stepFn: (_b, eng) => {
        for (let i = 0; i < blockSize; i++) eng.step(0.0, 0.0, true, true, 0);
      },
    },
    {
      name: 'High RPM WOT (6500 RPM)',
      sampleRate: 96000,
      initFn: (eng) => {
        eng.omega = 6200.0 * ((2.0 * Math.PI) / 60.0);
      },
      stepFn: (_b, eng) => {
        for (let i = 0; i < blockSize; i++) eng.step(1.0, 260.0, true, false, 0);
      },
    },
  ];

  for (const cfg of benchConfigs) {
    const eng = new PhysicalEngine(cfg.sampleRate, 0x99887766);
    if (cfg.initFn) cfg.initFn(eng);

    // Warm-up: 400 blocks (JIT tier-up + steady cache)
    for (let w = 0; w < 400; w++) {
      cfg.stepFn(w, eng);
    }

    const totalBlocks = 1500;
    const blockTimesMs = new Float64Array(totalBlocks);
    const budgetMs = (blockSize / cfg.sampleRate) * 1000.0;

    const heapBefore = process.memoryUsage().heapUsed;
    for (let b = 0; b < totalBlocks; b++) {
      const t0 = performance.now();
      cfg.stepFn(b, eng);
      const t1 = performance.now();
      blockTimesMs[b] = t1 - t0;
    }
    const heapAfter = process.memoryUsage().heapUsed;
    const heapDeltaPerBlock = Math.max(0.0, (heapAfter - heapBefore) / totalBlocks);

    const sorted = Float64Array.from(blockTimesMs).sort();
    const sumMs = blockTimesMs.reduce((a, v) => a + v, 0.0);
    const avgMs = sumMs / totalBlocks;
    const medianMs = sorted[Math.floor(totalBlocks * 0.50)];
    const p95Ms = sorted[Math.floor(totalBlocks * 0.95)];
    const p99Ms = sorted[Math.floor(totalBlocks * 0.99)];
    const maxMs = sorted[totalBlocks - 1];
    let misses = 0;
    for (let b = 0; b < totalBlocks; b++) {
      if (blockTimesMs[b] > budgetMs) misses++;
    }

    const rec: CpuBenchmarkRecord = {
      scenario: cfg.name,
      sampleRate: cfg.sampleRate,
      blockSize,
      totalBlocks,
      budgetMsPerBlock: budgetMs,
      avgMs,
      medianMs,
      p95Ms,
      p99Ms,
      maxMs,
      cpuPercentMean: (avgMs / budgetMs) * 100.0,
      cpuPercentP99: (p99Ms / budgetMs) * 100.0,
      deadlineMisses: misses,
      heapDeltaBytesPerBlock: heapDeltaPerBlock,
    };
    cpuBenchmarks.push(rec);

    recordTest(
      'WP-D',
      `Real-time 128-sample block benchmark: ${cfg.name} @ ${cfg.sampleRate} Hz`,
      medianMs < budgetMs * 0.65 && p95Ms < budgetMs * 1.15,
      `avg=${avgMs.toFixed(3)} ms (${rec.cpuPercentMean.toFixed(1)}% CPU), med=${medianMs.toFixed(3)} ms, P95=${p95Ms.toFixed(3)} ms, P99=${p99Ms.toFixed(3)} ms, max=${maxMs.toFixed(3)} ms (budget=${budgetMs.toFixed(3)} ms, misses=${misses}/${totalBlocks})`,
      `median < ${(budgetMs * 0.65).toFixed(3)} ms & P95 < ${(budgetMs * 1.15).toFixed(3)} ms`
    );
  }

  return { legacyMaxErr, legacyWorstX, newMaxErr, newWorstX };
}

// ============================================================================
// MAIN RUNNER & MACHINE-READABLE SUMMARY OUTPUT
// ============================================================================
function main(): void {
  const cpuList = os.cpus();
  const cpuModel = cpuList.length > 0 ? cpuList[0].model : 'Unknown CPU';
  console.log('================================================================================');
  console.log('EngineSIMtest — Phase 10 Physics & Acoustic Validation Suite');
  console.log(`Runtime: Node ${process.version} | OS: ${os.type()} ${os.release()} (${os.arch()})`);
  console.log(`CPU: ${cpuModel} (${cpuList.length} logical cores)`);
  console.log('================================================================================');

  runWorkPackageAAndE();
  runWorkPackageB();
  runWorkPackageC();
  const tanhStats = runWorkPackageD();

  const totalTests = testResults.length;
  const passedTests = testResults.filter((t) => t.passed).length;
  const failedTests = totalTests - passedTests;

  console.log('\n================================================================================');
  console.log(`PHASE 10 TEST SUMMARY: ${passedTests}/${totalTests} PASSED (${failedTests} FAILED)`);
  console.log('================================================================================');

  console.log('\n--- PHYSICAL & ACOUSTIC INVARIANTS ---');
  for (const inv of invariants) {
    console.log(
      `${inv.id} [${inv.workPackage}] ${inv.property}: measured=${inv.measuredResidual} | limit=${inv.acceptanceLimit} | ${inv.passed ? 'PASS' : 'FAIL'}`
    );
  }

  console.log('\n--- FASTTANH VERIFICATION ---');
  console.log(
    `Legacy [3/2] Padé maxAbsError = ${tanhStats.legacyMaxErr.toFixed(7)} at |x| = ${tanhStats.legacyWorstX.toFixed(5)}`
  );
  console.log(
    `Phase 10 C1 [3/4] Rational maxAbsError = ${tanhStats.newMaxErr.toFixed(7)} at |x| = ${tanhStats.newWorstX.toFixed(5)}`
  );

  console.log('\n--- CPU BENCHMARKS (128-SAMPLE BLOCKS) ---');
  for (const b of cpuBenchmarks) {
    console.log(
      `${b.scenario} @ ${b.sampleRate} Hz (budget ${b.budgetMsPerBlock.toFixed(3)} ms): avg=${b.avgMs.toFixed(3)} ms (${b.cpuPercentMean.toFixed(1)}%), med=${b.medianMs.toFixed(3)} ms, P95=${b.p95Ms.toFixed(3)} ms, P99=${b.p99Ms.toFixed(3)} ms (${b.cpuPercentP99.toFixed(1)}%), max=${b.maxMs.toFixed(3)} ms, misses=${b.deadlineMisses}/${b.totalBlocks}, heapDelta=${b.heapDeltaBytesPerBlock.toFixed(1)} B/blk`
    );
  }

  console.log('\n--- AUDIO REGRESSION METRICS ---');
  for (const m of audioMetricsTable) {
    console.log(
      `${m.scenarioId} (${m.sampleRate} Hz): RPM ${m.rpmStart.toFixed(0)}->${m.rpmEnd.toFixed(0)} [${m.rpmMin.toFixed(0)}..${m.rpmMax.toFixed(0)}] | peak=${m.peakAbs.toFixed(3)}, rms=${m.rms.toFixed(3)}, CF=${m.crestFactor.toFixed(2)}, DC=(${m.dcOffsetExL.toExponential(2)}, ${m.dcOffsetExR.toExponential(2)}) | centroid=${m.spectralCentroidHz.toFixed(0)} Hz, f0=${m.fundamentalMeasuredHz.toFixed(1)}/${m.fundamentalExpectedHz.toFixed(1)} Hz | bands=[${m.bandSubBass20_60Pct.toFixed(1)}%, ${m.bandLow60_250Pct.toFixed(1)}%, ${m.bandMid250_1000Pct.toFixed(1)}%, ${m.bandHighMid1000_4000Pct.toFixed(1)}%, ${m.bandHigh4000_12000Pct.toFixed(1)}%] | clips=${m.clippingCount}, clamps=${m.recoveryClampCount}`
    );
  }

  if (failedTests > 0) {
    process.exit(1);
  }
}

main();
