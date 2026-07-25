#include "public.sdk/source/vst/hosting/module.h"
#include "public.sdk/source/vst/hosting/hostclasses.h"
#include "public.sdk/source/vst/hosting/plugprovider.h"
#include "pluginterfaces/gui/iplugview.h"
#include "pluginterfaces/vst/ivstaudioprocessor.h"
#include "pluginterfaces/vst/ivstcomponent.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"

#include <iostream>
#include <string>
#include <string_view>

namespace {

std::string jsonEscape(std::string_view value)
{
    std::string result;
    result.reserve(value.size() + 8);
    for (const unsigned char character : value)
    {
        switch (character)
        {
            case '"': result += "\\\""; break;
            case '\\': result += "\\\\"; break;
            case '\b': result += "\\b"; break;
            case '\f': result += "\\f"; break;
            case '\n': result += "\\n"; break;
            case '\r': result += "\\r"; break;
            case '\t': result += "\\t"; break;
            default:
                if (character < 0x20)
                {
                    static constexpr char hex[] = "0123456789abcdef";
                    result += "\\u00";
                    result += hex[(character >> 4) & 0x0f];
                    result += hex[character & 0x0f];
                }
                else
                {
                    result += static_cast<char>(character);
                }
        }
    }
    return result;
}

void writeString(std::string_view key, std::string_view value)
{
    std::cout << '"' << key << "\":\"" << jsonEscape(value) << '"';
}

struct Capabilities
{
    bool initialized {false};
    bool sample32 {false};
    bool hasEditor {false};
    int audioInputs {0};
    int audioOutputs {0};
    int eventInputs {0};
    bool stereoMainInput {false};
    bool stereoMainOutput {false};
};

Capabilities inspect(const VST3::Hosting::PluginFactory& factory,
                     const VST3::Hosting::ClassInfo& classInfo)
{
    using namespace Steinberg;
    using namespace Steinberg::Vst;
    Capabilities result;
    PlugProvider provider(factory, classInfo, true);
    result.initialized = provider.initialize();
    if (!result.initialized)
        return result;
    auto component = provider.getComponentPtr();
    auto controller = provider.getControllerPtr();
    auto processor = U::cast<IAudioProcessor>(component);
    if (!component || !processor)
        return result;
    result.sample32 = processor->canProcessSampleSize(kSample32) == kResultTrue;
    result.audioInputs = component->getBusCount(kAudio, kInput);
    result.audioOutputs = component->getBusCount(kAudio, kOutput);
    result.eventInputs = component->getBusCount(kEvent, kInput);
    for (int32 index = 0; index < result.audioInputs; ++index)
    {
        BusInfo info {};
        if (component->getBusInfo(kAudio, kInput, index, info) == kResultTrue &&
            info.busType == kMain && info.channelCount == 2)
            result.stereoMainInput = true;
    }
    for (int32 index = 0; index < result.audioOutputs; ++index)
    {
        BusInfo info {};
        if (component->getBusInfo(kAudio, kOutput, index, info) == kResultTrue &&
            info.busType == kMain && info.channelCount == 2)
            result.stereoMainOutput = true;
    }
    if (controller)
    {
        if (auto view = owned(controller->createView(ViewType::kEditor)))
            result.hasEditor = true;
    }
    return result;
}

} // namespace

int main(int argc, char** argv)
{
    if (argc != 2)
    {
        std::cerr << "usage: yadaw-vst3-probe <module.vst3>\n";
        return 2;
    }

    std::string error;
    auto module = VST3::Hosting::Module::create(argv[1], error);
    if (!module)
    {
        std::cerr << error << '\n';
        return 3;
    }

    const auto& factory = module->getFactory();
    const auto factoryInfo = factory.info();
    Steinberg::Vst::HostApplication host;
    Steinberg::Vst::PluginContextFactory::instance().setPluginContext(&host);
    Steinberg::Vst::PlugProvider::setErrorStream(&std::cerr);
    std::cout << "{\"module\":{";
    writeString("path", module->getPath());
    std::cout << ",\"vendor\":\"" << jsonEscape(factoryInfo.vendor()) << "\",\"classes\":[";
    bool first = true;
    for (const auto& classInfo : factory.classInfos())
    {
        if (classInfo.category() != "Audio Module Class")
            continue;
        if (!first)
            std::cout << ',';
        first = false;
        std::cout << '{';
        writeString("classId", classInfo.ID().toString());
        std::cout << ',';
        writeString("name", classInfo.name());
        std::cout << ',';
        writeString("vendor", classInfo.vendor());
        std::cout << ',';
        writeString("version", classInfo.version());
        std::cout << ',';
        writeString("category", classInfo.subCategoriesString());
        const auto capabilities = inspect(factory, classInfo);
        std::cout << ",\"initialized\":" << (capabilities.initialized ? "true" : "false")
                  << ",\"sample32\":" << (capabilities.sample32 ? "true" : "false")
                  << ",\"hasEditor\":" << (capabilities.hasEditor ? "true" : "false")
                  << ",\"audioInputs\":" << capabilities.audioInputs
                  << ",\"audioOutputs\":" << capabilities.audioOutputs
                  << ",\"eventInputs\":" << capabilities.eventInputs
                  << ",\"stereoMainInput\":"
                  << (capabilities.stereoMainInput ? "true" : "false")
                  << ",\"stereoMainOutput\":"
                  << (capabilities.stereoMainOutput ? "true" : "false");
        std::cout << '}';
    }
    std::cout << "]}}\n";
    return 0;
}
