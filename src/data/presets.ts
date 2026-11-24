export interface EnginePreset {
    id: string;
    name: string;
    description: string;
    engineKey: string;
    turboType: number; // 0=NA, 1=Small, 2=Medium, 3=Big
    enablePops: boolean;
    mass: number;
    volumes: {
        tailpipe: number;
        intake: number;
        mech: number;
        whine: number;
        flutter: number;
        pops: number;
    }
}

export const enginePresets: EnginePreset[] = [
    {
        id: "lambo-v10",
        name: "Lambo V10",
        description: "Naturally Aspirated, Odd-firing V10. High RPM scream and lots of pops/burbles on liftoff.",
        engineKey: "v10-gallardo",
        turboType: 0,
        enablePops: true,
        mass: 1400,
        volumes: {
            tailpipe: 0.9,
            intake: 0.6,
            mech: 0.2,
            whine: 0.0,
            flutter: 0.0,
            pops: 0.7
        }
    },
    {
        id: "wrc-boxer",
        name: "WRC Boxer",
        description: "Iconic unequal length header rumble. Big turbo, lots of flutter and aggressive anti-lag pops.",
        engineKey: "h4-boxer",
        turboType: 3,
        enablePops: true,
        mass: 1250,
        volumes: {
            tailpipe: 0.8,
            intake: 0.5,
            mech: 0.3,
            whine: 0.6,
            flutter: 0.9,
            pops: 1.0
        }
    },
    {
        id: "f1-v10",
        name: "F1 V10 (2004)",
        description: "18,000 RPM NA Screamer. Extremely loud tailpipe, pure mechanic whine, no pops.",
        engineKey: "f1-v10",
        turboType: 0,
        enablePops: false,
        mass: 600,
        volumes: {
            tailpipe: 1.0,
            intake: 0.8,
            mech: 0.5,
            whine: 0.0,
            flutter: 0.0,
            pops: 0.0
        }
    },
    {
        id: "maserati-gt",
        name: "Maserati GranTurismo S",
        description: "4.7L Crossplane V8 with an X-pipe. Incredibly resonant, high-pitched scream with loud burbles.",
        engineKey: "v8-maserati-gt",
        turboType: 0,
        enablePops: true,
        mass: 1880,
        volumes: {
            tailpipe: 1.0,
            intake: 0.6,
            mech: 0.3,
            whine: 0.0,
            flutter: 0.0,
            pops: 0.8
        }
    },
    {
        id: "porsche-h6",
        name: "GT3 H6",
        description: "High-revving Flat-6 NA. Strong intake roar and mechanical valvetrain presence.",
        engineKey: "h6-porsche",
        turboType: 0,
        enablePops: true,
        mass: 1430,
        volumes: {
            tailpipe: 0.7,
            intake: 0.9,
            mech: 0.5,
            whine: 0.0,
            flutter: 0.0,
            pops: 0.3
        }
    },
    {
        id: "drift-jdm",
        name: "JDM Drift I4",
        description: "Turbocharged Inline 4. Big turbo whine, insane flutter on off-throttle, some pops.",
        engineKey: "inline-4",
        turboType: 2,
        enablePops: true,
        mass: 1300,
        volumes: {
            tailpipe: 0.6,
            intake: 0.5,
            mech: 0.3,
            whine: 0.8,
            flutter: 1.0,
            pops: 0.6
        }
    },
    {
        id: "harley-v2",
        name: "Chopper V2",
        description: "Low-end torque monster. 45-degree V-twin 'potato-potato' idle.",
        engineKey: "v2-harley",
        turboType: 0,
        enablePops: false,
        mass: 320,
        volumes: {
            tailpipe: 0.8,
            intake: 0.3,
            mech: 0.6,
            whine: 0.0,
            flutter: 0.0,
            pops: 0.1
        }
    },
    {
        id: "jet-fighter",
        name: "Fighter Jet",
        description: "Experimental Turbine Engine. Massive whine, continuous combustion roar.",
        engineKey: "jet-fighter",
        turboType: 3,
        enablePops: false,
        mass: 15000,
        volumes: {
            tailpipe: 0.8,
            intake: 0.5,
            mech: 0.0,
            whine: 1.0,
            flutter: 0.0,
            pops: 0.0
        }
    },
    {
        id: "turbofan",
        name: "Commercial Turbofan",
        description: "Heavy Airliner Engine. Deep rumble and massive compressor whine.",
        engineKey: "turbofan-airliner",
        turboType: 3,
        enablePops: false,
        mass: 50000,
        volumes: {
            tailpipe: 1.0,
            intake: 1.0,
            mech: 0.0,
            whine: 0.8,
            flutter: 0.0,
            pops: 0.0
        }
    }
];
