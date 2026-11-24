import React, { useEffect, useRef, useState } from 'react';
import { Play, Square } from "lucide-react";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import phase9WorkletUrl from '../audio/phase9Worklet.ts?worker&url';

function cn(...inputs: (string | undefined | null | false)[]) {
  return twMerge(clsx(inputs));
}

// Synthesize a clean, zero-noise exterior tailpipe/underbody acoustic cabinet IR (32 ms, zero random white-noise tail, zero sine-wave ringing!).
// Provides subtle ground-plane & bumper boundary loading without adding synthetic reverb hiss or 20 dB comb-filter hollowness.
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

    // Subtle exterior close-field boundary reflections ONLY (no 0ms duplicate tap that causes comb cancellation with dry path!)
    const earlyTaps = ch === 0
      ? [
          { ms: 0.85, gain: 0.36 },  // rear valence / bumper lip diffraction
          { ms: 2.35, gain: 0.22 },  // asphalt ground reflection
          { ms: 6.10, gain: -0.11 }, // underbody diffuser scatter
          { ms: 12.4, gain: 0.06 },
        ]
      : [
          { ms: 0.95, gain: 0.36 },
          { ms: 2.55, gain: 0.22 },
          { ms: 6.60, gain: -0.11 },
          { ms: 13.2, gain: 0.06 },
        ];

    for (const tap of earlyTaps) {
      const idx = Math.floor((tap.ms / 1000) * sr);
      if (idx >= 0 && idx < length) {
        data[idx] += tap.gain;
      }
    }

    // Smooth boundary lowpass (~5.2 kHz -> ~1.6 kHz) so exterior reflections preserve natural V8 bite without metallic zing
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

export default function Phase9Demo() {
    const audioCtx = useRef<AudioContext | null>(null);
    const workletLoaded = useRef<boolean>(false);
    const workletNode = useRef<AudioWorkletNode | null>(null);
    const fadeGainRef = useRef<GainNode | null>(null);
    const outputNodes = useRef<AudioNode[]>([]);
    const stopTimeoutRef = useRef<number>(0);
    const sessionIdRef = useRef<number>(0);
    const analyserRef = useRef<AnalyserNode | null>(null);
    const visualizerBufRef = useRef<Float32Array<ArrayBuffer> | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const animationRef = useRef<number>(0);

    const [isPlaying, setIsPlaying] = useState(false);
    const [throttle, setThrottle] = useState(0);
    const [load, setLoad] = useState(0);
    const [rpm, setRpm] = useState(0);
    const [power, setPower] = useState(0);
    const [pressures, setPressures] = useState({ man: 101325, exL: 101325, exR: 101325 });
    const [ignition, setIgnition] = useState(true);
    const [starter, setStarter] = useState(false);
    // 0 = Neutral (N), 1 = Automatic Drive (D), -1..-6 = Manual Paddle Mode (M1..M6)
    const [driveMode, setDriveMode] = useState(1);
    const [gear, setGear] = useState(1);
    const [speedKmh, setSpeedKmh] = useState(0);

    const drawVisualizer = () => {
        if (!analyserRef.current || !canvasRef.current) return;

        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const width = canvas.width;
        const height = canvas.height;

        const bufferLength = analyserRef.current.frequencyBinCount;
        if (!visualizerBufRef.current || visualizerBufRef.current.length !== bufferLength) {
            visualizerBufRef.current = new Float32Array(bufferLength);
        }
        const dataArray = visualizerBufRef.current;
        analyserRef.current.getFloatTimeDomainData(dataArray);

        ctx.fillStyle = '#09090b'; // zinc-950
        ctx.fillRect(0, 0, width, height);

        ctx.lineWidth = 2;
        ctx.strokeStyle = '#f43f5e'; // rose-500
        ctx.beginPath();

        const sliceWidth = width * 1.0 / bufferLength;
        let x = 0;

        for (let i = 0; i < bufferLength; i++) {
            const v = dataArray[i];
            const y = (v * height / 2) + (height / 2);

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

    const startAudio = async () => {
        // Cancel any pending fade-out teardown and clean previous graph immediately
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
            const AudioContextBase = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
            audioCtx.current = new AudioContextBase();
            workletLoaded.current = false;
        }

        const ctx = audioCtx.current;
        if (ctx.state === 'suspended') {
            await ctx.resume();
        }
        if (mySession !== sessionIdRef.current) return;

        try {
            if (!workletLoaded.current) {
                await ctx.audioWorklet.addModule(phase9WorkletUrl);
                workletLoaded.current = true;
            }
            if (mySession !== sessionIdRef.current) return;

            const node = new AudioWorkletNode(ctx, 'phase9-processor', {
                outputChannelCount: [2]
            });

            // Clean acoustic mastering chain with balanced studio-mic dynamics + 20ms click-free fade-in/out:
            // Worklet -> (Dry 92% + Clean Exterior Boundary IR Convolver 16%) -> Warmth EQ -> Presence -> Air Rolloff -> Soft-Knee Limiter -> Master Trim -> Fade -> Analyser -> Destination
            const dryGain = ctx.createGain();
            dryGain.gain.value = 0.92;

            const wetGain = ctx.createGain();
            wetGain.gain.value = 0.16;

            const convolver = ctx.createConvolver();
            convolver.buffer = createExhaustSpaceIR(ctx);

            // Subtle close-mic chest warmth + crisp exterior tailpipe presence + ultrasonic rolloff above 10.8 kHz
            const bodyShelf = ctx.createBiquadFilter();
            bodyShelf.type = 'peaking';
            bodyShelf.frequency.value = 120;
            bodyShelf.Q.value = 0.80;
            bodyShelf.gain.value = 1.4;

            const presenceShelf = ctx.createBiquadFilter();
            presenceShelf.type = 'peaking';
            presenceShelf.frequency.value = 2650;
            presenceShelf.Q.value = 0.55;
            presenceShelf.gain.value = 3.2;

            const airRolloff = ctx.createBiquadFilter();
            airRolloff.type = 'lowpass';
            airRolloff.frequency.value = 10800;
            airRolloff.Q.value = 0.65;

            // Fast transparent soft-knee limiter + master headroom trim: keeps Idle/Crank present and WOT strictly unclipped
            const limiter = ctx.createDynamicsCompressor();
            limiter.threshold.value = -9.5;
            limiter.knee.value = 12.0;
            limiter.ratio.value = 8.0;
            limiter.attack.value = 0.001;
            limiter.release.value = 0.085;

            const masterGain = ctx.createGain();
            masterGain.gain.value = 0.86;

            const fadeGain = ctx.createGain();
            const now = ctx.currentTime;
            fadeGain.gain.setValueAtTime(0.0001, now);
            fadeGain.gain.linearRampToValueAtTime(1.0, now + 0.02);

            const analyser = ctx.createAnalyser();
            analyser.fftSize = 2048;

            node.connect(dryGain);
            node.connect(convolver);
            convolver.connect(wetGain);

            dryGain.connect(bodyShelf);
            wetGain.connect(bodyShelf);
            bodyShelf.connect(presenceShelf);
            presenceShelf.connect(airRolloff);
            airRolloff.connect(limiter);
            limiter.connect(masterGain);
            masterGain.connect(fadeGain);
            fadeGain.connect(analyser);
            analyser.connect(ctx.destination);

            workletNode.current = node;
            fadeGainRef.current = fadeGain;
            analyserRef.current = analyser;
            outputNodes.current = [node, dryGain, wetGain, convolver, bodyShelf, presenceShelf, airRolloff, limiter, masterGain, fadeGain, analyser];

            node.port.onmessage = (e) => {
                if (mySession !== sessionIdRef.current) return;
                if (e.data.type === 'telemetry') {
                    setRpm(e.data.rpm);
                    setPower(e.data.power);
                    setPressures({
                        man: e.data.manP,
                        exL: e.data.exPL,
                        exR: e.data.exPR
                    });
                    if (e.data.gear !== undefined) setGear(e.data.gear);
                    if (e.data.speedKmh !== undefined) setSpeedKmh(e.data.speedKmh);
                }
            };

            // Sync UI state immediately on engine init
            node.port.postMessage({
                type: 'init',
                throttle,
                load,
                ignition,
                starter,
                driveMode
            });

            setIsPlaying(true);
            drawVisualizer();
        } catch (e) {
            console.error("Failed to start Phase 9:", e);
        }
    };

    const stopAudio = (immediate = false) => {
        sessionIdRef.current += 1;
        if (stopTimeoutRef.current) {
            window.clearTimeout(stopTimeoutRef.current);
            stopTimeoutRef.current = 0;
        }

        const nodesToDisconnect = outputNodes.current;
        const fadeNode = fadeGainRef.current;
        const ctx = audioCtx.current;

        outputNodes.current = [];
        workletNode.current = null;
        fadeGainRef.current = null;
        analyserRef.current = null;

        if (animationRef.current) {
            cancelAnimationFrame(animationRef.current);
            animationRef.current = 0;
        }
        setIsPlaying(false);

        if (!immediate && fadeNode && ctx && ctx.state === 'running' && nodesToDisconnect.length > 0) {
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

    const updateParams = () => {
        if (workletNode.current) {
            workletNode.current.port.postMessage({
                type: 'params',
                throttle,
                load,
                ignition,
                starter,
                driveMode
            });
        }
    };

    useEffect(() => {
        updateParams();
    }, [throttle, load, ignition, starter, driveMode]);

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

    const engineState = rpm < 50 ? "STALLED" : (!ignition ? "CUT" : (throttle > 0.8 && rpm > 2000 ? "WOT" : (throttle > 0.1 ? "PULLING" : (rpm > 1200 ? "OVERRUN" : "IDLE"))));
    const gearLabel = driveMode === 0 || gear === 0 ? "N" : driveMode > 0 ? `D${gear}` : `M${Math.abs(driveMode)}`;

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-2xl font-bold tracking-tight">Phase 9: Physical Engine Simulator</h2>
                    <p className="text-muted-foreground">True 1D fluid dynamics and thermodynamic engine modeling.</p>
                </div>
            </div>

            <div className="border border-zinc-800 bg-zinc-900/50 rounded-xl overflow-hidden">
                <div className="p-6 border-b border-zinc-800">
                    <div className="flex justify-between items-center">
                        <span className="text-lg font-semibold">V8 Engine Test Stand</span>
                        <button 
                            className={cn(
                                "flex items-center gap-2 px-4 py-2 rounded-md font-medium text-sm transition-colors",
                                isPlaying 
                                    ? "bg-red-500/10 text-red-500 hover:bg-red-500/20" 
                                    : "bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20"
                            )}
                            onClick={isPlaying ? () => stopAudio(false) : startAudio}
                        >
                            {isPlaying ? <Square size={16} /> : <Play size={16} />}
                            {isPlaying ? 'Stop Engine' : 'Start Engine'}
                        </button>
                    </div>
                    <p className="text-sm text-zinc-400 mt-2">
                        Calculates gas flow, pressure, temperature, and Wiebe combustion forces in real-time. Audio is generated physically through individual primary header runners, 4-into-1 collectors, H-pipe, expansion mufflers, intake snorkel waveguide, and acoustic space convolution.
                    </p>
                </div>
                <div className="p-6 space-y-6">
                    
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
                        <div className="space-y-5 bg-zinc-950 p-6 rounded-xl border border-zinc-800 col-span-1">
                            <h3 className="text-sm font-medium text-zinc-400 uppercase tracking-widest">Controls</h3>
                            
                            <div className="flex gap-4">
                                <button 
                                    onClick={() => setIgnition(!ignition)}
                                    className={cn("flex-1 py-2 px-4 rounded-md font-medium transition-colors border", ignition ? "bg-rose-500/10 text-rose-500 border-rose-500/30" : "bg-zinc-900 text-zinc-400 border-zinc-800")}
                                >
                                    Ignition {ignition ? "ON" : "OFF"}
                                </button>
                                <button 
                                    onMouseDown={() => setStarter(true)}
                                    onMouseUp={() => setStarter(false)}
                                    onMouseLeave={() => setStarter(false)}
                                    onTouchStart={() => setStarter(true)}
                                    onTouchEnd={() => setStarter(false)}
                                    className={cn("flex-1 py-2 px-4 rounded-md font-medium transition-colors border", starter ? "bg-amber-500/20 text-amber-500 border-amber-500/50" : "bg-zinc-900 text-zinc-400 border-zinc-800")}
                                >
                                    Starter
                                </button>
                            </div>

                            <div className="space-y-2 pt-1">
                                <div className="flex justify-between items-center">
                                    <label className="text-sm font-medium">6-Speed Auto Transmission</label>
                                    <span className="text-xs font-mono font-bold px-2 py-0.5 rounded bg-fuchsia-500/15 text-fuchsia-400 border border-fuchsia-500/30">
                                        {gearLabel} • {Math.round(speedKmh)} km/h
                                    </span>
                                </div>
                                <div className="grid grid-cols-5 gap-1.5">
                                    <button
                                        onClick={() => setDriveMode(0)}
                                        className={cn(
                                            "py-1.5 rounded-md font-mono text-xs font-bold border transition-colors",
                                            driveMode === 0
                                                ? "bg-zinc-200 text-zinc-950 border-white"
                                                : "bg-zinc-900 text-zinc-400 border-zinc-800 hover:bg-zinc-800"
                                        )}
                                    >
                                        N
                                    </button>
                                    <button
                                        onClick={() => setDriveMode(1)}
                                        className={cn(
                                            "py-1.5 rounded-md font-mono text-xs font-bold border transition-colors",
                                            driveMode === 1
                                                ? "bg-fuchsia-500/20 text-fuchsia-400 border-fuchsia-500/50"
                                                : "bg-zinc-900 text-zinc-400 border-zinc-800 hover:bg-zinc-800"
                                        )}
                                    >
                                        D (Auto)
                                    </button>
                                    <button
                                        onClick={() => setDriveMode(-(gear > 0 ? gear : 1))}
                                        className={cn(
                                            "py-1.5 rounded-md font-mono text-xs font-bold border transition-colors",
                                            driveMode < 0
                                                ? "bg-amber-500/20 text-amber-400 border-amber-500/50"
                                                : "bg-zinc-900 text-zinc-400 border-zinc-800 hover:bg-zinc-800"
                                        )}
                                    >
                                        M (Hold)
                                    </button>
                                    <button
                                        onClick={() => {
                                            const cur = driveMode < 0 ? Math.abs(driveMode) : (gear > 0 ? gear : 1);
                                            setDriveMode(-Math.max(1, cur - 1));
                                        }}
                                        className="py-1.5 rounded-md font-mono text-xs font-bold border bg-zinc-900 text-zinc-300 border-zinc-800 hover:bg-zinc-800 transition-colors"
                                        title="Downshift Paddle"
                                    >
                                        - Gear
                                    </button>
                                    <button
                                        onClick={() => {
                                            const cur = driveMode < 0 ? Math.abs(driveMode) : (gear > 0 ? gear : 1);
                                            setDriveMode(-Math.min(6, cur + 1));
                                        }}
                                        className="py-1.5 rounded-md font-mono text-xs font-bold border bg-zinc-900 text-zinc-300 border-zinc-800 hover:bg-zinc-800 transition-colors"
                                        title="Upshift Paddle"
                                    >
                                        + Gear
                                    </button>
                                </div>
                            </div>

                            <div className="space-y-3 pt-1">
                                <div className="flex justify-between">
                                    <label className="text-sm font-medium">Throttle</label>
                                    <span className="text-sm text-zinc-400 font-mono">{(throttle * 100).toFixed(0)}%</span>
                                </div>
                                <input 
                                    type="range"
                                    className="w-full accent-fuchsia-500"
                                    value={throttle} 
                                    min={0} max={1} step={0.01}
                                    onChange={e => setThrottle(parseFloat(e.target.value))} 
                                />
                            </div>
                            
                            <div className="space-y-3 pt-2">
                                <div className="flex justify-between">
                                    <label className="text-sm font-medium">Wheel / Dyno Brake Load</label>
                                    <span className="text-sm text-zinc-400 font-mono">{load.toFixed(0)} Nm</span>
                                </div>
                                <input 
                                    type="range"
                                    className="w-full accent-fuchsia-500"
                                    value={load} 
                                    min={0} max={500} step={5}
                                    onChange={e => setLoad(parseFloat(e.target.value))} 
                                />
                            </div>
                        </div>

                        <div className="space-y-4 bg-zinc-950 p-6 rounded-xl border border-zinc-800 flex flex-col justify-center items-center col-span-1 lg:col-span-1">
                            <h3 className="text-sm font-medium text-zinc-400 self-start uppercase tracking-widest">Exhaust Audio Signal</h3>
                            <div className="w-full h-48 bg-zinc-950 rounded-lg overflow-hidden border border-zinc-800">
                                <canvas ref={canvasRef} width={800} height={200} className="w-full h-full" />
                            </div>
                        </div>
                        
                        <div className="space-y-4 bg-zinc-950 p-6 rounded-xl border border-zinc-800 flex flex-col justify-center items-center col-span-1 md:col-span-2 lg:col-span-1">
                            <div className="flex w-full justify-between items-center self-start">
                                <h3 className="text-sm font-medium text-zinc-400 uppercase tracking-widest">Telemetry</h3>
                                <div className="flex items-center gap-2">
                                    <div className="px-2 py-1 text-[10px] font-bold font-mono rounded-md tracking-wider border bg-fuchsia-500/10 text-fuchsia-400 border-fuchsia-500/20">
                                        {gearLabel} • {Math.round(speedKmh)} KM/H
                                    </div>
                                    <div className={cn("px-2 py-1 text-[10px] font-bold rounded-md tracking-widest border", 
                                        engineState === "STALLED" ? "bg-red-500/10 text-red-500 border-red-500/20" :
                                        engineState === "IDLE" ? "bg-blue-500/10 text-blue-400 border-blue-500/20" :
                                        engineState === "WOT" ? "bg-amber-500/10 text-amber-500 border-amber-500/20" :
                                        engineState === "PULLING" ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" :
                                        "bg-zinc-800 text-zinc-400 border-zinc-700"
                                    )}>
                                        {engineState}
                                    </div>
                                </div>
                            </div>
                            <div className="flex flex-col items-center justify-center py-4 w-full gap-4">
                                <div className="text-center w-full flex flex-col items-center">
                                    <div className="relative w-48 h-48 flex items-center justify-center">
                                        <svg viewBox="0 0 200 200" className="w-full h-full absolute top-0 left-0">
                                            {/* Dial background */}
                                            <path d="M 40 160 A 80 80 0 1 1 160 160" fill="none" stroke="#27272a" strokeWidth="8" strokeLinecap="round" />
                                            {/* Redline */}
                                            <path d="M 140 35 A 80 80 0 0 1 160 160" fill="none" stroke="#ef4444" strokeWidth="8" strokeLinecap="round" opacity="0.5" />
                                            
                                            {/* Ticks */}
                                            {Array.from({ length: 9 }).map((_, i) => {
                                                const ang = (-120 + i * (240 / 8)) * (Math.PI / 180);
                                                const x1 = 100 + Math.sin(ang) * 65;
                                                const y1 = 100 - Math.cos(ang) * 65;
                                                const x2 = 100 + Math.sin(ang) * 75;
                                                const y2 = 100 - Math.cos(ang) * 75;
                                                return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={i >= 7 ? "#ef4444" : "#52525b"} strokeWidth="3" strokeLinecap="round" />;
                                            })}
                                            
                                            {/* Needle */}
                                            <g style={{ transform: `rotate(${-120 + (Math.min(rpm, 8000) / 8000) * 240}deg)`, transformOrigin: '100px 100px', transition: 'transform 50ms linear' }}>
                                                <line x1="100" y1="100" x2="100" y2="30" stroke="#f43f5e" strokeWidth="4" strokeLinecap="round" />
                                                <circle cx="100" cy="100" r="8" fill="#f43f5e" />
                                            </g>
                                        </svg>
                                        <div className="absolute flex flex-col items-center mt-12">
                                            <div className="text-3xl font-black tracking-tighter text-white font-mono leading-none">
                                                {Math.round(rpm)}
                                            </div>
                                            <div className="text-[10px] text-zinc-500 font-bold tracking-widest uppercase mt-1">RPM</div>
                                        </div>
                                    </div>
                                    <div className="mt-2 flex flex-col items-center">
                                        <div className="text-xl font-bold text-emerald-400 font-mono">
                                            {Math.max(0, (power / 745.7)).toFixed(1)} HP
                                        </div>
                                        <div className="text-xs text-zinc-500 font-medium tracking-widest uppercase">Power</div>
                                    </div>
                                </div>
                                
                                <div className="grid grid-cols-3 gap-2 w-full pt-4 border-t border-zinc-800/50">
                                    <div className="flex flex-col items-center">
                                        <div className="h-16 w-3 bg-zinc-900 rounded-full overflow-hidden flex items-end relative">
                                            <div className="w-full bg-blue-500/80 transition-all duration-75" style={{ height: `${Math.max(0, Math.min(100, (pressures.man / 101325) * 100))}%` }} />
                                        </div>
                                        <div className="text-[10px] text-zinc-500 font-medium uppercase mt-2">Intake</div>
                                    </div>
                                    <div className="flex flex-col items-center">
                                        <div className="h-16 w-3 bg-zinc-900 rounded-full overflow-hidden flex items-end relative">
                                            <div className="w-full bg-orange-500/80 transition-all duration-75" style={{ height: `${Math.max(0, Math.min(100, ((pressures.exL - 100000) / 100000) * 100))}%` }} />
                                        </div>
                                        <div className="text-[10px] text-zinc-500 font-medium uppercase mt-2">Ex. L</div>
                                    </div>
                                    <div className="flex flex-col items-center">
                                        <div className="h-16 w-3 bg-zinc-900 rounded-full overflow-hidden flex items-end relative">
                                            <div className="w-full bg-orange-500/80 transition-all duration-75" style={{ height: `${Math.max(0, Math.min(100, ((pressures.exR - 100000) / 100000) * 100))}%` }} />
                                        </div>
                                        <div className="text-[10px] text-zinc-500 font-medium uppercase mt-2">Ex. R</div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>

                </div>
            </div>
        </div>
    );
}
