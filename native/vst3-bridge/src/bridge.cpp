#include "yadaw_vst3_bridge.h"

#include "public.sdk/source/common/memorystream.h"
#include "public.sdk/source/vst/hosting/eventlist.h"
#include "public.sdk/source/vst/hosting/hostclasses.h"
#include "public.sdk/source/vst/hosting/module.h"
#include "public.sdk/source/vst/hosting/parameterchanges.h"
#include "public.sdk/source/vst/hosting/plugprovider.h"
#include "public.sdk/source/vst/hosting/processdata.h"
#include "public.sdk/source/vst/utility/stringconvert.h"
#include "pluginterfaces/vst/ivstaudioprocessor.h"
#include "pluginterfaces/vst/ivstcomponent.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"

#include <algorithm>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

using namespace Steinberg;
using namespace Steinberg::Vst;

namespace {

HostApplication gHostApplication;

void writeError(const std::string& message, char* destination, size_t capacity)
{
    if (!destination || capacity == 0)
        return;
    const auto count = std::min(capacity - 1, message.size());
    std::memcpy(destination, message.data(), count);
    destination[count] = '\0';
}

void copyText(const String128 source, char* destination, size_t capacity)
{
    if (!destination || capacity == 0)
        return;
    const auto text = StringConvert::convert(source, 128);
    const auto count = std::min(capacity - 1, text.size());
    std::memcpy(destination, text.data(), count);
    destination[count] = '\0';
}

std::vector<uint8_t> streamBytes(MemoryStream& stream)
{
    const auto size = static_cast<size_t>(stream.getSize());
    const auto* data = reinterpret_cast<const uint8_t*>(stream.getData());
    return data && size ? std::vector<uint8_t>(data, data + size) : std::vector<uint8_t>{};
}

} // namespace

struct YadawVst3Instance
{
    VST3::Hosting::Module::Ptr module;
    std::unique_ptr<PlugProvider> provider;
    IPtr<IComponent> component;
    IPtr<IAudioProcessor> processor;
    IPtr<IEditController> controller;
    HostProcessData processData;
    EventList inputEvents;
    ParameterChanges inputParameterChanges;
    ParameterChanges outputParameterChanges;
    ProcessContext processContext {};
    uint32_t maximumBlockFrames {0};
    bool processing {false};
    std::vector<uint8_t> componentStateCache;
    std::vector<uint8_t> controllerStateCache;

    ~YadawVst3Instance()
    {
        if (processor && processing)
            processor->setProcessing(false);
        if (component)
            component->setActive(false);
        processData.unprepare();
    }
};

YadawVst3Instance* yadaw_vst3_create(
    const char* modulePath,
    const char* classId,
    double sampleRate,
    uint32_t maximumBlockFrames,
    char* errorMessage,
    size_t errorCapacity)
{
    if (!modulePath || !classId || sampleRate <= 0.0 || maximumBlockFrames == 0 ||
        maximumBlockFrames > 4096)
    {
        writeError("invalid VST3 instance configuration", errorMessage, errorCapacity);
        return nullptr;
    }

    auto instance = std::make_unique<YadawVst3Instance>();
    std::string moduleError;
    instance->module = VST3::Hosting::Module::create(modulePath, moduleError);
    if (!instance->module)
    {
        writeError(moduleError, errorMessage, errorCapacity);
        return nullptr;
    }

    PluginContextFactory::instance().setPluginContext(&gHostApplication);
    const auto& factory = instance->module->getFactory();
    for (const auto& info : factory.classInfos())
    {
        if (info.category() == kVstAudioEffectClass && info.ID().toString() == classId)
        {
            instance->provider = std::make_unique<PlugProvider>(factory, info, true);
            break;
        }
    }
    if (!instance->provider || !instance->provider->initialize())
    {
        writeError("VST3 class could not be initialized", errorMessage, errorCapacity);
        return nullptr;
    }

    instance->component = instance->provider->getComponentPtr();
    instance->controller = instance->provider->getControllerPtr();
    instance->processor = U::cast<IAudioProcessor>(instance->component);
    if (!instance->component || !instance->processor ||
        instance->processor->canProcessSampleSize(kSample32) != kResultTrue)
    {
        writeError("VST3 class does not support sample32 processing", errorMessage, errorCapacity);
        return nullptr;
    }

    for (int32 index = 0; index < instance->component->getBusCount(kAudio, kInput); ++index)
        instance->component->activateBus(kAudio, kInput, index, true);
    for (int32 index = 0; index < instance->component->getBusCount(kAudio, kOutput); ++index)
        instance->component->activateBus(kAudio, kOutput, index, true);
    for (int32 index = 0; index < instance->component->getBusCount(kEvent, kInput); ++index)
        instance->component->activateBus(kEvent, kInput, index, true);

    ProcessSetup setup {
        kRealtime,
        kSample32,
        static_cast<int32>(maximumBlockFrames),
        sampleRate
    };
    if (instance->processor->setupProcessing(setup) != kResultOk)
    {
        writeError("VST3 setupProcessing failed", errorMessage, errorCapacity);
        return nullptr;
    }
    if (!instance->processData.prepare(*instance->component, 0, kSample32))
    {
        writeError("VST3 process buffer preparation failed", errorMessage, errorCapacity);
        return nullptr;
    }
    if (instance->component->setActive(true) != kResultOk)
    {
        writeError("VST3 component activation failed", errorMessage, errorCapacity);
        return nullptr;
    }
    // A small number of otherwise conforming plug-ins return kResultFalse from
    // setProcessing while still transitioning successfully. Steinberg's own
    // AudioHost sample deliberately treats this notification as best effort.
    instance->processor->setProcessing(true);

    instance->maximumBlockFrames = maximumBlockFrames;
    instance->processing = true;
    instance->processData.inputEvents = &instance->inputEvents;
    instance->processData.inputParameterChanges = &instance->inputParameterChanges;
    instance->processData.outputParameterChanges = &instance->outputParameterChanges;
    instance->processData.processContext = &instance->processContext;
    instance->processContext.sampleRate = sampleRate;
    return instance.release();
}

void yadaw_vst3_destroy(YadawVst3Instance* instance)
{
    delete instance;
}

int32_t yadaw_vst3_process_stereo(
    YadawVst3Instance* instance,
    const float* inputLeft,
    const float* inputRight,
    float* outputLeft,
    float* outputRight,
    uint32_t frameCount,
    const YadawVst3ProcessContext* context)
{
    if (!instance || !instance->processing || !outputLeft || !outputRight ||
        frameCount > instance->maximumBlockFrames)
        return 0;

    auto& processContext = instance->processContext;
    processContext.state =
        ProcessContext::kContTimeValid |
        ProcessContext::kProjectTimeMusicValid |
        ProcessContext::kBarPositionValid |
        ProcessContext::kTempoValid |
        ProcessContext::kTimeSigValid;
    if (context)
    {
        if (context->playing)
            processContext.state |= ProcessContext::kPlaying;
        if (context->recording)
            processContext.state |= ProcessContext::kRecording;
        processContext.projectTimeSamples = context->project_time_samples;
        processContext.continousTimeSamples = context->continuous_time_samples;
        processContext.projectTimeMusic = context->project_time_quarters;
        processContext.barPositionMusic = context->bar_position_quarters;
        processContext.tempo = context->tempo;
        processContext.timeSigNumerator = context->time_signature_numerator;
        processContext.timeSigDenominator = context->time_signature_denominator;
    }
    instance->processData.numSamples = static_cast<int32>(frameCount);
    Sample32* inputs[] = {const_cast<Sample32*>(inputLeft), const_cast<Sample32*>(inputRight)};
    Sample32* outputs[] = {outputLeft, outputRight};
    if (instance->processData.numInputs > 0)
    {
        if (!inputLeft || !inputRight ||
            !instance->processData.setChannelBuffers(kInput, 0, inputs, 2))
            return 0;
    }
    if (instance->processData.numOutputs < 1 ||
        !instance->processData.setChannelBuffers(kOutput, 0, outputs, 2))
        return 0;
    const auto result = instance->processor->process(instance->processData) == kResultOk;
    instance->inputEvents.clear();
    instance->inputParameterChanges.clearQueue();
    instance->outputParameterChanges.clearQueue();
    return result ? 1 : 0;
}

int32_t yadaw_vst3_note_on(
    YadawVst3Instance* instance,
    int16_t busIndex,
    int16_t channel,
    int16_t key,
    float velocity,
    int32_t noteId,
    int32_t sampleOffset)
{
    if (!instance || busIndex < 0 || channel < 0 || channel > 15 ||
        key < 0 || key > 127 || velocity < 0.f || velocity > 1.f ||
        sampleOffset < 0 || static_cast<uint32_t>(sampleOffset) > instance->maximumBlockFrames)
        return 0;
    Event event {};
    event.busIndex = busIndex;
    event.sampleOffset = sampleOffset;
    event.type = Event::kNoteOnEvent;
    event.noteOn.channel = channel;
    event.noteOn.pitch = key;
    event.noteOn.tuning = 0.f;
    event.noteOn.velocity = velocity;
    event.noteOn.length = 0;
    event.noteOn.noteId = noteId;
    return instance->inputEvents.addEvent(event) == kResultOk ? 1 : 0;
}

int32_t yadaw_vst3_note_off(
    YadawVst3Instance* instance,
    int16_t busIndex,
    int16_t channel,
    int16_t key,
    float velocity,
    int32_t noteId,
    int32_t sampleOffset)
{
    if (!instance || busIndex < 0 || channel < 0 || channel > 15 ||
        key < 0 || key > 127 || velocity < 0.f || velocity > 1.f ||
        sampleOffset < 0 || static_cast<uint32_t>(sampleOffset) > instance->maximumBlockFrames)
        return 0;
    Event event {};
    event.busIndex = busIndex;
    event.sampleOffset = sampleOffset;
    event.type = Event::kNoteOffEvent;
    event.noteOff.channel = channel;
    event.noteOff.pitch = key;
    event.noteOff.tuning = 0.f;
    event.noteOff.velocity = velocity;
    event.noteOff.noteId = noteId;
    return instance->inputEvents.addEvent(event) == kResultOk ? 1 : 0;
}

int32_t yadaw_vst3_flush_parameters(YadawVst3Instance* instance)
{
    if (!instance)
        return 0;
    instance->processData.numSamples = 0;
    const auto result = instance->processor->process(instance->processData) == kResultOk;
    instance->inputParameterChanges.clearQueue();
    instance->outputParameterChanges.clearQueue();
    return result ? 1 : 0;
}

int32_t yadaw_vst3_set_parameter(
    YadawVst3Instance* instance,
    uint32_t parameterId,
    double normalizedValue,
    uint32_t sampleOffset)
{
    if (!instance || normalizedValue < 0.0 || normalizedValue > 1.0 ||
        sampleOffset > instance->maximumBlockFrames)
        return 0;
    int32 queueIndex = 0;
    auto* queue = instance->inputParameterChanges.addParameterData(parameterId, queueIndex);
    int32 pointIndex = 0;
    if (!queue ||
        queue->addPoint(static_cast<int32>(sampleOffset), normalizedValue, pointIndex) != kResultOk)
        return 0;
    if (instance->controller)
        instance->controller->setParamNormalized(parameterId, normalizedValue);
    return 1;
}

uint32_t yadaw_vst3_parameter_count(const YadawVst3Instance* instance)
{
    return instance && instance->controller
        ? static_cast<uint32_t>(instance->controller->getParameterCount())
        : 0;
}

int32_t yadaw_vst3_parameter_info(
    const YadawVst3Instance* instance,
    uint32_t index,
    YadawVst3ParameterInfo* result)
{
    if (!instance || !instance->controller || !result)
        return 0;
    ParameterInfo info {};
    if (instance->controller->getParameterInfo(static_cast<int32>(index), info) != kResultOk)
        return 0;
    *result = {};
    result->id = info.id;
    result->default_normalized = info.defaultNormalizedValue;
    result->normalized = instance->controller->getParamNormalized(info.id);
    result->step_count = info.stepCount;
    result->flags = info.flags;
    copyText(info.title, result->title, sizeof(result->title));
    copyText(info.units, result->units, sizeof(result->units));
    return 1;
}

uint32_t yadaw_vst3_latency_samples(const YadawVst3Instance* instance)
{
    return instance && instance->processor ? instance->processor->getLatencySamples() : 0;
}

uint32_t yadaw_vst3_tail_samples(const YadawVst3Instance* instance)
{
    return instance && instance->processor ? instance->processor->getTailSamples() : 0;
}

size_t yadaw_vst3_component_state_size(YadawVst3Instance* instance)
{
    if (!instance || !instance->component)
        return 0;
    MemoryStream stream;
    if (instance->component->getState(&stream) != kResultOk)
        return 0;
    instance->componentStateCache = streamBytes(stream);
    return instance->componentStateCache.size();
}

size_t yadaw_vst3_controller_state_size(YadawVst3Instance* instance)
{
    if (!instance || !instance->controller)
        return 0;
    MemoryStream stream;
    if (instance->controller->getState(&stream) != kResultOk)
        return 0;
    instance->controllerStateCache = streamBytes(stream);
    return instance->controllerStateCache.size();
}

size_t yadaw_vst3_copy_component_state(
    YadawVst3Instance* instance,
    uint8_t* destination,
    size_t capacity)
{
    if (!instance || !destination || capacity < instance->componentStateCache.size())
        return 0;
    std::memcpy(destination, instance->componentStateCache.data(),
                instance->componentStateCache.size());
    return instance->componentStateCache.size();
}

size_t yadaw_vst3_copy_controller_state(
    YadawVst3Instance* instance,
    uint8_t* destination,
    size_t capacity)
{
    if (!instance || !destination || capacity < instance->controllerStateCache.size())
        return 0;
    std::memcpy(destination, instance->controllerStateCache.data(),
                instance->controllerStateCache.size());
    return instance->controllerStateCache.size();
}

int32_t yadaw_vst3_restore_state(
    YadawVst3Instance* instance,
    const uint8_t* componentState,
    size_t componentSize,
    const uint8_t* controllerState,
    size_t controllerSize)
{
    if (!instance || (!componentState && componentSize) || (!controllerState && controllerSize))
        return 0;
    MemoryStream componentStream(const_cast<uint8_t*>(componentState), componentSize);
    if (instance->component->setState(&componentStream) != kResultOk)
        return 0;
    if (instance->controller)
    {
        componentStream.seek(0, IBStream::kIBSeekSet, nullptr);
        if (instance->controller->setComponentState(&componentStream) != kResultOk)
            return 0;
        if (controllerSize)
        {
            MemoryStream controllerStream(const_cast<uint8_t*>(controllerState), controllerSize);
            if (instance->controller->setState(&controllerStream) != kResultOk)
                return 0;
        }
    }
    return 1;
}
