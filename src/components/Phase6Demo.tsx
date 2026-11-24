import { useState, useRef, useEffect, useCallback } from "react";
import { phase6WorkletCode } from "../audio/phase6Worklet";
import { engines, EngineConfig } from "../data/engines";
import { Play, Square, Settings2, Key, Gauge, ArrowUpCircle, ArrowDownCircle, CarFront, Wind } from "lucide-react";

function generateReverbIR(ctx: AudioContext, type: "track" | "cabin" | "tunnel") {
    let duration = 0.4;
    let decay = 10.0;
    let filterFreq = 3000;

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

export function Phase6Demo() {
  const [isPlaying, setIsPlaying] = useState(false);
  const [engineKey, setEngineKey] = useState<string>("inline-4");
  const [isTurbo, setIsTurbo] = useState(true);
  
  const [error, setError] = useState<string | null>(null);

  const audioContextRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const masterGainRef = useRef<GainNode | null>(null);

  const rpmDashRef = useRef<HTMLSpanElement>(null);
  const speedDashRef = useRef<HTMLSpanElement>(null);
  const gearDashRef = useRef<HTMLSpanElement>(null);
  const boostDashRef = useRef<HTMLDivElement>(null);

  const activeEngine = engines[engineKey];

  // Physics Engine State
  const inputsRef = useRef({ throttle: false, brake: false });
  const physicsRef = useRef({
    speed: 0,
    rpm: 1000,
    gear: 0,
    clutch: 0,
    throttleInput: 0,
    brakeInput: 0,
    boost: 0,
    lastTime: performance.now(),
    gearRatios: [0, 3.42, 2.10, 1.45, 1.03, 0.81, 0.62],
    finalDrive: 3.73,
    wheelRadius: 0.33,
    mass: 1500,
    maxRpm: 7500
  });

  const updateEngineConfig = useCallback((config: EngineConfig) => {
    if (workletNodeRef.current) {
      workletNodeRef.current.port.postMessage({ type: "config", config });
    }
    physicsRef.current.maxRpm = config.metadata.max_rpm;
  }, []);

  const shiftUp = useCallback(() => {
    const state = physicsRef.current;
    if (state.gear === 0) {
        state.gear = 1;
        return;
    }
    if (state.gear >= state.gearRatios.length - 1 || state.clutch > 0) return;
    state.clutch = 1;
    state.throttleInput = 0; 
    setTimeout(() => {
        state.gear++;
        state.clutch = 0;
    }, 60);
  }, []);

  const shiftDown = useCallback(() => {
    const state = physicsRef.current;
    if (state.gear <= 1) {
        state.gear = 0;
        return;
    }
    if (state.clutch > 0) return;
    state.clutch = 1;
    state.throttleInput = 1.0; 
    setTimeout(() => {
        state.gear--;
        state.clutch = 0;
    }, 120); 
  }, []);

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
      setError(err.message || "Failed to initialize Phase 6 Worklet.");
    }
  };

  useEffect(() => {
    updateEngineConfig(activeEngine);
  }, [activeEngine, engineKey, updateEngineConfig]);

  useEffect(() => {
      if (workletNodeRef.current && audioContextRef.current) {
          const tP = workletNodeRef.current.parameters.get("turboEnabled");
          if (tP) tP.setValueAtTime(isTurbo ? 1 : 0, audioContextRef.current.currentTime);
      }
  }, [isTurbo]);

  useEffect(() => {
    if (!isPlaying) return;
    
    let frameId: number;

    const loop = (time: number) => {
        const state = physicsRef.current;
        const dt = Math.min((time - state.lastTime) / 1000, 0.1); 
        state.lastTime = time;

        const gearRatio = state.gearRatios[state.gear];
        const totalRatio = gearRatio * state.finalDrive;

        if (state.clutch === 0) {
           state.throttleInput = inputsRef.current.throttle ? 1.0 : 0.0;
           state.brakeInput = inputsRef.current.brake ? 1.0 : 0.0;
        }

        // Turbo map integration (simplified macro)
        let exhaustFlow = (state.rpm / state.maxRpm) * (0.2 + 0.8 * state.throttleInput);
        if (isTurbo) {
             let targetBoost = exhaustFlow * state.throttleInput * 1.5; // Max 1.5 bar
             if (state.throttleInput < 0.1) targetBoost = 0; 
             state.boost += (targetBoost - state.boost) * 2.0 * dt; // Lag
        } else {
             state.boost = 0;
        }

        let maxTorque = 450;
        if (isTurbo) maxTorque += state.boost * 200; // Boost adds massive torque

        const normRpm = state.rpm / state.maxRpm;
        const torqueCurve = Math.max(0, 1.0 - Math.pow(normRpm - 0.6, 2) * 2.0);
        
        let ignition = 1.0;
        if (state.rpm >= state.maxRpm) {
            ignition = 0.0; 
        }

        const engineTorque = torqueCurve * maxTorque * state.throttleInput * ignition;
        const engineFriction = 30 + 0.03 * state.rpm + (isTurbo ? 10 : 0); 

        const brakeTorque = state.brakeInput * 4500;
        const drag = 0.5 * 1.2 * 0.3 * 2.0 * state.speed * state.speed + 20 * state.speed;

        if (state.gear === 0 || state.clutch > 0) {
            const netTorque = engineTorque - engineFriction;
            const inertia = 0.2; 
            const accelRad = netTorque / inertia;
            const accelRpm = accelRad * (60 / (2 * Math.PI));
            state.rpm += accelRpm * dt;
            
            if (state.throttleInput === 0 && state.rpm < 1000) {
               state.rpm += 3000 * dt; 
            }

            let wheelForce = -drag - (brakeTorque / state.wheelRadius);
            if (state.speed > 0) {
               state.speed += (wheelForce / state.mass) * dt;
               if (state.speed < 0) state.speed = 0;
            }
        } else {
            if (state.speed < 4.0) { 
                const targetSlipRpm = 1000 + state.throttleInput * 3000;
                state.rpm += (targetSlipRpm - state.rpm) * 10.0 * dt;
                
                let slipTorque = engineTorque - engineFriction;
                if (slipTorque < 0) slipTorque = 0; 

                const wheelTorque = slipTorque * totalRatio;
                const netForce = (wheelTorque / state.wheelRadius) - drag - (brakeTorque / state.wheelRadius);
                
                state.speed += (netForce / state.mass) * dt;
                if (state.speed < 0) state.speed = 0;
            } else {
                const wheelTorque = (engineTorque - engineFriction) * totalRatio;
                const netForce = (wheelTorque / state.wheelRadius) - drag - (brakeTorque / state.wheelRadius);
                state.speed += (netForce / state.mass) * dt;
                
                if (state.speed < 0.1) state.speed = 0;
                state.rpm = (state.speed * 60) / (2 * Math.PI * state.wheelRadius) * totalRatio;
                
                if (state.rpm < 800) {
                    state.rpm = 800; 
                    if (state.brakeInput === 0) {
                         state.speed += 2.0 * dt; 
                    }
                }
            }
        }

        if (state.rpm < 0) state.rpm = 0;

        if (rpmDashRef.current && speedDashRef.current && gearDashRef.current && boostDashRef.current) {
            const rpmClamped = Math.max(0, Math.round(state.rpm));
            rpmDashRef.current.innerText = rpmClamped.toString();
            
            if (state.rpm > state.maxRpm - 500) {
               rpmDashRef.current.className = "text-6xl md:text-8xl font-mono font-bold text-red-500 tabular-nums drop-shadow-[0_0_15px_rgba(239,68,68,0.5)] transition-colors duration-100";
            } else {
               rpmDashRef.current.className = "text-6xl md:text-8xl font-mono font-bold text-stone-200 tabular-nums drop-shadow-[0_0_15px_rgba(255,255,255,0.2)] transition-colors duration-100";
            }

            speedDashRef.current.innerText = Math.round(state.speed * 3.6).toString();
            gearDashRef.current.innerText = state.gear === 0 ? "N" : state.gear.toString();

            const boostClamped = Math.max(0, state.boost).toFixed(2);
            boostDashRef.current.innerText = boostClamped;
            
            if (state.boost > 0.05) {
                boostDashRef.current.className = "text-3xl font-mono font-bold text-cyan-400 tabular-nums drop-shadow-[0_0_10px_rgba(34,211,238,0.5)]";
            } else {
                boostDashRef.current.className = "text-3xl font-mono font-bold text-stone-600 tabular-nums";
            }
        }

        if (workletNodeRef.current && audioContextRef.current) {
            const rpmP = workletNodeRef.current.parameters.get("rpm");
            const thrP = workletNodeRef.current.parameters.get("throttle");
            if (rpmP) rpmP.setTargetAtTime(state.rpm, audioContextRef.current.currentTime, 0.015);
            if (thrP) thrP.setTargetAtTime(state.throttleInput, audioContextRef.current.currentTime, 0.015);
        }
        
        frameId = requestAnimationFrame(loop);
    };
    
    physicsRef.current.lastTime = performance.now();
    frameId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frameId);
  }, [isPlaying, isTurbo]);

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
               <h1 className="text-4xl text-stone-100 font-mono font-bold tracking-tight">Phase 6: Forced Induction</h1>
               <div className="px-2 py-0.5 bg-cyan-500/10 border border-cyan-500/30 text-cyan-400 font-mono text-[10px] uppercase rounded-full">Turbocharger Sim</div>
           </div>
           
           <p className="text-stone-400 font-mono text-sm leading-relaxed max-w-3xl animate-in fade-in delay-150 duration-700">
             The engine block is now augmented with a dynamic turbocharger model. Exhaust gases spool up the turbine (generating high-frequency compressor whine), forcing compressed air into the manifold, thus increasing volumetric efficiency and torque. Sudden throttle closures stall the compressor, releasing pressure through a blow-off valve.
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
                <div className="flex items-center gap-2 mb-6 pb-4 border-b border-stone-800 border-dashed">
                    <Wind className="text-stone-500" size={18} />
                    <h2 className="text-stone-200 font-mono font-semibold uppercase tracking-wider text-sm">Aspiration</h2>
                </div>
                
                <div className="flex gap-2 mb-8 bg-stone-900 p-1 rounded-md border border-stone-800">
                     <button
                        onClick={() => setIsTurbo(false)}
                        className={`flex-1 py-2 font-mono text-xs uppercase tracking-wide rounded transition-all ${
                            !isTurbo ? 'bg-stone-800 text-stone-200 shadow-sm border border-stone-700' : 'text-stone-500 hover:text-stone-400'
                        }`}
                     >
                         NA
                     </button>
                     <button
                        onClick={() => setIsTurbo(true)}
                        className={`flex-1 py-2 font-mono text-xs uppercase tracking-wide rounded transition-all ${
                            isTurbo ? 'bg-cyan-500/20 text-cyan-400 shadow-sm border border-cyan-500/50' : 'text-stone-500 hover:text-stone-400'
                        }`}
                     >
                         Turbo
                     </button>
                </div>

                <div className="flex items-center gap-2 mb-6 pb-4 border-b border-stone-800 border-dashed">
                    <Key className="text-stone-500" size={18} />
                    <h2 className="text-stone-200 font-mono font-semibold uppercase tracking-wider text-sm">Block</h2>
                </div>

                <div className="space-y-2 mb-8">
                {Object.keys(engines).map((key) => (
                    <button
                    key={key}
                    disabled={isPlaying}
                    onClick={() => setEngineKey(key)}
                    className={`w-full text-left px-4 py-3 rounded font-mono text-sm uppercase tracking-wide border transition-all ${
                        engineKey === key
                        ? "bg-indigo-500/10 border-indigo-500/30 text-indigo-400"
                        : "bg-stone-900 border-stone-800 text-stone-500 hover:text-stone-300 disabled:opacity-50 disabled:hover:text-stone-500"
                    }`}
                    >
                    {engines[key].name}
                    </button>
                ))}
                </div>

                <div className="mt-auto">
                    <button
                        onClick={togglePlayback}
                        className={`w-full flex items-center justify-center gap-2 px-4 py-4 rounded-md font-mono text-sm font-bold transition-all uppercase tracking-widest ${
                            isPlaying
                            ? "bg-red-500/20 text-red-400 border border-red-500/50 hover:bg-red-500/30 shadow-[0_0_15px_rgba(239,68,68,0.1)]"
                            : "bg-cyan-500/20 text-cyan-400 border border-cyan-500/50 hover:bg-cyan-500/30 shadow-[0_0_15px_rgba(6,182,212,0.1)]"
                        }`}
                        >
                        {isPlaying ? <Square size={16} /> : <Play size={16} />}
                        {isPlaying ? "Kill Contact" : "Start Simulator"}
                    </button>
                </div>
            </div>

          </div>

          <div className="col-span-2 space-y-8 animate-in fade-in slide-in-from-right-4 duration-700 delay-500 fill-mode-both">
             
             <div className="bg-stone-950 border border-stone-800 rounded-lg p-6 overflow-hidden relative group">
                <div className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-96 h-96 rounded-full blur-[100px] pointer-events-none transition-colors duration-1000 ${
                     isTurbo ? 'bg-cyan-500/5 group-hover:bg-cyan-500/10' : 'bg-indigo-500/5 group-hover:bg-indigo-500/10'
                }`}></div>

                <div className="flex items-center gap-2 mb-6 pb-4 border-b border-stone-800 border-dashed relative z-10">
                  <Gauge className="text-stone-500" size={18} />
                  <h2 className="text-stone-200 font-mono font-semibold uppercase tracking-wider text-sm">Telemetry HUD</h2>
                </div>
                
                <div className="grid grid-cols-2 md:flex md:flex-row gap-8 justify-center bg-stone-900 border border-stone-800 p-8 rounded-xl items-center shadow-[inset_0_0_20px_rgba(0,0,0,0.5)] relative z-10 w-full">
                    
                    <div className="flex flex-col items-center">
                        <span className="text-stone-500 font-mono text-[10px] uppercase font-bold tracking-widest mb-2 text-center">Gear</span>
                        <span ref={gearDashRef} className="text-5xl md:text-6xl font-mono font-bold text-amber-500 drop-shadow-[0_0_15px_rgba(245,158,11,0.5)]">N</span>
                    </div>
                    
                    <div className="hidden md:block w-px h-16 bg-stone-800" />
                    
                    <div className="flex flex-col items-center flex-1">
                        <span className="text-stone-500 font-mono text-[10px] uppercase font-bold tracking-widest mb-2 text-center">Engine Speed</span>
                        <div className="flex items-baseline gap-2">
                            <span ref={rpmDashRef} className="text-5xl md:text-8xl font-mono font-bold text-stone-200 tabular-nums drop-shadow-[0_0_15px_rgba(255,255,255,0.2)] transition-colors duration-100">0</span>
                        </div>
                    </div>
                    
                    <div className="hidden md:block w-px h-16 bg-stone-800" />
                    
                    <div className="flex flex-col items-center">
                        <span className="text-stone-500 font-mono text-[10px] uppercase font-bold tracking-widest mb-2 text-center">Speed</span>
                        <div className="flex items-baseline gap-2">
                            <span ref={speedDashRef} className="text-5xl md:text-6xl font-mono font-bold text-emerald-400 tabular-nums drop-shadow-[0_0_15px_rgba(52,211,153,0.3)]">0</span>
                            <span className="text-stone-500 font-mono text-sm hidden md:inline">KMH</span>
                        </div>
                    </div>
                    
                    {isTurbo && (
                        <>
                           <div className="hidden md:block w-px h-16 bg-stone-800" />
                           <div className="flex flex-col items-center">
                               <span className="text-stone-500 font-mono text-[10px] uppercase font-bold tracking-widest mb-2 text-center">Boost (Bar)</span>
                               <span ref={boostDashRef} className="text-3xl font-mono font-bold text-stone-600 tabular-nums">0.00</span>
                           </div>
                        </>
                    )}
                </div>

                <div className="grid grid-cols-2 gap-4 mt-6 relative z-10">
                     <button
                        onClick={shiftDown}
                        className="py-4 flex flex-col items-center justify-center gap-2 bg-stone-900 border border-stone-800 rounded-lg text-stone-400 hover:text-stone-200 hover:bg-stone-800 hover:border-stone-700 active:bg-stone-700 transition-all select-none"
                     >
                         <ArrowDownCircle size={24} />
                         <span className="font-mono text-xs uppercase tracking-widest font-bold text-stone-500">Downshift Base (Q)</span>
                     </button>
                     <button
                        onClick={shiftUp}
                        className="py-4 flex flex-col items-center justify-center gap-2 bg-stone-900 border border-stone-800 rounded-lg text-stone-400 hover:text-stone-200 hover:bg-stone-800 hover:border-stone-700 active:bg-stone-700 transition-all select-none"
                     >
                         <ArrowUpCircle size={24} />
                         <span className="font-mono text-xs uppercase tracking-widest font-bold text-stone-500">Upshift Base (E)</span>
                     </button>
                </div>
             </div>

          </div>

        </div>
      </div>
    </div>
  );
}
