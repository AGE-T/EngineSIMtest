# Phase 8 Engine Simulator

A high-fidelity spatial audio physics engine simulator in the browser, featuring procedural sound synthesis via Web Audio API AudioWorklets.

## Features Added

*   **Pops & Bangs (ECU)**: Unburnt fuel ignites in the downpipe creating gunshot-like pops. Pops are isolated and routed through a dedicated `street` Impulse Response (IR) convolver to mimic an outdoor acoustic tail and environment delay, instead of clipping the downpipe block. The frequency of the pops has been significantly lowered manually for a far more authentic, chest-thumping bass crack.
*   **Intake Pitch Modulation**: A resonant low-pass filter models the intake tract. As throttle load and RPM increases, the filter cutoff opens dramatically (pitching up ~7 semitones) while the resonance intensifies, simulating the vast volume of air being sucked into the engine block.
*   **Rev Limiter**: A smoothed interpolation applies over the ignition amplitude (`this.ignitionAmp`) cutting fuel smoothly at max RPM, which entirely eliminates clipping defects and digital transients (the previous sharp "clicking" sounds).
*   **Spatial Audio Panning**: The mix engine allows panning Whine, Surge, Exhaust, Intake, and Mechanical noise. *Mechanical noise now represents the combination of valve ticking, general rotating friction white-noise, and sub-bass block rumbling.*
*   **Turbo Tuning**: Small turbo configurations have been boosted. Whine volume was reduced by 20%, whereas Surge/Flutter intensity was globally increased by 50% across all configurations.

## Advanced Routing

The worklet now utilizes an expanded channel mapping (4 Channels):

-   **Output Channels 0 & 1**: Main Left/Right Mix (Includes Dry Engine, Tailpipe, Intake, Mech, Turbo).
-   **Output Channels 2 & 3**: Dedicated Pops/Bangs output L/R. This allows routing the unburnt fuel explosion impulses exclusively through a heavy Reverb/Convolver to simulate a massive outdoor stadium/street crack.

## Use

Open the app or run the dev server to start simulated driving. Press `E` and `Q` to shift up and down, hit the throttle for intake noise, and drop the throttle at high RPM with the Pops checkbox enabled to simulate unburnt fuel igniting.
