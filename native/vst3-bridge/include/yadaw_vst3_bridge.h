#pragma once

#include <stddef.h>
#include <stdint.h>

#if defined(_WIN32)
#define YADAW_VST3_EXPORT __declspec(dllexport)
#else
#define YADAW_VST3_EXPORT __attribute__((visibility("default")))
#endif

#ifdef __cplusplus
extern "C" {
#endif

typedef struct YadawVst3Instance YadawVst3Instance;

typedef struct YadawVst3ProcessContext
{
    int64_t project_time_samples;
    int64_t continuous_time_samples;
    double project_time_quarters;
    double bar_position_quarters;
    double tempo;
    int32_t time_signature_numerator;
    int32_t time_signature_denominator;
    uint8_t playing;
    uint8_t recording;
} YadawVst3ProcessContext;

typedef struct YadawVst3ParameterInfo
{
    uint32_t id;
    double default_normalized;
    double normalized;
    int32_t step_count;
    uint32_t flags;
    char title[128];
    char units[128];
} YadawVst3ParameterInfo;

YADAW_VST3_EXPORT YadawVst3Instance* yadaw_vst3_create(
    const char* module_path,
    const char* class_id,
    double sample_rate,
    uint32_t maximum_block_frames,
    char* error_message,
    size_t error_capacity);

YADAW_VST3_EXPORT void yadaw_vst3_destroy(YadawVst3Instance* instance);

YADAW_VST3_EXPORT int32_t yadaw_vst3_process_stereo(
    YadawVst3Instance* instance,
    const float* input_left,
    const float* input_right,
    float* output_left,
    float* output_right,
    uint32_t frame_count,
    const YadawVst3ProcessContext* context);

YADAW_VST3_EXPORT int32_t yadaw_vst3_note_on(
    YadawVst3Instance* instance,
    int16_t bus_index,
    int16_t channel,
    int16_t key,
    float velocity,
    int32_t note_id,
    int32_t sample_offset);
YADAW_VST3_EXPORT int32_t yadaw_vst3_note_off(
    YadawVst3Instance* instance,
    int16_t bus_index,
    int16_t channel,
    int16_t key,
    float velocity,
    int32_t note_id,
    int32_t sample_offset);

YADAW_VST3_EXPORT int32_t yadaw_vst3_flush_parameters(YadawVst3Instance* instance);
YADAW_VST3_EXPORT int32_t yadaw_vst3_set_parameter(
    YadawVst3Instance* instance,
    uint32_t parameter_id,
    double normalized_value,
    uint32_t sample_offset);
YADAW_VST3_EXPORT uint32_t yadaw_vst3_parameter_count(const YadawVst3Instance* instance);
YADAW_VST3_EXPORT int32_t yadaw_vst3_parameter_info(
    const YadawVst3Instance* instance,
    uint32_t index,
    YadawVst3ParameterInfo* result);

YADAW_VST3_EXPORT uint32_t yadaw_vst3_latency_samples(const YadawVst3Instance* instance);
YADAW_VST3_EXPORT uint32_t yadaw_vst3_tail_samples(const YadawVst3Instance* instance);
YADAW_VST3_EXPORT int32_t yadaw_vst3_consume_latency_changed(YadawVst3Instance* instance);
YADAW_VST3_EXPORT int32_t yadaw_vst3_consume_latency_changed(YadawVst3Instance* instance);
YADAW_VST3_EXPORT int32_t yadaw_vst3_open_editor(YadawVst3Instance* instance);
YADAW_VST3_EXPORT void yadaw_vst3_close_editor(YadawVst3Instance* instance);
YADAW_VST3_EXPORT int32_t yadaw_vst3_editor_open(const YadawVst3Instance* instance);
YADAW_VST3_EXPORT void yadaw_vst3_pump_editor_events(void);

YADAW_VST3_EXPORT size_t yadaw_vst3_component_state_size(YadawVst3Instance* instance);
YADAW_VST3_EXPORT size_t yadaw_vst3_controller_state_size(YadawVst3Instance* instance);
YADAW_VST3_EXPORT size_t yadaw_vst3_copy_component_state(
    YadawVst3Instance* instance,
    uint8_t* destination,
    size_t capacity);
YADAW_VST3_EXPORT size_t yadaw_vst3_copy_controller_state(
    YadawVst3Instance* instance,
    uint8_t* destination,
    size_t capacity);
YADAW_VST3_EXPORT int32_t yadaw_vst3_restore_state(
    YadawVst3Instance* instance,
    const uint8_t* component_state,
    size_t component_size,
    const uint8_t* controller_state,
    size_t controller_size);

#ifdef __cplusplus
}
#endif
