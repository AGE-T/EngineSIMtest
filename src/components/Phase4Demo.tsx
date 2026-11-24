import { useState, useRef, useEffect } from "react";
import { phase4WorkletCode } from "../audio/phase4Worklet";
import { engines, EngineConfig } from "../data/engines";
import { Play, Square, Activity, Settings2, Sparkles, Volume2 } from "lucide-react";

function generateReverbIR(ctx: AudioContext, type: "track" | "cabin" | "tunnel") {
    // Generate an impulse response
    let duration = 0.4;
    let decay = 10.0;
    let filterFreq = 3000;

    if (type === "tunnel") {
        duration = 1.5;
        decay = 3.0;
        filterFreq = 800; // Muffled, boomy
    } else if (type === "cabin") {
        duration = 0.15;
        decay = 20.0;
        filterFreq = 1000;
    } else { // track
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
            // White noise
            let noise = (Math.random() * 2 - 1);
            // Simple low pass step
            let alpha = filterFreq / sr; 
            lastVal = lastVal + alpha * (noise - lastVal);
            // Apply decay
            channel[i] = lastVal * Math.exp(-decay * i / sr) * 0.15; // lower volume mix
        }
    }
    return buffer;
}


export function Phase4Demo() {
  const [isPlaying, setIsPlaying] = useState(false);
  const [engineKey, setEngineKey] = useState<string>("v8-flatplane");
  const [envType, setEnvType] = useState<"track" | "cabin" | "tunnel">("track");
  
  // Controls
  const [targetRpm, setTargetRpm] = useState(1000);
  const [throttle, setThrottle] = useState(0);
  
  const [error, setError] = useState<string | null>(null);

  const audioContextRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const convolverNodeRef = useRef<ConvolverNode | null>(null);
  const masterGainRef = useRef<GainNode | null>(null);

  const activeEngine = engines[engineKey];

  const updateEngineConfig = (config: EngineConfig) => {
    if (workletNodeRef.current) {
      workletNodeRef.current.port.postMessage({ type: "config", config });
    }
  };

  const updateEnvironment = (ctx: AudioContext, type: "track" | "cabin" | "tunnel") => {
      if (convolverNodeRef.current) {
          convolverNodeRef.current.buffer = generateReverbIR(ctx, type);
      }
  }

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

        const blob = new Blob([phase4WorkletCode], { type: "application/javascript" });
        const url = URL.createObjectURL(blob);

        await ctx.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);

        const node = new AudioWorkletNode(ctx, "phase4-engine-worklet", {
             outputChannelCount: [2] 
        });
        
        // Master Volume
        const gain = ctx.createGain();
        gain.gain.value = 0.5; // keep it from blowing ears off
        gain.connect(ctx.destination);
        masterGainRef.current = gain;

        // Convolution Reverb
        const convolver = ctx.createConvolver();
        convolver.connect(gain);
        convolverNodeRef.current = convolver;
        
        updateEnvironment(ctx, envType);

        // Dry connection
        node.connect(gain);
        // Wet connection
        node.connect(convolver);

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
      setError(err.message || "Failed to initialize Phase 4 Worklet.");
    }
  };

  useEffect(() => {
    updateEngineConfig(activeEngine);
  }, [activeEngine, engineKey]);

  useEffect(() => {
     if (audioContextRef.current) {
         updateEnvironment(audioContextRef.current, envType);
     }
  }, [envType]);

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
           <div className="flex items-center gap-3 mb-2 animate-in fade-in slide-in-from-bottom-2 duration-700">
               <h1 className="text-4xl text-stone-100 font-mono font-bold tracking-tight">Phase 4: Production</h1>
               <div className="px-2 py-0.5 bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 font-mono text-[10px] uppercase rounded-full">v1.1 Stable </div>
           </div>
           
           <p className="text-stone-400 font-mono text-sm leading-relaxed max-w-3xl animate-in fade-in delay-150 duration-700">
             The engine simulation has been stabilized. Mathematical clipping ("recsegés") has been replaced with organic soft wave-steepening bounds and smoothed valve-impedance mapping. Synthesized environmental IR convolution bounds the final output in space.
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
                        : "bg-emerald-500/20 text-emerald-400 border border-emerald-500/50 hover:bg-emerald-500/30 shadow-[0_0_15px_rgba(16,185,129,0.1)]"
                    }`}
                    >
                    {isPlaying ? <Square size={16} /> : <Play size={16} />}
                    {isPlaying ? "Cut Ignition" : "Ignite Engine"}
                    </button>
                </div>
            </div>

            <div className="bg-stone-950 border border-stone-800 rounded-lg p-6 flex flex-col hover:border-stone-700 transition-colors">
                <div className="flex justify-between items-center mb-4">
                     <span className="text-stone-500 font-mono text-xs uppercase">Target Speed</span>
                     <span className="text-stone-200 font-mono text-lg font-bold">{targetRpm} <span className="text-stone-500 text-xs">RPM</span></span>
                </div>
                <input
                    type="range"
                    min="800"
                    max={activeEngine.metadata.max_rpm + 500}
                    step="10"
                    value={targetRpm}
                    onChange={(e) => setTargetRpm(Number(e.target.value))}
                    className="w-full appearance-none bg-stone-800 h-2 rounded-full outline-none [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-6 [&::-webkit-slider-thumb]:h-6 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-stone-200 cursor-pointer"
                />

                <div className="w-full flex gap-2 mt-8">
                    <button 
                        onMouseDown={() => { setThrottle(0.0); setTargetRpm(1000); }}
                        className="flex-1 bg-stone-900 border border-stone-800 rounded py-2 text-stone-400 font-mono text-xs hover:bg-stone-800 hover:text-stone-200 active:bg-stone-700 transition-colors"
                    >
                        Idle
                    </button>
                    <button 
                         onMouseDown={() => { setThrottle(0.8); setTargetRpm(activeEngine.metadata.max_rpm - 1500); }}
                         onMouseUp={() => { setThrottle(0.0); setTargetRpm(1000); }}
                         className="flex-1 bg-stone-900 border border-stone-800 rounded py-2 text-stone-400 font-mono text-xs hover:bg-stone-800 hover:text-stone-200 active:bg-stone-700 transition-colors"
                    >
                        Rev
                    </button>
                    <button 
                         onMouseDown={() => { setThrottle(1.0); setTargetRpm(activeEngine.metadata.max_rpm + 300); }}
                         onMouseUp={() => { setThrottle(0.0); setTargetRpm(1000); }}
                         className="flex-1 bg-red-900/20 border border-red-500/30 rounded py-2 text-red-400 font-mono text-xs hover:bg-red-900/40 active:bg-red-900/60 transition-colors"
                    >
                        Redline
                    </button>
                </div>
            </div>
          </div>

          <div className="col-span-2 space-y-8 animate-in fade-in slide-in-from-right-4 duration-700 delay-500 fill-mode-both">
             <div className="bg-stone-950 border border-stone-800 rounded-lg p-6 hover:border-stone-700 transition-colors">
                <div className="flex items-center gap-2 mb-8 pb-4 border-b border-stone-800 border-dashed">
                  <Volume2 className="text-stone-500" size={18} />
                  <h2 className="text-stone-200 font-mono font-semibold uppercase tracking-wider text-sm">Environmental Acoustics</h2>
                </div>
                
                <div className="grid grid-cols-3 gap-4 mb-8">
                     <button
                        onClick={() => setEnvType("track")}
                        className={`p-4 rounded-lg flex flex-col items-center justify-center gap-2 border transition-colors ${
                             envType === "track" ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400" : "bg-stone-900 border-stone-800 text-stone-500 hover:text-stone-300"
                        }`}
                     >
                        <span className="font-mono text-xs uppercase font-bold tracking-widest">Open Track</span>
                     </button>
                     <button
                        onClick={() => setEnvType("tunnel")}
                        className={`p-4 rounded-lg flex flex-col items-center justify-center gap-2 border transition-colors ${
                             envType === "tunnel" ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400" : "bg-stone-900 border-stone-800 text-stone-500 hover:text-stone-300"
                        }`}
                     >
                        <span className="font-mono text-xs uppercase font-bold tracking-widest">Long Tunnel</span>
                     </button>
                     <button
                        onClick={() => setEnvType("cabin")}
                        className={`p-4 rounded-lg flex flex-col items-center justify-center gap-2 border transition-colors ${
                             envType === "cabin" ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400" : "bg-stone-900 border-stone-800 text-stone-500 hover:text-stone-300"
                        }`}
                     >
                        <span className="font-mono text-xs uppercase font-bold tracking-widest">Interior Cabin</span>
                     </button>
                </div>

                <div className="flex flex-col">
                    <div className="flex justify-between items-end mb-3">
                        <label className="text-stone-400 font-mono text-xs uppercase tracking-widest">
                            Throttle Matrix Link
                        </label>
                        <span className="text-amber-400 font-mono font-bold text-lg">
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
                        className="w-full appearance-none bg-stone-800 h-2 rounded-full outline-none [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-amber-400 cursor-pointer"
                    />
                </div>
             </div>

             <div className="bg-stone-950 border border-stone-800 rounded-lg p-6 hover:border-stone-700 transition-colors">
                <div className="flex items-center gap-2 mb-6 pb-4 border-b border-stone-800 border-dashed">
                  <Sparkles className="text-stone-500" size={18} />
                  <h2 className="text-stone-200 font-mono font-semibold uppercase tracking-wider text-sm">DSP Stability Corrections Applied</h2>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="p-4 bg-stone-900 border border-stone-800 rounded-md">
                        <div className="flex items-start gap-3">
                            <div className="mt-0.5 text-emerald-500">✓</div>
                            <div>
                                <span className="text-stone-300 font-mono text-xs block mb-1 uppercase font-bold">Tanh Wave Steepening</span>
                                <span className="text-stone-500 font-mono text-[10px] leading-relaxed">
                                    Replaced rigid bounds with organic Math.tanh compression within the waveguide. High pressure now causes rasp instead of digital clipping bugs.
                                </span>
                            </div>
                        </div>
                    </div>
                    <div className="p-4 bg-stone-900 border border-stone-800 rounded-md">
                        <div className="flex items-start gap-3">
                            <div className="mt-0.5 text-emerald-500">✓</div>
                            <div>
                                <span className="text-stone-300 font-mono text-xs block mb-1 uppercase font-bold">Valve Impedance Smoothing</span>
                                <span className="text-stone-500 font-mono text-[10px] leading-relaxed">
                                    Valve lift relies on phase transitioning rather than exact step limits. Prevents boundary clicks during valve transitions.
                                </span>
                            </div>
                        </div>
                    </div>
                    <div className="p-4 bg-stone-900 border border-stone-800 rounded-md">
                        <div className="flex items-start gap-3">
                            <div className="mt-0.5 text-emerald-500">✓</div>
                            <div>
                                <span className="text-stone-300 font-mono text-xs block mb-1 uppercase font-bold">Lowpass Burst Pops</span>
                                <span className="text-stone-500 font-mono text-[10px] leading-relaxed">
                                    Unburnt fuel is ignited into smooth decaying bursts rather than 1-sample noise impulses, creating deep bass responses.
                                </span>
                            </div>
                        </div>
                    </div>
                    <div className="p-4 bg-stone-900 border border-stone-800 rounded-md">
                        <div className="flex items-start gap-3">
                            <div className="mt-0.5 text-emerald-500">✓</div>
                            <div>
                                <span className="text-stone-300 font-mono text-xs block mb-1 uppercase font-bold">Impulse Convolution Reverb</span>
                                <span className="text-stone-500 font-mono text-[10px] leading-relaxed">
                                    Final stage signal merges via standard Convolver Node using computationally generated environmental impulse response buffers.
                                </span>
                            </div>
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
