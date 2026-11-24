# VST3 Fordítási Útmutató (Windows / Mac)

Mivel beállítottam a **CMake FetchContent**-et, a JUCE keretrendszert a gép automatikusan le fogja tölteni fordítás közben. Nem kell manuálisan telepítened a JUCE-t!

Csak a fordító (Compiler) és a CMake eszköz szükséges.

## 1. Előfeltételek telepítése

### Ha Windows-on vagy:
1. **Visual Studio 2022 Community** letöltése (Ingyenes):
   Telepítésnél pipáld be a **"Desktop development with C++"** modult!
2. **CMake** letöltése és telepítése (https://cmake.org/download/). (Telepítésnél válaszd, hogy adja hozzá a PATH-hoz).
3. **Git** telepítése (https://git-scm.com/downloads) - a JUCE letöltéséhez kellhet a háttérben.

### Ha Mac-en vagy:
1. Nyiss egy Terminált és futtasd: `xcode-select --install` (Ez telepíti az Apple clang C++ fordítóját).
2. Telepítsd a CMake-et. Vagy töltsd le a cmake.org-ról, vagy ha van Homebrew-d: `brew install cmake`.

---

## 2. A kód lefordítása

Csomagold ki a projektünkből a `vst-boilerplate` mappát a gépedre, majd nyiss benne egy Parancssort / Terminált (Windows-on pl. PowerShell vagy CMD abba a mappába navigálva).

Futtasd a következő parancsokat sorban:

```bash
# 1. Hozzuk létre a build mappát
mkdir build
cd build

# 2. Generáljuk le a projekt fájlokat (Windows-on ez elkészíti a Visual Studio projektet, Mac-en a Makefile/Xcode projektet)
cmake ..

# 3. Indítsuk el a tényleges fordítást (Ez pörgetni fogja a processzort pár percig, amíg a JUCE is lefordul)
cmake --build . --config Release
```

## 3. Hol találom az elkészült VST3 plugint?

Ha a fenti lépések sikeresen lefutottak:
- **Windows:** A `build/EngineSimulator_artefacts/Release/VST3/` mappában találsz egy `EngineSimulator.vst3` fájt vagy mappát. Ezt másold be a `C:\Program Files\Common Files\VST3` mappádba.
- **Mac:** A `build/EngineSimulator_artefacts/Release/VST3/` mappában látsz egy `EngineSimulator.vst3` fájlt. Ezt másold a `~/Library/Audio/Plug-Ins/VST3/` vagy `/Library/Audio/Plug-Ins/VST3/` mappába.

Indítsd újra az Ableton-t! A pluginek között (VST3 -> Auth vagy megadott mappa) látnod kell az `Engine Sim` plugint. Húzd be egy sávra!

## 4. Tesztelés / Következő lépés

Jelenleg a C++ kódunk (a `PluginProcessor.cpp`-ben) csendet generál, mivel a teljes böngészős fizikát (600 sor TypeScript) még nem írtuk át C++-ra. 
A cél itt most az, hogy **lásd a plugint az Abletonban, lásd a paramétereket (macro map-elhető RPM, Throttle, stb.) és kipróbáld a Multi-Out buszokat (kimeneteket).**

Próbáld meg ezeket a lépéseket, és írj, ha hibaüzenetet kapsz a fordítás (`cmake --build .`) közben! Ha sikerül behúzni Abletonba, akkor jöhet a fizika (DSP) átírása C++-ra!
