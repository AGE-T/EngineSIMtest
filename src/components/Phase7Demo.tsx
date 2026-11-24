import { useState, useRef, useEffect, useCallback } from "react";
import { phase6WorkletCode } from "../audio/phase6Worklet";
import { engines, EngineConfig } from "../data/engines";
import { Play, Square, Key, Gauge, ArrowUpCircle, ArrowDownCircle, Gamepad2, Wind } from "lucide-react";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

function cn(...inputs: (string | undefined | null | false)[]) {
  return twMerge(clsx(inputs));
}

function generateReverbIR(ctx: AudioContext, type: "track" | "cabin" | "tunnel") {
    let duration = 0.4;
    let decay = 10.0;
    let filterFreq = 3000;

    if (type === "tunnel") {
        duration = 1.5;
        decay = 3.0;
        filterFreq = 800; 
    } else if (type === "cabin") {
        duration = 0.15;
        decay = 20.0;
        filterFreq = 1000;
    } else { 
        duration = 0.6;
        decay = 12.0;
        filterFreq = 4000;
    }

    const sr = ctx.sampleRate;
    const length = Math.floor(sr * duration);
    const buffer = ctx.createBuffer(2, length, sr);
    
    for (let c = 0; c < 2; c++) {
        const channel = buffer.getChannelData(c);
        let lastVal = 0;
        for (let i = 0; i < length; i++) {
            let noise = (Math.random() * 2 - 1);
            let alpha = filterFreq / sr; 
            lastVal = lastVal + alpha * (noise - lastVal);
            channel[i] = lastVal * Math.exp(-decay * i / sr) * 0.15;
        }
    }
    return buffer;
}

export function Phase7Demo() {
  const [isPlaying, setIsPlaying] = useState(false);
  const [engineKey, setEngineKey] = useState<string>("v8-flatplane");
  const [turboEnabled, setTurboEnabled] = useState(true);
  
  const [error, setError] = useState<string | null>(null);

  const audioContextRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const masterGainRef = useRef<GainNode | null>(null);

  const rpmDashRef = useRef<HTMLSpanElement>(null);
  const speedDashRef = useRef<HTMLSpanElement>(null);
  const gearDashRef = useRef<HTMLSpanElement>(null);

  const activeEngine = engines[engineKey];

  // Physics Engine State
  const inputsRef = useRef({ throttle: false, brake: false });
  const physicsRef = useRef({
    speed: 0,
    rpm: 1000,
    gear: 0, // 0 = Neutral
    clutch: 0,
    throttleInput: 0,
    brakeInput: 0,
    lastTime: performance.now(),
    gearRatios: [0, 3.42, 2.10, 1.45, 1.03, 0.81, 0.62],
    finalDrive: 3.73,
    wheelRadius: 0.33,
    mass: 1500,
    maxRpm: 7500,
    drivetrainFlexVel: 0
  });

  const updateEngineConfig = useCallback((config: EngineConfig) => {
    if (workletNodeRef.current) {
      workletNodeRef.current.port.postMessage({ type: "config", config });
    }
    physicsRef.current.maxRpm = config.metadata.max_rpm;
    physicsRef.current.gearRatios = config.metadata.gearRatios || [0, 3.42, 2.10, 1.45, 1.03, 0.81, 0.62, 0.52];
    physicsRef.current.finalDrive = config.metadata.finalDrive || 3.73;
    physicsRef.current.mass = config.metadata.mass || 1500;
    physicsRef.current.wheelRadius = config.metadata.wheelRadius || 0.33;
    
    if (physicsRef.current.gear >= physicsRef.current.gearRatios.length) {
        physicsRef.current.gear = physicsRef.current.gearRatios.length - 1;
    }
  }, []);

  const shiftUp = useCallback(() => {
    const state = physicsRef.current;
    if (state.gear === 0) {
        state.gear = 1;
        return;
    }
    if (state.gear >= state.gearRatios.length - 1 || state.clutch > 0) return;
    
    // Snappy DCT Upshift
    state.clutch = 1;
    state.throttleInput = 0; 
    
    setTimeout(() => {
        state.gear++;
        state.clutch = 0;
    }, 60); // 60ms shift time
  }, []);

  const shiftDown = useCallback(() => {
    const state = physicsRef.current;
    if (state.gear <= 1) {
        state.gear = 0;
        return;
    }
    if (state.clutch > 0) return;
    
    // Auto-blip Downshift
    state.clutch = 1;
    state.throttleInput = 1.0; // Rev match blip
    
    setTimeout(() => {
        state.gear--;
        state.clutch = 0;
    }, 120); // 120ms downshift
  }, []);

  // Keyboard Listeners
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === "w" || e.key === "ArrowUp") inputsRef.current.throttle = true;
        if (e.key === "s" || e.key === "ArrowDown") inputsRef.current.brake = true;
        if (e.key.toLowerCase() === "e" || e.key === "Shift") shiftUp();
        if (e.key.toLowerCase() === "q" || e.key === "Control") shiftDown();
    };
    const handleKeyUp = (e: KeyboardEvent) => {
        if (e.key === "w" || e.key === "ArrowUp") inputsRef.current.throttle = false;
        if (e.key === "s" || e.key === "ArrowDown") inputsRef.current.brake = false;
    };
    
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
        window.removeEventListener("keydown", handleKeyDown);
        window.removeEventListener("keyup", handleKeyUp);
    };
  }, [shiftUp, shiftDown]);

  const togglePlayback = async () => {
    try {
      if (isPlaying) {
        audioContextRef.current?.suspend();
        setIsPlaying(false);
        return;
      }

      if (!audioContextRef.current) {
        const AudioContextBase = window.AudioContext || (window as any).webkitAudioContext;
        const ctx = new AudioContextBase();
        audioContextRef.current = ctx;

        // Reusing Phase 6 Worklet for DSP (which has Turbo built-in!)
        const blob = new Blob([phase6WorkletCode], { type: "application/javascript" });
        const url = URL.createObjectURL(blob);

        await ctx.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);

        const node = new AudioWorkletNode(ctx, "phase6-engine-worklet", {
             outputChannelCount: [2] 
        });
        
        const gain = ctx.createGain();
        gain.gain.value = 0.5;
        gain.connect(ctx.destination);
        masterGainRef.current = gain;

        const convolver = ctx.createConvolver();
        convolver.buffer = generateReverbIR(ctx, "track");
        convolver.connect(gain);
        
        node.connect(gain);
        node.connect(convolver);

        workletNodeRef.current = node;

        setTimeout(() => {
          updateEngineConfig(activeEngine);
        }, 50);

      } else if (audioContextRef.current.state === "suspended") {
        updateEngineConfig(activeEngine);
        audioContextRef.current.resume();
      }
      setIsPlaying(true);
    } catch (err: any) {
      console.error(err);
      setError(err.message || "Failed to initialize Phase 7 Worklet.");
    }
  };

  useEffect(() => {
    updateEngineConfig(activeEngine);
  }, [activeEngine, engineKey, updateEngineConfig]);

  // Main Vehicle Physics Loop
  useEffect(() => {
    if (!isPlaying) return;
    
    let frameId: number;

    const loop = (time: number) => {
        const state = physicsRef.current;
        const dt = Math.min((time - state.lastTime) / 1000, 0.1); // max 100ms
        state.lastTime = time;

        const gearRatio = state.gearRatios[state.gear];
        const totalRatio = gearRatio * state.finalDrive;

        // Apply inputs actively unless clutch is operating
        if (state.clutch === 0) {
           state.throttleInput = inputsRef.current.throttle ? 1.0 : 0.0;
           state.brakeInput = inputsRef.current.brake ? 1.0 : 0.0;
        }

        // Engine performance characteristics
        const maxTorque = 450 + (turboEnabled ? 200 : 0); // Turbo adds raw torque factor simply for physics
        const normRpm = state.rpm / state.maxRpm;
        const torqueCurve = Math.max(0, 1.0 - Math.pow(normRpm - 0.6, 2) * 2.0);
        
        let ignition = 1.0;
        if (state.rpm >= state.maxRpm) {
            ignition = 0.0; // Hard Limiter
        }

        const engineTorque = torqueCurve * maxTorque * state.throttleInput * ignition;
        const engineFriction = 30 + 0.03 * state.rpm; // Internal loss

        const brakeTorque = state.brakeInput * 4500;
        const drag = 0.5 * 1.2 * 0.3 * 2.0 * state.speed * state.speed + 20 * state.speed;

        if (state.gear === 0 || state.clutch > 0) {
            // Unlocked Engine State (Neutral or Clutch in)
            const netTorque = engineTorque - engineFriction;
            const inertia = 0.15; // Extremely responsive revving
            const accelRad = netTorque / inertia;
            const accelRpm = accelRad * (60 / (2 * Math.PI));
            state.rpm += accelRpm * dt;
            
            if (state.throttleInput === 0 && state.rpm < 1000) {
               state.rpm += 3000 * dt; // idle recovery
            }

            // Car coasts
            let wheelForce = -drag - (brakeTorque / state.wheelRadius);
            if (state.speed > 0) {
               state.speed += (wheelForce / state.mass) * dt;
               if (state.speed < 0) state.speed = 0;
            }
        } else {
            // Locked Drivetrain State
            const wheelTorque = (engineTorque - engineFriction) * totalRatio;
            const netForce = (wheelTorque / state.wheelRadius) - drag - (brakeTorque / state.wheelRadius);
            
            const idealRpm = (state.speed * 60) / (2 * Math.PI * state.wheelRadius) * totalRatio;
            
            // Dynamic stall/slip target based on throttle
            const idleRpm = 1000;
            const slipTargetRpm = idleRpm + state.throttleInput * 1500;
            
            if (idealRpm < slipTargetRpm) {
                // Clutch slipping: Engine revs to slipTargetRpm, wheels driven by slip torque
                state.rpm += (slipTargetRpm - state.rpm) * 15.0 * dt;
                
                let slipTorque = engineTorque - engineFriction;
                if (slipTorque < 0) slipTorque = 0; // Don't allow engine braking to back-drive at slip speeds
                
                const force = (slipTorque * totalRatio / state.wheelRadius) - drag - (brakeTorque / state.wheelRadius);
                state.speed += (force / state.mass) * dt;
                if (state.speed < 0) state.speed = 0;
            } else {
                // Fully engaged clutch: Engine locked to wheels
                state.speed += (netForce / state.mass) * dt;
                if (state.speed < 0.1) state.speed = 0;
                
                // New idealRpm after speed update
                const newIdealRpm = (state.speed * 60) / (2 * Math.PI * state.wheelRadius) * totalRatio;
                const rpmDifference = newIdealRpm - state.rpm;
                
                state.drivetrainFlexVel += rpmDifference * 1000.0 * dt;
                state.drivetrainFlexVel *= Math.exp(-10.0 * dt); 
                
                state.rpm += state.drivetrainFlexVel * dt;
                state.rpm += rpmDifference * 20.0 * dt; 
            }
            
            // Anti-stall idle crawling
            if (state.rpm < 800) {
                state.rpm = 800; // Force idle
                if (state.brakeInput === 0 && state.throttleInput === 0) {
                    state.speed += 2.0 * dt; // Crawl forward
                }
            }
        }

        const overRevLimit = state.maxRpm * 1.25;
        if (state.rpm > overRevLimit) {
            state.rpm = overRevLimit;
            // Massive rear tire lockup simulation on money shift
            state.speed -= 20.0 * dt; 
        }

        // Clamp safely
        if (state.rpm < 0) state.rpm = 0;

        // UI Dashboard Updates (Direct DOM manipulation for 60fps performance without react state lag)
        if (rpmDashRef.current && speedDashRef.current && gearDashRef.current) {
            const rpmClamped = Math.max(0, Math.round(state.rpm));
            rpmDashRef.current.innerText = rpmClamped.toString();
            
            if (state.rpm > state.maxRpm - 500) {
               rpmDashRef.current.className = "text-6xl font-mono font-bold text-red-500 tabular-nums drop-shadow-[0_0_15px_rgba(239,68,68,0.5)]";
            } else {
               rpmDashRef.current.className = "text-6xl font-mono font-bold text-stone-200 tabular-nums drop-shadow-[0_0_15px_rgba(255,255,255,0.2)]";
            }

            speedDashRef.current.innerText = Math.round(state.speed * 3.6).toString();
            gearDashRef.current.innerText = state.gear === 0 ? "N" : state.gear.toString();
        }

        // Push commands to Worklet
        if (workletNodeRef.current && audioContextRef.current) {
            const rpmP = workletNodeRef.current.parameters.get("rpm");
            const thrP = workletNodeRef.current.parameters.get("throttle");
            const loadP = workletNodeRef.current.parameters.get("load");
            const turboP = workletNodeRef.current.parameters.get("turboEnabled");

            if (rpmP) rpmP.setTargetAtTime(state.rpm, audioContextRef.current.currentTime, 0.015);
            if (thrP) thrP.setTargetAtTime(state.throttleInput, audioContextRef.current.currentTime, 0.015);
            if (loadP) loadP.setTargetAtTime(state.throttleInput * ignition, audioContextRef.current.currentTime, 0.05); // slightly smoothed
            if (turboP) turboP.value = turboEnabled ? 1 : 0;
        }
        
        frameId = requestAnimationFrame(loop);
    };
    
    // Kickstart Loop
    physicsRef.current.lastTime = performance.now();
    frameId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frameId);
  }, [isPlaying, turboEnabled]);

  useEffect(() => {
    return () => {
      audioContextRef.current?.close();
    };
  }, []);

  return (
    <div className="flex-1 h-screen overflow-y-auto bg-stone-900 flex flex-col p-8 lg:p-16">
      <div className="max-w-5xl mx-auto w-full">
        <div className="mb-12">
           <div className="flex items-center gap-3 mb-2 animate-in fade-in slide-in-from-bottom-2 duration-700">
               <h1 className="text-4xl text-stone-100 font-mono font-bold tracking-tight">Phase 7: Full System</h1>
               <div className="px-2 py-0.5 bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 font-mono text-[10px] uppercase rounded-full">Drivetrain + Turbo</div>
           </div>
           
           <p className="text-stone-400 font-mono text-sm leading-relaxed max-w-3xl animate-in fade-in delay-150 duration-700">
             The engine physics are now combined with the turbo model in a complete interactive simulation. Let the turbine spool up under heavy load, and hear the compressor blow-off valve trigger when quick-shifting through gears.
           </p>
        </div>

        {error && (
          <div className="bg-red-500/10 border border-red-500/50 text-red-400 px-4 py-3 rounded-md mb-8 font-mono text-sm">
            Error: {error}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          
          <div className="col-span-1 space-y-8 animate-in fade-in slide-in-from-left-4 duration-700 delay-300 fill-mode-both">
            <div className="bg-stone-950 border border-stone-800 rounded-lg p-6 flex flex-col hover:border-stone-700 transition-colors">
                <div className="flex items-center justify-between mb-6 pb-4 border-b border-stone-800 border-dashed">
                    <div className="flex items-center gap-2">
                        <Key className="text-stone-500" size={18} />
                        <h2 className="text-stone-200 font-mono font-semibold uppercase tracking-wider text-sm">Ignition</h2>
                    </div>

                    <button
                        onClick={() => setTurboEnabled(!turboEnabled)}
                        className={cn(
                            "flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-mono font-bold uppercase transition-all",
                            turboEnabled 
                            ? "bg-cyan-500/20 text-cyan-400 border border-cyan-500/50 shadow-[0_0_10px_rgba(6,182,212,0.2)]"
                            : "bg-stone-800 text-stone-500 border border-stone-700 hover:bg-stone-700 hover:text-stone-400"
                        )}
                    >
                        <Wind size={14} />
                        {turboEnabled ? "Boost Act" : "NA Mode"}
                    </button>
                </div>
                
                <div className="space-y-2 mb-8">
                {Object.keys(engines).map((key) => (
                    <button
                    key={key}
                    disabled={isPlaying}
                    onClick={() => setEngineKey(key)}
                    className={cn(
                        "w-full text-left px-4 py-3 rounded font-mono text-sm uppercase tracking-wide border transition-all",
                        engineKey === key
                        ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400"
                        : "bg-stone-900 border-stone-800 text-stone-500 hover:text-stone-300 disabled:opacity-50 disabled:hover:text-stone-500"
                    )}
                    >
                    {engines[key].name}
                    </button>
                ))}
                </div>

                <div className="mt-auto">
                    <button
                        onClick={togglePlayback}
                        className={cn(
                            "w-full flex items-center justify-center gap-2 px-4 py-4 rounded-md font-mono text-sm font-bold transition-all uppercase tracking-widest",
                            isPlaying
                            ? "bg-red-500/20 text-red-400 border border-red-500/50 hover:bg-red-500/30 shadow-[0_0_15px_rgba(239,68,68,0.1)]"
                            : "bg-emerald-500/20 text-emerald-400 border border-emerald-500/50 hover:bg-emerald-500/30 shadow-[0_0_15px_rgba(16,185,129,0.1)]"
                        )}
                        >
                        {isPlaying ? <Square size={16} /> : <Play size={16} />}
                        {isPlaying ? "Kill Contact" : "Start Simulator"}
                    </button>
                </div>
            </div>

            <div className="bg-stone-950 border border-stone-800 rounded-lg p-6 flex flex-col hover:border-stone-700 transition-colors">
                <div className="flex items-center justify-between mb-4 pb-4 border-b border-stone-800 border-dashed">
                    <div className="flex items-center gap-2">
                        <Gamepad2 className="text-stone-500" size={18} />
                        <h2 className="text-stone-200 font-mono font-semibold uppercase tracking-wider text-sm">Keybinds</h2>
                    </div>
                </div>
                
                <div className="flex flex-col gap-3 font-mono text-xs text-stone-400">
                    <div className="flex justify-between items-center bg-stone-900 p-2 rounded">
                        <span>Throttle</span>
                        <div className="flex gap-2">
                            <kbd className="px-2 py-1 bg-stone-800 rounded border border-stone-700 text-stone-200">W</kbd>
                            <kbd className="px-2 py-1 bg-stone-800 rounded border border-stone-700 text-stone-200">↑</kbd>
                        </div>
                    </div>
                    <div className="flex justify-between items-center bg-stone-900 p-2 rounded">
                        <span>Brake</span>
                        <div className="flex gap-2">
                            <kbd className="px-2 py-1 bg-stone-800 rounded border border-stone-700 text-stone-200">S</kbd>
                            <kbd className="px-2 py-1 bg-stone-800 rounded border border-stone-700 text-stone-200">↓</kbd>
                        </div>
                    </div>
                    <div className="flex justify-between items-center bg-stone-900 p-2 rounded">
                        <span>Shift Up</span>
                        <div className="flex gap-2">
                            <kbd className="px-2 py-1 bg-stone-800 rounded border border-stone-700 text-stone-200">E</kbd>
                        </div>
                    </div>
                    <div className="flex justify-between items-center bg-stone-900 p-2 rounded">
                        <span>Shift Down</span>
                        <div className="flex gap-2">
                            <kbd className="px-2 py-1 bg-stone-800 rounded border border-stone-700 text-stone-200">Q</kbd>
                        </div>
                    </div>
                </div>

                <div className="mt-8 flex gap-2">
                     <button
                        onMouseDown={() => inputsRef.current.throttle = true}
                        onMouseUp={() => inputsRef.current.throttle = false}
                        onMouseLeave={() => inputsRef.current.throttle = false}
                        className="flex-1 py-3 bg-stone-900 border border-stone-800 rounded text-stone-300 font-mono text-xs uppercase hover:bg-stone-800 active:bg-stone-700 select-none"
                     >
                        GAS
                     </button>
                     <button
                        onMouseDown={() => inputsRef.current.brake = true}
                        onMouseUp={() => inputsRef.current.brake = false}
                        onMouseLeave={() => inputsRef.current.brake = false}
                        className="flex-1 py-3 bg-stone-900 border border-stone-800 rounded text-red-400 font-mono text-xs uppercase hover:bg-stone-800 active:bg-stone-700 select-none"
                     >
                        BRK
                     </button>
                </div>
            </div>
          </div>

          <div className="col-span-2 space-y-8 animate-in fade-in slide-in-from-right-4 duration-700 delay-500 fill-mode-both">
             
             {/* Digital Dashboard */}
             <div className="bg-stone-950 border border-stone-800 rounded-lg p-6 overflow-hidden relative group">
                {/* Glow rings in background */}
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-96 h-96 bg-emerald-500/5 rounded-full blur-[100px] pointer-events-none group-hover:bg-emerald-500/10 transition-colors duration-1000"></div>

                <div className="flex items-center gap-2 mb-6 pb-4 border-b border-stone-800 border-dashed relative z-10">
                  <Gauge className="text-stone-500" size={18} />
                  <h2 className="text-stone-200 font-mono font-semibold uppercase tracking-wider text-sm">SysTelemetry HUD</h2>
                </div>
                
                <div className="flex flex-col md:flex-row gap-8 justify-center bg-stone-900 border border-stone-800 p-8 rounded-xl items-center shadow-[inset_0_0_20px_rgba(0,0,0,0.5)] relative z-10">
                    <div className="flex flex-col items-center">
                        <span className="text-stone-500 font-mono text-[10px] uppercase font-bold tracking-widest mb-2">Gear</span>
                        <span ref={gearDashRef} className="text-6xl font-mono font-bold text-amber-500 drop-shadow-[0_0_15px_rgba(245,158,11,0.5)]">N</span>
                    </div>
                    
                    <div className="hidden md:block w-px h-16 bg-stone-800" />
                    
                    <div className="flex flex-col items-center min-w-[200px]">
                        <span className="text-stone-500 font-mono text-[10px] uppercase font-bold tracking-widest mb-2">Engine Speed</span>
                        <div className="flex items-baseline gap-2">
                            <span ref={rpmDashRef} className="text-7xl md:text-8xl font-mono font-bold text-stone-200 tabular-nums drop-shadow-[0_0_15px_rgba(255,255,255,0.2)] transition-colors duration-100">0</span>
                            <span className="text-stone-500 font-mono text-sm md:text-xl">RPM</span>
                        </div>
                    </div>
                    
                    <div className="hidden md:block w-px h-16 bg-stone-800" />
                    
                    <div className="flex flex-col items-center min-w-[140px]">
                        <span className="text-stone-500 font-mono text-[10px] uppercase font-bold tracking-widest mb-2">Vehicle Velocity</span>
                        <div className="flex items-baseline gap-2">
                            <span ref={speedDashRef} className="text-6xl md:text-7xl font-mono font-bold text-emerald-400 tabular-nums drop-shadow-[0_0_15px_rgba(52,211,153,0.3)]">0</span>
                            <span className="text-stone-500 font-mono text-sm md:text-xl">KM/H</span>
                        </div>
                    </div>
                </div>

                <div className="grid grid-cols-2 gap-4 mt-6 relative z-10">
                     <button
                        onClick={shiftDown}
                        className="py-4 flex flex-col items-center justify-center gap-2 bg-stone-900 border border-stone-800 rounded-lg text-stone-400 hover:text-stone-200 hover:bg-stone-800 hover:border-stone-700 active:bg-stone-700 transition-all select-none"
                     >
                         <ArrowDownCircle size={24} />
                         <span className="font-mono text-xs uppercase tracking-widest font-bold text-stone-500">Downshift (Q)</span>
                     </button>
                     <button
                        onClick={shiftUp}
                        className="py-4 flex flex-col items-center justify-center gap-2 bg-stone-900 border border-stone-800 rounded-lg text-stone-400 hover:text-stone-200 hover:bg-stone-800 hover:border-stone-700 active:bg-stone-700 transition-all select-none"
                     >
                         <ArrowUpCircle size={24} />
                         <span className="font-mono text-xs uppercase tracking-widest font-bold text-stone-500">Upshift (E)</span>
                     </button>
                </div>
             </div>

          </div>

        </div>
      </div>
    </div>
  );
}
