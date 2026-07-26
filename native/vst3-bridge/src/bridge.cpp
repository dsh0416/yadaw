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
#include "pluginterfaces/gui/iplugview.h"
#include "pluginterfaces/gui/iplugviewcontentscalesupport.h"

#include <algorithm>
#include <array>
#include <atomic>
#include <condition_variable>
#include <cstdio>
#include <cstring>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

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

#if defined(_WIN32)
class NativeEditorWindow;

static tresult safeAttachPlugView(IPlugView* view, HWND window)
{
#if defined(_MSC_VER)
    __try
    {
        return view->attached(window, kPlatformTypeHWND);
    }
    __except (EXCEPTION_EXECUTE_HANDLER)
    {
        return kResultFalse;
    }
#else
    return view->attached(window, kPlatformTypeHWND);
#endif
}

class NativePlugFrame : public IPlugFrame
{
public:
    explicit NativePlugFrame(NativeEditorWindow& owner) : owner(owner) {}
    tresult PLUGIN_API resizeView(IPlugView* view, ViewRect* newSize) override;
    tresult PLUGIN_API queryInterface(const TUID iid, void** object) override
    {
        if (!object)
            return kInvalidArgument;
        *object = nullptr;
        if (FUnknownPrivate::iidEqual(iid, IPlugFrame::iid) ||
            FUnknownPrivate::iidEqual(iid, FUnknown::iid))
        {
            *object = static_cast<IPlugFrame*>(this);
            addRef();
            return kResultTrue;
        }
        return kNoInterface;
    }
    uint32 PLUGIN_API addRef() override { return 1000; }
    uint32 PLUGIN_API release() override { return 1000; }

private:
    NativeEditorWindow& owner;
};

class NativeEditorWindow
{
public:
    explicit NativeEditorWindow(IEditController* controller)
        : controller(controller), frame(*this)
    {
        if (controller)
            controller->addRef();
    }

    ~NativeEditorWindow() { close(); if (controller) controller->release(); }

    bool open()
    {
        if (window)
        {
            ShowWindow(window, SW_RESTORE);
            SetForegroundWindow(window);
            return true;
        }
        return createAndAttach();
    }

    void close()
    {
        detach();
        if (window)
            DestroyWindow(window);
        window = nullptr;
        if (oleInitialized)
        {
            OleUninitialize();
            oleInitialized = false;
        }
    }

    bool isOpen() const { return window != nullptr; }

    void resize(ViewRect rectangle)
    {
        if (!window)
            return;
        RECT bounds {0, 0, rectangle.getWidth(), rectangle.getHeight()};
        AdjustWindowRect(&bounds, WS_OVERLAPPEDWINDOW, FALSE);
        resizing = true;
        SetWindowPos(window, nullptr, 0, 0, bounds.right - bounds.left,
                     bounds.bottom - bounds.top, SWP_NOMOVE | SWP_NOZORDER);
        resizing = false;
    }

private:
    static LRESULT CALLBACK windowProc(HWND window, UINT message, WPARAM wparam, LPARAM lparam)
    {
        auto* editor = reinterpret_cast<NativeEditorWindow*>(
            GetWindowLongPtrW(window, GWLP_USERDATA));
        if (!editor)
            return DefWindowProcW(window, message, wparam, lparam);
        switch (message)
        {
            case WM_SIZE:
                if (editor->view && !editor->resizing)
                {
                    RECT client {};
                    GetClientRect(window, &client);
                    ViewRect size {0, 0, client.right, client.bottom};
                    editor->view->onSize(&size);
                }
                return 0;
            case WM_CLOSE:
                editor->detach();
                DestroyWindow(window);
                return 0;
            case WM_DESTROY:
                editor->window = nullptr;
                return 0;
            default:
                return DefWindowProcW(window, message, wparam, lparam);
        }
    }

    bool createAndAttach()
    {
        const auto oleResult = OleInitialize(nullptr);
        oleInitialized = SUCCEEDED(oleResult);
        const wchar_t* className = L"YadawVst3EditorWindow";
        WNDCLASSW windowClass {};
        windowClass.lpfnWndProc = windowProc;
        windowClass.hInstance = GetModuleHandleW(nullptr);
        windowClass.lpszClassName = className;
        windowClass.hCursor = LoadCursor(nullptr, IDC_ARROW);
        RegisterClassW(&windowClass);

        view = owned(controller ? controller->createView(ViewType::kEditor) : nullptr);
        ViewRect size {};
        if (!view || view->getSize(&size) != kResultTrue)
        {
            view = nullptr;
            if (oleInitialized)
            {
                OleUninitialize();
                oleInitialized = false;
            }
            return false;
        }
        const DWORD windowStyle =
            WS_CAPTION | WS_SYSMENU | WS_CLIPCHILDREN | WS_CLIPSIBLINGS |
            (view->canResize() == kResultTrue ? WS_SIZEBOX | WS_MAXIMIZEBOX : 0);
        RECT bounds {0, 0, size.getWidth(), size.getHeight()};
        AdjustWindowRectEx(&bounds, windowStyle, FALSE, WS_EX_APPWINDOW);
        window = CreateWindowExW(
            WS_EX_APPWINDOW, className, L"YADAW VST3", windowStyle,
            CW_USEDEFAULT, CW_USEDEFAULT, bounds.right - bounds.left, bounds.bottom - bounds.top,
            nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
        if (window)
            SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(this));
        if (!window || view->isPlatformTypeSupported(kPlatformTypeHWND) != kResultTrue)
        {
            if (window)
                DestroyWindow(window);
            window = nullptr;
            view = nullptr;
            if (oleInitialized)
            {
                OleUninitialize();
                oleInitialized = false;
            }
            return false;
        }
        if (auto scaleSupport = U::cast<IPlugViewContentScaleSupport>(view))
        {
            const auto dpi = GetDpiForWindow(window);
            scaleSupport->setContentScaleFactor(
                static_cast<float>(dpi) / static_cast<float>(USER_DEFAULT_SCREEN_DPI));
        }
        const auto frameResult = window ? view->setFrame(&frame) : kResultFalse;
        const auto attachResult = window && frameResult == kResultTrue
            ? safeAttachPlugView(view, window) : kResultFalse;
        if (!window || frameResult != kResultTrue || attachResult != kResultTrue)
        {
            if (window)
                DestroyWindow(window);
            window = nullptr;
            view = nullptr;
            if (oleInitialized)
            {
                OleUninitialize();
                oleInitialized = false;
            }
            return false;
        }
        ShowWindow(window, SW_SHOW);
        return true;
    }

    void detach()
    {
        if (view)
        {
            view->removed();
            view->setFrame(nullptr);
            view = nullptr;
        }
    }

    IEditController* controller {nullptr};
    IPtr<IPlugView> view;
    NativePlugFrame frame;
    HWND window {nullptr};
    bool oleInitialized {false};
    bool resizing {false};

    friend class NativePlugFrame;
};

tresult PLUGIN_API NativePlugFrame::resizeView(IPlugView* view, ViewRect* newSize)
{
    if (!view || !newSize)
        return kInvalidArgument;
    owner.resize(*newSize);
    return kResultTrue;
}

static int32_t safeOpenNativeEditor(NativeEditorWindow* editor)
{
#if defined(_MSC_VER)
    __try
    {
        return editor && editor->open() ? 1 : 0;
    }
    __except (EXCEPTION_EXECUTE_HANDLER)
    {
        return 0;
    }
#else
    return editor && editor->open() ? 1 : 0;
#endif
}

static void safeCloseNativeEditor(std::unique_ptr<NativeEditorWindow>& editor)
{
#if defined(_MSC_VER)
    __try
    {
        editor.reset();
    }
    __except (EXCEPTION_EXECUTE_HANDLER)
    {
        editor.release();
    }
#else
    editor.reset();
#endif
}
#endif

struct YadawVst3Instance;

struct QueuedParameter
{
    ParamID id {0};
    ParamValue value {0.0};
    int32 sampleOffset {0};
};

class RealtimeParameterQueue
{
public:
    bool push(QueuedParameter value)
    {
        std::lock_guard<std::mutex> lock(producerMutex);
        const auto write = writeIndex.load(std::memory_order_relaxed);
        if (write - readIndex.load(std::memory_order_acquire) >= values.size())
            return false;
        values[write % values.size()] = value;
        writeIndex.store(write + 1, std::memory_order_release);
        return true;
    }

    bool pop(QueuedParameter& value)
    {
        const auto read = readIndex.load(std::memory_order_relaxed);
        if (read == writeIndex.load(std::memory_order_acquire))
            return false;
        value = values[read % values.size()];
        readIndex.store(read + 1, std::memory_order_release);
        return true;
    }

private:
    std::array<QueuedParameter, 1024> values {};
    std::atomic<uint64_t> writeIndex {0};
    std::atomic<uint64_t> readIndex {0};
    std::mutex producerMutex;
};

class YadawComponentHandler : public IComponentHandler
{
public:
    explicit YadawComponentHandler(YadawVst3Instance& instance) : instance(instance) {}
    tresult PLUGIN_API beginEdit(ParamID id) override;
    tresult PLUGIN_API performEdit(ParamID id, ParamValue valueNormalized) override;
    tresult PLUGIN_API endEdit(ParamID id) override;
    tresult PLUGIN_API restartComponent(int32 flags) override;
    tresult PLUGIN_API queryInterface(const TUID iid, void** object) override
    {
        if (!object)
            return kInvalidArgument;
        *object = nullptr;
        if (FUnknownPrivate::iidEqual(iid, IComponentHandler::iid) ||
            FUnknownPrivate::iidEqual(iid, FUnknown::iid))
        {
            *object = static_cast<IComponentHandler*>(this);
            addRef();
            return kResultTrue;
        }
        return kNoInterface;
    }
    uint32 PLUGIN_API addRef() override { return 1000; }
    uint32 PLUGIN_API release() override { return 1000; }

private:
    YadawVst3Instance& instance;
};

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
    RealtimeParameterQueue realtimeParameters;
    std::unique_ptr<YadawComponentHandler> componentHandler;
    std::atomic<bool> latencyChanged {false};
#if defined(_WIN32)
    std::unique_ptr<NativeEditorWindow> editor;
#endif

    ~YadawVst3Instance()
    {
#if defined(_WIN32)
        editor.reset();
#endif
        if (controller)
            controller->setComponentHandler(nullptr);
        componentHandler.reset();
        if (processor && processing)
            processor->setProcessing(false);
        if (component)
            component->setActive(false);
        processData.unprepare();
    }
};

tresult PLUGIN_API YadawComponentHandler::beginEdit(ParamID)
{
    return kResultTrue;
}

tresult PLUGIN_API YadawComponentHandler::performEdit(ParamID id, ParamValue valueNormalized)
{
    return instance.realtimeParameters.push({id, valueNormalized, 0})
        ? kResultTrue : kResultFalse;
}

tresult PLUGIN_API YadawComponentHandler::endEdit(ParamID)
{
    return kResultTrue;
}

tresult PLUGIN_API YadawComponentHandler::restartComponent(int32 flags)
{
    if (flags & kLatencyChanged)
        instance.latencyChanged.store(true, std::memory_order_release);
    return kResultTrue;
}

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
    if (instance->controller)
    {
        instance->componentHandler = std::make_unique<YadawComponentHandler>(*instance);
        instance->controller->setComponentHandler(instance->componentHandler.get());
    }
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
    QueuedParameter parameter {};
    while (instance->realtimeParameters.pop(parameter))
    {
        int32 queueIndex = 0;
        auto* queue =
            instance->inputParameterChanges.addParameterData(parameter.id, queueIndex);
        int32 pointIndex = 0;
        if (queue)
            queue->addPoint(parameter.sampleOffset, parameter.value, pointIndex);
    }
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
    if (!instance->realtimeParameters.push(
            {parameterId, normalizedValue, static_cast<int32>(sampleOffset)}))
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

int32_t yadaw_vst3_consume_latency_changed(YadawVst3Instance* instance)
{
    return instance && instance->latencyChanged.exchange(false, std::memory_order_acq_rel)
        ? 1 : 0;
}

int32_t yadaw_vst3_open_editor(YadawVst3Instance* instance)
{
#if defined(_WIN32)
    if (!instance || !instance->controller)
        return 0;
    if (!instance->editor)
        instance->editor = std::make_unique<NativeEditorWindow>(instance->controller);
    return safeOpenNativeEditor(instance->editor.get());
#else
    (void)instance;
    return 0;
#endif
}

void yadaw_vst3_close_editor(YadawVst3Instance* instance)
{
#if defined(_WIN32)
    if (instance)
        safeCloseNativeEditor(instance->editor);
#else
    (void)instance;
#endif
}

int32_t yadaw_vst3_editor_open(const YadawVst3Instance* instance)
{
#if defined(_WIN32)
    return instance && instance->editor && instance->editor->isOpen() ? 1 : 0;
#else
    (void)instance;
    return 0;
#endif
}

void yadaw_vst3_pump_editor_events()
{
#if defined(_WIN32)
    MSG message {};
    while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE))
    {
        TranslateMessage(&message);
        DispatchMessageW(&message);
    }
#endif
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
