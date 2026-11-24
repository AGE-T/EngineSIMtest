import { useState, useRef, useEffect } from "react";
import { phase2WorkletCode } from "../audio/phase2Worklet";
import { engines, EngineConfig } from "../data/engines";
import { Play, Square, Activity, Settings2, Guitar } from "lucide-react";

export function Phase2Demo() {
  const [isPlaying, setIsPlaying] = useState(false);
  const [engineKey, setEngineKey] = useState<string>("v8-crossplane");
  const [rpm, setRpm] = useState(1500);
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

        const blob = new Blob([phase2WorkletCode], { type: "application/javascript" });
        const url = URL.createObjectURL(blob);

        await ctx.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);

        const node = new AudioWorkletNode(ctx, "phase2-engine-worklet", {
             outputChannelCount: [2] // Ensure stereo output
        });
        node.connect(ctx.destination);
        workletNodeRef.current = node;

        // Apply config
        setTimeout(() => {
          updateEngineConfig(activeEngine);
          if (workletNodeRef.current) {
             const rpmParam = workletNodeRef.current.parameters.get("rpm");
             if (rpmParam) rpmParam.value = rpm;
          }
        }, 50);

      } else if (audioContextRef.current.state === "suspended") {
        updateEngineConfig(activeEngine);
        audioContextRef.current.resume();
      }
      setIsPlaying(true);
    } catch (err: any) {
      console.error(err);
      setError(err.message || "Failed to initialize Phase 2 Worklet.");
    }
  };

  useEffect(() => {
    updateEngineConfig(activeEngine);
  }, [activeEngine, engineKey]);

  useEffect(() => {
    if (workletNodeRef.current && audioContextRef.current) {
      const rpmParam = workletNodeRef.current.parameters.get("rpm");
      if (rpmParam) rpmParam.setTargetAtTime(rpm, audioContextRef.current.currentTime, 0.1);
    }
  }, [rpm]);

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
             Phase 2: Networks & Geometry
           </h1>
           <p className="text-stone-400 font-mono text-sm leading-relaxed max-w-3xl">
             Simulating multi-cylinder geometry with N-port scattering junctions. 
             Features banks of runners merging into downpipes via 4-to-1 collectors, 
             and optional cross/X-pipes for bank interaction. Note how the firing order 
             and geometry define the acoustic character (Crossplane burble vs Flatplane scream vs I4 drone).
           </p>
        </div>

        {error && (
          <div className="bg-red-500/10 border border-red-500/50 text-red-400 px-4 py-3 rounded-md mb-8 font-mono text-sm">
            Error: {error}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          
          <div className="col-span-1 bg-stone-950 border border-stone-800 rounded-lg p-6 flex flex-col">
            <div className="flex items-center gap-2 mb-6 pb-4 border-b border-stone-800 border-dashed">
              <Settings2 className="text-stone-500" size={18} />
              <h2 className="text-stone-200 font-mono font-semibold uppercase tracking-wider text-sm">Engine Select</h2>
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
              {isPlaying && <p className="text-stone-600 text-xs mt-2 font-mono italic">Engine must be stopped to swap blocks.</p>}
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
                  {isPlaying ? "Cut Ignition" : "Start Engine"}
                </button>
            </div>
          </div>

          <div className="col-span-2 space-y-8">
             <div className="bg-stone-950 border border-stone-800 rounded-lg p-6">
                <div className="flex items-center gap-2 mb-8 pb-4 border-b border-stone-800 border-dashed">
                  <Activity className="text-stone-500" size={18} />
                  <h2 className="text-stone-200 font-mono font-semibold uppercase tracking-wider text-sm">Telemetry</h2>
                </div>
                
                <div className="mb-8">
                  <div className="flex justify-between items-end mb-3">
                    <label className="text-stone-400 font-mono text-xs uppercase tracking-widest">
                      Engine Speed
                    </label>
                    <span className="text-stone-200 font-mono font-bold text-2xl">
                      {rpm} <span className="text-stone-500 text-sm">RPM</span>
                    </span>
                  </div>
                  <input
                    type="range"
                    min="500"
                    max="9000"
                    step="100"
                    value={rpm}
                    onChange={(e) => setRpm(Number(e.target.value))}
                    className="w-full appearance-none bg-stone-800 h-2 rounded-full outline-none [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-6 [&::-webkit-slider-thumb]:h-6 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-stone-200 cursor-pointer"
                  />
                </div>

                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 pt-4 border-t border-stone-800">
                    <div className="flex flex-col">
                       <span className="text-stone-500 font-mono text-[10px] uppercase mb-1">Layout</span>
                       <span className="text-stone-200 font-mono text-lg font-semibold">{activeEngine.layout}</span>
                    </div>
                    <div className="flex flex-col">
                       <span className="text-stone-500 font-mono text-[10px] uppercase mb-1">Primary Freq</span>
                       <span className="text-emerald-400 font-mono text-lg font-semibold">
                          {((rpm / 120) * (activeEngine.cylinders.length / 2)).toFixed(1)} <span className="text-xs text-stone-500">Hz</span>
                       </span>
                    </div>
                    <div className="flex flex-col">
                       <span className="text-stone-500 font-mono text-[10px] uppercase mb-1">Crossover</span>
                       <span className="text-blue-400 font-mono text-lg font-semibold uppercase">{activeEngine.crossPipe}</span>
                    </div>
                    <div className="flex flex-col">
                       <span className="text-stone-500 font-mono text-[10px] uppercase mb-1">Exhaust Layout</span>
                       <span className="text-stone-300 font-mono text-lg font-semibold uppercase">
                         {activeEngine.cylsR.length === 0 ? "Single Mono" : "True Dual"}
                       </span>
                    </div>
                </div>
             </div>

             <div className="bg-stone-950 border border-stone-800 rounded-lg p-6">
                <div className="flex items-center gap-2 mb-6 pb-4 border-b border-stone-800 border-dashed">
                  <Guitar className="text-stone-500" size={18} />
                  <h2 className="text-stone-200 font-mono font-semibold uppercase tracking-wider text-sm">Active Geometry</h2>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="border border-stone-800/50 p-4 rounded bg-stone-900/50">
                    <h3 className="text-stone-400 font-mono text-[10px] uppercase tracking-widest mb-3">Left Bank Config</h3>
                    <ul className="space-y-2">
                       {activeEngine.cylsL.map((idx) => {
                          const cyl = activeEngine.cylinders.find(c => c.index === idx)!;
                          return (
                             <li key={idx} className="flex justify-between items-center text-xs font-mono text-stone-300">
                                <span>Cyl {idx + 1} Phase</span>
                                <span className="text-emerald-500">{cyl.phaseOffset}°</span>
                             </li>
                          )
                       })}
                    </ul>
                  </div>
                  <div className="border border-stone-800/50 p-4 rounded bg-stone-900/50">
                    <h3 className="text-stone-400 font-mono text-[10px] uppercase tracking-widest mb-3">Right Bank Config</h3>
                    {activeEngine.cylsR.length > 0 ? (
                       <ul className="space-y-2">
                         {activeEngine.cylsR.map((idx) => {
                            const cyl = activeEngine.cylinders.find(c => c.index === idx)!;
                            return (
                               <li key={idx} className="flex justify-between items-center text-xs font-mono text-stone-300">
                                  <span>Cyl {idx + 1} Phase</span>
                                  <span className="text-emerald-500">{cyl.phaseOffset}°</span>
                               </li>
                            )
                         })}
                       </ul>
                    ) : (
                       <div className="text-stone-600 font-mono text-xs italic">No right bank (Inline Layout)</div>
                    )}
                  </div>
                </div>
             </div>
          </div>

        </div>
      </div>
    </div>
  );
}
