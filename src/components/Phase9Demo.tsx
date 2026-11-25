import React, { useEffect, useRef, useState } from "react";
import { Play, Square, Zap, Cpu, Gauge, Flame, ShieldAlert, ArrowDownCircle, Activity, Radio, Sliders } from "lucide-react";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import phase9WorkletUrl from "../audio/phase9Worklet.ts?worker&url";
import { PhysicalEngine } from "../audio/phase9Engine";
import { GameLiteEngine } from "../audio/gameLiteEngine";
import { SpatialTelemetry } from "../audio/gameVehicleSoundSource";

function cn(...inputs: (string | undefined | null | false)[]) {
  return twMerge(clsx(inputs));
}

// Synthesize a clean, zero-noise exterior tailpipe/underbody acoustic cabinet IR (32 ms, zero random white-noise tail, zero sine-wave ringing!).
function createExhaustSpaceIR(ctx: AudioContext): AudioBuffer {
  const sr = ctx.sampleRate;
  const durationSec = 0.032;
  const length = Math.floor(sr * durationSec);
  const buffer = ctx.createBuffer(2, length, sr);

  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    let lp1 = 0.0;
    let lp2 = 0.0;
    let hpX1 = 0.0;
    let hpY1 = 0.0;
    const hpR = Math.exp((-2 * Math.PI * 55) / sr);

    const earlyTaps =
      ch === 0
        ? [
            { ms: 0.85, gain: 0.36 },
            { ms: 2.35, gain: 0.22 },
            { ms: 6.1, gain: -0.11 },
            { ms: 12.4, gain: 0.06 },
          ]
        : [
            { ms: 0.95, gain: 0.36 },
            { ms: 2.55, gain: 0.22 },
            { ms: 6.6, gain: -0.11 },
            { ms: 13.2, gain: 0.06 },
          ];

    for (const tap of earlyTaps) {
      const idx = Math.floor((tap.ms / 1000) * sr);
      if (idx >= 0 && idx < length) {
        data[idx] += tap.gain;
      }
    }

    for (let i = 0; i < length; i++) {
      const t = i / sr;
      const raw = data[i];
      const fc = 5200.0 * Math.exp(-28.0 * t) + 1600.0;
      const alpha = Math.min(0.88, (2.0 * Math.PI * fc) / (2.0 * Math.PI * fc + sr));
      lp1 += alpha * (raw - lp1);
      lp2 += alpha * (lp1 - lp2);

      const hp = lp2 - hpX1 + hpR * hpY1;
      hpX1 = lp2;
      hpY1 = hp;
      data[i] = hp;
    }
  }

  return buffer;
}

interface WorkletProfileTelemetry {
  blocksRecorded: number;
  avgMs: number;
  medianMs: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  overruns: number;
}

interface BenchmarkComparison {
  liteBlockMs: number;
  liteMedianMs: number;
  liteP95Ms: number;
  liteP99Ms: number;
  liteMaxMs: number;
  liteOverruns: number;
  liteCpuPct: number;
  liteMaxEngines: number;
  fullBlockMs: number;
  fullMedianMs: number;
  fullP95Ms: number;
  fullP99Ms: number;
  fullMaxMs: number;
  fullOverruns: number;
  fullCpuPct: number;
  fullMaxEngines: number;
  speedup: number;
}

// Measure both engines head-to-head on the current browser V8 thread over 1,500 blocks (192,000 samples @ 48 kHz)
function runHeadToHeadBenchmark(sr: number = 48000): BenchmarkComparison {
  const blocks = 1500;
  const blockSize = 128;
  const budgetMs = (blockSize / sr) * 1000.0;

  const lite = new GameLiteEngine(sr);
  const full = new PhysicalEngine(sr);

  // Warmup JIT
  for (let i = 0; i < 64 * blockSize; i++) {
    lite.step(0.65, 40, true, false, 1);
    full.step(0.65, 40, true, false, 1);
  }

  const liteTimes = new Float64Array(blocks);
  const fullTimes = new Float64Array(blocks);

  let sink = 0.0;
  let liteOverruns = 0;
  const t0LiteAll = performance.now();
  for (let b = 0; b < blocks; b++) {
    const thr = b < 900 ? 0.75 : 0.0;
    const brk = b < 900 ? 30 : 280;
    const tb0 = performance.now();
    for (let i = 0; i < blockSize; i++) {
      const r = lite.step(thr, brk, true, false, 1);
      sink += r.exhaustAudioL;
    }
    const dtMs = Math.max(0.0, performance.now() - tb0);
    liteTimes[b] = dtMs;
    if (dtMs > budgetMs) liteOverruns++;
  }
  const elapsedLiteMs = Math.max(0.01, performance.now() - t0LiteAll);

  let fullOverruns = 0;
  const t0FullAll = performance.now();
  for (let b = 0; b < blocks; b++) {
    const thr = b < 900 ? 0.75 : 0.0;
    const brk = b < 900 ? 30 : 280;
    const tb0 = performance.now();
    for (let i = 0; i < blockSize; i++) {
      const r = full.step(thr, brk, true, false, 1);
      sink += r.exhaustAudioL;
    }
    const dtMs = Math.max(0.0, performance.now() - tb0);
    fullTimes[b] = dtMs;
    if (dtMs > budgetMs) fullOverruns++;
  }
  const elapsedFullMs = Math.max(0.01, performance.now() - t0FullAll);

  // Prevent dead-code elimination
  if (sink === 1e99) console.log(sink);

  liteTimes.sort();
  fullTimes.sort();

  const liteBlockMs = elapsedLiteMs / blocks;
  const fullBlockMs = elapsedFullMs / blocks;
  const liteCpuPct = (liteBlockMs / budgetMs) * 100.0;
  const fullCpuPct = (fullBlockMs / budgetMs) * 100.0;

  return {
    liteBlockMs,
    liteMedianMs: liteTimes[Math.floor(blocks * 0.50)],
    liteP95Ms: liteTimes[Math.floor(blocks * 0.95)],
    liteP99Ms: liteTimes[Math.floor(blocks * 0.99)],
    liteMaxMs: liteTimes[blocks - 1],
    liteOverruns,
    liteCpuPct,
    liteMaxEngines: Math.max(1, Math.floor(100.0 / Math.max(0.1, liteCpuPct))),
    fullBlockMs,
    fullMedianMs: fullTimes[Math.floor(blocks * 0.50)],
    fullP95Ms: fullTimes[Math.floor(blocks * 0.95)],
    fullP99Ms: fullTimes[Math.floor(blocks * 0.99)],
    fullMaxMs: fullTimes[blocks - 1],
    fullOverruns,
    fullCpuPct,
    fullMaxEngines: Math.max(1, Math.floor(100.0 / Math.max(0.1, fullCpuPct))),
    speedup: fullBlockMs / Math.max(0.0001, liteBlockMs),
  };
}

export default function Phase9Demo() {
  const audioCtx = useRef<AudioContext | null>(null);
  const workletLoaded = useRef<boolean>(false);
  const workletNode = useRef<AudioWorkletNode | null>(null);
  const fadeGainRef = useRef<GainNode | null>(null);
  const dryGainRef = useRef<GainNode | null>(null);
  const wetGainRef = useRef<GainNode | null>(null);
  const subHpfRef = useRef<BiquadFilterNode | null>(null);
  const bodyShelfRef = useRef<BiquadFilterNode | null>(null);
  const presenceShelfRef = useRef<BiquadFilterNode | null>(null);
  const airRolloffRef = useRef<BiquadFilterNode | null>(null);
  const masterGainRef = useRef<GainNode | null>(null);
  const outputNodes = useRef<AudioNode[]>([]);
  const stopTimeoutRef = useRef<number>(0);
  const autoStarterTimeoutRef = useRef<number>(0);
  const sessionIdRef = useRef<number>(0);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const visualizerBufRef = useRef<Float32Array<ArrayBuffer> | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animationRef = useRef<number>(0);

  // Persistent calibration instances for sub-microsecond live CPU metering when AudioWorklet timer is quantized
  const calibLiteRef = useRef<GameLiteEngine | null>(null);
  const calibFullRef = useRef<PhysicalEngine | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [engineMode, setEngineMode] = useState<"lite" | "full">("lite");
  const [throttle, setThrottle] = useState(0);
  const [isBraking, setIsBraking] = useState(false);
  const [brakeForce, setBrakeForce] = useState(0);
  const [rpm, setRpm] = useState(0);
  const [power, setPower] = useState(0);
  const [pressures, setPressures] = useState({ man: 101325, exL: 101325, exR: 101325 });
  const [ignition, setIgnition] = useState(true);
  const [starter, setStarter] = useState(false);
  // Automatic transmission only: 1 = D (6-Speed Automatic), 0 = N (Neutral)
  const [driveMode, setDriveMode] = useState<0 | 1>(1);
  const [gear, setGear] = useState(1);
  const [speedKmh, setSpeedKmh] = useState(0);

  // Live CPU telemetry & Head-to-head benchmark state
  const [liveCpuPct, setLiveCpuPct] = useState<number>(0);
  const [liveBlockMs, setLiveBlockMs] = useState<number>(0);
  const [blockBudgetMs, setBlockBudgetMs] = useState<number>(2.667);
  const [workletProfile, setWorkletProfile] = useState<WorkletProfileTelemetry | null>(null);
  const [benchmark, setBenchmark] = useState<BenchmarkComparison | null>(null);
  const [isBenchmarking, setIsBenchmarking] = useState(false);

  // Final Audio Filters, Exhaust Midrange EQ, & Source Mixer Controls (accessible for both Phase 9 & Game Lite)
  const [highCutEnabled, setHighCutEnabled] = useState<boolean>(true);
  const [highCutHz, setHighCutHz] = useState<number>(7800);
  const [radCutoffHz, setRadCutoffHz] = useState<number>(8200);
  const [airRolloffEnabled, setAirRolloffEnabled] = useState<boolean>(true);
  const [airRolloffHz, setAirRolloffHz] = useState<number>(9500);
  const [airRolloffQ, setAirRolloffQ] = useState<number>(0.58);
  const [midEqHz, setMidEqHz] = useState<number>(880);
  const [midEqGainDb, setMidEqGainDb] = useState<number>(2.2);
  const [midEqQ, setMidEqQ] = useState<number>(0.65);
  const [bodyEqHz, setBodyEqHz] = useState<number>(125);
  const [bodyEqGainDb, setBodyEqGainDb] = useState<number>(1.6);
  const [subHpfHz, setSubHpfHz] = useState<number>(24);
  const [exhaustLevel, setExhaustLevel] = useState<number>(0.82);
  const [intakeLevel, setIntakeLevel] = useState<number>(0.36);
  const [mechLevel, setMechLevel] = useState<number>(0.95);
  const [jetNoiseScale, setJetNoiseScale] = useState<number>(0.75);
  const [reverbWet, setReverbWet] = useState<number>(0.14);

  // Attachable 3D/2D GameVehicleSoundSource Controls
  const [spatialMode, setSpatialMode] = useState<boolean>(false);
  const [listenerDistanceM, setListenerDistanceM] = useState<number>(3.2);
  const [listenerAngleDeg, setListenerAngleDeg] = useState<number>(180); // 180 = Behind exhaust, 0 = Front hood
  const [spatialTelemetry, setSpatialTelemetry] = useState<SpatialTelemetry | null>(null);

  // Effective throttle and braking load sent to engine
  const effectiveThrottle = isBraking ? 0.0 : throttle;
  const effectiveBrakeLoad = isBraking ? 340.0 : brakeForce;

  // Run initial baseline benchmark on mount so user immediately sees measured CPU numbers
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const res = runHeadToHeadBenchmark(48000);
      setBenchmark(res);
      setLiveCpuPct(res.liteCpuPct);
      setLiveBlockMs(res.liteBlockMs);
    }, 80);
    return () => window.clearTimeout(timer);
  }, []);

  // Auto-release starter once engine catches and fires past 540 RPM
  useEffect(() => {
    if (starter && ignition && rpm > 540) {
      const t = window.setTimeout(() => {
        setStarter(false);
      }, 140);
      return () => window.clearTimeout(t);
    }
  }, [starter, ignition, rpm]);

  const drawVisualizer = () => {
    if (!analyserRef.current || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;

    const bufferLength = analyserRef.current.frequencyBinCount;
    if (!visualizerBufRef.current || visualizerBufRef.current.length !== bufferLength) {
      visualizerBufRef.current = new Float32Array(bufferLength);
    }
    const dataArray = visualizerBufRef.current;
    analyserRef.current.getFloatTimeDomainData(dataArray);

    ctx.fillStyle = "#09090b";
    ctx.fillRect(0, 0, width, height);

    ctx.lineWidth = 2;
    ctx.strokeStyle = engineMode === "lite" ? "#10b981" : "#f43f5e";
    ctx.beginPath();

    const sliceWidth = (width * 1.0) / bufferLength;
    let x = 0;

    for (let i = 0; i < bufferLength; i++) {
      const v = dataArray[i];
      const y = (v * height) / 2 + height / 2;

      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }

      x += sliceWidth;
    }

    ctx.lineTo(canvas.width, canvas.height / 2);
    ctx.stroke();

    animationRef.current = requestAnimationFrame(drawVisualizer);
  };

  const disconnectNodesNow = (nodes: AudioNode[]) => {
    for (const n of nodes) {
      try {
        n.disconnect();
      } catch {
        // ignore already disconnected nodes
      }
    }
  };

  // High-precision burst timing probe (16 blocks = 2048 samples) so sub-100us GameLite blocks never quantize to 0.00ms
  const measureCalibratedCpuLoad = (
    mode: "lite" | "full",
    sr: number,
    thr: number,
    brk: number,
    ign: boolean,
    str: boolean,
    dMode: number,
    workletReportedMs: number
  ) => {
    if (!calibLiteRef.current || calibLiteRef.current.sampleRate !== sr) {
      calibLiteRef.current = new GameLiteEngine(sr);
      calibFullRef.current = new PhysicalEngine(sr);
    }
    const eng = mode === "lite" ? calibLiteRef.current! : calibFullRef.current!;
    const probeBlocks = 12;
    const t0 = performance.now();
    for (let b = 0; b < probeBlocks; b++) {
      for (let i = 0; i < 128; i++) {
        eng.step(thr, brk, ign, str, dMode);
      }
    }
    const probeAvgMs = Math.max(0.005, (performance.now() - t0) / probeBlocks);
    // Combine AudioWorklet reported timing with high-resolution burst timer if worklet timer was quantized
    const bestMs =
      workletReportedMs > 0.015 ? 0.55 * workletReportedMs + 0.45 * probeAvgMs : probeAvgMs;
    const budget = (128 / sr) * 1000.0;
    const pct = (bestMs / budget) * 100.0;

    setBlockBudgetMs(budget);
    setLiveBlockMs((prev) => (prev <= 0.001 ? bestMs : prev * 0.72 + bestMs * 0.28));
    setLiveCpuPct((prev) => (prev <= 0.01 ? pct : prev * 0.72 + pct * 0.28));
  };

  const startAudio = async (withColdCrank: boolean = false) => {
    sessionIdRef.current += 1;
    const mySession = sessionIdRef.current;
    if (stopTimeoutRef.current) {
      window.clearTimeout(stopTimeoutRef.current);
      stopTimeoutRef.current = 0;
    }
    if (outputNodes.current.length > 0) {
      disconnectNodesNow(outputNodes.current);
      outputNodes.current = [];
    }

    if (!audioCtx.current) {
      const AudioContextBase =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      audioCtx.current = new AudioContextBase();
      workletLoaded.current = false;
    }

    const ctx = audioCtx.current;
    if (ctx.state === "suspended") {
      await ctx.resume();
    }
    if (mySession !== sessionIdRef.current) return;

    try {
      if (!workletLoaded.current) {
        await ctx.audioWorklet.addModule(phase9WorkletUrl);
        workletLoaded.current = true;
      }
      if (mySession !== sessionIdRef.current) return;

      const node = new AudioWorkletNode(ctx, "phase9-processor", {
        outputChannelCount: [2],
      });

      const dryGain = ctx.createGain();
      dryGain.gain.value = 0.94;

      const wetGain = ctx.createGain();
      wetGain.gain.value = reverbWet;

      const convolver = ctx.createConvolver();
      convolver.buffer = createExhaustSpaceIR(ctx);

      const subHpf = ctx.createBiquadFilter();
      subHpf.type = "highpass";
      subHpf.frequency.value = subHpfHz;
      subHpf.Q.value = 0.707;

      const bodyShelf = ctx.createBiquadFilter();
      bodyShelf.type = "peaking";
      bodyShelf.frequency.value = bodyEqHz;
      bodyShelf.Q.value = 0.8;
      bodyShelf.gain.value = bodyEqGainDb;

      const presenceShelf = ctx.createBiquadFilter();
      presenceShelf.type = "peaking";
      presenceShelf.frequency.value = midEqHz;
      presenceShelf.Q.value = midEqQ;
      presenceShelf.gain.value = midEqGainDb;

      const airRolloff = ctx.createBiquadFilter();
      airRolloff.type = "lowpass";
      airRolloff.frequency.value = airRolloffEnabled ? airRolloffHz : 22000;
      airRolloff.Q.value = airRolloffQ;

      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -9.5;
      limiter.knee.value = 12.0;
      limiter.ratio.value = 8.0;
      limiter.attack.value = 0.001;
      limiter.release.value = 0.085;

      const masterGain = ctx.createGain();
      masterGain.gain.value = 0.88;

      const fadeGain = ctx.createGain();
      const now = ctx.currentTime;
      fadeGain.gain.setValueAtTime(0.0001, now);
      fadeGain.gain.linearRampToValueAtTime(1.0, now + 0.02);

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;

      node.connect(dryGain);
      node.connect(convolver);
      convolver.connect(wetGain);

      dryGain.connect(subHpf);
      wetGain.connect(subHpf);
      subHpf.connect(bodyShelf);
      bodyShelf.connect(presenceShelf);
      presenceShelf.connect(airRolloff);
      airRolloff.connect(limiter);
      limiter.connect(masterGain);
      masterGain.connect(fadeGain);
      fadeGain.connect(analyser);
      analyser.connect(ctx.destination);

      workletNode.current = node;
      fadeGainRef.current = fadeGain;
      dryGainRef.current = dryGain;
      wetGainRef.current = wetGain;
      subHpfRef.current = subHpf;
      bodyShelfRef.current = bodyShelf;
      presenceShelfRef.current = presenceShelf;
      airRolloffRef.current = airRolloff;
      masterGainRef.current = masterGain;
      analyserRef.current = analyser;
      outputNodes.current = [
        node,
        dryGain,
        wetGain,
        convolver,
        subHpf,
        bodyShelf,
        presenceShelf,
        airRolloff,
        limiter,
        masterGain,
        fadeGain,
        analyser,
      ];

      let probeCounter = 0;
      node.port.onmessage = (e) => {
        if (mySession !== sessionIdRef.current) return;
        if (e.data.type === "telemetry") {
          setRpm(e.data.rpm);
          setPower(e.data.power);
          setPressures({
            man: e.data.manP,
            exL: e.data.exPL,
            exR: e.data.exPR,
          });
          if (e.data.gear !== undefined) setGear(e.data.gear);
          if (e.data.speedKmh !== undefined) setSpeedKmh(e.data.speedKmh);
          if (e.data.workletProfile) {
            setWorkletProfile(e.data.workletProfile);
          }
          if (e.data.spatial) {
            setSpatialTelemetry(e.data.spatial);
          }

          if ((probeCounter++ & 3) === 0) {
            measureCalibratedCpuLoad(
              e.data.engineMode || engineMode,
              ctx.sampleRate,
              effectiveThrottle,
              effectiveBrakeLoad,
              ignition,
              starter,
              driveMode,
              e.data.blockAvgMs || 0
            );
          }
        }
      };

      const initIgn = withColdCrank ? true : ignition;
      const initStr = withColdCrank ? true : starter;
      if (withColdCrank) {
        setIgnition(true);
        setStarter(true);
      }

      const rad = (listenerAngleDeg * Math.PI) / 180.0;
      node.port.postMessage({
        type: "init",
        engineMode,
        throttle: effectiveThrottle,
        load: effectiveBrakeLoad,
        ignition: initIgn,
        starter: initStr,
        driveMode,
        highCutHz,
        highCutEnabled,
        radCutoffHz,
        jetNoiseScale,
        exhaustLevel,
        intakeLevel,
        mechLevel,
        spatialMode,
      });
      node.port.postMessage({
        type: "spatial",
        spatialMode,
        carPos: { x: 0, y: 0, z: 0 },
        carVel: { x: 0, y: 0, z: speedKmh / 3.6 },
        carFwd: { x: 0, y: 0, z: 1 },
        listenerPos: {
          x: Math.sin(rad) * listenerDistanceM,
          y: 1.5,
          z: Math.cos(rad) * listenerDistanceM,
        },
        listenerVel: { x: 0, y: 0, z: speedKmh / 3.6 },
        listenerRight: { x: 1, y: 0, z: 0 },
      });

      setIsPlaying(true);
      drawVisualizer();
    } catch (e) {
      console.error("Failed to start audio engine:", e);
    }
  };

  const stopAudio = (immediate = false) => {
    sessionIdRef.current += 1;
    if (stopTimeoutRef.current) {
      window.clearTimeout(stopTimeoutRef.current);
      stopTimeoutRef.current = 0;
    }
    if (autoStarterTimeoutRef.current) {
      window.clearTimeout(autoStarterTimeoutRef.current);
      autoStarterTimeoutRef.current = 0;
    }

    const nodesToDisconnect = outputNodes.current;
    const fadeNode = fadeGainRef.current;
    const ctx = audioCtx.current;

    outputNodes.current = [];
    workletNode.current = null;
    fadeGainRef.current = null;
    dryGainRef.current = null;
    wetGainRef.current = null;
    subHpfRef.current = null;
    bodyShelfRef.current = null;
    presenceShelfRef.current = null;
    airRolloffRef.current = null;
    masterGainRef.current = null;
    analyserRef.current = null;

    if (animationRef.current) {
      cancelAnimationFrame(animationRef.current);
      animationRef.current = 0;
    }
    setIsPlaying(false);
    setStarter(false);

    if (!immediate && fadeNode && ctx && ctx.state === "running" && nodesToDisconnect.length > 0) {
      const now = ctx.currentTime;
      fadeNode.gain.cancelScheduledValues(now);
      fadeNode.gain.setValueAtTime(fadeNode.gain.value, now);
      fadeNode.gain.linearRampToValueAtTime(0.0, now + 0.02);
      stopTimeoutRef.current = window.setTimeout(() => {
        disconnectNodesNow(nodesToDisconnect);
        stopTimeoutRef.current = 0;
      }, 35);
    } else {
      disconnectNodesNow(nodesToDisconnect);
    }
  };

  // Dedicated START / IGNITION action:
  // Turns Ignition ON and cranks the starter motor automatically until the V8 fires up!
  const handleStartIgnition = () => {
    if (!isPlaying) {
      startAudio(true);
      return;
    }
    setIgnition(true);
    setIsBraking(false);
    if (rpm < 480) {
      setStarter(true);
      if (autoStarterTimeoutRef.current) window.clearTimeout(autoStarterTimeoutRef.current);
      autoStarterTimeoutRef.current = window.setTimeout(() => {
        setStarter(false);
      }, 1400);
    }
  };

  // Dedicated KILL action:
  // Immediately cuts ignition & fuel, letting the V8 spin down under compression to 0 RPM (STALLED)
  const handleKillEngine = () => {
    if (autoStarterTimeoutRef.current) {
      window.clearTimeout(autoStarterTimeoutRef.current);
      autoStarterTimeoutRef.current = 0;
    }
    setIgnition(false);
    setStarter(false);
    setThrottle(0);
    setIsBraking(false);
  };

  const handleRunBenchmark = () => {
    setIsBenchmarking(true);
    window.setTimeout(() => {
      const sr = audioCtx.current?.sampleRate || 48000;
      const res = runHeadToHeadBenchmark(sr);
      setBenchmark(res);
      setLiveCpuPct(engineMode === "lite" ? res.liteCpuPct : res.fullCpuPct);
      setLiveBlockMs(engineMode === "lite" ? res.liteBlockMs : res.fullBlockMs);
      setIsBenchmarking(false);
    }, 30);
  };

  useEffect(() => {
    if (workletNode.current) {
      workletNode.current.port.postMessage({
        type: "params",
        engineMode,
        throttle: effectiveThrottle,
        load: effectiveBrakeLoad,
        ignition,
        starter,
        driveMode,
        highCutHz,
        highCutEnabled,
        radCutoffHz,
        jetNoiseScale,
        exhaustLevel,
        intakeLevel,
        mechLevel,
        spatialMode,
      });
    }
  }, [
    engineMode,
    effectiveThrottle,
    effectiveBrakeLoad,
    ignition,
    starter,
    driveMode,
    highCutHz,
    highCutEnabled,
    radCutoffHz,
    jetNoiseScale,
    exhaustLevel,
    intakeLevel,
    mechLevel,
    spatialMode,
  ]);

  // Live update WebAudio Biquad EQ & Filter nodes without restarting audio
  useEffect(() => {
    const ctx = audioCtx.current;
    if (!ctx) return;
    const now = ctx.currentTime;
    if (subHpfRef.current) {
      subHpfRef.current.frequency.setTargetAtTime(subHpfHz, now, 0.015);
    }
    if (bodyShelfRef.current) {
      bodyShelfRef.current.frequency.setTargetAtTime(bodyEqHz, now, 0.015);
      bodyShelfRef.current.gain.setTargetAtTime(bodyEqGainDb, now, 0.015);
    }
    if (presenceShelfRef.current) {
      presenceShelfRef.current.frequency.setTargetAtTime(midEqHz, now, 0.015);
      presenceShelfRef.current.gain.setTargetAtTime(midEqGainDb, now, 0.015);
      presenceShelfRef.current.Q.setTargetAtTime(midEqQ, now, 0.015);
    }
    if (airRolloffRef.current) {
      airRolloffRef.current.frequency.setTargetAtTime(
        airRolloffEnabled ? airRolloffHz : 22000,
        now,
        0.015
      );
      airRolloffRef.current.Q.setTargetAtTime(airRolloffQ, now, 0.015);
    }
    if (wetGainRef.current) {
      wetGainRef.current.gain.setTargetAtTime(reverbWet, now, 0.015);
    }
  }, [
    subHpfHz,
    bodyEqHz,
    bodyEqGainDb,
    midEqHz,
    midEqGainDb,
    midEqQ,
    airRolloffEnabled,
    airRolloffHz,
    airRolloffQ,
    reverbWet,
  ]);

  useEffect(() => {
    if (workletNode.current) {
      const rad = (listenerAngleDeg * Math.PI) / 180.0;
      const vMps = speedKmh / 3.6;
      workletNode.current.port.postMessage({
        type: "spatial",
        spatialMode,
        carPos: { x: 0, y: 0, z: 0 },
        carVel: { x: 0, y: 0, z: vMps },
        carFwd: { x: 0, y: 0, z: 1 },
        listenerPos: {
          x: Math.sin(rad) * listenerDistanceM,
          y: 1.5,
          z: Math.cos(rad) * listenerDistanceM,
        },
        listenerVel: { x: 0, y: 0, z: vMps },
        listenerRight: { x: 1, y: 0, z: 0 },
      });
    }
  }, [spatialMode, listenerDistanceM, listenerAngleDeg, speedKmh]);

  useEffect(() => {
    if (benchmark) {
      setLiveCpuPct(engineMode === "lite" ? benchmark.liteCpuPct : benchmark.fullCpuPct);
      setLiveBlockMs(engineMode === "lite" ? benchmark.liteBlockMs : benchmark.fullBlockMs);
    }
  }, [engineMode]);

  useEffect(() => {
    return () => {
      stopAudio(true);
      if (audioCtx.current) {
        audioCtx.current.close().catch(() => {});
        audioCtx.current = null;
        workletLoaded.current = false;
      }
    };
  }, []);

  const engineState =
    rpm < 50
      ? "STALLED"
      : !ignition
      ? "KILL / CUT"
      : isBraking
      ? "BRAKING / OVERRUN"
      : throttle > 0.8 && rpm > 2000
      ? "WOT"
      : throttle > 0.08
      ? "PULLING"
      : rpm > 1250
      ? "OVERRUN (DFCO)"
      : "IDLE";

  const gearLabel = driveMode === 0 || gear === 0 ? "N" : `D${gear}`;
  const estPolyphony = Math.max(1, Math.floor(100.0 / Math.max(0.1, liveCpuPct)));

  return (
    <div className="flex-1 h-screen overflow-y-auto p-6 md:p-8 space-y-6 bg-zinc-950 text-zinc-100">
      {/* Header & Live A/B Engine Architecture Switcher */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-zinc-800 pb-5">
        <div>
          <div className="flex items-center gap-2.5">
            <span
              className={cn(
                "px-2.5 py-0.5 text-xs font-mono font-bold uppercase rounded border",
                engineMode === "lite"
                  ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
                  : "bg-fuchsia-500/15 text-fuchsia-400 border-fuchsia-500/30"
              )}
            >
              {engineMode === "lite" ? "GAME LITE • DIRECT SYNTH" : "PHASE 9/10 • FULL 1D PHYSICS"}
            </span>
            <span className="text-xs font-mono text-zinc-400">
              6-Speed Auto V8 • Start Ignition / Lassítás / Kill
            </span>
          </div>
          <h2 className="text-2xl font-bold tracking-tight mt-1">
            {engineMode === "lite"
              ? "Game-Ready Direct Acoustic V8 Synthesizer (Alacsony CPU)"
              : "Phase 9/10: Full 1D Thermodynamic & Waveguide V8 Simulator"}
          </h2>
          <p className="text-sm text-zinc-400 mt-0.5">
            {engineMode === "lite"
              ? "Közvetlen előre-bake-elt hengeri nyomás-impulzusok + összehajtott Burgers-rezonátor és 3 kHz-es meghajtólánc-fizika (~7-10× kisebb CPU terhelés)."
              : "Teljes, mintánkénti (48 kHz) 8-hengeres gáztörvény, Wiebe-égés, Woschni hőveszteség és 17-csöves Kelly-Lochbaum hullámvezető szimuláció."}
          </p>
        </div>

        {/* Live A/B Mode Switcher + Master Audio Power */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="inline-flex rounded-lg p-1 bg-zinc-900 border border-zinc-800">
            <button
              onClick={() => setEngineMode("lite")}
              className={cn(
                "flex items-center gap-2 px-3.5 py-2 rounded-md text-xs font-mono font-bold transition-all",
                engineMode === "lite"
                  ? "bg-emerald-500 text-zinc-950 shadow-sm"
                  : "text-zinc-400 hover:text-zinc-200"
              )}
            >
              <Zap size={14} />
              Game Lite (Direct Synth)
            </button>
            <button
              onClick={() => setEngineMode("full")}
              className={cn(
                "flex items-center gap-2 px-3.5 py-2 rounded-md text-xs font-mono font-bold transition-all",
                engineMode === "full"
                  ? "bg-fuchsia-500 text-zinc-950 shadow-sm"
                  : "text-zinc-400 hover:text-zinc-200"
              )}
            >
              <Cpu size={14} />
              Phase 9 (Full 1D Sim)
            </button>
          </div>

          <button
            className={cn(
              "flex items-center gap-2 px-4 py-2.5 rounded-lg font-mono font-bold text-xs uppercase tracking-wider transition-colors border",
              isPlaying
                ? "bg-red-500/15 text-red-400 border-red-500/30 hover:bg-red-500/25"
                : "bg-emerald-500/15 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/25"
            )}
            onClick={isPlaying ? () => stopAudio(false) : () => startAudio(false)}
          >
            {isPlaying ? <Square size={15} /> : <Play size={15} />}
            {isPlaying ? "Audio Stop" : "Audio Bekapcsolása"}
          </button>
        </div>
      </div>

      {/* Main 3-Column Interactive Console */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Column 1: Streamlined Controls (Start Ignition, Lassítás, Kill, Auto Transmission, Throttle) */}
        <div className="space-y-5 bg-zinc-900/70 p-6 rounded-xl border border-zinc-800">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-mono font-bold text-zinc-400 uppercase tracking-widest">
              Vezérlőpult (Csak Automata Váltó)
            </h3>
            <span className="text-xs font-mono font-bold px-2.5 py-0.5 rounded bg-zinc-800 text-zinc-200 border border-zinc-700">
              {gearLabel} • {Math.round(speedKmh)} km/h
            </span>
          </div>

          {/* Primary Action Trio: START IGNITION | LASSÍTÁS (BRAKE) | KILL */}
          <div className="grid grid-cols-3 gap-2.5">
            <button
              onClick={handleStartIgnition}
              onMouseDown={() => {
                if (isPlaying && rpm < 480) {
                  setIgnition(true);
                  setStarter(true);
                }
              }}
              onMouseUp={() => setStarter(false)}
              className={cn(
                "flex flex-col items-center justify-center gap-1.5 py-3.5 px-3 rounded-lg font-mono text-xs font-bold border transition-all",
                starter
                  ? "bg-amber-500/25 text-amber-300 border-amber-400 shadow-lg shadow-amber-500/10"
                  : ignition && rpm > 400
                  ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/40 hover:bg-emerald-500/25"
                  : "bg-emerald-500 text-zinc-950 border-emerald-400 hover:bg-emerald-400"
              )}
            >
              <Flame size={18} />
              <span>{starter ? "INDÍTÁS..." : "START IGNITION"}</span>
            </button>

            <button
              onMouseDown={() => setIsBraking(true)}
              onMouseUp={() => setIsBraking(false)}
              onMouseLeave={() => setIsBraking(false)}
              onTouchStart={() => setIsBraking(true)}
              onTouchEnd={() => setIsBraking(false)}
              className={cn(
                "flex flex-col items-center justify-center gap-1.5 py-3.5 px-3 rounded-lg font-mono text-xs font-bold border transition-all select-none",
                isBraking
                  ? "bg-amber-500 text-zinc-950 border-amber-300 shadow-lg shadow-amber-500/20"
                  : "bg-zinc-800/90 text-amber-400 border-amber-500/30 hover:bg-zinc-800"
              )}
            >
              <ArrowDownCircle size={18} />
              <span>{isBraking ? "FÉKEZÉS AKTÍV" : "LASSÍTÁS (FÉK)"}</span>
            </button>

            <button
              onClick={handleKillEngine}
              className={cn(
                "flex flex-col items-center justify-center gap-1.5 py-3.5 px-3 rounded-lg font-mono text-xs font-bold border transition-all",
                !ignition
                  ? "bg-red-500 text-white border-red-400"
                  : "bg-red-500/15 text-red-400 border-red-500/30 hover:bg-red-500/25"
              )}
            >
              <ShieldAlert size={18} />
              <span>KILL MOTOR</span>
            </button>
          </div>

          {/* 6-Speed Automatic Transmission Indicator (D1..D6 + N/D Toggle) */}
          <div className="space-y-2 pt-2 border-t border-zinc-800/80">
            <div className="flex justify-between items-center">
              <label className="text-xs font-mono uppercase text-zinc-400">
                6-Sebességes Automata Váltó
              </label>
              <div className="flex gap-1.5">
                <button
                  onClick={() => setDriveMode(1)}
                  className={cn(
                    "px-2.5 py-1 rounded text-xs font-mono font-bold border transition-colors",
                    driveMode === 1
                      ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/50"
                      : "bg-zinc-900 text-zinc-400 border-zinc-800"
                  )}
                >
                  D (Automata)
                </button>
                <button
                  onClick={() => setDriveMode(0)}
                  className={cn(
                    "px-2.5 py-1 rounded text-xs font-mono font-bold border transition-colors",
                    driveMode === 0
                      ? "bg-zinc-200 text-zinc-950 border-white"
                      : "bg-zinc-900 text-zinc-400 border-zinc-800"
                  )}
                >
                  N (Üres)
                </button>
              </div>
            </div>

            {/* Active Automatic Gear Progression Pills (D1..D6) */}
            <div className="grid grid-cols-6 gap-1.5 pt-1">
              {[1, 2, 3, 4, 5, 6].map((g) => {
                const active = driveMode === 1 && gear === g;
                return (
                  <div
                    key={g}
                    className={cn(
                      "py-1.5 text-center rounded font-mono text-xs font-bold border transition-all",
                      active
                        ? "bg-emerald-500/20 text-emerald-300 border-emerald-400 shadow-sm"
                        : "bg-zinc-950/80 text-zinc-600 border-zinc-800/80"
                    )}
                  >
                    D{g}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Throttle Control + Quick Presets */}
          <div className="space-y-2.5 pt-2 border-t border-zinc-800/80">
            <div className="flex justify-between items-center">
              <label className="text-sm font-medium">Gázpedál (Throttle)</label>
              <span className="text-sm font-mono font-bold text-emerald-400">
                {(effectiveThrottle * 100).toFixed(0)}%
              </span>
            </div>
            <input
              type="range"
              className="w-full accent-emerald-500 cursor-pointer"
              value={throttle}
              min={0}
              max={1}
              step={0.01}
              onChange={(e) => {
                setIsBraking(false);
                setThrottle(parseFloat(e.target.value));
              }}
            />
            <div className="grid grid-cols-4 gap-1.5 pt-0.5">
              {[
                { label: "Alapjárat 0%", val: 0.0 },
                { label: "Cruise 30%", val: 0.3 },
                { label: "Sport 65%", val: 0.65 },
                { label: "Padlógáz 100%", val: 1.0 },
              ].map((preset) => (
                <button
                  key={preset.label}
                  onClick={() => {
                    setIsBraking(false);
                    setThrottle(preset.val);
                  }}
                  className={cn(
                    "py-1 px-1.5 rounded text-[11px] font-mono border transition-colors",
                    Math.abs(throttle - preset.val) < 0.02 && !isBraking
                      ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/40"
                      : "bg-zinc-950 text-zinc-400 border-zinc-800 hover:bg-zinc-800"
                  )}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          {/* Continuous Brake / Road Resistance Slider */}
          <div className="space-y-2 pt-2 border-t border-zinc-800/80">
            <div className="flex justify-between items-center">
              <label className="text-xs font-mono uppercase text-zinc-400">
                Folyamatos Fékerő / Emelkedő Terhelés
              </label>
              <span className="text-xs font-mono text-amber-400">
                {effectiveBrakeLoad.toFixed(0)} Nm
              </span>
            </div>
            <input
              type="range"
              className="w-full accent-amber-500 cursor-pointer"
              value={brakeForce}
              min={0}
              max={400}
              step={5}
              onChange={(e) => setBrakeForce(parseFloat(e.target.value))}
            />
          </div>

          {/* Final -6 dB/octave High-Cut Filter Control */}
          <div className="space-y-2 pt-2 border-t border-zinc-800/80">
            <div className="flex justify-between items-center">
              <label className="text-xs font-mono uppercase text-zinc-400 flex items-center gap-1.5">
                <Sliders size={13} className="text-emerald-400" />
                Végső -6 dB/oct Magasvágó (Worklet LPF)
              </label>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setHighCutEnabled((prev) => !prev)}
                  className={cn(
                    "px-2 py-0.5 rounded text-[10px] font-mono font-bold border transition-colors",
                    highCutEnabled
                      ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/40"
                      : "bg-zinc-900 text-zinc-400 border-zinc-700"
                  )}
                >
                  {highCutEnabled ? "ON" : "BYPASS"}
                </button>
                <span className="text-xs font-mono font-bold text-emerald-400">
                  {highCutEnabled ? `${(highCutHz / 1000).toFixed(1)} kHz` : "OFF"}
                </span>
              </div>
            </div>
            <input
              type="range"
              className="w-full accent-emerald-500 cursor-pointer"
              value={highCutHz}
              min={1000}
              max={18000}
              step={100}
              disabled={!highCutEnabled}
              onChange={(e) => setHighCutHz(parseFloat(e.target.value))}
            />
            <div className="text-[11px] font-mono text-zinc-500">
              Egylépcsős (-6 dB/oct) végső magasvágó szűrő duplázás nélkül; a teljes szűrő- és középtartomány EQ pult lentebb érhető el.
            </div>
          </div>
        </div>

        {/* Column 2: Real-Time CPU Load Meter & Head-to-Head Benchmark */}
        <div className="space-y-4 bg-zinc-900/70 p-6 rounded-xl border border-zinc-800 flex flex-col justify-between">
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Activity size={16} className="text-emerald-400" />
                <h3 className="text-xs font-mono font-bold text-zinc-400 uppercase tracking-widest">
                  Valós Idejű CPU Terhelés & Benchmark
                </h3>
              </div>
              <span
                className={cn(
                  "text-xs font-mono font-bold px-2 py-0.5 rounded border",
                  engineMode === "lite"
                    ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
                    : "bg-fuchsia-500/15 text-fuchsia-400 border-fuchsia-500/30"
                )}
              >
                {engineMode === "lite" ? "GAME LITE AKTÍV" : "PHASE 9 FULL AKTÍV"}
              </span>
            </div>

            {/* Primary Live CPU Gauge */}
            <div className="p-4 rounded-lg bg-zinc-950 border border-zinc-800 space-y-3">
              <div className="flex justify-between items-baseline">
                <div>
                  <div className="text-xs font-mono text-zinc-400">
                    Aktuális Audio DSP CPU Terhelés (1 mag @ 48 kHz)
                  </div>
                  <div className="text-3xl font-black font-mono tracking-tight text-white mt-0.5">
                    {liveCpuPct.toFixed(2)}%
                  </div>
                </div>
                <div className="text-right font-mono">
                  <div className="text-xs text-zinc-400">128-minta blokk-idő</div>
                  <div className="text-sm font-bold text-emerald-400">
                    {liveBlockMs.toFixed(3)} ms{" "}
                    <span className="text-zinc-500">/ {blockBudgetMs.toFixed(2)} ms</span>
                  </div>
                </div>
              </div>

              {/* CPU Load Bar */}
              <div className="w-full h-3 bg-zinc-900 rounded-full overflow-hidden border border-zinc-800">
                <div
                  className={cn(
                    "h-full transition-all duration-150",
                    engineMode === "lite" ? "bg-emerald-500" : "bg-fuchsia-500"
                  )}
                  style={{ width: `${Math.min(100, Math.max(1.5, liveCpuPct * 2.5))}%` }}
                />
              </div>

              <div className="flex justify-between text-xs font-mono text-zinc-400 pt-1">
                <span>Becsült polifónia (1 CPU magon):</span>
                <span className="font-bold text-zinc-200">~{estPolyphony} egyidejű V8 motor</span>
              </div>
            </div>

            {/* Head-to-Head Benchmark Comparison Card */}
            {benchmark && (
              <div className="p-4 rounded-lg bg-zinc-950 border border-zinc-800 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-mono font-bold uppercase text-zinc-400">
                    Mért Összehasonlítás (192 000 minta @ 48 kHz)
                  </span>
                  <span className="px-2 py-0.5 text-xs font-mono font-bold rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
                    {benchmark.speedup.toFixed(1)}× GYORSABB
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-3 text-xs font-mono">
                  <div className="p-2.5 rounded bg-emerald-500/5 border border-emerald-500/25 space-y-1">
                    <div className="font-bold text-emerald-400">⚡ Game Lite (Direct)</div>
                    <div className="text-lg font-black text-white">
                      {benchmark.liteCpuPct.toFixed(2)}% CPU
                    </div>
                    <div className="text-zinc-400">
                      avg {benchmark.liteBlockMs.toFixed(3)} / P99 {benchmark.liteP99Ms.toFixed(3)} ms
                    </div>
                    <div className="text-emerald-300/90">
                      ~{benchmark.liteMaxEngines} motor/mag ({benchmark.liteOverruns} overrun)
                    </div>
                  </div>

                  <div className="p-2.5 rounded bg-fuchsia-500/5 border border-fuchsia-500/25 space-y-1">
                    <div className="font-bold text-fuchsia-400">🔬 Phase 9 (Full 1D)</div>
                    <div className="text-lg font-black text-white">
                      {benchmark.fullCpuPct.toFixed(2)}% CPU
                    </div>
                    <div className="text-zinc-400">
                      avg {benchmark.fullBlockMs.toFixed(3)} / P99 {benchmark.fullP99Ms.toFixed(3)} ms
                    </div>
                    <div className="text-fuchsia-300/90">
                      ~{benchmark.fullMaxEngines} motor/mag ({benchmark.fullOverruns} overrun)
                    </div>
                  </div>
                </div>

                {workletProfile && workletProfile.blocksRecorded > 0 && (
                  <div className="pt-2 border-t border-zinc-800/80 text-[11px] font-mono text-zinc-400 flex flex-wrap justify-between gap-2">
                    <span>
                      AudioWorklet ({workletProfile.blocksRecorded} blk): med{" "}
                      {workletProfile.medianMs.toFixed(3)} ms | P95 {workletProfile.p95Ms.toFixed(3)} ms | P99{" "}
                      {workletProfile.p99Ms.toFixed(3)} ms | max {workletProfile.maxMs.toFixed(3)} ms
                    </span>
                    <span
                      className={cn(
                        "font-bold",
                        workletProfile.overruns === 0 ? "text-emerald-400" : "text-amber-400"
                      )}
                    >
                      Overruns: {workletProfile.overruns}/{workletProfile.blocksRecorded}
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Oscilloscope + Benchmark Trigger Button */}
          <div className="space-y-3">
            <div className="w-full h-28 bg-zinc-950 rounded-lg overflow-hidden border border-zinc-800 relative">
              <canvas ref={canvasRef} width={600} height={140} className="w-full h-full" />
              <span className="absolute top-1.5 left-2.5 text-[10px] font-mono text-zinc-500 uppercase">
                Kipufogó Hullámforma (Valós Idejű)
              </span>
            </div>

            <button
              onClick={handleRunBenchmark}
              disabled={isBenchmarking}
              className="w-full py-2.5 px-4 rounded-lg font-mono text-xs font-bold uppercase tracking-wider bg-zinc-800 hover:bg-zinc-700 text-zinc-100 border border-zinc-700 transition-colors"
            >
              {isBenchmarking
                ? "CPU Benchmark Futtatása..."
                : "Újra-mérés: Phase 9 vs. Game Lite CPU Benchmark"}
            </button>
          </div>
        </div>

        {/* Column 3: Tachometer, Speedometer, Gear, & Manifold Telemetry */}
        <div className="space-y-4 bg-zinc-900/70 p-6 rounded-xl border border-zinc-800 flex flex-col justify-between items-center">
          <div className="flex w-full justify-between items-center">
            <div className="flex items-center gap-2">
              <Gauge size={16} className="text-zinc-400" />
              <h3 className="text-xs font-mono font-bold text-zinc-400 uppercase tracking-widest">
                Műszerfal & Telemetria
              </h3>
            </div>
            <div className="flex items-center gap-2">
              <div className="px-2.5 py-1 text-xs font-bold font-mono rounded-md border bg-emerald-500/10 text-emerald-400 border-emerald-500/25">
                {gearLabel} • {Math.round(speedKmh)} KM/H
              </div>
              <div
                className={cn(
                  "px-2.5 py-1 text-[10px] font-bold font-mono rounded-md tracking-wider border",
                  engineState === "STALLED" || engineState === "KILL / CUT"
                    ? "bg-red-500/15 text-red-400 border-red-500/30"
                    : engineState === "BRAKING / OVERRUN" || engineState === "OVERRUN (DFCO)"
                    ? "bg-amber-500/15 text-amber-400 border-amber-500/30"
                    : engineState === "IDLE"
                    ? "bg-blue-500/15 text-blue-400 border-blue-500/30"
                    : "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
                )}
              >
                {engineState}
              </div>
            </div>
          </div>

          {/* Analog/Digital Tachometer */}
          <div className="flex flex-col items-center justify-center py-2 w-full">
            <div className="relative w-48 h-48 flex items-center justify-center">
              <svg viewBox="0 0 200 200" className="w-full h-full absolute top-0 left-0">
                <path
                  d="M 40 160 A 80 80 0 1 1 160 160"
                  fill="none"
                  stroke="#27272a"
                  strokeWidth="8"
                  strokeLinecap="round"
                />
                <path
                  d="M 140 35 A 80 80 0 0 1 160 160"
                  fill="none"
                  stroke="#ef4444"
                  strokeWidth="8"
                  strokeLinecap="round"
                  opacity="0.5"
                />

                {Array.from({ length: 9 }).map((_, i) => {
                  const ang = (-120 + i * (240 / 8)) * (Math.PI / 180);
                  const x1 = 100 + Math.sin(ang) * 65;
                  const y1 = 100 - Math.cos(ang) * 65;
                  const x2 = 100 + Math.sin(ang) * 75;
                  const y2 = 100 - Math.cos(ang) * 75;
                  return (
                    <line
                      key={i}
                      x1={x1}
                      y1={y1}
                      x2={x2}
                      y2={y2}
                      stroke={i >= 7 ? "#ef4444" : "#52525b"}
                      strokeWidth="3"
                      strokeLinecap="round"
                    />
                  );
                })}

                <g
                  style={{
                    transform: `rotate(${-120 + (Math.min(rpm, 8000) / 8000) * 240}deg)`,
                    transformOrigin: "100px 100px",
                    transition: "transform 45ms linear",
                  }}
                >
                  <line
                    x1="100"
                    y1="100"
                    x2="100"
                    y2="30"
                    stroke={engineMode === "lite" ? "#10b981" : "#f43f5e"}
                    strokeWidth="4"
                    strokeLinecap="round"
                  />
                  <circle
                    cx="100"
                    cy="100"
                    r="8"
                    fill={engineMode === "lite" ? "#10b981" : "#f43f5e"}
                  />
                </g>
              </svg>
              <div className="absolute flex flex-col items-center mt-12">
                <div className="text-3xl font-black tracking-tighter text-white font-mono leading-none">
                  {Math.round(rpm)}
                </div>
                <div className="text-[10px] text-zinc-500 font-bold tracking-widest uppercase mt-1">
                  RPM
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-6 w-full text-center mt-1">
              <div>
                <div className="text-xl font-bold text-emerald-400 font-mono">
                  {Math.max(0, power / 745.7).toFixed(1)} LE
                </div>
                <div className="text-[10px] text-zinc-500 font-mono uppercase">Teljesítmény</div>
              </div>
              <div>
                <div className="text-xl font-bold text-zinc-100 font-mono">
                  {Math.round(speedKmh)} km/h
                </div>
                <div className="text-[10px] text-zinc-500 font-mono uppercase">
                  Sebesség ({gearLabel})
                </div>
              </div>
            </div>
          </div>

          {/* Pressure Bars */}
          <div className="grid grid-cols-3 gap-2 w-full pt-3 border-t border-zinc-800/70">
            <div className="flex flex-col items-center">
              <div className="h-12 w-3 bg-zinc-950 rounded-full overflow-hidden flex items-end border border-zinc-800">
                <div
                  className="w-full bg-blue-500/80 transition-all duration-75"
                  style={{
                    height: `${Math.max(0, Math.min(100, (pressures.man / 101325) * 100))}%`,
                  }}
                />
              </div>
              <div className="text-[10px] text-zinc-400 font-mono uppercase mt-1.5">
                MAP {(pressures.man / 1000).toFixed(0)} kPa
              </div>
            </div>
            <div className="flex flex-col items-center">
              <div className="h-12 w-3 bg-zinc-950 rounded-full overflow-hidden flex items-end border border-zinc-800">
                <div
                  className="w-full bg-orange-500/80 transition-all duration-75"
                  style={{
                    height: `${Math.max(
                      0,
                      Math.min(100, ((pressures.exL - 100000) / 100000) * 100)
                    )}%`,
                  }}
                />
              </div>
              <div className="text-[10px] text-zinc-400 font-mono uppercase mt-1.5">Kipuf. B</div>
            </div>
            <div className="flex flex-col items-center">
              <div className="h-12 w-3 bg-zinc-950 rounded-full overflow-hidden flex items-end border border-zinc-800">
                <div
                  className="w-full bg-orange-500/80 transition-all duration-75"
                  style={{
                    height: `${Math.max(
                      0,
                      Math.min(100, ((pressures.exR - 100000) / 100000) * 100)
                    )}%`,
                  }}
                />
              </div>
              <div className="text-[10px] text-zinc-400 font-mono uppercase mt-1.5">Kipuf. J</div>
            </div>
          </div>
        </div>
      </div>

      {/* Master Final Audio Filter, Exhaust Midrange EQ & Output Mixer Panel */}
      <div className="bg-zinc-900/70 p-6 rounded-xl border border-zinc-800 space-y-5">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 border-b border-zinc-800 pb-4">
          <div className="flex items-center gap-2.5">
            <Sliders size={18} className="text-emerald-400" />
            <div>
              <h3 className="text-sm font-mono font-bold text-zinc-100 uppercase tracking-wider">
                Végső Hangszűrők, Kipufogó Középtartomány EQ & Kimeneti Keverő (Phase 9 & Game Lite)
              </h3>
              <p className="text-xs text-zinc-400">
                Közvetlen valós idejű hozzáférés a szimulátor összes végső szűrőjéhez: Worklet -6 dB/oct LPF, kipufogóvég sugárzási LPF, WebAudio -12 dB/oct Biquad LPF, 400–2500 Hz kipufogó közép-kiemelés (fülvédő-hatás ellen) és hangforrás-arányok.
              </p>
            </div>
          </div>

          {/* Quick Filter & EQ Presets */}
          <div className="flex flex-wrap gap-1.5">
            {[
              {
                label: "Alapértelmezett (Nyílt V8)",
                apply: () => {
                  setHighCutEnabled(true);
                  setHighCutHz(7800);
                  setRadCutoffHz(8200);
                  setAirRolloffEnabled(true);
                  setAirRolloffHz(9500);
                  setAirRolloffQ(0.58);
                  setMidEqHz(880);
                  setMidEqGainDb(2.2);
                  setMidEqQ(0.65);
                  setBodyEqHz(125);
                  setBodyEqGainDb(1.6);
                  setSubHpfHz(24);
                  setExhaustLevel(0.82);
                  setIntakeLevel(0.36);
                  setMechLevel(0.95);
                  setJetNoiseScale(0.75);
                  setReverbWet(0.14);
                },
              },
              {
                label: "Közép-Kiemelt (400–2000 Hz Punch)",
                apply: () => {
                  setHighCutEnabled(true);
                  setHighCutHz(8400);
                  setRadCutoffHz(8800);
                  setAirRolloffEnabled(true);
                  setAirRolloffHz(10500);
                  setAirRolloffQ(0.65);
                  setMidEqHz(760);
                  setMidEqGainDb(5.0);
                  setMidEqQ(0.55);
                  setBodyEqHz(135);
                  setBodyEqGainDb(2.6);
                  setSubHpfHz(24);
                  setExhaustLevel(0.95);
                  setIntakeLevel(0.34);
                  setMechLevel(0.88);
                  setJetNoiseScale(0.65);
                  setReverbWet(0.15);
                },
              },
              {
                label: "Lágy Magas + Erős Közép (Fülvédő Nélkül)",
                apply: () => {
                  setHighCutEnabled(true);
                  setHighCutHz(4600);
                  setRadCutoffHz(7600);
                  setAirRolloffEnabled(true);
                  setAirRolloffHz(6200);
                  setAirRolloffQ(0.75);
                  setMidEqHz(920);
                  setMidEqGainDb(5.8);
                  setMidEqQ(0.55);
                  setBodyEqHz(130);
                  setBodyEqGainDb(2.2);
                  setSubHpfHz(25);
                  setExhaustLevel(0.92);
                  setIntakeLevel(0.30);
                  setMechLevel(0.85);
                  setJetNoiseScale(0.50);
                  setReverbWet(0.14);
                },
              },
              {
                label: "Nyers Szimulátor (Filter Bypass)",
                apply: () => {
                  setHighCutEnabled(false);
                  setRadCutoffHz(14000);
                  setAirRolloffEnabled(false);
                  setMidEqGainDb(0.0);
                  setBodyEqGainDb(0.0);
                  setSubHpfHz(15);
                },
              },
            ].map((preset) => (
              <button
                key={preset.label}
                onClick={preset.apply}
                className="px-2.5 py-1.5 rounded text-[11px] font-mono font-bold bg-zinc-950 hover:bg-zinc-800 text-emerald-300 border border-zinc-800 transition-colors"
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Sub-column 1: High-Cut & Tailpipe Radiation LPFs */}
          <div className="p-4 rounded-lg bg-zinc-950 border border-zinc-800 space-y-3.5">
            <div className="text-xs font-mono font-bold uppercase text-emerald-400 border-b border-zinc-800 pb-2">
              1. Magasvágó Szűrők (LPF Lánc)
            </div>

            {/* Worklet 1-Pole -6 dB/oct High-Cut */}
            <div className="space-y-1.5">
              <div className="flex justify-between items-center text-xs font-mono">
                <span className="text-zinc-300">Worklet -6 dB/oct LPF</span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setHighCutEnabled((p) => !p)}
                    className={cn(
                      "px-2 py-0.5 rounded text-[10px] font-bold border",
                      highCutEnabled
                        ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/40"
                        : "bg-zinc-900 text-zinc-500 border-zinc-800"
                    )}
                  >
                    {highCutEnabled ? "ON" : "BYPASS"}
                  </button>
                  <span className="font-bold text-emerald-400">
                    {highCutEnabled ? `${highCutHz} Hz` : "OFF"}
                  </span>
                </div>
              </div>
              <input
                type="range"
                className="w-full accent-emerald-500 cursor-pointer"
                min={1000}
                max={18000}
                step={100}
                disabled={!highCutEnabled}
                value={highCutHz}
                onChange={(e) => setHighCutHz(parseFloat(e.target.value))}
              />
            </div>

            {/* Tailpipe Radiation Cutoff (-6 dB/oct inside Levine-Schwinger) */}
            <div className="space-y-1.5">
              <div className="flex justify-between items-center text-xs font-mono">
                <span className="text-zinc-300">Kipufogóvég Sugárzási LPF (-6 dB/oct)</span>
                <span className="font-bold text-emerald-400">{radCutoffHz} Hz</span>
              </div>
              <input
                type="range"
                className="w-full accent-emerald-500 cursor-pointer"
                min={1500}
                max={16000}
                step={100}
                value={radCutoffHz}
                onChange={(e) => setRadCutoffHz(parseFloat(e.target.value))}
              />
            </div>

            {/* WebAudio 2-Pole -12 dB/oct Biquad LPF (airRolloff) */}
            <div className="space-y-1.5">
              <div className="flex justify-between items-center text-xs font-mono">
                <span className="text-zinc-300">WebAudio -12 dB/oct Biquad LPF</span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setAirRolloffEnabled((p) => !p)}
                    className={cn(
                      "px-2 py-0.5 rounded text-[10px] font-bold border",
                      airRolloffEnabled
                        ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/40"
                        : "bg-zinc-900 text-zinc-500 border-zinc-800"
                    )}
                  >
                    {airRolloffEnabled ? "ON" : "BYPASS"}
                  </button>
                  <span className="font-bold text-emerald-400">
                    {airRolloffEnabled ? `${airRolloffHz} Hz` : "OFF"}
                  </span>
                </div>
              </div>
              <input
                type="range"
                className="w-full accent-emerald-500 cursor-pointer"
                min={1500}
                max={18000}
                step={100}
                disabled={!airRolloffEnabled}
                value={airRolloffHz}
                onChange={(e) => setAirRolloffHz(parseFloat(e.target.value))}
              />
            </div>

            {/* WebAudio LPF Resonance Q */}
            <div className="space-y-1.5">
              <div className="flex justify-between items-center text-xs font-mono">
                <span className="text-zinc-400">Biquad LPF Jósági Tényező (Q)</span>
                <span className="font-bold text-zinc-200">{airRolloffQ.toFixed(2)}</span>
              </div>
              <input
                type="range"
                className="w-full accent-emerald-500 cursor-pointer"
                min={0.3}
                max={2.0}
                step={0.05}
                disabled={!airRolloffEnabled}
                value={airRolloffQ}
                onChange={(e) => setAirRolloffQ(parseFloat(e.target.value))}
              />
            </div>
          </div>

          {/* Sub-column 2: Exhaust Midrange & Low-Mid Body Parametric EQ */}
          <div className="p-4 rounded-lg bg-zinc-950 border border-zinc-800 space-y-3.5">
            <div className="text-xs font-mono font-bold uppercase text-amber-400 border-b border-zinc-800 pb-2">
              2. Kipufogó Középtartomány & Test EQ
            </div>

            {/* Midrange Peaking Gain (dB) */}
            <div className="space-y-1.5">
              <div className="flex justify-between items-center text-xs font-mono">
                <span className="text-zinc-300">Középtartomány Kiemelés (Mid Gain)</span>
                <span className="font-bold text-amber-400">
                  {midEqGainDb >= 0 ? `+${midEqGainDb.toFixed(1)}` : midEqGainDb.toFixed(1)} dB
                </span>
              </div>
              <input
                type="range"
                className="w-full accent-amber-500 cursor-pointer"
                min={-12}
                max={12}
                step={0.2}
                value={midEqGainDb}
                onChange={(e) => setMidEqGainDb(parseFloat(e.target.value))}
              />
            </div>

            {/* Midrange Center Frequency (Hz) */}
            <div className="space-y-1.5">
              <div className="flex justify-between items-center text-xs font-mono">
                <span className="text-zinc-300">Közép EQ Frekvencia (300–3500 Hz)</span>
                <span className="font-bold text-amber-400">{midEqHz} Hz</span>
              </div>
              <input
                type="range"
                className="w-full accent-amber-500 cursor-pointer"
                min={300}
                max={3500}
                step={20}
                value={midEqHz}
                onChange={(e) => setMidEqHz(parseFloat(e.target.value))}
              />
            </div>

            {/* Midrange Bandwidth Q */}
            <div className="space-y-1.5">
              <div className="flex justify-between items-center text-xs font-mono">
                <span className="text-zinc-400">Közép EQ Sávszélesség (Q)</span>
                <span className="font-bold text-zinc-200">{midEqQ.toFixed(2)}</span>
              </div>
              <input
                type="range"
                className="w-full accent-amber-500 cursor-pointer"
                min={0.25}
                max={2.5}
                step={0.05}
                value={midEqQ}
                onChange={(e) => setMidEqQ(parseFloat(e.target.value))}
              />
            </div>

            {/* Low-Mid Body EQ & Sub-HPF */}
            <div className="grid grid-cols-2 gap-3 pt-1">
              <div className="space-y-1">
                <div className="flex justify-between text-[11px] font-mono">
                  <span className="text-zinc-400">Mély-Test ({bodyEqHz}Hz)</span>
                  <span className="font-bold text-amber-400">
                    {bodyEqGainDb >= 0 ? `+${bodyEqGainDb.toFixed(1)}` : bodyEqGainDb.toFixed(1)} dB
                  </span>
                </div>
                <input
                  type="range"
                  className="w-full accent-amber-500 cursor-pointer"
                  min={-10}
                  max={10}
                  step={0.5}
                  value={bodyEqGainDb}
                  onChange={(e) => setBodyEqGainDb(parseFloat(e.target.value))}
                />
              </div>
              <div className="space-y-1">
                <div className="flex justify-between text-[11px] font-mono">
                  <span className="text-zinc-400">Sub-HPF Vágás</span>
                  <span className="font-bold text-zinc-200">{subHpfHz} Hz</span>
                </div>
                <input
                  type="range"
                  className="w-full accent-amber-500 cursor-pointer"
                  min={10}
                  max={120}
                  step={2}
                  value={subHpfHz}
                  onChange={(e) => setSubHpfHz(parseFloat(e.target.value))}
                />
              </div>
            </div>
          </div>

          {/* Sub-column 3: Source Component Mixer & Turbulence / Cabinet IR */}
          <div className="p-4 rounded-lg bg-zinc-950 border border-zinc-800 space-y-3.5">
            <div className="text-xs font-mono font-bold uppercase text-fuchsia-400 border-b border-zinc-800 pb-2">
              3. Hangforrás Keverő (Kipufogó / Szívó / Blokk)
            </div>

            {/* Exhaust Level */}
            <div className="space-y-1.5">
              <div className="flex justify-between items-center text-xs font-mono">
                <span className="text-zinc-300">Kipufogó Szint (Exhaust Bark & Mid)</span>
                <span className="font-bold text-fuchsia-400">{Math.round(exhaustLevel * 100)}%</span>
              </div>
              <input
                type="range"
                className="w-full accent-fuchsia-500 cursor-pointer"
                min={0}
                max={1.5}
                step={0.02}
                value={exhaustLevel}
                onChange={(e) => setExhaustLevel(parseFloat(e.target.value))}
              />
            </div>

            {/* Intake Level */}
            <div className="space-y-1.5">
              <div className="flex justify-between items-center text-xs font-mono">
                <span className="text-zinc-300">Szívócső / Fojtószelep (Intake)</span>
                <span className="font-bold text-fuchsia-400">{Math.round(intakeLevel * 100)}%</span>
              </div>
              <input
                type="range"
                className="w-full accent-fuchsia-500 cursor-pointer"
                min={0}
                max={1.5}
                step={0.02}
                value={intakeLevel}
                onChange={(e) => setIntakeLevel(parseFloat(e.target.value))}
              />
            </div>

            {/* Mechanical Block & Valvetrain Level */}
            <div className="space-y-1.5">
              <div className="flex justify-between items-center text-xs font-mono">
                <span className="text-zinc-300">Motorblokk & Szelepvezérlés (Mech)</span>
                <span className="font-bold text-fuchsia-400">{Math.round(mechLevel * 100)}%</span>
              </div>
              <input
                type="range"
                className="w-full accent-fuchsia-500 cursor-pointer"
                min={0}
                max={1.5}
                step={0.02}
                value={mechLevel}
                onChange={(e) => setMechLevel(parseFloat(e.target.value))}
              />
            </div>

            {/* Jet Turbulence Noise & Exterior Cabinet IR */}
            <div className="grid grid-cols-2 gap-3 pt-1">
              <div className="space-y-1">
                <div className="flex justify-between text-[11px] font-mono">
                  <span className="text-zinc-400">Gázsugár Zaj (Jet)</span>
                  <span className="font-bold text-fuchsia-400">{Math.round(jetNoiseScale * 100)}%</span>
                </div>
                <input
                  type="range"
                  className="w-full accent-fuchsia-500 cursor-pointer"
                  min={0}
                  max={2.0}
                  step={0.05}
                  value={jetNoiseScale}
                  onChange={(e) => setJetNoiseScale(parseFloat(e.target.value))}
                />
              </div>
              <div className="space-y-1">
                <div className="flex justify-between text-[11px] font-mono">
                  <span className="text-zinc-400">Kültéri Tér (IR Wet)</span>
                  <span className="font-bold text-zinc-200">{Math.round(reverbWet * 100)}%</span>
                </div>
                <input
                  type="range"
                  className="w-full accent-fuchsia-500 cursor-pointer"
                  min={0}
                  max={0.4}
                  step={0.01}
                  value={reverbWet}
                  onChange={(e) => setReverbWet(parseFloat(e.target.value))}
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Attachable 3D/2D Game Vehicle Sound Source Panel */}
      <div className="bg-zinc-900/70 p-6 rounded-xl border border-zinc-800 space-y-5">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 border-b border-zinc-800 pb-4">
          <div className="flex items-center gap-2.5">
            <Radio size={18} className="text-emerald-400" />
            <div>
              <h3 className="text-sm font-mono font-bold text-zinc-100 uppercase tracking-wider">
                GameVehicleSoundSource — Játékbeli Autóra Csatolható 3D/2D Hangforrás Modul
              </h3>
              <p className="text-xs text-zinc-400">
                Közvetlenül ráköthető a játékbeli autó entitásra (pozíció, sebesség, irányvektor): távolság-csillapítás, -6 dB/oct légköri magaselnyelés, elöl (szívócső/blokk) vs. hátul (kipufogó) iránykarakterisztika és sztereó térhangzás.
              </p>
            </div>
          </div>

          <button
            onClick={() => {
              setEngineMode("lite");
              setSpatialMode((prev) => !prev);
            }}
            className={cn(
              "px-4 py-2 rounded-lg font-mono text-xs font-bold uppercase border transition-all",
              spatialMode
                ? "bg-emerald-500 text-zinc-950 border-emerald-400 shadow-lg shadow-emerald-500/15"
                : "bg-zinc-800 text-emerald-400 border-emerald-500/30 hover:bg-zinc-700"
            )}
          >
            {spatialMode ? "3D Autó Sound Source: AKTÍV" : "3D Autó Sound Source Teszt Bekapcsolása"}
          </button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Spatial Position & Directivity Controls */}
          <div className="space-y-4">
            <div className="space-y-2">
              <div className="flex justify-between text-xs font-mono">
                <span className="text-zinc-400">Hallgató Távolsága az Autótól (Distance Attenuation & -6 dB/oct Air Cut)</span>
                <span className="font-bold text-emerald-400">{listenerDistanceM.toFixed(1)} m</span>
              </div>
              <input
                type="range"
                className="w-full accent-emerald-500 cursor-pointer"
                min={1.5}
                max={75}
                step={0.5}
                value={listenerDistanceM}
                onChange={(e) => {
                  setSpatialMode(true);
                  setEngineMode("lite");
                  setListenerDistanceM(parseFloat(e.target.value));
                }}
              />
            </div>

            <div className="space-y-2">
              <div className="flex justify-between text-xs font-mono">
                <span className="text-zinc-400">Kamera / Hallgató Szöge az Autó Körül (-180°..+180°)</span>
                <span className="font-bold text-emerald-400">
                  {listenerAngleDeg}° (
                  {Math.abs(listenerAngleDeg) > 135
                    ? "Hátul • Kipufogó Fókusz"
                    : Math.abs(listenerAngleDeg) < 45
                    ? "Elöl • Motorháztető / Szívócső"
                    : listenerAngleDeg < 0
                    ? "Bal Oldal"
                    : "Jobb Oldal"}
                  )
                </span>
              </div>
              <input
                type="range"
                className="w-full accent-emerald-500 cursor-pointer"
                min={-180}
                max={180}
                step={5}
                value={listenerAngleDeg}
                onChange={(e) => {
                  setSpatialMode(true);
                  setEngineMode("lite");
                  setListenerAngleDeg(parseFloat(e.target.value));
                }}
              />
              <div className="grid grid-cols-4 gap-1.5 pt-1">
                {[
                  { label: "Hátul (180° Kipuf.)", angle: 180, dist: 3.0 },
                  { label: "Elöl (0° Motorházt.)", angle: 0, dist: 2.5 },
                  { label: "Jobb Oldal (+90°)", angle: 90, dist: 4.0 },
                  { label: "Távoli (35m Hátul)", angle: 165, dist: 35.0 },
                ].map((p) => (
                  <button
                    key={p.label}
                    onClick={() => {
                      setSpatialMode(true);
                      setEngineMode("lite");
                      setListenerAngleDeg(p.angle);
                      setListenerDistanceM(p.dist);
                    }}
                    className="py-1.5 px-2 rounded text-[11px] font-mono bg-zinc-950 hover:bg-zinc-800 text-zinc-300 border border-zinc-800 transition-colors"
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            {spatialTelemetry && (
              <div className="grid grid-cols-4 gap-2 pt-2 text-center font-mono text-xs">
                <div className="p-2 rounded bg-zinc-950 border border-zinc-800">
                  <div className="text-[10px] text-zinc-500 uppercase">Távolság Gain</div>
                  <div className="font-bold text-white">{(spatialTelemetry.distanceGain * 100).toFixed(0)}%</div>
                </div>
                <div className="p-2 rounded bg-zinc-950 border border-zinc-800">
                  <div className="text-[10px] text-zinc-500 uppercase">Légköri -6dB Cut</div>
                  <div className="font-bold text-emerald-400">
                    {(spatialTelemetry.effectiveHighCutHz / 1000).toFixed(2)} kHz
                  </div>
                </div>
                <div className="p-2 rounded bg-zinc-950 border border-zinc-800">
                  <div className="text-[10px] text-zinc-500 uppercase">Hátsó Kipuf. Arány</div>
                  <div className="font-bold text-amber-400">
                    {(spatialTelemetry.rearDirectivity * 100).toFixed(0)}%
                  </div>
                </div>
                <div className="p-2 rounded bg-zinc-950 border border-zinc-800">
                  <div className="text-[10px] text-zinc-500 uppercase">Sztereó Pan</div>
                  <div className="font-bold text-zinc-200">{spatialTelemetry.panStereo.toFixed(2)}</div>
                </div>
              </div>
            )}
          </div>

          {/* Ready-to-Use Game Loop Attachment Code Snippet */}
          <div className="p-4 rounded-lg bg-zinc-950 border border-zinc-800 font-mono text-xs text-zinc-300 space-y-2 overflow-x-auto">
            <div className="text-[11px] font-bold text-emerald-400 uppercase">
              Használat a játékban (src/audio/gameVehicleSoundSource.ts):
            </div>
            <pre className="text-[11px] leading-relaxed text-zinc-300">{`import { GameVehicleSoundSource } from "./audio/gameVehicleSoundSource";

// 1. Példányosítás az autó entitáshoz (~2-3% CPU @ 48 kHz):
const carSound = new GameVehicleSoundSource({
  sampleRate: 48000,
  refDistance: 2.5,
  maxDistance: 140.0,
  nearHighCutHz: 4800, // -6 dB/oct szűrő közelről
  farHighCutHz: 1050,  // -6 dB/oct légköri elnyelés távolról
});

// 2. Minden játék-frame-ben (update loop):
carSound.setControls({
  throttle: car.throttlePedal,     // 0.0 .. 1.0
  brakeLoadNm: car.brakePedal * 340,
  ignition: car.ignitionOn,
  starter: car.starterButton,
  driveMode: 1,                    // 6-sebességes automata (D)
});
carSound.setVehicleTransform(car.position, car.velocity, car.forward);
carSound.setListenerTransform(camera.position, camera.velocity, camera.right);

// 3. AudioWorklet / játék audio callback-ben (128 minta):
const telemetry = carSound.processBlock(outputLeft, outputRight);`}</pre>
          </div>
        </div>
      </div>
    </div>
  );
}
