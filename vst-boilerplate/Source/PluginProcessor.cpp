#include "PluginProcessor.h"

// ==============================================================================
// 1. Különálló sztereó kimenetek (Multi-Out Buszok) inicializálása
// ==============================================================================
EngineSimulatorAudioProcessor::EngineSimulatorAudioProcessor()
     : AudioProcessor (BusesProperties()
                       .withOutput ("Tailpipe",    juce::AudioChannelSet::stereo(), true)
                       .withOutput ("Pops",        juce::AudioChannelSet::stereo(), true)
                       .withOutput ("EngineBlock", juce::AudioChannelSet::stereo(), true)
                       .withOutput ("Intake",      juce::AudioChannelSet::stereo(), true)
                       .withOutput ("Turbo",       juce::AudioChannelSet::stereo(), true)
                       ),
       apvts(*this, nullptr, "Parameters", createParameterLayout())
{
}

EngineSimulatorAudioProcessor::~EngineSimulatorAudioProcessor() {}

// ==============================================================================
// 2. Automatikus Ableton Paraméterek (Enveloper / Macros mappolás)
// ==============================================================================
juce::AudioProcessorValueTreeState::ParameterLayout EngineSimulatorAudioProcessor::createParameterLayout()
{
    std::vector<std::unique_ptr<juce::RangedAudioParameter>> params;

    // RPM & Throttle Control (Easily map to Ableton Envelopes)
    params.push_back(std::make_unique<juce::AudioParameterFloat>("rpm", "Engine RPM", 0.0f, 20000.0f, 1000.0f));
    params.push_back(std::make_unique<juce::AudioParameterFloat>("throttle", "Throttle", 0.0f, 1.0f, 0.0f));
    params.push_back(std::make_unique<juce::AudioParameterFloat>("load", "Engine Load", 0.0f, 1.0f, 0.0f));
    
    // Turbo settings
    params.push_back(std::make_unique<juce::AudioParameterChoice>("turbotype", "Turbo Type", juce::StringArray{"NA", "Small", "Big", "Twin"}, 0));
    
    // Mixers (0.0 to 1.0)
    params.push_back(std::make_unique<juce::AudioParameterFloat>("vol_tailpipe", "Tailpipe Vol", 0.0f, 1.0f, 1.0f));
    params.push_back(std::make_unique<juce::AudioParameterFloat>("vol_pops", "Pops Vol", 0.0f, 1.0f, 1.0f));
    params.push_back(std::make_unique<juce::AudioParameterFloat>("vol_mech", "Mech Vol", 0.0f, 1.0f, 1.0f));
    params.push_back(std::make_unique<juce::AudioParameterFloat>("vol_intake", "Intake Vol", 0.0f, 1.0f, 1.0f));
    params.push_back(std::make_unique<juce::AudioParameterFloat>("vol_turbo", "Turbo Vol", 0.0f, 1.0f, 1.0f));

    return { params.begin(), params.end() };
}

void EngineSimulatorAudioProcessor::prepareToPlay (double sampleRate, int samplesPerBlock)
{
    currentSampleRate = sampleRate;
    // Itt inicializálhatjuk a DelayLine-okat, Filtereket a Sample Rate alapján
    // Ezeket a JS Constructorból vesszük át (this.sr = sampleRate)
}

void EngineSimulatorAudioProcessor::releaseResources() {}

// ==============================================================================
// 3. Valós idejű Audio Ciklus (Az AudioWorklet 'process' funkciója ide kerül)
// ==============================================================================
void EngineSimulatorAudioProcessor::processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midiMessages)
{
    juce::ScopedNoDenormals noDenormals;

    // Buffer törlése biztonsági okokból
    for (int i = 0; i < buffer.getNumChannels(); ++i) {
        buffer.clear (i, 0, buffer.getNumSamples());
    }

    // Aktuális Ableton paraméterek lekérése
        float rpm = apvts.getRawParameterValue("rpm")->load();
        float throttle = apvts.getRawParameterValue("throttle")->load();
        // turboType, vol_x stb beolvasása...
        
        // Teszt oszcillátor, hogy ellenőrizd a hangot Abletonban:
        // A frekvencia az RPM függvénye (pl. 1000 RPM -> ~33 Hz alaphang)
        float targetFreq = std::max(20.0f, rpm / 30.0f); 
        // Simítás (Low-pass)
        testFreq = testFreq * 0.999f + targetFreq * 0.001f;

        // Fázis léptetése
        float phaseIncrement = (testFreq * 2.0f * juce::MathConstants<float>::pi) / currentSampleRate;

        // Kimeneti buszok beállítása (10 csatorna = 5 sztereó sáv)
        auto* tailpipeL = buffer.getWritePointer(0);
        auto* tailpipeR = buffer.getWritePointer(1);
        auto* popsL     = buffer.getWritePointer(2);
        auto* popsR     = buffer.getWritePointer(3);
        auto* engineL   = buffer.getWritePointer(4);
        auto* engineR   = buffer.getWritePointer(5);
        auto* intakeL   = buffer.getWritePointer(6);
        auto* intakeR   = buffer.getWritePointer(7);
        auto* turboL    = buffer.getWritePointer(8);
        auto* turboR    = buffer.getWritePointer(9);

        // Csatornák hangerejének kiolvasása a potikból
        float volTail = apvts.getRawParameterValue("vol_tailpipe")->load();

        for (int sample = 0; sample < buffer.getNumSamples(); ++sample)
        {
            testPhase += phaseIncrement;
            if (testPhase >= 2.0f * juce::MathConstants<float>::pi)
                testPhase -= 2.0f * juce::MathConstants<float>::pi;

            // Generálunk egy teszt hangot, ami egy pici torzított szinuszhullám
            float testSound = std::tanh(std::sin(testPhase) * 2.0f) * 0.2f * volTail;

            // --------------------------------------------------------------------------
            // IDE JÖN MAJD A VALÓDI DSP LOGIKA a phase8Worklet.ts-ből
            // --------------------------------------------------------------------------
            
            // Fő kimenetre rárakjuk a teszt hangot, a többire csendet (későbbre)
            float rawExhaustL = testSound; 
            float rawExhaustR = testSound;
        float rawPops = 0.0f;
        float rawMech = 0.0f;
        float rawIntake = 0.0f;
        float rawTurbo = 0.0f;

        // Csatornák írása
        tailpipeL[sample] = rawExhaustL;
        tailpipeR[sample] = rawExhaustR;
        
        popsL[sample] = rawPops;
        popsR[sample] = rawPops;

        engineL[sample] = rawMech;
        engineR[sample] = rawMech;

        intakeL[sample] = rawIntake;
        intakeR[sample] = rawIntake;

        turboL[sample] = rawTurbo;
        turboR[sample] = rawTurbo;
    }
}

// ==============================================================================
// Állapot mentés/töltés (Ableton Project mentésekor ez menti el a paramétereket)
// ==============================================================================
void EngineSimulatorAudioProcessor::getStateInformation (juce::MemoryBlock& destData)
{
    auto state = apvts.copyState();
    std::unique_ptr<juce::XmlElement> xml (state.createXml());
    copyXmlToBinary (*xml, destData);
}

void EngineSimulatorAudioProcessor::setStateInformation (const void* data, int sizeInBytes)
{
    std::unique_ptr<juce::XmlElement> xmlState (getXmlFromBinary (data, sizeInBytes));
    if (xmlState != nullptr) {
        if (xmlState->hasTagName (apvts.state.getType())) {
            apvts.replaceState (juce::ValueTree::fromXml (*xmlState));
        }
    }
}

// Setup hook
juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter()
{
    return new EngineSimulatorAudioProcessor();
}
