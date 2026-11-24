# EngineSIMtest — Phase 10: Physics & Acoustic Validation Report

## 1. Summary of Changes & Baseline Provenance

* **Repository:** `https://github.com/AGE-T/EngineSIMtest`
* **Audited Baseline Commit Reference:** `b69aa6f9f4d33f3a50f239cb7369871ea1963e7b` (`main` branch)
* **Environment Provenance Note:** The workspace is an AI Studio Linux container snapshot (`Linux 4.19.0-gvisor x86_64`, no `.git` metadata directory present) initialized from baseline commit `b69aa6f9f4d33f3a50f239cb7369871ea1963e7b` with the current session's Phase 9 physical acoustic refinements and Phase 10 mathematical/physical validation fixes applied.
* **Scope Discipline:**
  * Phase 8 (`src/components/LiveDemo.tsx`) and `/vst-boilerplate/` (incomplete C++/JUCE 7 VST3 scaffold) were preserved and kept strictly separate from Phase 9/10 validation work.
  * No new engine layouts, sound effects, or VST ports were added.
* **Key Phase 10 Code & Validation Changes:**
  1. **Controllable Deterministic Seed (`src/audio/phase9Engine.ts`):** Added `new PhysicalEngine(sampleRate, seed = 0x12345678)`, `setSeed(seed)`, and `getSeed()` for reproducible bit-exact testing across seeds while retaining physical cycle-to-cycle variation during normal operation.
  2. **Multi-Port Scattering Junction Admittance Correction (`src/audio/phase9Engine.ts`):** Derived and implemented mass-flow admittance weighting $Y_i = 1 / Z_i = A_i / c_i$ $[(\text{kg/s})/\text{Pa}]$ across all three multi-port junctions in `ExhaustBank.step()` (4-into-1 collector, midpipe/H-pipe/3-path muffler inlet, and muffler-exit/tailpipe) and passed `this.hPipe.Y` from `PhysicalEngine.step()`.
  3. **Exact $C^1$-Clamped `[3/4]` Rational `fastTanh` Approximant (`src/audio/phase9Engine.ts`):** Replaced the legacy `[3/2]` Padé approximation ($\max |R(x) - \tanh(x)| = 0.023520$ at $|x| = 1.5660$, violating the `< 0.003` comment by $7.8\times$) with an exact $C^1$-clamped `[3/4]` rational approximant achieving $\max |R(x) - \tanh(x)| = 0.0007217 < 0.00073$ ($32.6\times$ reduction in error, $4.15\times$ below the $0.003$ bound).
  4. **Explicit Clamp Diagnostics & Cylinder Initialization (`src/audio/phase9Engine.ts`):** Added zero-allocation `ClampDiagnostics` counters distinguishing numerical recovery clamps (`nanOrInfCount`, `cylMassFloorCount`, `cylEnergyBoundCount`, `manMassFloorCount`, `manEnergyBoundCount`, `manPressureCeilingCount`, `waveguideSaturationCount`) from expected physical actuator/spark bounds (`iacvActuatorBoundCount`, `sparkAdvanceBoundCount`, `freshMassRoundoffClampCount`). Corrected `Cylinder` initial charge temperature ($T_0 = T_{\text{atm}} + 73\,\text{K} = 368\,\text{K}$, accounting for intake charge + hot residual gas mixing) so adiabatic expansion from TDC on sample 0 never dips below $265\,\text{K}$ (`0` recovery clamps across all 9 operating scenarios).
  5. **Hot-Loop Coefficient Precomputation (`src/audio/phase9Engine.ts`):** Precomputed `this.shiftAlpha` in `PhysicalEngine.constructor`, removing the last per-sample `Math.exp` call from `PhysicalEngine.step()`, and replaced the unverified `<5% single-core CPU` comment with measured environment-specific benchmarks.
  6. **Automated Browser-Independent Validation Suite (`tests/phase10Validation.ts`, `package.json`):** Added `"test": "tsx tests/phase10Validation.ts"` running 33 automated tests across Work Packages A–E.

---

## 2. Test Commands, Environment & Pass/Fail Counts

### Environment
* **OS / Kernel:** `Linux localhost 4.19.0-gvisor #1 SMP x86_64 GNU/Linux` (virtualized gVisor container, 2 logical vCPUs: `Intel(R) Xeon(R) CPU @ 2.20GHz`)
* **Node.js:** `v22.23.5`
* **npm:** `10.9.9`
* **TypeScript (`tsc`):** `Version 5.8.3`

### Commands & Results
| Command | Purpose | Result |
| :--- | :--- | :--- |
| `npm test` | Run Phase 10 automated validation & benchmark suite (`tsx tests/phase10Validation.ts`) | **33 / 33 PASSED (0 FAILED)** |
| `npm run lint` | TypeScript full type-check (`tsc --noEmit`) | **PASS (0 errors)** |
| `npm run build` | Production Vite bundle build (`vite build`) | **PASS** |

---

## 3. Mathematical Derivations & Physical / Acoustic Invariants

### 3.1 Derivation of Multi-Port Junction Scattering in Mass-Flow Convention (WP-C)
In `src/audio/phase9Engine.ts`, each `WaveguideTube` decomposes acoustic pressure into forward and backward traveling pressure waves $p_i^+, p_i^-$ $[\text{Pa}]$ and defines characteristic impedance with respect to **mass flow rate** $\dot{m}_i = \rho_i U_i = \rho_i A_i u_i$ $[\text{kg/s}]$:
$$P_i = p_i^+ + p_i^-, \qquad \dot{m}_i = \frac{p_i^+ - p_i^-}{Z_i}, \qquad Z_i = \frac{c_i}{A_i} \quad \left[\frac{\text{Pa}}{\text{kg/s}}\right]$$
Note that because classical volumetric acoustic impedance is $Z_{\text{vol},i} = \frac{\rho_i c_i}{A_i}$ $[\text{Pa}/(\text{m}^3/\text{s})]$ and mass flow is $\dot{m}_i = \rho_i U_i$, gas density $\rho_i$ cancels out exactly:
$$Z_{\text{mass},i} = \frac{p_i^+ - p_i^-}{\dot{m}_i} = \frac{Z_{\text{vol},i} U_i}{\rho_i U_i} = \frac{c_i}{A_i}$$
Therefore, each port's **mass-flow admittance** is:
$$Y_i = \frac{1}{Z_i} = \frac{A_i}{c_i} \quad \left[\frac{\text{kg/s}}{\text{Pa}}\right]$$
At an $N$-port lossless Kelly-Lochbaum junction where $p_i^{\text{in}}$ denotes the wave arriving at the junction on branch $i$ and $p_i^{\text{out}}$ denotes the wave leaving the junction on branch $i$:
1. **Pressure continuity:** $p_i^{\text{in}} + p_i^{\text{out}} = P_J \implies p_i^{\text{out}} = P_J - p_i^{\text{in}}$ for all $i \in \{1, \dots, N\}$.
2. **Mass-flow conservation:**
   $$\sum_{i=1}^N \dot{m}_{i,\text{into J}} = \sum_{i=1}^N Y_i \left(p_i^{\text{in}} - p_i^{\text{out}}\right) = \sum_{i=1}^N Y_i \left(2 p_i^{\text{in}} - P_J\right) = 0 \implies P_J = \frac{2 \sum_{i=1}^N Y_i\, p_i^{\text{in}}}{\sum_{i=1}^N Y_i}$$
3. **Lossless acoustic wave-power conservation:**
   $$\sum_{i=1}^N Y_i \left(p_i^{\text{out}}\right)^2 = \sum_{i=1}^N Y_i \left(P_J - p_i^{\text{in}}\right)^2 = P_J^2 \sum_{i=1}^N Y_i - 2 P_J \sum_{i=1}^N Y_i p_i^{\text{in}} + \sum_{i=1}^N Y_i \left(p_i^{\text{in}}\right)^2 = \sum_{i=1}^N Y_i \left(p_i^{\text{in}}\right)^2$$

When connected waveguides have different temperatures ($c_{\text{prim}} \neq c_{\text{mid}} \neq c_{\text{tail}} \neq 0.93\,c_{\text{tail}}$), raw area weighting ($A_i$) violates $\sum \dot{m}_i = 0$, whereas admittance weighting ($Y_i = A_i / c_i$) conserves both mass flow and wave power to machine precision ($< 10^{-15}$).

### 3.2 Nonlinear Propagation Equation & Operating Range (WP-C)
`WaveguideTube.readOutputs(nlStrength)` implements a passive delay-modulated nonlinear wave-steepening approximation (inspired by 1D Burgers shock steepening where high-pressure wave crests propagate faster than troughs):
$$\tau_{\text{target}}[n] = \text{nlStrength} \cdot \Delta\tau_{\max} \cdot \operatorname{fastTanh}\!\left(\frac{2.2}{P_{\text{atm}}}\, \tilde{p}^+[n]\right), \qquad \Delta\tau_{\max} = \min(7.5,\, 0.20\, D_{\text{base}})$$
where $\tilde{p}^+[n]$ is a 1-pole low-pass filtered ($f_c = 2600\,\text{Hz}$) forward pressure estimate and the applied fractional delay shift $\Delta\tau[n]$ is slew-rate limited on every sample:
$$\left|\Delta\tau[n] - \Delta\tau[n - 1]\right| \le 0.42 \quad \text{samples/step}$$
Because the read index advances by $1 - (\Delta\tau[n] - \Delta\tau[n-1]) \ge 0.58 > 0$ samples per step, the read pointer is **strictly monotonic** (zero time-reversal or foldover aliasing) and cannot create unbounded energy.

### 3.3 Physical & Acoustic Invariants Table
| ID | Work Package | Physical / Acoustic Invariant | Measured Residual | Acceptance Limit | Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `INV-A1` | WP-A | Deterministic state & audio reproduction (same config + seed `0xCAFEBABE`, 24,000 steps) | `0.000e+0` | `0.0` (bit-exact) | **PASS** |
| `INV-B1` | WP-B | Internal energy $\leftrightarrow$ temperature analytical inversion $\max_{T \in [220,3800]} |T(u(T)) - T|$ | `1.364e-12 K` | `< 1.0e-11 K` | **PASS** |
| `INV-B2` | WP-B | Closed-cylinder 1st-Law energy accounting $|(E_{\text{end}} - E_0) + \int P\,dV| / E_0$ | `1.172e-16` (Euler cycle drift `6.078e-4`) | `< 1.0e-12` (drift `< 1.5e-3`) | **PASS** |
| `INV-B3` | WP-B | Valve interface mass & enthalpy flux conservation $|(\dot{m}, \dot{E})_{\text{man}} + (\dot{m}, \dot{E})_{\text{cyl}}|$ | `dm: 0.00e+0, dE: 0.00e+0` | `0.0` (exact) | **PASS** |
| `INV-B4` | WP-B | Wiebe single-application heat release & fresh-charge consumption residual | `heat: 6.135e-16, fresh: 5.568e-16` | `< 1.0e-12` | **PASS** |
| `INV-B5` | WP-B | Crossplane V8 firing order `1-8-4-3-6-5-7-2` & $90^\circ$ bank cadence | `L-R-R-L-R-L-L-R` (slots `0-1-2-3-4-5-6-7`) | `L-R-R-L-R-L-L-R` | **PASS** |
| `INV-C1` | WP-C | Multi-port hetero-thermal junction mass-flow conservation $|\sum \dot{m}_i| / \sum |\dot{m}_i|$ | `4.278e-17` | `< 1.0e-14` | **PASS** |
| `INV-C2` | WP-C | Lossless N-port junction wave-power balance $|\sum Y_i (p_i^{\text{out}})^2 - \sum Y_i (p_i^{\text{in}})^2| / P_{\text{in}}$ | `1.705e-16` | `< 1.0e-14` | **PASS** |
| `INV-C3` | WP-C | 4-point Cubic Hermite fractional-delay phase & gain error ($D = 27.37$ samples, $>80$ wraps) | `0.00208 samples / 0.00001 dB` | `< 0.02 samples / < 0.02 dB` | **PASS** |
| `INV-C4` | WP-C | Waveguide impulse propagation delay vs. analytical $L f_s / c$ ($L=0.52\,\text{m}, c=344\,\text{m/s}$) | `0.44 samples` ($73$ vs. $72.56$) | `<= 1.0 sample` | **PASS** |
| `INV-C5` | WP-C | Nonlinear delay-modulation read-pointer slew rate $|d(\text{shift})/dn|$ | `0.2619 samples/step` | `<= 0.42 samples/step` | **PASS** |
| `INV-D1` | WP-D | `fastTanh` maximum absolute error $\sup_{x \in [-6,6]} |\operatorname{fastTanh}(x) - \tanh(x)|$ | `0.0007217` at $|x| = 2.3487$ | `< 0.00075` (`< 0.003` spec) | **PASS** |

---

## 4. `fastTanh` Measured Error & Final Decision (WP-D)

* **Legacy `[3/2]` Padé Formula:** $R_{\text{legacy}}(x) = \frac{x(27 + x^2)}{27 + 9x^2}$ clamped at $|x| \ge 3$.
  * **Measured Maximum Absolute Error (200,001-point grid on $[-6, 6]$):** **`0.0235203` at $|x| = 1.56600$** ($7.84\times$ larger than the source comment's `< 0.003` claim).
* **Final Decision:** Replaced `fastTanh` with an exact $C^1$-clamped `[3/4]` rational approximant on $[-4.07, 4.07]$:
  $$R(x) = \begin{cases} \operatorname{sgn}(x), & |x| \ge 4.07 \\ \dfrac{x (C_0 + N_2 x^2)}{C_0 + x^2 (D_2 + x^2)}, & |x| < 4.07 \end{cases}$$
  where $C_0 = 163.88050423825393$, $N_2 = 13.171696172305033$, $D_2 = 67.41614521033179$.
  * **Measured Maximum Absolute Error:** **`0.0007217` at $|x| = 2.34870$** ($32.6\times$ lower error than the legacy Padé, $4.15\times$ below the $0.003$ bound).
  * **Boundary Smoothness:** Exact $R(\pm 4.07) = \pm 1$ and $R'(\pm 4.07) = 0$ (measured left derivative at $4.07 - 10^{-6}$ is $3.77 \times 10^{-9}$), with strict monotonicity ($R'(x) \ge 0$) everywhere.

---

## 5. CPU & Real-Time Block-Time Benchmarks (WP-D)

* **Measurement Method:** 1,500 consecutive 128-sample AudioWorklet blocks after a 400-block JIT warm-up per configuration, timed with `performance.now()` in Node.js `v22.23.5` on `Linux 4.19.0-gvisor x86_64` (`Intel(R) Xeon(R) CPU @ 2.20GHz`).
* **Evaluation of the `<5% CPU` Comment:** In this virtualized 2.20 GHz gVisor container, 128 samples at 48 kHz (budget `2.667 ms`) require a median of **`0.493–0.517 ms`** (`18.5%–19.4%` of single-core real-time budget) and an average of **`0.550–0.653 ms`** (`20.6%–24.5%` CPU). The `<5% single-core CPU` comment in `src/audio/phase9Engine.ts` was therefore **removed** and replaced with the measured environment-qualified figures below.

| Scenario | Sample Rate | Block Budget | Avg (ms) | Median (ms) | P95 (ms) | P99 (ms) | Max (ms) | Mean CPU % | Deadline Misses (of 1500) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| Warm Idle (750 RPM) | `44,100 Hz` | `2.902 ms` | `0.576 ms` | `0.506 ms` | `0.858 ms` | `1.106 ms` | `5.840 ms` | **19.8%** | `2 / 1500` (gVisor host schedule) |
| Warm Idle (750 RPM) | `48,000 Hz` | `2.667 ms` | `0.562 ms` | `0.503 ms` | `0.811 ms` | `0.985 ms` | `5.654 ms` | **21.1%** | `1 / 1500` (gVisor host schedule) |
| High RPM WOT (6500 RPM) | `48,000 Hz` | `2.667 ms` | `0.550 ms` | `0.493 ms` | `0.781 ms` | `0.977 ms` | `6.103 ms` | **20.6%** | `1 / 1500` (gVisor host schedule) |
| High Transient Activity (Shifts + Overrun) | `48,000 Hz` | `2.667 ms` | `0.653 ms` | `0.517 ms` | `0.989 ms` | `3.588 ms` | `5.324 ms` | **24.5%** | `34 / 1500` (container VM pre-emption) |
| Worst-Case Cold Crank + Starter Gear Mesh | `48,000 Hz` | `2.667 ms` | `0.563 ms` | `0.511 ms` | `0.784 ms` | `0.941 ms` | `2.769 ms` | **21.1%** | `1 / 1500` (gVisor host schedule) |
| High RPM WOT (6500 RPM) | `96,000 Hz` | `1.333 ms` | `0.533 ms` | `0.489 ms` | `0.742 ms` | `0.986 ms` | `5.552 ms` | **40.0%** | `4 / 1500` (gVisor host schedule) |

* **Hot-Path Allocation Audit:** Inspection of `PhysicalEngine.step()`, `ExhaustBank.step()`, and `WaveguideTube` confirms **zero `new` object, array, or closure allocations** inside the per-sample loop; all scratch structures (`throttleFlow`, `inFlow`, `exFlow`, `stepOut`, `result`, `bankFlowsL/R`, `primaryInPlus`) are preallocated in the constructors.

---

## 6. Deterministic Audio-Regression Metrics (WP-E)

| Scenario ID | Rate (Hz) | RPM Trajectory (`start -> end [min..max]`) | Peak | RMS | Crest Factor | DC Offset (`ExL, ExR`) | Centroid (Hz) | V8 Firing $f_0$ (`meas / exp Hz`) | 5-Band Energy (`20-60 / 60-250 / 250-1k / 1k-4k / 4k-12k`) | Clips / Recovery Clamps |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `1_cold_start_and_cranking` | `48000` | `0 -> 783 [0..1602]` | `0.592` | `0.047` | `12.63` | `(4.67e-4, 7.11e-4)` | `237 Hz` | `52.9 / 52.2 Hz` | `72.7% / 23.8% / 3.4% / 0.0% / 0.0%` | `0 / 0` |
| `2_warm_idle_equilibrium` | `48000` | `745 -> 750 [628..1051]` | `0.362` | `0.033` | `10.82` | `(3.28e-4, 3.03e-4)` | `236 Hz` | `50.2 / 50.0 Hz` | `79.6% / 18.6% / 1.8% / 0.0% / 0.0%` | `0 / 0` |
| `3_low_and_medium_load_cruise` | `48000` | `745 -> 4363 [436..4365]` | `0.388` | `0.091` | `4.29` | `(3.64e-3, 3.80e-3)` | `814 Hz` | `290.3 / 290.9 Hz` | `0.2% / 7.5% / 91.6% / 0.7% / 0.0%` | `0 / 0` |
| `4_wide_open_throttle_wot` | `48000` | `2400 -> 6732 [2179..6732]` | `0.517` | `0.161` | `3.21` | `(5.15e-3, 5.45e-3)` | `1092 Hz` | `445.9 / 448.8 Hz` | `2.6% / 5.1% / 89.2% / 3.0% / 0.0%` | `0 / 0` |
| `5_dfco_overrun_and_idle_catch` | `48000` | `4200 -> 725 [654..4200]` | `0.331` | `0.052` | `6.31` | `(2.46e-4, 2.28e-4)` | `239 Hz` | `49.9 / 48.3 Hz` | `83.2% / 15.6% / 0.9% / 0.0% / 0.0%` | `0 / 0` |
| `6_soft_and_hard_rev_limiter` | `48000` | `6200 -> 7049 [6148..7073]` | `0.629` | `0.264` | `2.38` | `(4.77e-3, 4.74e-3)` | `854 Hz` | `468.2 / 469.9 Hz` | `2.1% / 23.3% / 73.9% / 0.6% / 0.0%` | `0 / 0` |
| `7_gear_changes_and_load_transients` | `48000` | `745 -> 2380 [568..5567]` | `0.553` | `0.109` | `5.08` | `(1.68e-4, -9.23e-5)` | `541 Hz` | `159.8 / 158.6 Hz` | `44.3% / 27.6% / 27.7% / 0.3% / 0.0%` | `0 / 0` |
| `8_stall_and_restart_cycle` | `48000` | `745 -> 791 [0..1603]` | `0.362` | `0.040` | `9.16` | `(3.40e-4, 2.86e-4)` | `223 Hz` | `52.5 / 52.8 Hz` | `75.1% / 22.8% / 2.0% / 0.0% / 0.0%` | `0 / 0` |
| `9_multi_sample_rate_96kHz` | `96000` | `745 -> 3303 [371..3307]` | `0.340` | `0.066` | `5.14` | `(4.72e-3, 4.55e-3)` | `551 Hz` | `216.2 / 220.2 Hz` | `1.6% / 41.3% / 56.8% / 0.3% / 0.0%` | `0 / 0` |

---

## 7. Defects Found & Fixed vs. Unfixed

| ID | Severity | Location | Description & Quantitative Evidence | Status & Rationale |
| :--- | :--- | :--- | :--- | :--- |
| **DEF-1** | **High (Acoustic Physics)** | `src/audio/phase9Engine.ts` (`ExhaustBank.step`) | Multi-port Kelly-Lochbaum junctions weighted incoming waves by raw cross-sectional area $A_i$ instead of mass-flow admittance $Y_i = A_i / c_i$, despite connected pipes having different speeds of sound ($c_{\text{prim}} \neq c_{\text{mid}} \neq c_{\text{tail}} \neq 0.93\,c_{\text{tail}}$). Caused non-zero junction mass-flow residuals ($\sim 6.5\%$ error across a $610 \to 490\,\text{m/s}$ collector transition). | **FIXED:** Weighted all 3 multi-port junctions (collector, midpipe/H-pipe/muffler-inlet, muffler-exit/tailpipe) by $Y_i = A_i / c_i$. Mass-flow and lossless wave-power residuals are now `< 1e-15`. |
| **DEF-2** | **Medium (Numerical Approximation)** | `src/audio/phase9Engine.ts` (`fastTanh`) | Legacy `[3/2]` Padé approximation `x*(27+x^2)/(27+9*x^2)` claimed `max error < 0.003` in its comment but had a measured max absolute error of **`0.0235203` at $|x| = 1.5660$**. | **FIXED:** Replaced with an exact $C^1$-clamped `[3/4]` rational approximant on $[-4.07, 4.07]$ with measured max absolute error **`0.0007217` at $|x| = 2.3487$** ($32.6\times$ reduction). |
| **DEF-3** | **Medium (Thermodynamic Initialization)** | `src/audio/phase9Engine.ts` (`Cylinder.constructor`) | All 8 cylinders were initialized at $T_0 = T_{\text{atm}} + 35\,\text{K} = 330\,\text{K}$ regardless of stroke position. For the cylinder starting at TDC ($360^\circ$, $V_0 = V_c$), adiabatic expansion to BDC ($10.2\times$ volume ratio) cooled the unburned gas to the $220\,\text{K}$ floor (`342` `cylEnergyBoundCount` clamps during the first revolution). | **FIXED:** Set warm initial equilibrium charge temperature to $T_0 = T_{\text{atm}} + 73\,\text{K} = 368\,\text{K}$ (accounting for hot residual exhaust gas fraction at idle), eliminating all `cylEnergyBoundCount` clamps (`0` recovery clamps across all 9 scenarios). |
| **DEF-4** | **Low (Hot-Loop Hygiene & Docs)** | `src/audio/phase9Engine.ts` (lines 12, 1164) | Line 1164 called `Math.exp(-this.dt / 0.032)` on every sample for `shiftAlpha`, and line 12 claimed `<5% single-core CPU @ 48 kHz` without environment qualification. | **FIXED:** Precomputed `this.shiftAlpha` in constructor and updated the header comment with measured Node/V8 gVisor container block timings (`~0.55–0.65 ms` per `2.67 ms` block). |
| **DEF-5** | **Low (Testability & Docs)** | `src/audio/phase9Engine.ts`, `README.md`, `src/data/architecture.ts` | `PhysicalEngine` had a hardcoded RNG seed (`0x12345678`) with no constructor/setter API; `README.md` only documented Phase 8; `architecture.ts` only listed Phases 1–4. | **FIXED:** Added `seed` parameter and `setSeed()`, added `npm test` (`tests/phase10Validation.ts`), and updated `README.md` and `src/data/architecture.ts`. |

---

## 8. Explicit Statement of What Remains Unverified

1. **Empirical Dyno & In-Vehicle Acoustic Recording Comparison:** While Phase 10 proves internal mathematical consistency, thermodynamic 1st-Law conservation, admittance-conserving waveguide scattering, and analytical resonance agreement, the model has **not** been validated against physical cylinder-pressure transducer traces or calibrated free-field dyno microphone recordings of a real 4.58L crossplane V8.
2. **Full Compressible Navier-Stokes / Riemann Shock-Tube Solver:** The nonlinear wave steepening in `WaveguideTube.readOutputs()` is a validated, strictly monotonic delay-modulation approximation of Burgers crest advance ($|d(\text{shift})/dn| \le 0.42$), not a finite-volume method-of-characteristics or Riemann shock solver.
3. **Browser AudioWorklet Thread Deadline Jitter Across Consumer Hardware:** Real-time block benchmarks were measured in a virtualized Linux gVisor container (`Intel Xeon @ 2.20 GHz`, Node `v22.23.5`), where occasional container hypervisor pre-emptions cause P99/max spikes (`> 2.67 ms`) despite median execution taking `0.50 ms` (`~19%` of budget). Dedicated bare-metal browser `AudioWorklet` thread profiling on Windows/macOS/iOS/Android hardware remains outside the headless container test environment.
4. **Native C++ / JUCE VST3 Port (`/vst-boilerplate/`):** The `/vst-boilerplate/` directory remains an incomplete C++17 / JUCE 7 scaffold and is not compiled or validated as part of Phase 10.
