#pragma once

#include <JuceHeader.h>

class EngineSimulatorAudioProcessor : public juce::AudioProcessor
{
public:
    EngineSimulatorAudioProcessor();
    ~EngineSimulatorAudioProcessor() override;

    void prepareToPlay (double sampleRate, int samplesPerBlock) override;
    void releaseResources() override;
    void processBlock (juce::AudioBuffer<float>&, juce::MidiBuffer&) override;

    juce::AudioProcessorEditor* createEditor() override { return new juce::GenericAudioProcessorEditor(*this); } // Auto-generated GUI based on Parameters
    bool hasEditor() const override { return true; }

    const juce::String getName() const override { return "Engine Sim"; }

    bool acceptsMidi() const override { return false; }
    bool producesMidi() const override { return false; }
    bool isMidiEffect() const override { return false; }
    double getTailLengthSeconds() const override { return 0.0; }

    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram (int index) override {}
    const juce::String getProgramName (int index) override { return {}; }
    void changeProgramName (int index, const juce::String& newName) override {}

    void getStateInformation (juce::MemoryBlock& destData) override;
    void setStateInformation (const void* data, int sizeInBytes) override;

    // Ableton Automation Parameters
    juce::AudioProcessorValueTreeState apvts;

private:
    juce::AudioProcessorValueTreeState::ParameterLayout createParameterLayout();

    // DSP State Variables (Translate these from phase8Worklet.ts)
    double currentSampleRate = 44100.0;
    float crankAngle = 0.0f;
    float currentOutputRpm = 1000.0f;
    
    // Teszt oszcillátor változók
    float testFreq = 33.3f;
    float testPhase = 0.0f;
    
    // Example state buffers for translation
    // std::vector<float> delayLineBuffer;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (EngineSimulatorAudioProcessor)
};
