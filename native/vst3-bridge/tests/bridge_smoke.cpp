#include "yadaw_vst3_bridge.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <iostream>
#include <string>

namespace {

constexpr uint32_t kFrames = 512;

YadawVst3Instance* create(const char* path, const char* classId)
{
    std::array<char, 1024> error {};
    auto* instance = yadaw_vst3_create(path, classId, 48000.0, 4096, error.data(), error.size());
    if (!instance)
        std::cerr << error.data() << '\n';
    return instance;
}

double energy(const std::array<float, kFrames>& left, const std::array<float, kFrames>& right)
{
    double result = 0.0;
    for (uint32_t index = 0; index < kFrames; ++index)
        result += std::abs(left[index]) + std::abs(right[index]);
    return result;
}

YadawVst3ProcessContext context()
{
    return {
        0,
        0,
        0.0,
        0.0,
        120.0,
        4,
        4,
        1,
        0
    };
}

} // namespace

int main(int argc, char** argv)
{
    if (argc != 3)
    {
        std::cerr << "usage: yadaw-vst3-smoke <again.vst3> <note-expression-synth.vst3>\n";
        return 2;
    }
    auto* effect = create(argv[1], "84E8DE5F92554F5396FAE4133C935A18");
    if (!effect)
        return 3;
    std::array<float, kFrames> inputLeft;
    std::array<float, kFrames> inputRight;
    std::array<float, kFrames> outputLeft {};
    std::array<float, kFrames> outputRight {};
    inputLeft.fill(0.25f);
    inputRight.fill(-0.25f);
    const auto processContext = context();
    const auto effectProcessed = yadaw_vst3_process_stereo(
        effect,
        inputLeft.data(),
        inputRight.data(),
        outputLeft.data(),
        outputRight.data(),
        kFrames,
        &processContext);
    const auto effectEnergy = energy(outputLeft, outputRight);
    const auto effectParameters = yadaw_vst3_parameter_count(effect);
    const auto effectState = yadaw_vst3_component_state_size(effect);
    yadaw_vst3_destroy(effect);
    if (!effectProcessed || effectEnergy <= 0.0 || effectParameters == 0 || effectState == 0)
    {
        std::cerr << "AGain processing/state smoke test failed\n";
        return 4;
    }

    auto* instrument = create(argv[2], "41466D9BB0654576B641098F686371B3");
    if (!instrument)
        return 5;
    outputLeft.fill(0.f);
    outputRight.fill(0.f);
    if (!yadaw_vst3_note_on(instrument, 0, 0, 60, 0.8f, 1, 0))
        return 6;
    const auto instrumentProcessed = yadaw_vst3_process_stereo(
        instrument,
        nullptr,
        nullptr,
        outputLeft.data(),
        outputRight.data(),
        kFrames,
        &processContext);
    const auto instrumentEnergy = energy(outputLeft, outputRight);
    yadaw_vst3_note_off(instrument, 0, 0, 60, 0.f, 1, 0);
    yadaw_vst3_destroy(instrument);
    if (!instrumentProcessed || instrumentEnergy <= 0.0)
    {
        std::cerr << "NoteExpressionSynth event processing smoke test failed\n";
        return 7;
    }
    std::cout << "VST3 effect and instrument block processing passed\n";
    return 0;
}
