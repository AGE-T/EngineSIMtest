import { useState, useRef, useEffect, useCallback } from "react";
import { phase8WorkletCode } from "../audio/phase8Worklet";
import { engines, EngineConfig } from "../data/engines";
import { enginePresets, EnginePreset } from "../data/presets";
import { Play, Square, Settings2, SlidersHorizontal, ArrowUpCircle, ArrowDownCircle, Gamepad2, RadioReceiver, FolderOpen, Activity } from "lucide-react";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

function cn(...inputs: (string | undefined | null | false)[]) {
  return twMerge(clsx(inputs));
}

function generateReverbIR(ctx: AudioContext, type: "track" | "cabin" | "tunnel" | "street") {
    let duration = 0.4;
    let decay = 10.0;
    let filterFreq = 3000;

    if (type === "tunnel") {
        duration = 1.5;
        decay = 3.0;
        filterFreq = 800; 
    } else if (type === "street") {
        duration = 0.5;    // Extremely short decay (500ms total block window)
        decay = 24.0;      // Extreme open-air attenuation rate
        filterFreq = 1600; // Softened high frequencies for warm asphalt reflection
    } else { 
        duration = 0.5;
        decay = 12.0;
        filterFreq = 3500;
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
            
            // for street add pseudo-reflections
            let env = Math.exp(-decay * i / sr);
            if (type === "street") {
               // Concrete early wall reflections (bounces) rather than smooth cathedral reverb tail
               let bounce1 = Math.exp(-15.0 * Math.abs(i - sr * 0.035) / sr) * 0.65; // 35ms bounce, very tight
               let bounce2 = Math.exp(-22.0 * Math.abs(i - sr * 0.085) / sr) * 0.35; // 85ms bounce, tighter
               let bounce3 = Math.exp(-28.0 * Math.abs(i - sr * 0.160) / sr) * 0.15; // 160ms bounce
               
               env = env * 0.02 + bounce1 + bounce2 + bounce3;
            }
            channel[i] = lastVal * env * 0.15;
        }
    }
    return buffer;
}

export function Phase8Demo() {
  const [isPlaying, setIsPlaying] = useState(false);
  const [engineKey, setEngineKey] = useState<string>("v8-flatplane");
  const activeEngine = engines[engineKey];
  
  const [turboType, setTurboType] = useState<number>(0); // 0=NA, 1=Small, 2=Big, 3=Twin
  
  // Mixer state
  const [volExhaust, setVolExhaust] = useState(1.0);
  const [panExhaust, setPanExhaust] = useState(0.0);
  
  const [volIntake, setVolIntake] = useState(1.0);
  const [panIntake, setPanIntake] = useState(0.0);
  
  const [volEngine, setVolEngine] = useState(1.0);
  const [panEngine, setPanEngine] = useState(0.0);
  
  const [volWhine, setVolWhine] = useState(1.0);
  const [volFlutter, setVolFlutter] = useState(1.0);
  const [panTurbo, setPanTurbo] = useState(0.0);

  const [enablePops, setEnablePops] = useState(true);
  const [enablePopsEcho, setEnablePopsEcho] = useState(true);
  const [volPops, setVolPops] = useState(1.0);
  const [panPops, setPanPops] = useState(0.0);
  const [carMass, setCarMass] = useState(1500);

  const [downpipeLength, setDownpipeLength] = useState(engines[engineKey].downpipeLength || 0.5);
  const [tailpipeLength, setTailpipeLength] = useState(engines[engineKey].tailpipeLength || 1.5);
  const [downpipeDiameter, setDownpipeDiameter] = useState(engines[engineKey].downpipeDiameter || 0.08);
  const [tailpipeDiameter, setTailpipeDiameter] = useState(engines[engineKey].tailpipeDiameter || 0.1);

  useEffect(() => {
    setDownpipeLength(activeEngine.downpipeLength || 0.5);
    setTailpipeLength(activeEngine.tailpipeLength || 1.5);
    setDownpipeDiameter(activeEngine.downpipeDiameter || 0.08);
    setTailpipeDiameter(activeEngine.tailpipeDiameter || 0.1);
  }, [activeEngine]);

  const [midiStatus, setMidiStatus] = useState<string>("Waiting for MIDI...");

  const [error, setError] = useState<string | null>(null);

  const [activePreset, setActivePreset] = useState<string>("custom");

  const applyPreset = (presetId: string) => {
      const preset = enginePresets.find(p => p.id === presetId);
      if (!preset) return;
      
      setActivePreset(preset.id);
      setEngineKey(preset.engineKey);
      setTurboType(preset.turboType);
      setEnablePops(preset.enablePops);
      setCarMass(preset.mass);
      setVolExhaust(preset.volumes.tailpipe);
      setVolIntake(preset.volumes.intake);
      setVolEngine(preset.volumes.mech);
      setVolWhine(preset.volumes.whine);
      setVolFlutter(preset.volumes.flutter);
      setVolPops(preset.volumes.pops);
  };

  const audioContextRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const popWetGainRef = useRef<GainNode | null>(null);

  const rpmDashRef = useRef<HTMLSpanElement>(null);
  const speedDashRef = useRef<HTMLSpanElement>(null);
  const gearDashRef = useRef<HTMLSpanElement>(null);

  const inputsRef = useRef({ throttle: false, brake: false, analogThrottle: 0.0 });
  const physicsRef = useRef({
    speed: 0,
    rpm: 1000,
    gear: 0, 
    clutch: 0,
    throttleInput: 0,
    brakeInput: 0,
    ignitionCut: false,
    ignitionCutTimer: 0,
    lastTime: performance.now(),
    gearRatios: [0, 3.42, 2.10, 1.45, 1.03, 0.81, 0.62, 0.52],
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
    
    // Safety check if current gear is out of bounds for the new engine
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

  useEffect(() => {
    // Check if the browser supports Web MIDI API
    const nav = navigator as any;
    if (nav.requestMIDIAccess) {
      nav.requestMIDIAccess().then(
        (midiAccess: any) => {
          setMidiStatus(`Connected (${midiAccess.inputs.size} ports)`);
          
          for (var input of midiAccess.inputs.values()) {
            input.onmidimessage = handleMidi;
          }
          
          midiAccess.onstatechange = (e: any) => {
            let hasConnection = false;
            let count = 0;
            for (var i of midiAccess.inputs.values()) {
                hasConnection = true; count++;
                i.onmidimessage = handleMidi;
            }
            setMidiStatus(hasConnection ? `Connected (${count} ports)` : "Disconnected (No input ports)");
          }
        },
        () => {
          setMidiStatus("Access Denied (Requires HTTPS/Permission)");
        }
      );
    } else {
      setMidiStatus("Unsupported in this Browser");
    }

    function handleMidi(msg: any) {
       const command = msg.data[0];
       const ccNumber = msg.data[1];
       const value = msg.data[2];

       if (command >= 176 && command <= 191) {
          const norm = value / 127.0;
          switch(ccNumber) {
             case 70: inputsRef.current.analogThrottle = norm; break;
             case 72: setTurboType(Math.round(norm * 3)); break;
             case 80: setVolExhaust(norm); break;
             case 81: setVolIntake(norm); break;
             case 82: setVolEngine(norm); break;
             case 83: setVolWhine(norm); break;
             case 84: setVolFlutter(norm); break;
             case 85: setVolPops(norm); break;
          }
       }
    }
  }, []);

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

        const blob = new Blob([phase8WorkletCode], { type: "application/javascript" });
        const url = URL.createObjectURL(blob);

        await ctx.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);

        const node = new AudioWorkletNode(ctx, "phase8-engine-worklet", {
             outputChannelCount: [10] 
        });
        
        const gain = ctx.createGain();
        gain.gain.value = 0.6; // Extra headroom for mix
        gain.connect(ctx.destination);

        // Split the 10-channel output 
        const splitter = ctx.createChannelSplitter(10);
        node.connect(splitter);

        const mainMix = ctx.createChannelMerger(2);
        
        // 0/1: Tailpipe
        splitter.connect(mainMix, 0, 0); // L
        splitter.connect(mainMix, 1, 1); // R
        
        // 4/5: Engine Block
        splitter.connect(mainMix, 4, 0); 
        splitter.connect(mainMix, 5, 1); 

        // 6/7: Intake
        splitter.connect(mainMix, 6, 0); 
        splitter.connect(mainMix, 7, 1); 

        // 8/9: Turbo
        splitter.connect(mainMix, 8, 0); 
        splitter.connect(mainMix, 9, 1); 
        
        // Pops to Dedicated Reverb
        const popsMix = ctx.createChannelMerger(2);
        splitter.connect(popsMix, 2, 0); // Pops L
        splitter.connect(popsMix, 3, 1); // Pops R

        const convolver = ctx.createConvolver();
        convolver.buffer = generateReverbIR(ctx, "track");
        convolver.connect(gain);
        
        // Dry Engine
        const dryGain = ctx.createGain();
        dryGain.gain.value = 0.8;
        mainMix.connect(dryGain);
        dryGain.connect(gain);
        
        // Wet send to reverb
        const wetGain = ctx.createGain();
        wetGain.gain.value = 0.3;
        mainMix.connect(wetGain);
        wetGain.connect(convolver);

        // Pops Reverb (Street gunshot effect)
        const popConvolver = ctx.createConvolver();
        popConvolver.buffer = generateReverbIR(ctx, "street");
        popConvolver.connect(gain);
        
        const popDryGain = ctx.createGain();
        popDryGain.gain.value = 1.0; // dry crack
        popsMix.connect(popDryGain);
        popDryGain.connect(gain);

        const popWetGain = ctx.createGain();
        popWetGain.gain.value = enablePopsEcho ? 1.0 : 0.0; // dynamic wet tail
        popsMix.connect(popWetGain);
        popWetGain.connect(popConvolver);
        popWetGainRef.current = popWetGain;

        workletNodeRef.current = node;

        setTimeout(() => {
          updateEngineConfig(activeEngine);
        }, 50);

      } else if (audioContextRef.current.state === "suspended") {
        updateEngineConfig(activeEngine);
      }
      if (audioContextRef.current?.state === "suspended") {
        audioContextRef.current.resume();
      }
      setIsPlaying(true);
    } catch (err: any) {
      console.error(err);
      setError(err.message || "Failed to initialize Phase 8 Worklet.");
    }
  };

  useEffect(() => {
    updateEngineConfig(activeEngine);
  }, [activeEngine, engineKey, updateEngineConfig]);

  useEffect(() => {
    if (workletNodeRef.current) {
        workletNodeRef.current.port.postMessage({ type: "updatePipes", downpipeLength, tailpipeLength, downpipeDiameter, tailpipeDiameter });
    }
  }, [downpipeLength, tailpipeLength, downpipeDiameter, tailpipeDiameter]);

  // Main Vehicle Physics Loop
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
           let baseThrottle = inputsRef.current.throttle ? 1.0 : 0.0;
           state.throttleInput = Math.max(baseThrottle, inputsRef.current.analogThrottle || 0.0);
           state.brakeInput = inputsRef.current.brake ? 1.0 : 0.0;
        }

        const maxTorque = (activeEngine.metadata.max_torque || 400) + (turboType > 0 ? 300 : 0); 
        const normRpm = state.rpm / state.maxRpm;
        const torqueCurve = Math.max(0, 1.0 - Math.pow(normRpm - 0.6, 2) * 2.0);
        
        let ignition = 1.0;
        // Rev limiter with bounce timer
        if (state.ignitionCutTimer > 0 && activeEngine.layout !== "Turbine" && activeEngine.layout !== "Turbofan") {
            state.ignitionCutTimer -= dt;
            state.ignitionCut = true;
        } else {
            state.ignitionCut = false;
        }

        if (state.rpm >= state.maxRpm && !state.ignitionCut) {
            if (activeEngine.layout === "Turbine" || activeEngine.layout === "Turbofan") {
                state.rpm = state.maxRpm; // smooth limiting
            } else {
                state.ignitionCut = true;
                // 80ms hard cut for that classic sututu / ratatat bounce
                state.ignitionCutTimer = 0.08;
            }
        }
        
        if (state.ignitionCut) {
            ignition = 0.0;
        }

        const engineTorque = torqueCurve * maxTorque * state.throttleInput * ignition;
        const engineFriction = maxTorque * 0.05 + maxTorque * 0.15 * Math.pow(normRpm, 2); 

        const brakeTorque = state.brakeInput * 4500;
        
        // Scale drag by mass so motorcycles (low mass) have less frontal area and rolling resistance
        const massScale = state.mass / 1500;
        const dragArea = 2.0 * Math.pow(massScale, 0.5); 
        const rollingRes = 20 * massScale;
        const drag = 0.5 * 1.2 * 0.3 * dragArea * state.speed * state.speed + rollingRes * state.speed;

        let idleRpm = 1000;
        let inertia = 0.15;
        let stallRpm = 800;
        const isJet = activeEngine.layout === "Turbine" || activeEngine.layout === "Turbofan";
        
        if (activeEngine.layout === "Rotary") inertia = 0.08;
        if (activeEngine.layout === "Turbine") {
            inertia = 10.0;
            idleRpm = 4000;
            stallRpm = 3000;
        }
        if (activeEngine.layout === "Turbofan") {
            inertia = 30.0;
            idleRpm = 3000;
            stallRpm = 2000;
        }

        if (state.gear === 0 || state.clutch > 0 || isJet) {
            const netTorque = engineTorque - engineFriction;
            
            const accelRad = netTorque / inertia;
            const accelRpm = accelRad * (60 / (2 * Math.PI));
            state.rpm += accelRpm * dt;
            
            if (state.throttleInput === 0 && state.rpm < idleRpm) {
               state.rpm += 5000 * dt; 
            }

            let wheelForce = -drag - (brakeTorque / state.wheelRadius);
            
            if (isJet) {
                const maxThrust = activeEngine.metadata.max_torque * 4.0; 
                const rpmRatio = Math.max(0, (state.rpm - idleRpm) / (state.maxRpm - idleRpm));
                const thrust = Math.pow(rpmRatio, 2.0) * maxThrust; // Quadratic thrust curve
                wheelForce += thrust;
                
                state.speed += (wheelForce / state.mass) * dt;
                if (state.speed < 0) state.speed = 0;
            } else {
                if (state.speed > 0) {
                   state.speed += (wheelForce / state.mass) * dt;
                   if (state.speed < 0) state.speed = 0;
                }
            }
        } else {
            const wheelTorque = (engineTorque - engineFriction) * totalRatio;
            const netForce = (wheelTorque / state.wheelRadius) - drag - (brakeTorque / state.wheelRadius);
            
            const idealRpm = (state.speed * 60) / (2 * Math.PI * state.wheelRadius) * totalRatio;
            
            // Dynamic stall/slip target based on throttle
            const slipTargetRpm = idleRpm + state.throttleInput * 1500;
            
            if (idealRpm < slipTargetRpm) {
                // Clutch slipping: Engine revs to slipTargetRpm, wheels driven by slip torque
                state.rpm += (slipTargetRpm - state.rpm) * 15.0 * dt;
                
                let slipTorque = engineTorque - engineFriction;
                if (slipTorque < 0) slipTorque = 0;
                
                const force = (slipTorque * totalRatio / state.wheelRadius) - drag - (brakeTorque / state.wheelRadius);
                state.speed += (force / state.mass) * dt;
                if (state.speed < 0) state.speed = 0;
            } else {
                // Fully engaged clutch: Engine locked to wheels
                state.speed += (netForce / state.mass) * dt;
                if (state.speed < 0) state.speed = 0;
                
                // New idealRpm after speed update
                const newIdealRpm = (state.speed * 60) / (2 * Math.PI * state.wheelRadius) * totalRatio;
                const rpmDifference = newIdealRpm - state.rpm;
                
                state.drivetrainFlexVel += rpmDifference * 1000.0 * dt;
                state.drivetrainFlexVel *= Math.exp(-10.0 * dt); 
                
                state.rpm += state.drivetrainFlexVel * dt;
                state.rpm += rpmDifference * 20.0 * dt; 
            }
            
            if (state.rpm < stallRpm) {
                state.rpm = stallRpm; 
                if (state.brakeInput === 0 && state.throttleInput === 0) {
                    state.speed += 2.0 * dt; 
                }
            }
        }

        if (state.rpm < 0) state.rpm = 0;

        if (rpmDashRef.current && speedDashRef.current && gearDashRef.current) {
            const rpmClamped = Math.max(0, Math.round(state.rpm));
            rpmDashRef.current.innerText = rpmClamped.toString();
            
            if (state.rpm > state.maxRpm - 500) {
               rpmDashRef.current.className = "text-6xl md:text-8xl font-mono font-bold text-red-500 tabular-nums drop-shadow-[0_0_15px_rgba(239,68,68,0.5)]";
            } else {
               rpmDashRef.current.className = "text-6xl md:text-8xl font-mono font-bold text-stone-200 tabular-nums drop-shadow-[0_0_15px_rgba(255,255,255,0.2)]";
            }

            speedDashRef.current.innerText = Math.round(state.speed * 3.6).toString();
            gearDashRef.current.innerText = state.gear === 0 ? "N" : state.gear.toString();
        }
        
        const overRevLimit = state.maxRpm * 1.25;
        if (state.rpm > overRevLimit) {
            state.rpm = overRevLimit;
            // Massive rear tire lockup simulation on money shift
            state.speed -= 20.0 * dt; 
        }
        if (state.rpm < 0) state.rpm = 0;

        // Apply audio params
        if (workletNodeRef.current && audioContextRef.current) {
            const p = workletNodeRef.current.parameters;
            const t = audioContextRef.current.currentTime;
            
            const engineLoad = (state.gear === 0 || state.clutch > 0.5) ? 0.05 : (state.throttleInput * ignition);
            
            p.get("rpm")?.setTargetAtTime(state.rpm, t, 0.015);
            p.get("throttle")?.setTargetAtTime(state.throttleInput, t, 0.015);
            p.get("load")?.setTargetAtTime(engineLoad, t, 0.05); 
            p.get("ignition")?.setTargetAtTime(ignition, t, 0.01);
            p.get("turboType")?.setTargetAtTime(turboType, t, 0.01);
            p.get("volExhaust")?.setTargetAtTime(volExhaust, t, 0.01);
            p.get("panExhaust")?.setTargetAtTime(panExhaust, t, 0.01);
            p.get("volIntake")?.setTargetAtTime(volIntake, t, 0.01);
            p.get("panIntake")?.setTargetAtTime(panIntake, t, 0.01);
            p.get("volEngine")?.setTargetAtTime(volEngine, t, 0.01);
            p.get("panEngine")?.setTargetAtTime(panEngine, t, 0.01);
            p.get("volWhine")?.setTargetAtTime(volWhine, t, 0.01);
            p.get("volFlutter")?.setTargetAtTime(volFlutter, t, 0.01);
            p.get("panTurbo")?.setTargetAtTime(panTurbo, t, 0.01);
            p.get("enablePops")?.setTargetAtTime(enablePops ? 1 : 0, t, 0.01);
            p.get("volPops")?.setTargetAtTime(volPops, t, 0.01);
            p.get("panPops")?.setTargetAtTime(panPops, t, 0.01);
            
            if (popWetGainRef.current && audioContextRef.current) {
                popWetGainRef.current.gain.setTargetAtTime(enablePopsEcho ? 1.0 : 0.0, t, 0.015);
            }
            
            // Mass is physically applied in physics state directly
            state.mass = carMass;
        }
        
        frameId = requestAnimationFrame(loop);
    };
    
    physicsRef.current.lastTime = performance.now();
    frameId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frameId);
  }, [isPlaying, turboType, volExhaust, panExhaust, volIntake, panIntake, volEngine, panEngine, volWhine, volFlutter, panTurbo, enablePops, enablePopsEcho, volPops, panPops, carMass, activeEngine.layout]);

  useEffect(() => {
    return () => {
      audioContextRef.current?.close();
    };
  }, []);

  return (
    <div className="flex-1 h-screen overflow-y-auto bg-stone-900 flex flex-col p-8 lg:p-16">
      <div className="max-w-6xl mx-auto w-full">
        <div className="mb-12">
           <div className="flex items-center gap-3 mb-2 animate-in fade-in slide-in-from-bottom-2 duration-700">
               <h1 className="text-4xl text-stone-100 font-mono font-bold tracking-tight">Phase 8: Master Studio Mixer</h1>
               <div className="px-2 py-0.5 bg-indigo-500/10 border border-indigo-500/30 text-indigo-400 font-mono text-[10px] uppercase rounded-full">Spatial Mix + Rotaries</div>
           </div>
           
           <p className="text-stone-400 font-mono text-sm leading-relaxed max-w-3xl animate-in fade-in delay-150 duration-700">
             Advanced routing separates Exhaust, Intake, and Engine Noise into distinct stereo planes. Tweak the acoustic mix perfectly, test different turbocharger arrangements, or explore the chaotic resonance of a multi-rotor Wankel engine.
           </p>
        </div>

        {error && (
          <div className="bg-red-500/10 border border-red-500/50 text-red-400 px-4 py-3 rounded-md mb-8 font-mono text-sm">
            Error: {error}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">
          
          {/* Controls */}
          <div className="col-span-1 space-y-6 animate-in fade-in slide-in-from-left-4 duration-700 delay-300 fill-mode-both">
            <div className="bg-stone-950 border border-indigo-500/30 rounded-lg p-5 flex flex-col hover:border-indigo-500/50 transition-colors shadow-[0_0_15px_rgba(99,102,241,0.05)]">
                <div className="flex items-center gap-2 mb-4 pb-3 border-b border-stone-800">
                    <FolderOpen className="text-indigo-400" size={16} />
                    <h2 className="text-stone-200 font-mono font-semibold uppercase tracking-wider text-xs">Presets</h2>
                </div>
                
                <select 
                   value={activePreset}
                   onChange={(e) => applyPreset(e.target.value)}
                   disabled={isPlaying}
                   className="w-full bg-indigo-950/30 border border-indigo-500/40 text-indigo-200 font-mono text-xs p-3 rounded uppercase focus:border-indigo-400 outline-none disabled:opacity-50 appearance-none cursor-pointer"
                >
                   <option value="custom" disabled>-- Select a Preset --</option>
                   {enginePresets.map(p => (
                       <option key={p.id} value={p.id}>{p.name}</option>
                   ))}
                </select>
                {activePreset !== "custom" && (
                    <div className="mt-3 text-stone-400 font-mono text-[10px] leading-relaxed">
                        {enginePresets.find(p => p.id === activePreset)?.description}
                    </div>
                )}
            </div>

            <div className="bg-stone-950 border border-stone-800 rounded-lg p-5 flex flex-col hover:border-stone-700 transition-colors">
                <div className="flex items-center gap-2 mb-4 pb-3 border-b border-stone-800">
                    <Settings2 className="text-stone-500" size={16} />
                    <h2 className="text-stone-200 font-mono font-semibold uppercase tracking-wider text-xs">Aspiration</h2>
                </div>
                
                <div className="flex flex-col gap-2">
                    {[
                      { id: 0, label: "Naturally Aspirated" },
                      { id: 1, label: "Small Single Turbo" },
                      { id: 2, label: "Big Turbo (Surge)" },
                      { id: 3, label: "Twin Turbos" }
                    ].map(t => (
                        <button
                          key={t.id}
                          onClick={() => setTurboType(t.id)}
                          className={cn(
                              "text-left px-3 py-2 rounded text-xs font-mono font-bold uppercase transition-all shadow-sm border",
                              turboType === t.id
                              ? "bg-indigo-500/20 text-indigo-400 border-indigo-500/50"
                              : "bg-stone-900 text-stone-500 border-stone-800 hover:text-stone-300"
                          )}
                        >
                            {t.label}
                        </button>
                    ))}
                </div>
            </div>

            <div className="bg-stone-950 border border-stone-800 rounded-lg p-5 flex flex-col hover:border-stone-700 transition-colors">
                 <div className="flex items-center gap-2 mb-4 pb-3 border-b border-stone-800">
                    <Gamepad2 className="text-stone-500" size={16} />
                    <h2 className="text-stone-200 font-mono font-semibold uppercase tracking-wider text-xs">Engine Block</h2>
                </div>
                
                <select 
                   value={engineKey}
                   onChange={(e) => setEngineKey(e.target.value)}
                   disabled={isPlaying}
                   className="w-full bg-stone-900 border border-stone-800 text-stone-300 font-mono text-xs p-3 rounded uppercase focus:border-stone-500 outline-none disabled:opacity-50 appearance-none cursor-pointer mb-6"
                >
                   {Object.keys(engines).map(k => (
                       <option key={k} value={k}>{engines[k].name}</option>
                   ))}
                </select>

                <div className="flex flex-col gap-4 mb-6">
                    <label className="flex items-center justify-between text-xs font-mono text-stone-400 cursor-pointer">
                        <span>Pops & Bangs (ECU)</span>
                        <input type="checkbox" checked={enablePops} onChange={(e) => setEnablePops(e.target.checked)} className="accent-indigo-500 w-4 h-4" />
                    </label>

                    <label className="flex items-center justify-between text-xs font-mono text-stone-400 cursor-pointer pl-4 border-l border-stone-800">
                        <span className="text-stone-500">└─ Street Reverb Echo</span>
                        <input type="checkbox" checked={enablePopsEcho} onChange={(e) => setEnablePopsEcho(e.target.checked)} className="accent-indigo-500 w-3.5 h-3.5" disabled={!enablePops} />
                    </label>

                    <div className="flex flex-col gap-2">
                        <div className="flex justify-between font-mono text-xs text-stone-400">
                            <span>Chassis Mass</span>
                            <span>{carMass} kg</span>
                        </div>
                        <input 
                            type="range" 
                            min="200" 
                            max="50000" 
                            step="50" 
                            value={carMass} 
                            onChange={(e) => setCarMass(parseInt(e.target.value))}
                            className="w-full accent-indigo-500"
                        />
                    </div>
                </div>

                <div className="flex items-center gap-2 mb-4 pb-3 border-b border-stone-800 mt-2">
                    <Activity className="text-stone-500" size={16} />
                    <h2 className="text-stone-200 font-mono font-semibold uppercase tracking-wider text-xs">Exhaust Tuning</h2>
                </div>
                
                <div className="flex flex-col gap-4 mb-6">
                    <div className="flex flex-col gap-2">
                        <div className="flex justify-between font-mono text-xs text-stone-400">
                            <span>Downpipe Length</span>
                            <span>{downpipeLength.toFixed(2)}m</span>
                        </div>
                        <input 
                            type="range" 
                            min="0.1" 
                            max="2.5" 
                            step="0.05" 
                            value={downpipeLength} 
                            onChange={(e) => setDownpipeLength(parseFloat(e.target.value))}
                            className="w-full accent-indigo-500"
                        />
                    </div>
                    <div className="flex flex-col gap-2">
                        <div className="flex justify-between font-mono text-xs text-stone-400">
                            <span>Downpipe Diameter</span>
                            <span>{downpipeDiameter.toFixed(3)}m</span>
                        </div>
                        <input 
                            type="range" 
                            min="0.03" 
                            max="0.15" 
                            step="0.01" 
                            value={downpipeDiameter} 
                            onChange={(e) => setDownpipeDiameter(parseFloat(e.target.value))}
                            className="w-full accent-indigo-500"
                        />
                    </div>
                    <div className="flex flex-col gap-2">
                        <div className="flex justify-between font-mono text-xs text-stone-400">
                            <span>Tailpipe Length</span>
                            <span>{tailpipeLength.toFixed(2)}m</span>
                        </div>
                        <input 
                            type="range" 
                            min="0.1" 
                            max="5.0" 
                            step="0.1" 
                            value={tailpipeLength} 
                            onChange={(e) => setTailpipeLength(parseFloat(e.target.value))}
                            className="w-full accent-indigo-500"
                        />
                    </div>
                    <div className="flex flex-col gap-2">
                        <div className="flex justify-between font-mono text-xs text-stone-400">
                            <span>Tailpipe Diameter</span>
                            <span>{tailpipeDiameter.toFixed(3)}m</span>
                        </div>
                        <input 
                            type="range" 
                            min="0.04" 
                            max="0.20" 
                            step="0.01" 
                            value={tailpipeDiameter} 
                            onChange={(e) => setTailpipeDiameter(parseFloat(e.target.value))}
                            className="w-full accent-indigo-500"
                        />
                    </div>
                </div>

                <div className="flex gap-2">
                     <button
                        onMouseDown={() => inputsRef.current.throttle = true}
                        onMouseUp={() => inputsRef.current.throttle = false}
                        onMouseLeave={() => inputsRef.current.throttle = false}
                        className="flex-2 py-4 bg-stone-900 border border-stone-800 rounded text-stone-300 font-mono text-xs uppercase hover:bg-stone-800 active:bg-stone-700 select-none font-bold"
                     >
                        GAS (W)
                     </button>
                     <button
                        onMouseDown={() => inputsRef.current.brake = true}
                        onMouseUp={() => inputsRef.current.brake = false}
                        onMouseLeave={() => inputsRef.current.brake = false}
                        className="flex-1 py-4 bg-stone-900 border border-stone-800 rounded text-red-400 font-mono text-xs uppercase hover:bg-stone-800 active:bg-stone-700 select-none"
                     >
                        BRK
                     </button>
                </div>
                
                <div className="mt-4">
                    <button
                        onClick={togglePlayback}
                        className={cn(
                            "w-full flex items-center justify-center gap-2 px-4 py-4 rounded-md font-mono text-sm font-bold transition-all uppercase tracking-widest",
                            isPlaying
                            ? "bg-red-500/20 text-red-400 border border-red-500/50 hover:bg-red-500/30"
                            : "bg-emerald-500/20 text-emerald-400 border border-emerald-500/50 hover:bg-emerald-500/30"
                        )}
                        >
                        {isPlaying ? <Square size={16} /> : <Play size={16} />}
                        {isPlaying ? "Kill Contact" : "Ignite"}
                    </button>
                </div>
            </div>
          </div>

          {/* Telemetry and Mixer */}
          <div className="col-span-1 lg:col-span-3 space-y-8 animate-in fade-in slide-in-from-right-4 duration-700 delay-500 fill-mode-both">
             
             {/* Studio Mixer */}
             <div className="bg-stone-950 border border-stone-800 rounded-lg p-6">
                 <div className="flex items-center gap-2 mb-6 pb-4 border-b border-stone-800">
                    <SlidersHorizontal className="text-stone-500" size={18} />
                    <h2 className="text-stone-200 font-mono font-semibold uppercase tracking-wider text-sm">Spatial Audio Mix Engine</h2>
                </div>

                <div className="grid grid-cols-2 lg:grid-cols-6 gap-6">
                    <MixerSlider label="Tailpipe" val={volExhaust} setVal={setVolExhaust} pan={panExhaust} setPan={setPanExhaust} />
                    <MixerSlider label="Intake" val={volIntake} setVal={setVolIntake} pan={panIntake} setPan={setPanIntake} />
                    <MixerSlider label="Mech" val={volEngine} setVal={setVolEngine} pan={panEngine} setPan={setPanEngine} />
                    <MixerSlider label="Whine" val={volWhine} setVal={setVolWhine} disabled={turboType === 0} pan={panTurbo} setPan={setPanTurbo} />
                    <MixerSlider label="Surge" val={volFlutter} setVal={setVolFlutter} disabled={turboType === 0} pan={panTurbo} setPan={setPanTurbo} />
                    <MixerSlider label="Pops" val={volPops} setVal={setVolPops} disabled={!enablePops} pan={panPops} setPan={setPanPops} />
                </div>
             </div>

             {/* Web MIDI External Control Panel */}
             <div className="bg-stone-950 border border-stone-800 rounded-lg p-6 flex flex-col sm:flex-row gap-6 justify-between items-center group relative overflow-hidden">
                <div className="flex items-center gap-3 relative z-10 w-full sm:w-auto">
                   <div className={cn("p-2 rounded-full", midiStatus.startsWith("Connected") ? "bg-green-500/10 text-green-500" : "bg-stone-900 text-stone-600")}>
                     <RadioReceiver size={20} />
                   </div>
                   <div className="flex-1">
                       <h3 className="text-stone-200 font-mono font-semibold uppercase tracking-wider text-sm flex items-center justify-between sm:justify-start gap-2">
                          Web MIDI Engine
                          {midiStatus.startsWith("Connected") && <span className="bg-green-500/20 text-green-400 text-[10px] px-2 py-0.5 rounded-full">ACTIVE</span>}
                       </h3>
                       <p className="text-stone-500 text-xs font-mono mt-0.5 uppercase tracking-wide truncate max-w-[200px] sm:max-w-none" title={midiStatus}>{midiStatus}</p>
                   </div>
                </div>
                <div className="flex w-full sm:w-auto relative z-10">
                    <div className="bg-stone-900/50 border border-stone-800/50 rounded-md p-3 w-full backdrop-blur-sm">
                        <span className="text-stone-500 text-[10px] uppercase font-mono block mb-1.5 font-bold tracking-widest">Automation Mappings (CC)</span>
                        <div className="text-stone-400 text-[10px] sm:text-xs font-mono grid grid-cols-2 gap-x-6 gap-y-1">
                           <div className="flex justify-between"><span>Throttle</span> <span className="text-stone-300">70</span></div>
                           <div className="flex justify-between"><span>Turbo Config</span> <span className="text-stone-300">72</span></div>
                           <div className="col-span-2 my-1 border-t border-stone-800/50"></div>
                           <div className="flex justify-between"><span>Mix Tail/Intake</span> <span className="text-stone-300">80-81</span></div>
                           <div className="flex justify-between"><span>Mix Mech/Whine</span> <span className="text-stone-300">82-83</span></div>
                           <div className="flex justify-between"><span>Mix Surge/Pops</span> <span className="text-stone-300">84-85</span></div>
                        </div>
                    </div>
                </div>
                <div className={cn("absolute inset-0 bg-gradient-to-r from-transparent via-transparent to-green-500/5 opacity-0 transition-opacity pointer-events-none duration-1000", midiStatus.startsWith("Connected") ? "opacity-100" : "")}></div>
             </div>

             <div className="bg-stone-950 border border-stone-800 rounded-lg p-6 overflow-hidden relative group">
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[500px] bg-indigo-500/5 rounded-full blur-[100px] pointer-events-none group-hover:bg-indigo-500/10 transition-colors duration-1000"></div>
                
                <div className="flex flex-col md:flex-row gap-8 justify-center bg-stone-900 border border-stone-800 p-8 rounded-xl items-center shadow-[inset_0_0_20px_rgba(0,0,0,0.5)] relative z-10">
                    <div className="flex flex-col items-center">
                        <span className="text-stone-500 font-mono text-[10px] uppercase font-bold tracking-widest mb-2">Gear</span>
                        <span ref={gearDashRef} className="text-6xl font-mono font-bold text-amber-500 drop-shadow-[0_0_15px_rgba(245,158,11,0.5)]">N</span>
                    </div>

                    <div className="hidden md:block w-px h-16 bg-stone-800" />
                    
                    <div className="flex flex-col items-center min-w-[160px]">
                        <span className="text-stone-500 font-mono text-[10px] uppercase font-bold tracking-widest mb-2">Speed</span>
                        <div className="flex items-baseline gap-2">
                            <span ref={speedDashRef} className="text-6xl font-mono font-bold text-stone-200 tabular-nums drop-shadow-[0_0_15px_rgba(255,255,255,0.2)]">0</span>
                            <span className="text-stone-500 font-mono text-sm">km/h</span>
                        </div>
                    </div>
                    
                    <div className="hidden md:block w-px h-16 bg-stone-800" />
                    
                    <div className="flex flex-col items-center min-w-[240px]">
                        <span className="text-stone-500 font-mono text-[10px] uppercase font-bold tracking-widest mb-2">Engine Speed</span>
                        <div className="flex items-baseline gap-2">
                            <span ref={rpmDashRef} className="text-7xl md:text-8xl font-mono font-bold text-stone-200 tabular-nums drop-shadow-[0_0_15px_rgba(255,255,255,0.2)]">0</span>
                            <span className="text-stone-500 font-mono text-sm md:text-xl">RPM</span>
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

function MixerSlider({ label, val, setVal, pan, setPan, disabled = false, disablePan = false }: { label: string, val: number, setVal: (v: number) => void, pan?: number, setPan?: (v: number) => void, disabled?: boolean, disablePan?: boolean }) {
    return (
        <div className={cn("flex flex-col items-center gap-3 transition-opacity", disabled && "opacity-30")}>
            <span className="font-mono text-[10px] uppercase font-bold text-stone-500 tracking-widest">{label}</span>
            <div className="h-32 w-8 bg-stone-900 border border-stone-800 rounded-full relative overflow-hidden group flex justify-center py-2">
                <div className="absolute bottom-0 w-full bg-stone-800 z-0 h-full"></div>
                <div 
                   className="absolute bottom-0 w-full bg-indigo-500/50 z-10 transition-all duration-100 border-t border-indigo-400"
                   style={{ height: `${val * 100 / 2}%` }}
                ></div>
                <input 
                   type="range" 
                   min="0" 
                   max="2" 
                   step="0.05" 
                   value={val} 
                   onChange={e => setVal(parseFloat(e.target.value))}
                   disabled={disabled}
                   className="absolute inset-0 opacity-0 z-20 cursor-ns-resize [writing-mode:bt-lr] [-webkit-appearance:slider-vertical] h-full w-full"
                />
            </div>
            
            {(pan !== undefined && setPan !== undefined && !disablePan) ? (
                <div className="w-16 flex flex-col items-center gap-1 mt-1">
                    <input 
                        type="range" 
                        min="-1" 
                        max="1" 
                        step="0.05" 
                        value={pan} 
                        onChange={e => setPan(parseFloat(e.target.value))}
                        disabled={disabled}
                        className="w-full h-1 bg-stone-800 rounded-full appearance-none cursor-ew-resize accent-indigo-500"
                    />
                    <span className="font-mono text-[9px] text-stone-600">
                        {pan < 0 ? `L${Math.abs(Math.round(pan*100))}` : pan > 0 ? `R${Math.round(pan*100)}` : 'C'}
                    </span>
                </div>
            ) : (
                <div className="h-6"></div>
            )}
        </div>
    )
}
