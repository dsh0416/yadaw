#pragma once

#include <cstdint>

#include "pluginterfaces/base/ipluginbase.h"
#include "ARAInterface.h"

struct HeronAraFactoryInfo
{
    std::int32_t lowest_api_generation;
    std::int32_t highest_api_generation;
    std::uint32_t playback_transformation_flags;
    std::int32_t supports_storing_audio_file_chunks;
    char factory_id[512];
    char document_archive_id[512];
    char plugin_name[256];
    char manufacturer_name[256];
    char version[128];
};

extern "C" std::int32_t heron_ara_query_factory(
    Steinberg::IPluginFactory* plugin_factory,
    const char factory_class_id[16],
    HeronAraFactoryInfo* info);

struct HeronAraMainFactory;
struct HeronAraPluginEntry;

extern "C" HeronAraMainFactory* heron_ara_main_factory_create(
    Steinberg::IPluginFactory* plugin_factory,
    const char factory_class_id[16],
    std::int32_t* result);
extern "C" const ARA::ARAFactory* heron_ara_main_factory_get(
    const HeronAraMainFactory* main_factory);
extern "C" void heron_ara_main_factory_destroy(HeronAraMainFactory* main_factory);

extern "C" HeronAraPluginEntry* heron_ara_plugin_entry_create(
    Steinberg::FUnknown* component,
    std::int32_t* result);
extern "C" const ARA::ARAFactory* heron_ara_plugin_entry_get_factory(
    const HeronAraPluginEntry* entry);
extern "C" const ARA::ARAPlugInExtensionInstance* heron_ara_plugin_entry_bind(
    HeronAraPluginEntry* entry,
    ARA::ARADocumentControllerRef document_controller,
    ARA::ARAPlugInInstanceRoleFlags known_roles,
    ARA::ARAPlugInInstanceRoleFlags assigned_roles,
    std::int32_t* result);
extern "C" void heron_ara_plugin_entry_destroy(HeronAraPluginEntry* entry);
