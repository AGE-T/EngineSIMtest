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

### 2. Run the Phase 10 / 10.1 Automated Physics & Acoustic Validation Suite
```bash
npm test
```
Executes `/tests/phase10Validation.ts` via `tsx` (zero browser dependency), running 40 deterministic checks across Phase 10 and Phase 10.1 Work Packages:
* **WP-A (Phase 10 & 10.1 — Determinism & Junction Mass-Flow vs. Physical Acoustic Power):** Bit-exact seed determinism (`new PhysicalEngine(sampleRate, seed)`), 9 representative operating-point scenario fixtures across 22.05, 44.1, 48, and 96 kHz, and explicit separation of junction pressure continuity ($p_i^+ + p_i^- = P_J$), mass-flow conservation ($\sum \dot{m}_i = \sum Y_{m,i}(p_i^+ - p_i^-) = 0$ with $Y_{m,i} = A_i / c_i$), the algebraic mass-admittance quadratic invariant ($\sum Y_{m,i} p^2$), and physical plane-wave acoustic power ($P_{\text{ac},i} = p_i U_{\text{vol},i} = Y_{\text{vol},i}((p_i^+)^2 - (p_i^-)^2)$ with $Y_{\text{vol},i} = A_i / (\rho_i c_i) = Y_{m,i} / \rho_i$), plus negative tests that reject deliberately wrong density/area weightings.
* **WP-B (Phase 10 & 10.1 — Thermodynamics & Engine-Level First-Law Energy Ledger):** Analytical $u(T) \leftrightarrow T(u)$ round-trip inversion, engine-level cylinder and manifold control-volume First-Law energy ledger ($\int \dot{H}_{\text{in}}\,dt - \int \dot{H}_{\text{ex}}\,dt + \int \dot{Q}_{\text{comb}}\,dt - \int \dot{Q}_{\text{wall}}\,dt - \int P\,\dot{V}\,dt$) cross-checked against independent state-reconstructed internal energy $U(P, V, m)$ and exact analytical slider-crank geometric work $\sum \bar{P}\,\Delta V_{\text{exact}}(\theta)$ with monotone $O(\Delta t)$ convergence across $24\,\text{kHz} \to 48\,\text{kHz} \to 96\,\text{kHz}$, single-application Wiebe heat release, and crossplane V8 `1-8-4-3-6-5-7-2` (`L-R-R-L-R-L-L-R`) firing sequence.
* **WP-C (Phase 10 & 10.1 — Cylinder Initial State & Waveguide Acoustics):** `Cylinder.constructor` initializes $T_0 = T_{\text{atm}} + 35.0 = 330.0\,\text{K}$ and $P_0 = 38.0\,\text{kPa}$ with lower energy bound `minE = newMass * U_MIN_150` ($150.0\,\text{K}$, aligned with `tempFromSpecificEnergy`), producing `0` recovery clamps during the first half-revolution expansion stroke ($T_{\min} = 208.90\,\text{K}$, which dipped below the legacy $220.0\,\text{K}$ threshold). Includes 4-point Cubic Hermite fractional-delay accuracy, dynamic $c(T)$ continuity, H-pipe coupling, and nonlinear Burgers delay-modulation monotonicity ($|d(\text{shift})/dn| \le 0.42$).
* **WP-D (Phase 10 & 10.1 — `fastTanh` Verification & Golden Audio Regression Suite):** Dense-grid (200,001-point) verification of the $C^1$-clamped `[3/4]` rational `fastTanh` approximant ($\max |R(x) - \tanh(x)| = 0.0007217 < 0.00073$), versioned golden audio regression comparisons across all 9 scenarios, and a negative comparator self-test.
* **WP-E & WP-F (Phase 10.1 — CI Workflow & Real-Time Deadline Profiling):** GitHub Actions workflow in `.github/workflows/ci.yml` (`npm ci` $\to$ `npm test` $\to$ `npm run lint` $\to$ `npm run build` on Node.js 22 LTS) and 128-sample AudioWorklet block-time benchmarks separating on-CPU execution time from container hypervisor pre-emptions.

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
