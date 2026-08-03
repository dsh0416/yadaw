#include "ara_bridge.hpp"

#include <algorithm>
#include <cstring>

#include "ARAVST3.h"

DEF_CLASS_IID(ARA::IMainFactory)
DEF_CLASS_IID(ARA::IPlugInEntryPoint)
DEF_CLASS_IID(ARA::IPlugInEntryPoint2)

namespace
{
template <std::size_t Size>
void copy_text(char (&destination)[Size], const char* source)
{
    destination[0] = '\0';
    if (!source)
        return;
    const auto count = std::min(Size - 1, std::strlen(source));
    std::memcpy(destination, source, count);
    destination[count] = '\0';
}
} // namespace

struct HeronAraMainFactory
{
    ARA::IMainFactory* interface {};
    const ARA::ARAFactory* factory {};
};

struct HeronAraPluginEntry
{
    ARA::IPlugInEntryPoint* entry {};
    ARA::IPlugInEntryPoint2* entry2 {};
    bool bound {};
};

extern "C" std::int32_t heron_ara_query_factory(
    Steinberg::IPluginFactory* plugin_factory,
    const char factory_class_id[16],
    HeronAraFactoryInfo* info)
{
    if (!plugin_factory || !factory_class_id || !info)
        return Steinberg::kInvalidArgument;

    ARA::IMainFactory* main_factory {};
    const auto result = plugin_factory->createInstance(
        factory_class_id,
        ARA::IMainFactory::iid,
        reinterpret_cast<void**>(&main_factory));
    if (result != Steinberg::kResultOk || !main_factory)
        return result;

    const auto* factory = main_factory->getFactory();
    if (!factory)
    {
        main_factory->release();
        return Steinberg::kInternalError;
    }

    std::memset(info, 0, sizeof(*info));
    info->lowest_api_generation = factory->lowestSupportedApiGeneration;
    info->highest_api_generation = factory->highestSupportedApiGeneration;
    info->playback_transformation_flags = factory->supportedPlaybackTransformationFlags;
    info->supports_storing_audio_file_chunks = factory->supportsStoringAudioFileChunks;
    copy_text(info->factory_id, factory->factoryID);
    copy_text(info->document_archive_id, factory->documentArchiveID);
    copy_text(info->plugin_name, factory->plugInName);
    copy_text(info->manufacturer_name, factory->manufacturerName);
    copy_text(info->version, factory->version);
    main_factory->release();
    return Steinberg::kResultOk;
}

extern "C" HeronAraMainFactory* heron_ara_main_factory_create(
    Steinberg::IPluginFactory* plugin_factory,
    const char factory_class_id[16],
    std::int32_t* result)
{
    if (!plugin_factory || !factory_class_id || !result)
        return nullptr;
    ARA::IMainFactory* interface {};
    *result = plugin_factory->createInstance(
        factory_class_id,
        ARA::IMainFactory::iid,
        reinterpret_cast<void**>(&interface));
    if (*result != Steinberg::kResultOk || !interface)
        return nullptr;
    const auto* factory = interface->getFactory();
    if (!factory)
    {
        interface->release();
        *result = Steinberg::kInternalError;
        return nullptr;
    }
    return new HeronAraMainFactory { interface, factory };
}

extern "C" const ARA::ARAFactory* heron_ara_main_factory_get(
    const HeronAraMainFactory* main_factory)
{
    return main_factory ? main_factory->factory : nullptr;
}

extern "C" void heron_ara_main_factory_destroy(HeronAraMainFactory* main_factory)
{
    if (!main_factory)
        return;
    main_factory->interface->release();
    delete main_factory;
}

extern "C" HeronAraPluginEntry* heron_ara_plugin_entry_create(
    Steinberg::FUnknown* component,
    std::int32_t* result)
{
    if (!component || !result)
        return nullptr;
    ARA::IPlugInEntryPoint* entry {};
    *result = component->queryInterface(
        ARA::IPlugInEntryPoint::iid,
        reinterpret_cast<void**>(&entry));
    if (*result != Steinberg::kResultOk || !entry)
        return nullptr;
    ARA::IPlugInEntryPoint2* entry2 {};
    component->queryInterface(
        ARA::IPlugInEntryPoint2::iid,
        reinterpret_cast<void**>(&entry2));
    return new HeronAraPluginEntry { entry, entry2, false };
}

extern "C" const ARA::ARAFactory* heron_ara_plugin_entry_get_factory(
    const HeronAraPluginEntry* entry)
{
    return entry ? entry->entry->getFactory() : nullptr;
}

extern "C" const ARA::ARAPlugInExtensionInstance* heron_ara_plugin_entry_bind(
    HeronAraPluginEntry* entry,
    ARA::ARADocumentControllerRef document_controller,
    ARA::ARAPlugInInstanceRoleFlags known_roles,
    ARA::ARAPlugInInstanceRoleFlags assigned_roles,
    std::int32_t* result)
{
    if (!entry || !document_controller || !result || entry->bound)
        return nullptr;
    const ARA::ARAPlugInExtensionInstance* extension {};
    if (entry->entry2)
        extension = entry->entry2->bindToDocumentControllerWithRoles(
            document_controller, known_roles, assigned_roles);
    else if (known_roles == assigned_roles &&
             assigned_roles == (ARA::kARAPlaybackRendererRole |
                                ARA::kARAEditorRendererRole |
                                ARA::kARAEditorViewRole))
        extension = entry->entry->bindToDocumentController(document_controller);
    if (!extension)
    {
        *result = Steinberg::kResultFalse;
        return nullptr;
    }
    entry->bound = true;
    *result = Steinberg::kResultOk;
    return extension;
}

extern "C" void heron_ara_plugin_entry_destroy(HeronAraPluginEntry* entry)
{
    if (!entry)
        return;
    if (entry->entry2)
        entry->entry2->release();
    entry->entry->release();
    delete entry;
}
