# EngineSIMtest — Phase 10 Physics & Acoustic Validation

A browser-based real-time engine sound and physics simulator built with React, TypeScript, Vite, and the Web Audio API (`AudioWorklet`).

The repository contains two distinct engine audio synthesis architectures (**Phase 8** and **Phase 9**), an interactive **Architecture Documentation** reference view, an automated **Phase 10 Physics & Acoustic Validation Suite** (`npm test`), and a historical incomplete C++/JUCE scaffold (`/vst-boilerplate/`).

---

## Project Structure & Component Status

| Component / Path | Phase / Status | Description |
| :--- | :--- | :--- |
| `/src/audio/phase9Engine.ts` | **Phase 9 & 10 (Active Default)** | Zero-allocation 1D thermodynamic, compressible orifice flow, and bidirectional digital-waveguide crossplane V8 simulator (`PhysicalEngine`), featuring temperature-dependent $C_v(T)$, Wiebe combustion, Woschni wall heat transfer, mass-flow admittance ($Y_i = A_i / c_i$) Kelly-Lochbaum junctions, nonlinear Burgers wave steepening, 6-speed torque-converter automatic transmission, and discrete gear-mesh/commutator 12V starter motor. |
| `/src/audio/phase9Worklet.ts` | **Phase 9 & 10 (Active Default)** | Inline `AudioWorkletProcessor` wrapper running `PhysicalEngine.step()` in real time and streaming 60 Hz telemetry to the UI. |
| `/src/components/Phase9Demo.tsx` | **Phase 9 & 10 (Active Default)** | Browser testbench & telemetry dashboard for the Phase 9 V8 engine (Ignition, Starter, N / Auto D / Manual M1–M6 transmission selector, Throttle, Dyno Load, Stereo Waveforms, and P/T/RPM gauges). |
| `/src/components/LiveDemo.tsx` | **Phase 8 (Preserved)** | Procedural multi-cylinder / turbo / ECU audio synthesizer featuring 4-channel AudioWorklet routing (Channels 0–1 Main L/R mix; Channels 2–3 dedicated Pops & Bangs street impulse-response convolver), intake pitch filter modulation, and spatial panning. |
| `/src/data/architecture.ts` | **Architecture Reference** | System architecture documentation covering Phases 1–4 conceptual design, historical MVP scope notes, and Phase 9 / Phase 10 mathematical and physical implementation reference. |
| `/tests/phase10Validation.ts` | **Phase 10 Validation Suite** | Automated, browser-independent test runner and benchmark suite verifying determinism, thermodynamic conservation, state bounds, acoustic junction scattering, `fastTanh` accuracy, and 128-sample block CPU headroom. |
| `/docs/PHASE10_VALIDATION_REPORT.md` | **Phase 10 Validation Report** | Complete analytical derivations, invariant tables, `fastTanh` error verification, CPU benchmark percentiles, and audio-regression metrics. |
| `/vst-boilerplate/` | **Incomplete Scaffold (Untouched)** | Early C++17 / JUCE 7 VST3 plugin skeleton (`CMakeLists.txt`, `PluginProcessor.h/.cpp`, `Waveguide.h`, `Cylinder.h`). Contains placeholder `TODO` stubs and is **not** a complete port of either Phase 8 or Phase 9. |

---

## Quick Start & Commands

### 1. Install Dependencies
```bash
npm install
```

### 2. Run the Phase 10 Automated Physics & Acoustic Validation Suite
```bash
npm test
```
Executes `/tests/phase10Validation.ts` via `tsx` (zero browser dependency), running 33 deterministic checks across Work Packages A–E:
* **WP-A:** Bit-exact seed determinism (`new PhysicalEngine(sampleRate, seed)`) and 9 representative operating-point scenario fixtures across 22.05, 44.1, 48, and 96 kHz.
* **WP-B:** Analytical $u(T) \leftrightarrow T(u)$ round-trip inversion, closed-cylinder First-Law energy accounting, intake-manifold-to-cylinder valve mass & enthalpy conservation, single-application Wiebe combustion heat release & fresh-charge consumption, crossplane V8 `1-8-4-3-6-5-7-2` (`L-R-R-L-R-L-L-R`) firing sequence, state validity bounds, and zero numerical recovery clamps.
* **WP-C:** Hetero-thermal multi-port Kelly-Lochbaum junction pressure continuity, mass-flow conservation ($\sum \dot{m}_i = 0$ via $Y_i = A_i / c_i$), lossless wave-power balance, 4-point Cubic Hermite fractional-delay accuracy, dynamic speed-of-sound $c(T)$ continuity, H-pipe cross-bank coupling, and nonlinear Burgers delay-modulation monotonicity ($|d(\text{shift})/dn| \le 0.42$).
* **WP-D:** Dense-grid (200,001-point) verification of the $C^1$-clamped `[3/4]` rational `fastTanh` approximant ($\max |R(x) - \tanh(x)| = 0.0007217 < 0.00073$, replacing the legacy `[3/2]` Padé which had $0.023520$ error at $|x| = 1.566$) and 128-sample AudioWorklet block-time benchmarks at 44.1, 48, and 96 kHz.
* **WP-E:** Deterministic audio-regression metrics (peak, RMS, crest factor, DC offset, clipping count, spectral centroid, V8 firing fundamental frequency, and 5-band spectral energy distribution).

### 3. Type-Check & Build
```bash
npm run lint
npm run build
```

### 4. Start Interactive Browser Development Server
```bash
npm run dev
```
Opens on `http://localhost:3000`. Use the top navigation bar to switch between:
* **Phase 9: 1D Physics V8** (default interactive thermodynamic & waveguide V8 testbench)
* **Architecture Docs** (complete engineering & Phase 10 validation documentation)
* **Phase 8 Demo** (preserved procedural audio & 4-channel Pops/Turbo convolver synthesizer)
