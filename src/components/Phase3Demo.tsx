import { useState, useRef, useEffect } from "react";
import { phase3WorkletCode } from "../audio/phase3Worklet";
import { engines, EngineConfig } from "../data/engines";
import { Play, Square, Activity, Settings2, Gauge } from "lucide-react";

export function Phase3Demo() {
  const [isPlaying, setIsPlaying] = useState(false);
  const [engineKey, setEngineKey] = useState<string>("v8-crossplane");
  
  // Controls
  const [targetRpm, setTargetRpm] = useState(1000);
  const [throttle, setThrottle] = useState(0);
  
  const [error, setError] = useState<string | null>(null);

  const audioContextRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);

  const activeEngine = engines[engineKey];

  const updateEngineConfig = (config: EngineConfig) => {
    if (workletNodeRef.current) {
      workletNodeRef.current.port.postMessage({ type: "config", config });
    }
  };

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

        const blob = new Blob([phase3WorkletCode], { type: "application/javascript" });
        const url = URL.createObjectURL(blob);

        await ctx.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);

        const node = new AudioWorkletNode(ctx, "phase3-engine-worklet", {
             outputChannelCount: [2] 
        });
        node.connect(ctx.destination);
        workletNodeRef.current = node;

        setTimeout(() => {
          updateEngineConfig(activeEngine);
          if (workletNodeRef.current) {
             const rpmParam = workletNodeRef.current.parameters.get("rpm");
             if (rpmParam) rpmParam.value = targetRpm;
          }
        }, 50);

      } else if (audioContextRef.current.state === "suspended") {
        updateEngineConfig(activeEngine);
        audioContextRef.current.resume();
      }
      setIsPlaying(true);
    } catch (err: any) {
      console.error(err);
      setError(err.message || "Failed to initialize Phase 3 Worklet.");
    }
  };

  useEffect(() => {
    updateEngineConfig(activeEngine);
  }, [activeEngine, engineKey]);

  useEffect(() => {
    if (workletNodeRef.current && audioContextRef.current) {
      const rpmParam = workletNodeRef.current.parameters.get("rpm");
      if (rpmParam) rpmParam.setTargetAtTime(targetRpm, audioContextRef.current.currentTime, 0.1);
    }
  }, [targetRpm]);

  useEffect(() => {
    if (workletNodeRef.current && audioContextRef.current) {
      const throttleParam = workletNodeRef.current.parameters.get("throttle");
      if (throttleParam) throttleParam.setTargetAtTime(throttle, audioContextRef.current.currentTime, 0.05);
    }
  }, [throttle]);

  useEffect(() => {
    return () => {
      audioContextRef.current?.close();
    };
  }, []);

  return (
    <div className="flex-1 h-screen overflow-y-auto bg-stone-900 flex flex-col p-8 lg:p-16">
      <div className="max-w-5xl mx-auto w-full">
        <div className="mb-12">
           <h1 className="text-4xl text-stone-100 font-mono font-bold tracking-tight mb-2">
             Phase 3: Transients & Textures
           </h1>
           <p className="text-stone-400 font-mono text-sm leading-relaxed max-w-3xl">
             Adding dynamic ECU states and resonance. Features include a dynamic throttle mapped to 
             combustion pressure, ignition cut rev-limiters capturing raw fuel, and overrun burbles/pops 
             exploding in the collector. Additionally, modal synthesis provides block/chassis resonance.
           </p>
        </div>

        {error && (
          <div className="bg-red-500/10 border border-red-500/50 text-red-400 px-4 py-3 rounded-md mb-8 font-mono text-sm">
            Error: {error}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          
          <div className="col-span-1 space-y-8">
            <div className="bg-stone-950 border border-stone-800 rounded-lg p-6 flex flex-col">
                <div className="flex items-center gap-2 mb-6 pb-4 border-b border-stone-800 border-dashed">
                <Settings2 className="text-stone-500" size={18} />
                <h2 className="text-stone-200 font-mono font-semibold uppercase tracking-wider text-sm">Engine Mapping</h2>
                </div>
                
                <div className="space-y-2 mb-8">
                {Object.keys(engines).map((key) => (
                    <button
                    key={key}
                    disabled={isPlaying}
                    onClick={() => setEngineKey(key)}
                    className={`w-full text-left px-4 py-3 rounded font-mono text-sm uppercase tracking-wide border transition-all ${
                        engineKey === key
                        ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400"
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
                        ? "bg-red-500/20 text-red-400 border border-red-500/50 hover:bg-red-500/30"
                        : "bg-emerald-500/20 text-emerald-400 border border-emerald-500/50 hover:bg-emerald-500/30"
                    }`}
                    >
                    {isPlaying ? <Square size={16} /> : <Play size={16} />}
                    {isPlaying ? "Cut Ignition" : "Ignite Engine"}
                    </button>
                </div>
            </div>

            <div className="bg-stone-950 border border-stone-800 rounded-lg p-6 flex flex-col">
                <div className="flex justify-between items-center mb-4">
                     <span className="text-stone-500 font-mono text-xs uppercase">Target Speed</span>
                     <span className="text-stone-200 font-mono text-lg font-bold">{targetRpm} <span className="text-stone-500 text-xs">RPM</span></span>
                </div>
                <input
                    type="range"
                    min="800"
                    max={activeEngine.metadata.max_rpm + 200}
                    step="10"
                    value={targetRpm}
                    onChange={(e) => setTargetRpm(Number(e.target.value))}
                    className="w-full appearance-none bg-stone-800 h-2 rounded-full outline-none [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-6 [&::-webkit-slider-thumb]:h-6 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-stone-200 cursor-pointer"
                />

                <div className="w-full flex gap-2 mt-8">
                    {/* Presets */}
                    <button 
                        onMouseDown={() => { setThrottle(0.0); setTargetRpm(1000); }}
                        className="flex-1 bg-stone-900 border border-stone-800 rounded py-2 text-stone-400 font-mono text-xs hover:bg-stone-800 hover:text-stone-200"
                    >
                        Idle
                    </button>
                    <button 
                         onMouseDown={() => { setThrottle(0.5); setTargetRpm(4000); }}
                         onMouseUp={() => { setThrottle(0.0); setTargetRpm(1000); }}
                         className="flex-1 bg-stone-900 border border-stone-800 rounded py-2 text-stone-400 font-mono text-xs hover:bg-stone-800 hover:text-stone-200"
                    >
                        Rev
                    </button>
                    <button 
                         onMouseDown={() => { setThrottle(1.0); setTargetRpm(activeEngine.metadata.max_rpm + 500); }}
                         onMouseUp={() => { setThrottle(0.0); setTargetRpm(1000); }}
                         className="flex-1 bg-red-900/20 border border-red-500/30 rounded py-2 text-red-400 font-mono text-xs hover:bg-red-900/40"
                    >
                        Redline
                    </button>
                </div>
            </div>
          </div>

          <div className="col-span-2 space-y-8">
             <div className="bg-stone-950 border border-stone-800 rounded-lg p-6">
                <div className="flex items-center gap-2 mb-8 pb-4 border-b border-stone-800 border-dashed">
                  <Gauge className="text-stone-500" size={18} />
                  <h2 className="text-stone-200 font-mono font-semibold uppercase tracking-wider text-sm">ECU & Telemetry</h2>
                </div>
                
                <div className="grid grid-cols-2 gap-8 mb-8">
                    <div className="flex flex-col">
                        <div className="flex justify-between items-end mb-3">
                            <label className="text-stone-400 font-mono text-xs uppercase tracking-widest">
                                Throttle Map
                            </label>
                            <span className="text-amber-400 font-mono font-bold text-2xl">
                                {(throttle * 100).toFixed(0)} <span className="text-stone-500 text-sm">%</span>
                            </span>
                        </div>
                        <input
                            type="range"
                            min="0"
                            max="1"
                            step="0.01"
                            value={throttle}
                            onChange={(e) => setThrottle(Number(e.target.value))}
                            className="w-full appearance-none bg-stone-800 h-4 rounded outline-none [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-2 [&::-webkit-slider-thumb]:h-6 [&::-webkit-slider-thumb]:bg-amber-400 cursor-pointer"
                        />
                    </div>
                </div>

                <div className="grid grid-cols-3 gap-4 pt-4 border-t border-stone-800">
                    <div className="flex flex-col">
                       <span className="text-stone-500 font-mono text-[10px] uppercase mb-1">Redline / Cut</span>
                       <span className="text-red-400 font-mono text-lg font-semibold">{activeEngine.metadata.max_rpm} RPM</span>
                    </div>
                    <div className="flex flex-col">
                       <span className="text-stone-500 font-mono text-[10px] uppercase mb-1">State</span>
                       <span className="text-blue-400 font-mono text-lg font-semibold uppercase">
                          {throttle > 0.8 ? "WOT" : throttle < 0.1 ? (targetRpm > 3000 ? "Overrun" : "Idle") : "Part Throttle"}
                       </span>
                    </div>
                    <div className="flex flex-col">
                       <span className="text-stone-500 font-mono text-[10px] uppercase mb-1">Limiter Type</span>
                       <span className="text-stone-300 font-mono text-lg font-semibold uppercase">
                          Hard Cut
                       </span>
                    </div>
                </div>
             </div>

             <div className="bg-stone-950 border border-stone-800 rounded-lg p-6">
                <div className="flex items-center gap-2 mb-6 pb-4 border-b border-stone-800 border-dashed">
                  <Activity className="text-stone-500" size={18} />
                  <h2 className="text-stone-200 font-mono font-semibold uppercase tracking-wider text-sm">Resonance Simulation</h2>
                </div>
                <div className="space-y-4">
                    <div className="p-4 bg-stone-900 border border-stone-800 rounded-md">
                        <div className="flex justify-between items-center mb-2">
                             <span className="text-stone-300 font-mono text-sm uppercase">Engine Block Modal Synthesis</span>
                             <div className="flex items-center gap-2">
                                <div className={`w-2 h-2 rounded-full ${isPlaying ? 'bg-emerald-500 animate-pulse' : 'bg-stone-700'}`}></div>
                                <span className="text-stone-500 font-mono text-[10px]">ACTIVE</span>
                             </div>
                        </div>
                        <p className="text-stone-500 font-mono text-xs">
                             Routing multi-bandpass Biquad filter banks simulating heavy metallic vibration frequencies [150hz, 320hz, 500hz, 850hz].
                        </p>
                    </div>
                    <div className="p-4 bg-stone-900 border border-stone-800 rounded-md">
                        <div className="flex justify-between items-center mb-2">
                             <span className="text-stone-300 font-mono text-sm uppercase">Exhaust Unburnt Fuel (Pops)</span>
                             <div className="flex items-center gap-2">
                                <div className={`w-2 h-2 rounded-full ${isPlaying ? 'bg-amber-500 animate-pulse' : 'bg-stone-700'}`}></div>
                                <span className="text-stone-500 font-mono text-[10px]">ACTIVE</span>
                             </div>
                        </div>
                        <p className="text-stone-500 font-mono text-xs">
                             Injecting randomized noise potentials at collectors when ECU invokes hard ignition cuts or overrun.
                        </p>
                    </div>
                </div>
             </div>
          </div>

        </div>
      </div>
    </div>
  );
}
