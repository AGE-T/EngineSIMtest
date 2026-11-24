export interface EngineMetadata {
  max_rpm: number;
  max_torque?: number;
  finalDrive?: number;
  gearRatios?: number[];
  mass?: number;
  wheelRadius?: number;
}

export interface EngineCylinder {
  index: number;
  phaseOffset: number; // 0 to 720
  length: number;      // runner length in meters
}

export interface EngineConfig {
  name: string;
  layout: string;
  metadata: EngineMetadata;
  cylinders: EngineCylinder[];
  cylsL: number[];
  cylsR: number[];
  downpipeLength: number;
  tailpipeLength: number;
  downpipeDiameter?: number;
  tailpipeDiameter?: number;
  crossPipe: "none" | "x-pipe" | "collector"; 
}

export const engines: Record<string, EngineConfig> = {
  "inline-4": {
    name: "Inline-4 2.0L",
    layout: "I4",
    metadata: { max_rpm: 7200, max_torque: 250 },
    // 1-3-4-2 Firing Order
    cylinders: [
      { index: 0, phaseOffset: 0, length: 0.4 },
      { index: 1, phaseOffset: 540, length: 0.45 },
      { index: 2, phaseOffset: 180, length: 0.45 },
      { index: 3, phaseOffset: 360, length: 0.4 }
    ],
    cylsL: [0, 1, 2, 3],
    cylsR: [],
    downpipeLength: 0.6,
    tailpipeLength: 1.8,
    crossPipe: "none"
  },
  "h4-boxer": {
    name: "Subaru WRC (Boxer 4)",
    layout: "H4",
    metadata: { max_rpm: 8000, max_torque: 550 },
    // 1-3-2-4 Firing Order. Unequal length headers are the secret to the Boxer rumble!
    // Pulses from bank 1 (1&3) take longer to reach the collector than bank 2 (2&4).
    cylinders: [
      { index: 0, phaseOffset: 0, length: 1.2 },   // Cyl 1 (Long runner)
      { index: 1, phaseOffset: 180, length: 1.2 }, // Cyl 3 (Long runner)
      { index: 2, phaseOffset: 360, length: 0.2 }, // Cyl 2 (Short runner)
      { index: 3, phaseOffset: 540, length: 0.2 }  // Cyl 4 (Short runner)
    ],
    cylsL: [0, 1], // Both long runners into same collector channel if needed
    cylsR: [2, 3],
    downpipeLength: 0.8,
    tailpipeLength: 1.8,
    crossPipe: "collector"
  },
  "h6-porsche": {
    name: "Porsche 911 (Boxer 6)",
    layout: "H6",
    metadata: { max_rpm: 8500, max_torque: 460 },
    // 1-6-2-4-3-5 Firing Order
    // Intervals are 120 degrees
    cylinders: [
      { index: 0, phaseOffset: 0, length: 0.4 },     // 1
      { index: 1, phaseOffset: 120, length: 0.4 },   // 6
      { index: 2, phaseOffset: 240, length: 0.4 },   // 2
      { index: 3, phaseOffset: 360, length: 0.4 },   // 4
      { index: 4, phaseOffset: 480, length: 0.4 },   // 3
      { index: 5, phaseOffset: 600, length: 0.4 }    // 5
    ],
    cylsL: [0, 2, 4],
    cylsR: [1, 3, 5],
    downpipeLength: 0.6,
    tailpipeLength: 1.2,
    crossPipe: "none"
  },
  "v2-harley": {
    name: "American V-Twin",
    layout: "V2",
    metadata: { 
        max_rpm: 5500, 
        max_torque: 160,
        finalDrive: 2.2, // Taller final drive for a cruiser
        gearRatios: [0, 2.8, 1.9, 1.4, 1.1, 0.9, 0.75], // Cruising gears
        mass: 350, // Heavy cruiser
        wheelRadius: 0.33
    },
    // 45 degree V, single crankpin. Fires at 0, 315, then waits 405 degrees. Potato-potato!
    cylinders: [
      { index: 0, phaseOffset: 0, length: 0.35 },    // Rear CYL
      { index: 1, phaseOffset: 315, length: 0.35 }   // Front CYL
    ],
    cylsL: [0, 1],
    cylsR: [],
    downpipeLength: 0.4,
    tailpipeLength: 1.0,
    crossPipe: "none"
  },
  "f1-v10": {
    name: "F1 Screaming V10",
    layout: "V10",
    metadata: { max_rpm: 18000, max_torque: 350 },
    // 72 degree even firing
    cylinders: Array.from({ length: 10 }).map((_, i) => ({
      index: i,
      phaseOffset: (i * 72) % 720,
      length: 0.15 + (i%5)*0.02
    })),
    cylsL: [0, 2, 4, 6, 8],
    cylsR: [1, 3, 5, 7, 9],
    downpipeLength: 0.2,
    tailpipeLength: 0.6,
    crossPipe: "x-pipe"
  },
  "v10-gallardo": {
    name: "Lamborghini Gallardo V10",
    layout: "V10",
    metadata: { max_rpm: 8200, max_torque: 540 },
    // 1-6-5-10-2-7-3-8-4-9 alternating firing interval (54 and 90 degrees)
    cylinders: [
      { index: 0, phaseOffset: 0, length: 0.4 },     // 1
      { index: 1, phaseOffset: 54, length: 0.4 },    // 6
      { index: 2, phaseOffset: 144, length: 0.4 },   // 5
      { index: 3, phaseOffset: 198, length: 0.4 },   // 10
      { index: 4, phaseOffset: 288, length: 0.4 },   // 2
      { index: 5, phaseOffset: 342, length: 0.4 },   // 7
      { index: 6, phaseOffset: 432, length: 0.4 },   // 3
      { index: 7, phaseOffset: 486, length: 0.4 },   // 8
      { index: 8, phaseOffset: 576, length: 0.4 },   // 4
      { index: 9, phaseOffset: 630, length: 0.4 }    // 9
    ],
    cylsL: [0, 2, 4, 6, 8],
    cylsR: [1, 3, 5, 7, 9],
    downpipeLength: 0.5,
    tailpipeLength: 1.4,
    crossPipe: "x-pipe"
  },
  "v8-crossplane": {
    name: "V8 Crossplane 6.2L",
    layout: "V8",
    metadata: { max_rpm: 6500, max_torque: 630 },
    // Typical burbling V8 with irregular bank firing (e.g. L,R,L,L,R,L,R,R)
    // 1-8-7-2-6-5-4-3
    cylinders: [
      { index: 0, phaseOffset: 0, length: 0.4 },    // 1 (L)
      { index: 1, phaseOffset: 270, length: 0.4 },  // 2 (R)
      { index: 2, phaseOffset: 630, length: 0.45 }, // 3 (L)
      { index: 3, phaseOffset: 540, length: 0.45 }, // 4 (R)
      { index: 4, phaseOffset: 450, length: 0.5 },  // 5 (L)
      { index: 5, phaseOffset: 360, length: 0.5 },  // 6 (R)
      { index: 6, phaseOffset: 180, length: 0.55 }, // 7 (L)
      { index: 7, phaseOffset: 90, length: 0.55 }   // 8 (R)
    ],
    cylsL: [0, 2, 4, 6],
    cylsR: [1, 3, 5, 7],
    downpipeLength: 0.4,
    tailpipeLength: 1.5,
    crossPipe: "x-pipe"
  },
  "v8-maserati-gt": {
    name: "Maserati GranTurismo S 4.7L V8",
    layout: "V8",
    metadata: { 
      max_rpm: 7500, 
      max_torque: 520,
      finalDrive: 3.73,
      gearRatios: [0, 3.15, 2.18, 1.57, 1.19, 0.94, 0.76],
      mass: 1880,
      wheelRadius: 0.35
    },
    // F136 Y crossplane V8. Firing order 1-8-4-2-7-3-6-5
    cylinders: [
      { index: 0, phaseOffset: 0, length: 0.45 },   // 1
      { index: 7, phaseOffset: 90, length: 0.45 },  // 8
      { index: 3, phaseOffset: 180, length: 0.45 }, // 4
      { index: 1, phaseOffset: 270, length: 0.45 }, // 2
      { index: 6, phaseOffset: 360, length: 0.45 }, // 7
      { index: 2, phaseOffset: 450, length: 0.45 }, // 3
      { index: 5, phaseOffset: 540, length: 0.45 }, // 6
      { index: 4, phaseOffset: 630, length: 0.45 }  // 5
    ],
    cylsL: [0, 1, 2, 3], 
    cylsR: [4, 5, 6, 7],
    downpipeLength: 0.6,
    tailpipeLength: 2.2, // Long exhaust for resonance
    crossPipe: "x-pipe"  // Maserati is famous for the X-pipe high pitch wail
  },
  "v8-flatplane": {
    name: "V8 Flatplane 4.5L",
    layout: "V8",
    metadata: { max_rpm: 9000, max_torque: 540 },
    // Indepedent alternating banks like two I4s spliced
    cylinders: [
      { index: 0, phaseOffset: 0, length: 0.4 },    // 1 (L)
      { index: 1, phaseOffset: 450, length: 0.4 },  // 2 (R)
      { index: 2, phaseOffset: 180, length: 0.45 }, // 3 (L)
      { index: 3, phaseOffset: 630, length: 0.45 }, // 4 (R)
      { index: 4, phaseOffset: 360, length: 0.5 },  // 5 (L)
      { index: 5, phaseOffset: 90, length: 0.5 },   // 6 (R)
      { index: 6, phaseOffset: 540, length: 0.55 }, // 7 (L)
      { index: 7, phaseOffset: 270, length: 0.55 }  // 8 (R)
    ],
    cylsL: [0, 2, 4, 6],
    cylsR: [1, 3, 5, 7],
    downpipeLength: 0.4,
    tailpipeLength: 1.2,
    crossPipe: "none"
  },
  "v10-screamer": {
    name: "V10 Screamer 5.2L",
    layout: "V10",
    metadata: { max_rpm: 8500, max_torque: 540 },
    cylinders: [
      { index: 0, phaseOffset: 0, length: 0.35 },    // 1 (L)
      { index: 1, phaseOffset: 540, length: 0.35 },  // 2 (R)
      { index: 2, phaseOffset: 144, length: 0.4 },   // 3 (L)
      { index: 3, phaseOffset: 684, length: 0.4 },   // 4 (R)
      { index: 4, phaseOffset: 288, length: 0.45 },  // 5 (L)
      { index: 5, phaseOffset: 108, length: 0.45 },  // 6 (R)
      { index: 6, phaseOffset: 432, length: 0.5 },   // 7 (L)
      { index: 7, phaseOffset: 252, length: 0.5 },   // 8 (R)
      { index: 8, phaseOffset: 576, length: 0.55 },  // 9 (L)
      { index: 9, phaseOffset: 396, length: 0.55 }   // 10 (R)
    ],
    cylsL: [0, 2, 4, 6, 8],
    cylsR: [1, 3, 5, 7, 9],
    downpipeLength: 0.3,
    tailpipeLength: 1.0,
    crossPipe: "x-pipe"
  },
  "v12-exotic": {
    name: "V12 Exotic 6.5L",
    layout: "V12",
    metadata: { max_rpm: 8200, max_torque: 690 },
    cylinders: [
      { index: 0, phaseOffset: 0, length: 0.3 },     // 1 (L)
      { index: 1, phaseOffset: 420, length: 0.3 },   // 2 (R)  (0 + 420)
      { index: 2, phaseOffset: 120, length: 0.35 },  // 3 (L)
      { index: 3, phaseOffset: 540, length: 0.35 },  // 4 (R)
      { index: 4, phaseOffset: 240, length: 0.4 },   // 5 (L)
      { index: 5, phaseOffset: 660, length: 0.4 },   // 6 (R)
      { index: 6, phaseOffset: 360, length: 0.45 },  // 7 (L)
      { index: 7, phaseOffset: 60, length: 0.45 },   // 8 (R)
      { index: 8, phaseOffset: 480, length: 0.5 },   // 9 (L)
      { index: 9, phaseOffset: 180, length: 0.5 },   // 10 (R)
      { index: 10, phaseOffset: 600, length: 0.55 }, // 11 (L)
      { index: 11, phaseOffset: 300, length: 0.55 }  // 12 (R)
    ],
    cylsL: [0, 2, 4, 6, 8, 10],
    cylsR: [1, 3, 5, 7, 9, 11],
    downpipeLength: 0.5,
    tailpipeLength: 1.3,
    crossPipe: "x-pipe"
  },
  "rotary-13b": {
    name: "2-Rotor Wankel (13B) 1.3L",
    layout: "Rotary",
    metadata: { max_rpm: 9500, max_torque: 220 },
    cylinders: [
      { index: 0, phaseOffset: 0, length: 0.2 },
      { index: 1, phaseOffset: 360, length: 0.2 },
      { index: 2, phaseOffset: 180, length: 0.25 },
      { index: 3, phaseOffset: 540, length: 0.25 }
    ],
    cylsL: [0, 1, 2, 3],
    cylsR: [],
    downpipeLength: 0.2, // Very short exhaust to capture that brap
    tailpipeLength: 0.8,
    crossPipe: "none"
  },
  "rotary-26b": {
    name: "4-Rotor Wankel (26B) 2.6L",
    layout: "Rotary",
    metadata: { max_rpm: 10500, max_torque: 400 },
    cylinders: [
      { index: 0, phaseOffset: 0, length: 0.12 },
      { index: 1, phaseOffset: 360, length: 0.12 },
      { index: 2, phaseOffset: 90, length: 0.14 },
      { index: 3, phaseOffset: 450, length: 0.14 },
      { index: 4, phaseOffset: 180, length: 0.16 },
      { index: 5, phaseOffset: 540, length: 0.16 },
      { index: 6, phaseOffset: 270, length: 0.18 },
      { index: 7, phaseOffset: 630, length: 0.18 }
    ],
    cylsL: [0, 1, 2, 3, 4, 5, 6, 7],
    cylsR: [],
    downpipeLength: 0.15,
    tailpipeLength: 0.6,
    crossPipe: "none"
  },
  "jet-fighter": {
    name: "Fighter Jet Turbine",
    layout: "Turbine",
    metadata: { max_rpm: 25000, max_torque: 8000, finalDrive: 5.0, gearRatios: [0, 1.5, 1.0, 0.8] },
    cylinders: Array.from({ length: 24 }).map((_, i) => ({
      index: i,
      phaseOffset: (i * 15) % 360,
      length: 0.1
    })),
    cylsL: Array.from({ length: 12 }).map((_, i) => i),
    cylsR: Array.from({ length: 12 }).map((_, i) => i + 12),
    downpipeLength: 0.1,
    tailpipeLength: 0.5,
    crossPipe: "none"
  },
  "turbofan-airliner": {
    name: "Commercial Turbofan",
    layout: "Turbofan",
    metadata: { max_rpm: 12000, max_torque: 25000, finalDrive: 2.0, gearRatios: [0, 2.0, 1.0] },
    cylinders: Array.from({ length: 32 }).map((_, i) => ({
      index: i,
      phaseOffset: (i * 11.25) % 360,
      length: 0.3
    })),
    cylsL: Array.from({ length: 16 }).map((_, i) => i),
    cylsR: Array.from({ length: 16 }).map((_, i) => i + 16),
    downpipeLength: 0.2,
    tailpipeLength: 2.0,
    crossPipe: "none"
  }
};
