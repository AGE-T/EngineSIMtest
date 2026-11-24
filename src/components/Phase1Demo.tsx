import { useState, useRef, useEffect } from "react";
import { phase1WorkletCode } from "../audio/phase1Worklet";
import { Play, Square, Activity, Volume2 } from "lucide-react";

export function Phase1Demo() {
  const [isPlaying, setIsPlaying] = useState(false);
  const [rpm, setRpm] = useState(1500);
  const [pipeLength, setPipeLength] = useState(1.5);
  const [error, setError] = useState<string | null>(null);

  const audioContextRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);

  const togglePlayback = async () => {
    try {
      if (isPlaying) {
        audioContextRef.current?.suspend();
        setIsPlaying(false);
        return;
      }

      if (!audioContextRef.current) {
        // Initialize Web Audio Context
        const AudioContextBase =
          window.AudioContext || (window as any).webkitAudioContext;
        const ctx = new AudioContextBase();
        audioContextRef.current = ctx;

        // Load AudioWorklet from blob to avoid bundler issues
        const blob = new Blob([phase1WorkletCode], {
          type: "application/javascript",
        });
        const url = URL.createObjectURL(blob);

        await ctx.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);

        // Instantiate processor
        const node = new AudioWorkletNode(ctx, "phase1-engine-worklet");
        node.connect(ctx.destination);
        workletNodeRef.current = node;

        // Set initial params Safely
        setTimeout(() => {
          if (!workletNodeRef.current) return;
          const rpmParam = workletNodeRef.current.parameters.get("rpm");
          if (rpmParam) rpmParam.value = rpm;

          const pipeParam = workletNodeRef.current.parameters.get("pipeLength");
          if (pipeParam) pipeParam.value = pipeLength;
        }, 50);
      } else if (audioContextRef.current.state === "suspended") {
        audioContextRef.current.resume();
      }
      setIsPlaying(true);
    } catch (err: any) {
      console.error(err);
      setError(err.message || "Failed to initialize AudioContext.");
    }
  };

  // Sync state to worklet params smoothly
  useEffect(() => {
    if (workletNodeRef.current && audioContextRef.current) {
      const rpmParam = workletNodeRef.current.parameters.get("rpm");
      if (rpmParam)
        rpmParam.setTargetAtTime(
          rpm,
          audioContextRef.current.currentTime,
          0.1
        );
    }
  }, [rpm]);

  useEffect(() => {
    if (workletNodeRef.current && audioContextRef.current) {
      const pipeParam = workletNodeRef.current.parameters.get("pipeLength");
      if (pipeParam)
        pipeParam.setTargetAtTime(
          pipeLength,
          audioContextRef.current.currentTime,
          0.1
        );
    }
  }, [pipeLength]);

  // Clean up on component unmount
  useEffect(() => {
    return () => {
      audioContextRef.current?.close();
    };
  }, []);

  return (
    <div className="flex-1 h-screen overflow-y-auto bg-stone-900 flex flex-col p-8 lg:p-16">
      <div className="max-w-4xl mx-auto w-full">
        <div className="mb-12">
          <h1 className="text-4xl text-stone-100 font-mono font-bold tracking-tight mb-2">
            Phase 1: MVP Sandbox
          </h1>
          <p className="text-stone-400 font-mono text-sm leading-relaxed max-w-2xl">
            Single-cylinder phenomenological blowdown passing through a fractional bidirectional waveguide. Adjust RPM and exhaust runner length to hear physical resonance and pitch changes inherently derived from the simulation geometry.
          </p>
        </div>

        {error && (
          <div className="bg-red-500/10 border border-red-500/50 text-red-400 px-4 py-3 rounded-md mb-8 font-mono text-sm">
            Error: {error}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          {/* Controls Panel */}
          <div className="bg-stone-950 border border-stone-800 rounded-lg p-6">
            <div className="flex items-center justify-between mb-8 pb-4 border-b border-stone-800 border-dashed">
              <div className="flex items-center gap-2">
                <Activity className="text-stone-500" size={18} />
                <h2 className="text-stone-200 font-mono font-semibold uppercase tracking-wider text-sm">
                  Mechanical Input
                </h2>
              </div>

              <button
                onClick={togglePlayback}
                className={`flex items-center gap-2 px-4 py-2 rounded-md font-mono text-xs font-bold transition-all ${
                  isPlaying
                    ? "bg-red-500/20 text-red-400 border border-red-500/50 hover:bg-red-500/30"
                    : "bg-emerald-500/20 text-emerald-400 border border-emerald-500/50 hover:bg-emerald-500/30"
                }`}
              >
                {isPlaying ? <Square size={14} /> : <Play size={14} />}
                {isPlaying ? "STOP ENGINE" : "IGNITE"}
              </button>
            </div>

            <div className="space-y-8">
              {/* RPM Slider */}
              <div>
                <div className="flex justify-between items-end mb-3">
                  <label className="text-stone-400 font-mono text-xs uppercase tracking-widest">
                    Engine Speed
                  </label>
                  <span className="text-stone-200 font-mono font-bold text-lg">
                    {rpm} <span className="text-stone-500 text-xs">RPM</span>
                  </span>
                </div>
                <input
                  type="range"
                  min="500"
                  max="8000"
                  step="100"
                  value={rpm}
                  onChange={(e) => setRpm(Number(e.target.value))}
                  className="w-full appearance-none bg-stone-800 h-1.5 rounded-full outline-none [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-stone-200"
                />
              </div>

              {/* Pipe Length Slider */}
              <div>
                <div className="flex justify-between items-end mb-3">
                  <label className="text-stone-400 font-mono text-xs uppercase tracking-widest">
                    Runner Length
                  </label>
                  <span className="text-stone-200 font-mono font-bold text-lg">
                    {pipeLength.toFixed(2)}{" "}
                    <span className="text-stone-500 text-xs">Meters</span>
                  </span>
                </div>
                <input
                  type="range"
                  min="0.2"
                  max="4.0"
                  step="0.05"
                  value={pipeLength}
                  onChange={(e) => setPipeLength(Number(e.target.value))}
                  className="w-full appearance-none bg-stone-800 h-1.5 rounded-full outline-none [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-stone-200"
                />
              </div>
            </div>
          </div>

          {/* Telemetry Panel */}
          <div className="bg-stone-950 border border-stone-800 rounded-lg p-6 flex flex-col">
            <div className="flex items-center gap-2 mb-8 pb-4 border-b border-stone-800 border-dashed">
              <Volume2 className="text-stone-500" size={18} />
              <h2 className="text-stone-200 font-mono font-semibold uppercase tracking-wider text-sm">
                Live Acoustic State
              </h2>
            </div>

            <div className="flex-1 grid grid-cols-2 gap-4">
              <div className="bg-stone-900 border border-stone-800/50 rounded p-4 flex flex-col justify-center">
                <span className="text-stone-500 font-mono text-[10px] uppercase mb-1">
                  Firing Pitch
                </span>
                <span className="text-emerald-400 font-mono font-bold text-2xl">
                  {/* Firing 1 time per 2 revolutions (4 stroke) for 1 cylinder */}
                  {(rpm / 120).toFixed(1)}{" "}
                  <span className="text-sm text-stone-500">Hz</span>
                </span>
              </div>
              <div className="bg-stone-900 border border-stone-800/50 rounded p-4 flex flex-col justify-center">
                <span className="text-stone-500 font-mono text-[10px] uppercase mb-1">
                  Pipe Resonance Length
                </span>
                <span className="text-blue-400 font-mono font-bold text-2xl">
                  {((pipeLength / 343) * 1000).toFixed(1)}{" "}
                  <span className="text-sm text-stone-500">ms delay</span>
                </span>
              </div>
              <div className="bg-stone-900 border border-stone-800/50 rounded p-4 flex flex-col justify-center">
                <span className="text-stone-500 font-mono text-[10px] uppercase mb-1">
                  Waveguide Status
                </span>
                <div className="flex items-center gap-2">
                  <div
                    className={`w-2 h-2 rounded-full ${
                      isPlaying
                        ? "bg-emerald-500 animate-pulse"
                        : "bg-stone-700"
                    }`}
                  ></div>
                  <span className="text-stone-300 font-mono font-bold text-sm uppercase">
                    {isPlaying ? "COMPUTING" : "IDLE"}
                  </span>
                </div>
              </div>
              <div className="bg-stone-900 border border-stone-800/50 rounded p-4 flex flex-col justify-center">
                <span className="text-stone-500 font-mono text-[10px] uppercase mb-1">
                  Exhaust Valve
                </span>
                <span className="text-stone-300 font-mono font-bold text-xl">
                  {(rpm / 120).toFixed(1)} <span className="text-xs text-stone-500">Opens/sec</span>
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
