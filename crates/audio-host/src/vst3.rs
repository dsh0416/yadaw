use std::{collections::HashMap, path::Path};

use yadaw_dsp_render::{PluginProcessContext, PluginProcessor};
use yadaw_dsp_runtime::protocol::{
    BinaryPayload, ControlCommand, ControlResult, ParameterCommand, ParameterGesture,
    PluginAudioMode, PluginEditorPreference, PluginParameter,
};
use yadaw_vst3_host::{
    AudioLayout, ClassId, HostProcessContext, HostedPlugin, PlugView, PluginKind, ProcessorLease,
};

pub type ProcessContext = HostProcessContext;

#[derive(Clone)]
pub struct Vst3ProcessorHandle {
    primary: ProcessorLease,
    secondary: Option<ProcessorLease>,
    left_delay: SampleDelay,
    right_delay: SampleDelay,
}

#[derive(Clone)]
struct SampleDelay {
    samples: Vec<f32>,
    cursor: usize,
}

impl SampleDelay {
    fn new(delay_samples: u32) -> Self {
        Self {
            samples: vec![0.0; delay_samples as usize],
            cursor: 0,
        }
    }

    fn process(&mut self, sample: f32) -> f32 {
        if self.samples.is_empty() {
            return sample;
        }
        let delayed = self.samples[self.cursor];
        self.samples[self.cursor] = sample;
        self.cursor = (self.cursor + 1) % self.samples.len();
        delayed
    }
}

impl Vst3ProcessorHandle {
    pub fn process_frame(&mut self, input: [f32; 2], context: &ProcessContext) -> Option<[f32; 2]> {
        match &mut self.secondary {
            Some(secondary) => {
                let left = self
                    .left_delay
                    .process(self.primary.process_frame([input[0], 0.0], context)?[0]);
                let right = self
                    .right_delay
                    .process(secondary.process_frame([input[1], 0.0], context)?[0]);
                Some([left, right])
            }
            None => self.primary.process_frame(input, context),
        }
    }

    pub fn note_on(&mut self, channel: u8, key: u8, velocity: u8, note_id: i32) -> bool {
        self.primary.note_on(channel, key, velocity, note_id)
    }

    pub fn note_off(&mut self, channel: u8, key: u8, velocity: u8, note_id: i32) -> bool {
        self.primary.note_off(channel, key, velocity, note_id)
    }
}

impl PluginProcessor for Vst3ProcessorHandle {
    fn clone_box(&self) -> Box<dyn PluginProcessor> {
        Box::new(self.clone())
    }

    fn process_frame(&mut self, input: [f32; 2], context: PluginProcessContext) -> [f32; 2] {
        let context = ProcessContext {
            project_time_samples: context.sample_position.min(i64::MAX as u64) as i64,
            continuous_time_samples: context.sample_position.min(i64::MAX as u64) as i64,
            project_time_quarters: context.quarter_position,
            bar_position_quarters: context.bar_position,
            tempo: context.tempo,
            time_signature_numerator: i32::from(context.time_signature_numerator),
            time_signature_denominator: i32::from(context.time_signature_denominator),
            playing: context.playing,
            recording: context.recording,
        };
        Vst3ProcessorHandle::process_frame(self, input, &context).unwrap_or(input)
    }

    fn note_on(&mut self, channel: u8, key: u8, velocity: u8) {
        let _ = Vst3ProcessorHandle::note_on(self, channel, key, velocity, -1);
    }

    fn note_off(&mut self, channel: u8, key: u8, velocity: u8) {
        let _ = Vst3ProcessorHandle::note_off(self, channel, key, velocity, -1);
    }
}

pub struct Vst3Runtime {
    instances: HashMap<String, Instance>,
    retired_instances: Vec<Instance>,
    next_runtime_handle: u32,
}

struct Instance {
    plugin: HostedPlugin,
    secondary: Option<HostedPlugin>,
    runtime_handle: u32,
    display_name: String,
}

impl Instance {
    fn processor_handle(&self) -> Vst3ProcessorHandle {
        let primary_latency = self.plugin.latency_samples();
        let secondary_latency = self
            .secondary
            .as_ref()
            .map_or(primary_latency, HostedPlugin::latency_samples);
        let maximum_latency = primary_latency.max(secondary_latency);
        Vst3ProcessorHandle {
            primary: self.plugin.processor_lease(),
            secondary: self.secondary.as_ref().map(HostedPlugin::processor_lease),
            left_delay: SampleDelay::new(maximum_latency - primary_latency),
            right_delay: SampleDelay::new(maximum_latency - secondary_latency),
        }
    }

    fn latency_samples(&self) -> u32 {
        self.secondary
            .as_ref()
            .map_or(self.plugin.latency_samples(), |secondary| {
                self.plugin
                    .latency_samples()
                    .max(secondary.latency_samples())
            })
    }

    fn tail_samples(&self) -> Option<u32> {
        self.secondary.as_ref().map_or_else(
            || self.plugin.tail_samples(),
            |secondary| max_tail(self.plugin.tail_samples(), secondary.tail_samples()),
        )
    }
}

struct LoadPluginRequest {
    instance_id: String,
    module_path: String,
    class_id: String,
    plugin_kind: String,
    audio_mode: PluginAudioMode,
    sample_rate: f64,
    component_state: Vec<u8>,
    controller_state: Vec<u8>,
}

impl Default for Vst3Runtime {
    fn default() -> Self {
        Self::new()
    }
}

impl Vst3Runtime {
    #[must_use]
    pub fn new() -> Self {
        Self {
            instances: HashMap::new(),
            retired_instances: Vec::new(),
            next_runtime_handle: 1,
        }
    }

    pub fn execute(&mut self, command: ControlCommand) -> ControlResult {
        match command {
            ControlCommand::LoadPlugin {
                instance_id,
                module_path,
                class_id,
                plugin_kind,
                audio_mode,
                sample_rate,
                component_state,
                controller_state,
            } => {
                let component_state = match inline_bytes(component_state) {
                    Ok(bytes) => bytes,
                    Err(message) => return control_error(message),
                };
                let controller_state = match inline_bytes(controller_state) {
                    Ok(bytes) => bytes,
                    Err(message) => return control_error(message),
                };
                self.load_plugin(LoadPluginRequest {
                    instance_id,
                    module_path,
                    class_id,
                    plugin_kind,
                    audio_mode,
                    sample_rate,
                    component_state,
                    controller_state,
                })
            }
            ControlCommand::UnloadPlugin { instance_id } => {
                // Retired audio graphs may still hold a processor lease. Remove the instance from
                // the live UI registry immediately, but retain its allocation until helper
                // shutdown, after the audio engine and every graph generation have stopped.
                if let Some(instance) = self.instances.remove(&instance_id) {
                    self.retired_instances.push(instance);
                }
                ControlResult::Accepted
            }
            ControlCommand::PluginParameters { instance_id } => {
                self.plugin_parameters(&instance_id)
            }
            ControlCommand::SetPluginParameter {
                instance_id,
                parameter_id,
                normalized,
                gesture,
            } => self.set_parameter(&instance_id, parameter_id, normalized, gesture),
            ControlCommand::SavePluginState { instance_id } => self.save_state(&instance_id),
            ControlCommand::OpenPluginEditor {
                instance_id,
                preference,
            } => self.editor_result(&instance_id, preference),
            ControlCommand::ClosePluginEditor { .. } => ControlResult::Accepted,
            _ => control_error("command is not a VST3 runtime command"),
        }
    }

    pub fn processor_handle(&self, instance_id: &str) -> Option<Vst3ProcessorHandle> {
        self.instances
            .get(instance_id)
            .map(Instance::processor_handle)
    }

    pub fn processor_handles(&self) -> HashMap<String, Vst3ProcessorHandle> {
        self.instances
            .iter()
            .map(|(id, instance)| (id.clone(), instance.processor_handle()))
            .collect()
    }

    pub fn create_view(&self, instance_id: &str) -> Result<PlugView, String> {
        self.instances
            .get(instance_id)
            .ok_or_else(|| "VST3 instance is not loaded".to_owned())?
            .plugin
            .create_view()
            .map_err(|error| error.to_string())
    }

    pub fn display_name(&self, instance_id: &str) -> Option<&str> {
        self.instances
            .get(instance_id)
            .map(|instance| instance.display_name.as_str())
    }

    pub fn class_id(&self, instance_id: &str) -> Option<String> {
        self.instances
            .get(instance_id)
            .map(|instance| instance.plugin.class_id().to_string())
    }

    pub fn parameters(&self, instance_id: &str) -> Result<Vec<PluginParameter>, String> {
        let instance = self
            .instances
            .get(instance_id)
            .ok_or_else(|| "VST3 instance is not loaded".to_owned())?;
        instance
            .plugin
            .parameters()
            .map(|parameters| {
                parameters
                    .into_iter()
                    .map(|parameter| PluginParameter {
                        id: parameter.id,
                        title: parameter.title,
                        units: parameter.units,
                        step_count: parameter.step_count,
                        default_normalized: parameter.default_normalized,
                        normalized: parameter.normalized,
                        flags: parameter.flags,
                    })
                    .collect()
            })
            .map_err(|error| error.to_string())
    }

    pub fn set_parameter_from_editor(
        &mut self,
        instance_id: &str,
        parameter_id: u32,
        normalized: f64,
        gesture: ParameterGesture,
    ) -> Result<(), String> {
        match self.set_parameter(instance_id, parameter_id, normalized, gesture) {
            ControlResult::Accepted => Ok(()),
            ControlResult::Error { message } => Err(message),
            _ => Err("unexpected VST3 parameter result".into()),
        }
    }

    pub fn apply_parameter_command(&mut self, command: ParameterCommand) -> ControlResult {
        let instance_id = self.instances.iter().find_map(|(id, instance)| {
            (instance.runtime_handle == command.runtime_handle).then(|| id.clone())
        });
        match instance_id {
            Some(instance_id) => self.set_parameter(
                &instance_id,
                command.parameter_id,
                command.normalized,
                command.gesture,
            ),
            None => control_error("VST3 runtime handle is stale"),
        }
    }

    pub fn take_timing_changes(&self) -> Vec<(String, u32, Option<u32>)> {
        self.instances
            .iter()
            .filter(|(_, instance)| {
                instance.plugin.take_latency_changed()
                    || instance
                        .secondary
                        .as_ref()
                        .is_some_and(HostedPlugin::take_latency_changed)
            })
            .map(|(id, instance)| {
                (
                    id.clone(),
                    instance.latency_samples(),
                    instance.tail_samples(),
                )
            })
            .collect()
    }

    fn load_plugin(&mut self, request: LoadPluginRequest) -> ControlResult {
        let LoadPluginRequest {
            instance_id,
            module_path,
            class_id,
            plugin_kind,
            audio_mode,
            sample_rate,
            component_state,
            controller_state,
        } = request;
        if let Some(instance) = self.instances.get(&instance_id) {
            return ControlResult::PluginLoaded {
                runtime_handle: instance.runtime_handle,
                latency_samples: instance.latency_samples(),
                tail_samples: instance.tail_samples(),
            };
        }
        let class_id = match class_id.parse::<ClassId>() {
            Ok(class_id) => class_id,
            Err(error) => return control_error(&error.to_string()),
        };
        let kind = match plugin_kind.as_str() {
            "effect" => PluginKind::Effect,
            "instrument" => PluginKind::Instrument,
            _ => return control_error("unsupported VST3 plugin kind"),
        };
        let layout = match audio_mode {
            PluginAudioMode::Mono | PluginAudioMode::DualMono => AudioLayout::Mono,
            PluginAudioMode::MonoToStereo => AudioLayout::MonoToStereo,
            PluginAudioMode::Stereo => AudioLayout::Stereo,
        };
        if kind == PluginKind::Instrument
            && matches!(
                audio_mode,
                PluginAudioMode::MonoToStereo | PluginAudioMode::DualMono
            )
        {
            return control_error("unsupported instrument audio mode");
        }
        let plugin = match HostedPlugin::create_with_layout(
            &module_path,
            class_id,
            sample_rate,
            kind,
            layout,
        ) {
            Ok(plugin) => plugin,
            Err(error) => return control_error(&error.to_string()),
        };
        let secondary = if audio_mode == PluginAudioMode::DualMono {
            match HostedPlugin::create_with_layout(
                &module_path,
                class_id,
                sample_rate,
                kind,
                AudioLayout::Mono,
            ) {
                Ok(plugin) => Some(plugin),
                Err(error) => return control_error(&error.to_string()),
            }
        } else {
            None
        };
        if (!component_state.is_empty() || !controller_state.is_empty())
            && let Err(error) = plugin.restore_state(&component_state, &controller_state)
        {
            return control_error(&error.to_string());
        }
        if let Some(secondary) = &secondary
            && (!component_state.is_empty() || !controller_state.is_empty())
            && let Err(error) = secondary.restore_state(&component_state, &controller_state)
        {
            return control_error(&error.to_string());
        }
        if let Some(secondary) = &secondary {
            plugin.mirror_parameters_to(secondary);
        }
        let latency_samples = secondary
            .as_ref()
            .map_or(plugin.latency_samples(), |secondary| {
                plugin.latency_samples().max(secondary.latency_samples())
            });
        let tail_samples = secondary.as_ref().map_or_else(
            || plugin.tail_samples(),
            |secondary| max_tail(plugin.tail_samples(), secondary.tail_samples()),
        );
        let runtime_handle = self.next_runtime_handle;
        self.next_runtime_handle = self.next_runtime_handle.wrapping_add(1).max(1);
        let display_name = Path::new(&module_path)
            .file_stem()
            .and_then(|name| name.to_str())
            .unwrap_or("VST3 plug-in")
            .to_owned();
        self.instances.insert(
            instance_id,
            Instance {
                plugin,
                secondary,
                runtime_handle,
                display_name,
            },
        );
        ControlResult::PluginLoaded {
            runtime_handle,
            latency_samples,
            tail_samples,
        }
    }

    fn plugin_parameters(&self, instance_id: &str) -> ControlResult {
        match self.parameters(instance_id) {
            Ok(parameters) => ControlResult::PluginParameters { parameters },
            Err(error) => control_error(&error),
        }
    }

    fn set_parameter(
        &mut self,
        instance_id: &str,
        parameter_id: u32,
        normalized: f64,
        gesture: ParameterGesture,
    ) -> ControlResult {
        let Some(instance) = self.instances.get(instance_id) else {
            return control_error("VST3 instance is not loaded");
        };
        if gesture == ParameterGesture::Begin {
            return ControlResult::Accepted;
        }
        let primary_result = instance.plugin.set_parameter(
            parameter_id,
            normalized,
            gesture == ParameterGesture::End,
        );
        if let Err(error) = primary_result {
            return control_error(&error.to_string());
        }
        ControlResult::Accepted
    }

    fn save_state(&self, instance_id: &str) -> ControlResult {
        let Some(instance) = self.instances.get(instance_id) else {
            return control_error("VST3 instance is not loaded");
        };
        match instance.plugin.save_state() {
            Ok((component_state, controller_state)) => ControlResult::PluginState {
                component_state: BinaryPayload::inline(component_state),
                controller_state: BinaryPayload::inline(controller_state),
            },
            Err(error) => control_error(&error.to_string()),
        }
    }

    fn editor_result(
        &self,
        instance_id: &str,
        preference: PluginEditorPreference,
    ) -> ControlResult {
        if !self.instances.contains_key(instance_id) {
            return control_error("VST3 instance is not loaded");
        }
        if !preference.is_valid() {
            return control_error("VST3 editor zoom is outside 50...400");
        }
        ControlResult::PluginEditor {
            active_mode: preference.mode,
            open: false,
        }
    }
}

fn inline_bytes(payload: BinaryPayload) -> Result<Vec<u8>, &'static str> {
    match payload {
        BinaryPayload::Inline { bytes } => Ok(bytes),
        BinaryPayload::Shared { .. } | BinaryPayload::Attachment { .. } => {
            Err("external VST3 state was not materialized")
        }
    }
}

fn max_tail(left: Option<u32>, right: Option<u32>) -> Option<u32> {
    match (left, right) {
        (Some(left), Some(right)) => Some(left.max(right)),
        (Some(_), None) | (None, Some(_)) | (None, None) => None,
    }
}

fn control_error(message: &str) -> ControlResult {
    ControlResult::Error {
        message: message.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_preferences_are_rejected_before_window_creation() {
        let runtime = Vst3Runtime::new();
        let result = runtime.editor_result(
            "missing",
            PluginEditorPreference {
                mode: yadaw_dsp_runtime::protocol::PluginEditorMode::Native,
                zoom_percent: 401,
            },
        );
        assert!(matches!(result, ControlResult::Error { .. }));
    }

    #[test]
    fn dual_mono_lane_delay_aligns_the_shorter_processor() {
        let mut delay = SampleDelay::new(2);
        assert_eq!(delay.process(1.0), 0.0);
        assert_eq!(delay.process(2.0), 0.0);
        assert_eq!(delay.process(3.0), 1.0);
    }

    #[test]
    fn an_infinite_dual_mono_tail_dominates_a_finite_tail() {
        assert_eq!(max_tail(Some(128), None), None);
        assert_eq!(max_tail(Some(128), Some(256)), Some(256));
    }
}
