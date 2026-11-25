export const sections = [
  {
    id: "system-architecture",
    title: "1. Complete System Architecture",
    content: `
# Complete System Architecture

The engine audio simulation system is structured around physical causality. Rather than generating synthetic tones, the system simulates the mechanical and fluid dynamic processes that produce engine sound. 

## High-Level Subsystems

1.  **Vehicle Input Interface**: Receives real-time telemetry (Throttle, Load, RPM, Gear).
2.  **Mechanical Engine Model**: Simulates crankshaft rotation, piston position, valve timing, and firing order.
3.  **Combustion & Thermodynamics Model**: Calculates cylinder pressure based on air-fuel mixture, ignition timing, and expansion.
4.  **Blowdown (Exhaust) & Induction (Intake) Generators**: Captures the rapid pressure equalization when valves open, acting as the primary acoustic excitation sources.
5.  **Acoustic Waveguide Network**: Simulates bidirectional pressure wave propagation through complex pipe geometries (runners, collectors, X/H-pipes).
6.  **Resonance System (Modal Synthesis)**: Simulates the structural vibrations of the engine block, chassis, and exhaust casing.
7.  **Spatial & Environmental Acoustics**: Applies chassis impulse responses (IR), cabin damping, and environmental convolution (Doppler, reflections).
8.  **Master Mixer & Protection**: Enforces numerical stability, soft-clipping, and multi-channel routing.
    `,
  },
  {
    id: "dsp-architecture",
    title: "2. DSP Architecture",
    content: `
# DSP Architecture

The DSP architecture separates processes by their physical bandwidth requirements. Trying to run mechanical simulations at audio rates is inefficient, while running waveguides at control rates is unstable.

## Multi-Rate Processing

### 1. Control Rate (e.g., 1000 - 2000 Hz)
*   **Mechanical State Machine:** Crankshaft angle, RPM smoothing, throttle interpolation.
*   **ECU Logic:** Rev limiter triggers, fuel cut mapping, ignition timing.
*   **Thermodynamic Model Update:** Heat transfer, mean cylinder pressure estimates.

### 2. Audio Sub-Rate (e.g., 22050 Hz) or Full Audio Rate (44100 / 48000 Hz)
*   **Combustion Blowdown:** High-frequency pressure pulse generation triggered by exact sub-sample valve opening times.
*   **Waveguide Network:** Delay lines, scattering junctions, bidirectional pressure wave propagation.
*   *Note: Using a 2x oversampling rate for waveguides (88.2 kHz or 96 kHz) is recommended to prevent high-frequency cramping in the nonlinear scattering stages.*

### 3. Block Level (Buffer Rate)
*   **Convolution Reverbs:** Environmental acoustics, large modal IRs.
*   **LOD Switching:** Transitioning vehicles from full physical models to simplified approximations based on distance.

## Signal Flow Constraint
All audio-rate processes MUST operate without locks (lock-free programming paradigms) using wait-free ring buffers for param updates from the Control Rate thread.
    `,
  },
  {
    id: "signal-flow",
    title: "3. Signal Flow Diagrams",
    content: `
# Signal Flow Diagrams

The signal flow moves strictly in the direction of physical causality, but wave networks involve feedback (bidirectional waves).

\`\`\`
[Input Telemetry] -> [ECU State] -> [Mechanical Crank State]
                                      |
                                      v
                             (Valve Math & Phasing)
                                      |
                                      v
                           [Combustion & Cylinder State]
                              |                       |
                       (Intake Valve)           (Exhaust Valve)
                              |                       |
                              v                       v
                   [Intake Runner Waveguide]  [Exhaust Runner Waveguide]
                              |                       |
                              v                       v
                    [Plenum / Airbox]         [Collector / Manifold]
                              |                       |
                              v                       v
                    [Intake Resonance]        [X-Pipe / H-Pipe Junctions]
                                                      |
                                                      v
                                                 [Mufflers]
                                                      |
                                                      v
                                             [Tailpipe Radiator]
                                                      |
                                                      v
[Modal Block Resonance] ---------------------------> [Mixer] <------------------ [Convolution Reverb]
                                                      |
                                                      v
                                            [DC Blocker & Limiter]
                                                      |
                                                      v
                                               [Audio Output]
\`\`\`
    `,
  },
  {
    id: "data-structures",
    title: "4. Data Structures",
    content: `
# Data Structures

Performance relies on cache-friendly data structures. Struct-of-Arrays (SoA) is preferred over Array-of-Structs (AoS) for waveguide processing to enable SIMD vectorization.

## Core Structures

### \`EngineConfig\` (Immutable after load)
*   \`numCylinders: int\`
*   \`firingOrder: int[]\`
*   \`bore: float\`, \`stroke: float\`
*   \`waveguideTopology: Graph<Node, Edge>\`

### \`MechanicalState\` (Lock-free atomic read/write)
*   \`rpm: float\`
*   \`crankAngle: float\`
*   \`throttlePosition: float\`
*   \`loadDemand: float\`

### \`CylinderState\` 
*   \`pressure: float\` (dynamic)
*   \`temperature: float\`
*   \`fuelMass: float\` (unburnt fuel for pops/bangs)
*   \`ignitionPhase: float\` (0.0 to 1.0)
*   \`intakeValveLift: float\`, \`exhaustValveLift: float\`

### \`WaveguideSegment\` (SIMD aligned)
*   \`length_samples: float\`
*   \`forwardPath: RingBuffer<float>\`
*   \`backwardPath: RingBuffer<float>\`
*   \`attenuationCoefficient: float\`
    `,
  },
  {
    id: "class-hierarchy",
    title: "5. Class Hierarchy",
    content: `
# Class Hierarchy

The architecture will rely on composition rather than deep inheritance. DSP components should be isolated from GUI and Engine definitions.

## Hierarchy outline

\`\`\`text
IProcessor (Interface)
 └── EngineAudioCore
      ├── InputHandler (Telemetry -> State)
      ├── MechanicalSimulator (Crank, Timing)
      │    └── std::vector<Cylinder>
      ├── AcousticNetwork (Graph of Nodes)
      │    ├── WaveguideLine (Delay/Attenuation)
      │    │    └── FractionalDelayBuffer
      │    ├── ScatteringJunction (N-port intersections)
      │    └── Terminus (Open end reflection / Radiation)
      ├── ResonatorBank
      │    └── ModalFilter (Biquad banks)
      └── ConvolutionEngine (GPU/CPU hybrid)
\`\`\`

## Key Interfaces
*   \`IAudioSource\`: Anything that injects pressure into a waveguide (e.g., Cylinder Blowdown interface).
*   \`IJunction\`: Implementations of Kelly-Lochbaum or generic impedance matching intersections.
    `,
  },
  {
    id: "engine-definition",
    title: "6. Engine Definition Format",
    content: `
# Engine Definition Format

Engine definitions must be completely detached from source code. We use a declarative YAML/JSON format allowing sound designers to define geometry.

\`\`\`yaml
engine:
  metadata:
    name: "Classic V8 Crossplane"
    layout: "V8"
    displacement_L: 6.2
    max_rpm: 6500
  mechanical:
    firing_order: [1, 8, 4, 3, 6, 5, 7, 2]
    crank_angles: [0, 90, 180, 270, 360, 450, 540, 630]
    idle_rpm: 800
    rev_limiter_mode: "fuel_cut" # or "ignition_cut"
  cylinders:
    bore_mm: 103.25
    stroke_mm: 92.0
  exhaust_system:
    runners:
      lengths_mm: [450, 480, 420, 500, 450, 480, 420, 500]
      diameter_mm: 45
    collectors:
      bank_1: [1, 3, 5, 7] # Cylinders mapping
      bank_2: [2, 4, 6, 8]
    cross_pipe:
      type: "x-pipe" # "x-pipe", "h-pipe", "none"
      distance_from_collector_mm: 800
    muffler:
      type: "chambered"
      volume_L: 12.0
      baffle_count: 3
    tailpipe:
      length_mm: 600
      diameter_mm: 65
\`\`\`
    `,
  },
  {
    id: "waveguide",
    title: "7. Waveguide Architecture",
    content: `
# Waveguide Architecture

The core of the exhaust and intake sound is a 1D Digital Waveguide Network (DWG).

## Bidirectional Propagation
Sound in a pipe is modelled as two traveling waves:
*   \`p+(x, t)\` (forward traveling pressure)
*   \`p-(x, t)\` (backward traveling pressure)

Total pressure at any point is \`P = p+ + p-\`.
Volumetric velocity is \`U = (p+ - p-) / Z\` (where Z is specific acoustic impedance).

## Components
1.  **Delay Lines**: Pipe lengths are converted to sample delays. Since physical lengths rarely match exact sample boundaries, we use **Fractional Delay Filters** (Thiran Allpass or Lagrange interpolation) to ensure tuning doesn't snap to a grid.
2.  **Thermo-viscous Attenuation**: High frequencies decay faster in pipes. A 1-pole lowpass filter is applied at the end of each delay line to model wall friction and heat exchange.
3.  **Non-Linear Wave Steepening**: For high-amplitude peaks (blowdown), waves travel faster at their peaks. This can be modelled using a variable-delay lookup or a simpler static waveshaper to introduce raspiness automatically.
    `,
  },
  {
    id: "scattering-junction",
    title: "8. Scattering Junction Architecture",
    content: `
# Scattering Junction Architecture

Whenever pipes merge, split, or change diameter, pressure waves reflect and transmit. This is handled by scattering junctions.

## The N-Port Junction
For a junction with N connected waveguide ports, we define:
*   \`Z_i\`: Characteristic impedance of port \`i\` (inversely proportional to cross-sectional area).
*   \`Y_i = 1 / Z_i\`: Admittance.

**Junction Pressure (P_J):**
\`P_J = ( \sum (2 * p+_i * Y_i) ) / ( \sum Y_i )\`

**Reflected & Transmitted Waves (p-_i):**
\`p-_i = P_J - p+_i\`

## Specific Topologies
1.  **Collector (4-to-1):** Four runner ports and one downpipe port. 
2.  **X-Pipe:** A 4-port junction (two inlets, two outlets) allowing pressure waves from bank 1 to bleed into bank 2.
3.  **H-Pipe:** A crossover pipe modelled as a short waveguide connecting two standard pipes at T-junctions (3-port).
4.  **Open End (Tailpipe Radiation):** At the tailpipe to open air, the impedance change is massive. A high-pass filter represents radiation efficiency, while most low-frequency energy reflects back inverted (open pipe resonance).
    `,
  },
  {
    id: "numerical-stability",
    title: "9. Numerical Stability Strategy",
    content: `
# Numerical Stability Strategy

Waveguides are highly susceptible to feedback explosions. An unstable engine configuration will output infinite noise immediately.

## 1. Denormal Protection
Delay lines and filters decay over time. When values get too small (e.g., 1e-38), CPUs switch to extremely slow floating-point exceptions.
*   **Action:** Enable FTZ (Flush-to-Zero) and DAZ (Denormals-Are-Zero) on the DSP thread.
*   **Action:** Inject minimal DC offset noise (e.g., 1e-15) if FTZ is unavailable.

## 2. Passivity Enforcement
The network MUST be passive. The energy leaving a junction cannot exceed the energy entering it.
*   **Action:** Assert \`\sum Energy_out <= \sum Energy_in\`. Add a strict 0.999 global decay coefficient inside the primary loops.

## 3. Waveguide Clamping
Extreme blowdown values can cause math errors.
*   **Action:** Use a soft-clipper (e.g. \`tanh()\` approximation) on the outputs of the cylinder blowdown BEFORE injecting into the waveguide.

## 4. Watchdog Limiter & DC Blocking
Every continuous simulation node needs DC removal.
*   **Action:** 10Hz high-pass filter on tailpipe output.
*   **Action:** Lookahead brickwall limiter on the master output. If values exceed 0dBFS internally, hard limit to prevent blowing user speakers.
*   **Action:** "Panic" reset if \`NaN\` or \`Inf\` is detected in any buffer.
    `,
  },
  {
    id: "cpu-gpu",
    title: "10. CPU/GPU Architecture",
    content: `
# CPU/GPU Architecture

Physical modelling requires extreme single-thread performance for the feedback loops. GPUs are bad at rapid feedback but great at parallel convolution.

## CPU Domain (Latency Critical)
*   Mechanical Engine State (Control thread)
*   Cylinder Blowdown & Thermodynamics
*   1D Waveguide Networks (Exhaust, Intake)
*   Scattering Junction Math

*Reasoning: The delay length of an exhaust runner might be 20 samples. The time it takes a GPU to receive 20 samples and send them back destroys the real-time requirements.*

## GPU / Offloaded CPU Thread Domain (Throughput Critical)
*   **Environmental Convolution Reverb:** Large impulse responses for cabins, tracks, and tunnels.
*   **Dense Modal Synthesis:** Calculating hundreds of decaying sine waves for engine block / chassis resonance.
*   **Acoustic Raytracing (Optional Future):** Doppler shifts and reflections from moving vehicles towards the camera in a 3D environment.
    `,
  },
  {
    id: "validation",
    title: "11. Validation Framework",
    content: `
# Validation Framework

Tuning purely by ear leads to overfitting. The engine must survive objective tests.

## 1. Spectrogram Comparison (Primary Tool)
*   Run the simulation at steady RPM states (e.g., 2000, 4000, 6000).
*   Perform FFT on the output and compare it against dyno recordings of the real engine.
*   The fundamental frequency and harmonic spacing MUST match exactly.

## 2. MFCC (Mel-Frequency Cepstral Coefficients)
*   Use MFCC feature extraction to determine "timbre distance."
*   This removes pitch bias and checks if an I4 actually sounds like an I4 rather than a V8.

## 3. Swept Sine Automated Parameter Testing
*   Input a mathematical swept sine wave through the defined exhaust system topology instead of combustion pulses.
*   Measure the impulse response and frequency response of the exhaust geometry to confirm standing waves match physical acoustic theory for given pipe lengths.

## 4. Blind A/B Check
*   Provide 5 simulated clips and 5 real clips to users to test the "uncanny valley" effect.
    `,
  },
  {
    id: "profiling",
    title: "12. Profiling Strategy",
    content: `
# Profiling Strategy

A real-time DSP system must guarantee worst-case execution time (WCET).

## 1. Cycle Counting per Subsystem
Wrap DSP processing blocks with lightweight RDTSC (Read Time-Stamp Counter) macros.
Log execution times for:
*   Combustion update
*   Waveguide step
*   Convolution step

## 2. Cache Miss Optimization
Use tools (like VTune or Valgrind/Callgrind) to map L1/L2 cache misses.
Waveguide ring buffers must be kept small and contiguous. Graph nodes should be stored in linear arrays based on execution order.

## 3. LOD Benchmarking
Establish hard limits.
*   **LOD 0 (Hero):** Max 2.0 ms CPU time per audio block (at 10ms block size).
*   **LOD 1 (Traffic):** Max 0.5 ms CPU time.
*   **LOD 2 (Distant):** Max 0.05 ms CPU time.
    `,
  },
  {
    id: "development-roadmap",
    title: "13. Development Roadmap",
    content: `
# Development Roadmap

## Phase 1: Core Physics (Historical MVP)
*   Implement EngineState, basic Thermodynamics, and Cylinder Blowdown.
*   Implement 1D fractional Waveguide and simple Terminus radiation.
*   Target: Generate a stable, unoptimized sound of a single cylinder popping through a straight pipe.

## Phase 2: Networks & Geometry
*   Implement Scattering Junctions (Collector, X-Pipe).
*   Create YAML Engine Definition parser.
*   Target: Build complete I4, V6, and V8 geometries. Tune firing orders for bank interaction.

## Phase 3: Transients & Textures
*   Implement ECU states (Rev Limiter, Fuel Cut, Overrun burbles).
*   Add unburnt fuel logic in exhaust for backfires.
*   Implement Modal resonance for block structure.

## Phase 4: Productionization
*   LOD systems, SIMD optimization, caching optimizations.
*   Environmental convolution mixing.
*   Automated validation framework integration.

## Phases 5–8: Procedural Multi-Channel Synthesizer (\`src/components/LiveDemo.tsx\`)
*   Implemented 4-channel \`AudioWorklet\` synthesis with dedicated Channels 2 & 3 Pops/Bangs street impulse-response convolver, turbocharger compressor whine & blow-off surge/flutter, intake filter pitch modulation, and spatial audio panning.

## Phase 9: 1D Thermodynamic & Digital-Waveguide V8 (\`src/audio/phase9Engine.ts\`)
*   Full 8-cylinder 4.58L crossplane V8 (\`1-8-4-3-6-5-7-2\`, bank cadence \`L-R-R-L-R-L-L-R\`) running at audio sample rate with zero per-sample heap allocations.
*   Temperature-dependent specific heat $C_v(T) = 670.5 + 0.165\\,T$ with exact analytical internal-energy inversion $T(u)$, separate total cylinder mass vs. combustible fresh-charge mass tracking, Wiebe combustion ($a=5, m=2$), and Woschni convective cylinder-wall heat loss.
*   Dual 4-into-1 Kelly-Lochbaum exhaust collectors, asymmetric L/R midpipes, H-pipe crossover waveguide, 3-path sport mufflers (perforated straight core + fiberglass-packed outer shell + quarter-wave Helmholtz side-branch), Levine-Schwinger open-pipe radiation, Lighthill high-velocity exit jet rush, and 0.52m intake snorkel waveguide + plenum/runner resonators.
*   6-speed hydraulic torque-converter automatic transmission (Neutral, Automatic Drive \`D1–D6\`, Manual \`M1–M6\`) with ZF-style upshift torque cut and downshift throttle blip, plus a discrete 132-tooth ring-gear / 11-tooth pinion / 16-bar commutator 12V PMGR starter motor.

## Phase 10: Physics & Acoustic Validation (\`tests/phase10Validation.ts\`)
*   Browser-independent automated test suite (\`npm test\`) verifying bit-exact seed determinism, closed-cylinder 1st-Law energy conservation, valve mass/enthalpy conservation, mass-flow admittance ($Y_i = A_i / c_i$) junction scattering across temperature gradients, $C^1$-clamped \`[3/4]\` rational \`fastTanh\` accuracy ($\\max |R(x) - \\tanh(x)| = 0.0007217 < 0.00073$), and 128-sample AudioWorklet real-time block headroom.
    `,
  },
  {
    id: "risk-assessment",
    title: "14. Risk Assessment",
    content: `
# Risk Assessment

| Risk | Severity | Probability | Mitigation Strategy |
| :--- | :--- | :--- | :--- |
| **Waveguide Feedback Explosion** | Critical | High | Implement strict passivity constraints, DC blocking, and global soft-limiting. |
| **Denormal CPU Spikes** | Critical | High | FTZ/DAZ compiler flags, low-level noise injection. |
| **Cannot hit Real-Time constraints** | High | Medium | Profile early. Switch from fractional delays to integer delays at lower LODs. Limit maximum junction complexity. |
| **Combustion sounds like white noise**| High | Medium | Refine blowdown curve. Use phenomenological pulse shaping if strict thermodynamics fails to produce distinct peaks. |
| **Variable Speed of Sound complications** | Medium | Low | For MVP, assume constant exhaust gas temperature (EGT). Phase in dynamic EGT scaling later. |
    `,
  },
  {
    id: "mvp-scope",
    title: "15. Historical Phase 1 MVP Scope vs. Current Implementation",
    content: `
# Historical Phase 1 MVP Scope vs. Current Implementation

> **Historical Note:** The original Phase 1 MVP scope below defined the initial proof-of-concept boundary. **Phase 9 and Phase 10 supersede these historical exclusions** by implementing full 1D gas thermodynamics, dynamic temperature-dependent speed of sound $c(T)$, H-pipe crossover coupling, intake snorkel waveguides, and a 6-speed torque-converter automatic drivetrain in \`src/audio/phase9Engine.ts\`.

### Included in Original Phase 1 MVP:
*   **Single Engine Layout:** Naturally Aspirated V8 Crossplane.
*   **Mechanical Model:** Fixed throttle-to-RPM mapper (no actual load/inertia physics yet).
*   **Excitation:** Simple blowdown phenomenological pulse (pre-computed shape triggered at specific crank angles).
*   **Waveguide:** 8 straight primary runners converging into 2 collectors, straight out to tailpipes. No X/H-pipes.
*   **DSP:** CPU only. Hardcoded definitions (no YAML parser).
*   **Protection:** DC blocker and Hard Limiter applied.

### Excluded from Original Phase 1 MVP (Now Implemented in Phase 8 / Phase 9):
*   Turbochargers (implemented in Phase 8 \`LiveDemo.tsx\`), Intake paths, and Airboxes (implemented in Phase 9 \`intakeSnorkel\` + Helmholtz/runner resonators).
*   Complex thermodynamic gas equations (implemented in Phase 9 via exact $C_v(T)$ integration, compressible orifice flow LUTs, Wiebe heat release, and Woschni heat transfer).
*   Temperature-dependent propagation speed (implemented in Phase 9 via per-sample $c(T) = \\sqrt{\\gamma(T) R T}$ LUT and 4-point Cubic Hermite fractional delay).
*   Chassis and street convolution (implemented in Phase 8 4-channel convolver routing).

### Status of \`/vst-boilerplate/\` (C++ / JUCE 7 Scaffold):
*   The \`/vst-boilerplate/\` directory contains an early C++17 / JUCE 7 VST3 plugin skeleton (\`CMakeLists.txt\`, \`PluginProcessor.h/.cpp\`, \`Waveguide.h\`, \`Cylinder.h\`) with \`TODO\` placeholder stubs. It is an incomplete scaffold and is intentionally kept separate from the validated Phase 9 TypeScript engine.
    `,
  },
  {
    id: "phase10-validation",
    title: "16. Phase 10 & 10.1 Physics & Acoustic Validation Reference",
    content: `
# Phase 10 & 10.1 Physics & Acoustic Validation Reference

Phase 10 and Phase 10.1 establish reproducible mathematical, thermodynamic, acoustic, and real-time CPU validation for \`PhysicalEngine\` (\`src/audio/phase9Engine.ts\`) via \`npm test\` (\`tests/phase10Validation.ts\`).

## 1. Multi-Port Junction Scattering: Mass-Flow Admittance vs. Physical Acoustic Power (Phase 10.1 WP-A)
In \`phase9Engine.ts\`, each \`WaveguideTube\` tracks both **mass-flow** and **volumetric** characteristic impedances/admittances at section gas state $(T_i, \\rho_i = P_{\\text{atm}}/(R_{\\text{gas}} T_i), c_i = \\sqrt{\\gamma(T_i) R_{\\text{gas}} T_i})$:
*   **Mass-flow impedance & admittance:**
    $$Z_{m,i} = \\frac{c_i}{A_i} \\quad [\\text{Pa}/(\\text{kg/s})], \\qquad Y_{m,i} = \\frac{A_i}{c_i} \\quad [(\\text{kg/s})/\\text{Pa}], \\qquad \\dot{m}_i = Y_{m,i}(p_i^+ - p_i^-) \\quad [\\text{kg/s}]$$
*   **Physical volumetric acoustic impedance & admittance:**
    $$Z_{\\text{vol},i} = \\frac{\\rho_i c_i}{A_i} \\quad [\\text{Pa}/(\\text{m}^3/\\text{s})], \\qquad Y_{\\text{vol},i} = \\frac{A_i}{\\rho_i c_i} = \\frac{Y_{m,i}}{\\rho_i} \\quad [(\\text{m}^3/\\text{s})/\\text{Pa}], \\qquad U_{\\text{vol},i} = Y_{\\text{vol},i}(p_i^+ - p_i^-) \\quad [\\text{m}^3/\\text{s}]$$

Enforcing pressure continuity ($p_i^+ + p_i^- = P_J$) and mass-flow continuity ($\\sum_{i=1}^N \\dot{m}_i = 0$) yields:
$$P_J = \\frac{2 \\sum_{i=1}^N Y_{m,i}\\, p_i^+}{\\sum_{i=1}^N Y_{m,i}}, \\qquad p_i^- = P_J - p_i^+$$
This satisfies the exact algebraic mass-admittance quadratic invariant $\\sum_{i=1}^N Y_{m,i} (p_i^-)^2 = \\sum_{i=1}^N Y_{m,i} (p_i^+)^2$.
Physical plane-wave acoustic power is $P_{\\text{ac},i} = p_i U_{\\text{vol},i} = Y_{\\text{vol},i}((p_i^+)^2 - (p_i^-)^2) = \\frac{A_i}{\\rho_i c_i}((p_i^+)^2 - (p_i^-)^2)$ $[\\text{W}]$. When all ports at a compact junction share a common local junction gas density $\\rho_J = P_{\\text{atm}}/(R_{\\text{gas}} T_J)$ (with axial temperature cooling along each tube mapped by a WKB impedance taper $\\sqrt{Z_{\\text{vol,out}}/Z_{\\text{vol,in}}}$), **both** mass flow ($\\sum \\dot{m}_i = 0$) and physical acoustic power ($\\sum P_{\\text{ac},i} = 0$) are conserved simultaneously ($< 10^{-15}$).

## 2. Engine-Level First-Law Control-Volume Energy Ledger (Phase 10.1 WP-B)
\`PhysicalEngine.energyLedger\` integrates the five cylinder control-volume fluxes ($\\int \\dot{H}_{\\text{in}}\\,dt$, $\\int \\dot{H}_{\\text{ex}}\\,dt$, $\\int \\dot{Q}_{\\text{comb}}\\,dt$, $\\int \\dot{Q}_{\\text{wall}}\\,dt$, $\\int P\\,\\dot{V}\\,dt$) and three manifold control-volume fluxes across \`PhysicalEngine.step()\`. Macroscopic state-reconstructed internal energy $\\Delta U(P, V, m)$ matches the net ledger flux to $< 10^{-15}$, and piston boundary work converges monotonically as $O(\\Delta t)$ toward exact analytical slider-crank work $\\sum \\bar{P}\\,\\Delta V_{\\text{exact}}(\\theta)$ and crankshaft mechanical indicated work $\\int \\tau_{\\text{ind,gross}}\\,\\omega\\,dt$ across $24\\,\\text{kHz} \\to 48\\,\\text{kHz} \\to 96\\,\\text{kHz}$.

## 3. Cylinder Initial State & Exact $C^1$-Clamped \`[3/4]\` Rational \`fastTanh\` (Phase 10.1 WP-C / WP-D)
*   **Cylinder Initial State:** \`Cylinder.constructor\` sets $T_0 = T_{\\text{atm}} + 35.0 = 330.0\\,\\text{K}$ and $P_0 = 38.0\\,\\text{kPa}$ with \`minE = newMass * U_MIN_150\` ($150.0\\,\\text{K}$), eliminating the 342 first-stroke expansion clamps ($T_{\\min} = 165.41\\,\\text{K}$) that occurred against the legacy $220.0\\,\\text{K}$ threshold.
*   **Exact $C^1$-Clamped \`[3/4]\` Rational \`fastTanh\`:** Maximum absolute error $0.0007217 < 0.00073$ (at $|x| = 2.3487$), a **32.6x error reduction** over the legacy \`[3/2]\` Padé approximation ($0.023520$).
    `,
  }
];

