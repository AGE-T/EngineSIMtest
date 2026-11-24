export const synthConfig = `
const CONFIG = {
    VOL_MULTIPLIERS: {
        MECH: 0.15,         // Teljes mechanikus zaj szorzó (csökkentve, hogy ne legyen túl hangos)
        INTAKE: 0.2,       // Szívóhang szorzó
        VALVE_TICK: 0.1,   // Szelep kattogás/cicergés szorzója (korábban ez cicergett nagyon)
        CHAIN: 0.001,      // Vezérműlánc alapzaj szorzója
        GRITTY_VIBE: 0.1, // Motorblokk rezonancia, morajlás
        PISTON_SCRAPE: 0.005, // Dugattyú súrlódás
        BEARING: 0.005     // Csapágy morajlás
    },
    FILTERS: {
        INTAKE_BASE_CUTOFF: 0.015,
        INTAKE_RESONANCE: 0.45
    }
};
`;
