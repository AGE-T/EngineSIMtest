cmake_minimum_required(VERSION 3.22)

project(EngineSimulator VERSION 1.0.0)

# Automatikus JUCE letöltés a netről (így nem kell manuálisan telepítened)
include(FetchContent)
FetchContent_Declare(
    juce
    URL https://github.com/juce-framework/JUCE/archive/refs/tags/7.0.9.zip
)
FetchContent_MakeAvailable(juce)

juce_add_plugin(EngineSimulator
    IS_SYNTH FALSE
    NEEDS_MIDI_INPUT FALSE
    NEEDS_MIDI_OUTPUT FALSE
    IS_MIDI_EFFECT FALSE
    FORMATS VST3 AU Standalone
    PRODUCT_NAME "Engine Simulator Multi-Out"
    PLUGIN_CODE EngS
    PLUGIN_MANUFACTURER_CODE Auth
)

target_compile_features(EngineSimulator PRIVATE cxx_std_20)

target_sources(EngineSimulator PRIVATE
    Source/PluginProcessor.cpp
    Source/PluginProcessor.h
    # Source/PluginEditor.cpp # Optional GUI
    # Source/PluginEditor.h   # Optional GUI
)

target_link_libraries(EngineSimulator PRIVATE
    juce::juce_audio_utils
    juce::juce_audio_processors
    # Recommended: juce_dsp for fast math/filters
    juce::juce_dsp
)
