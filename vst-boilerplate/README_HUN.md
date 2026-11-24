# Engine Simulator - JUCE VST3 Boilerplate

Ez a mappa egy **C++ JUCE** alapú sablont tartalmaz, amely lehetővé teszi, hogy a React / Web Audio (TypeScript) DSP logikánkat egyenesen egy Ableton Live kompatibilis multi-out VST3 pluginba fordítsuk.

## Miért JUCE és nem Max node.script?

1. **Teljesítmény:** A JavaScript Runtime (Node) Garbage Collection (szemétszállítás) miatt egy VST környezetben a valós idejű hanggenerálásnál (buffer callback) megakadásokat (dropouts) produkál. A mi kódunk mintánkénti (sample-by-sample) DSP-t használ sűrű csőszoftver modellezéssel. A C++ itt elengedhetetlen a stabil működéshez.
2. **Könnyű Migráció:** Az `AudioWorkletProcessor` belső működése nagyon hasonló a JUCE `processBlock`-jához. Ciklusokon belül mintákat manipulálunk, így a `phase8Worklet.ts` jórészt egy-az-egyben átírható C++ syntaxra.
3. **Multi-Out Buszok Abletonban:** A JUCE pluginoknál egyszerűen definiálhatunk tetszőleges kimeneteket. Ezt a `PluginProcessor.cpp` fájlban be is állítotam (10 csatorna / 5 busz).

## Automatikus Ableton Paraméterek

A JUCE `AudioProcessorValueTreeState` (APVTS) felelős a paraméterek publikálásáért a DAW (Ableton) felé:
- Az Abletonban minden, amit itt definiálunk, automazitálható burkológörbékkel (Envelopes).
- A plugin automatikusan generál magának egy vázat (GenericAudioProcessorEditor), amelyen a potméterek azonnal látszanak és map-elhetők, felületfejlesztés (React/frontend) nélkül!

## Ableton Multi-Out beállítása

1. Húzd be a lefordított VST3 plugint egy MIDI / Audio csatornára az Abletonban.
2. Ezen a főcsatornán fog szólni a **Tailpipe (Ch 1/2)**.
3. Hozz létre 4 új Audio csatornát.
4. Az Audio csatornák Bemenet (Audio From) legördülő menüjében válaszd ki a Plugin sávját.
5. A második legördülőben (Pre-FX / Post-FX helyett) választhatod a plugin kimeneti buszait:
   - `3/4: Pops`
   - `5/6: EngineBlock`
   - `7/8: Intake`
   - `9/10: Turbo`
   
Ezzel minden fizikai zajforrást egyéni csatornán kapsz meg Abletonon belül!

## Fordítás

Töltsd le ezt a mappát a gépedre, és nyisd meg a Projucer-el (JUCE szoftver), vagy használd a CMake rendszert egy szabványos buildhez:

```bash
mkdir build
cd build
cmake ..
cmake --build . --config Release
```
