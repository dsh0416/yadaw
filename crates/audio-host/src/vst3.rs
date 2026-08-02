use std::{collections::HashMap, path::Path, rc::Rc};

use yadaw_dsp_runtime::{
    block::MAX_PLUGIN_BLOCK_FRAMES,
    protocol::{
        BinaryPayload, ControlCommand, ControlResult, LiveMixerGraph, ParameterCommand,
        ParameterGesture, PluginAudioMode, PluginEditorPreference, PluginParameter,
    },
};
pub use yadaw_vst3_host::Vst3ProcessorHandle;
use yadaw_vst3_host::{AudioLayout, ClassId, HostedPlugin, PlugView, PluginKind};

use crate::ara::{AraDocument, AraFactoryHost};

pub struct Vst3Runtime {
    instances: HashMap<String, Instance>,
    retired_instances: Vec<GuardedInstance>,
    process_lifetime_guard: Option<Instance>,
    benchmark_lifetime_guards: Vec<GuardedInstance>,
    ara_factories: HashMap<(String, String), Rc<AraFactoryHost>>,
    next_runtime_handle: u32,
}

struct GuardedInstance {
    instance_id: String,
    instance: Instance,
}

struct Instance {
    benchmark_configuration: Option<InstanceConfiguration>,
    ara: Option<AraDocument>,
    plugin: HostedPlugin,
    secondary: Option<HostedPlugin>,
    runtime_handle: u32,
    display_name: String,
    ara_document_state: Vec<u8>,
}

#[derive(PartialEq)]
struct InstanceConfiguration {
    module_path: String,
    class_id: String,
    plugin_kind: String,
    audio_mode: PluginAudioMode,
    sample_rate_bits: u64,
    component_state: Vec<u8>,
    controller_state: Vec<u8>,
    ara_factory_class_id: Option<String>,
    ara_document_state: Vec<u8>,
}

impl InstanceConfiguration {
    fn from_request(request: &LoadPluginRequest) -> Self {
        Self {
            module_path: request.module_path.clone(),
            class_id: request.class_id.clone(),
            plugin_kind: request.plugin_kind.clone(),
            audio_mode: request.audio_mode,
            sample_rate_bits: request.sample_rate.to_bits(),
            component_state: request.component_state.clone(),
            controller_state: request.controller_state.clone(),
            ara_factory_class_id: request.ara_factory_class_id.clone(),
            ara_document_state: request.ara_document_state.clone(),
        }
    }
}

impl Instance {
    fn has_outstanding_processor_leases(&self) -> bool {
        self.plugin.has_outstanding_processor_leases()
            || self
                .secondary
                .as_ref()
                .is_some_and(HostedPlugin::has_outstanding_processor_leases)
    }

    fn processor_handle(&self) -> Vst3ProcessorHandle {
        let primary_latency = self.plugin.latency_samples();
        let secondary_latency = self
            .secondary
            .as_ref()
            .map_or(primary_latency, HostedPlugin::latency_samples);
        Vst3ProcessorHandle::new(
            self.plugin.processor_lease(),
            self.secondary.as_ref().map(HostedPlugin::processor_lease),
            primary_latency,
            secondary_latency,
            MAX_PLUGIN_BLOCK_FRAMES,
        )
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
    ara_factory_class_id: Option<String>,
    ara_document_state: Vec<u8>,
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
            process_lifetime_guard: None,
            benchmark_lifetime_guards: Vec::new(),
            ara_factories: HashMap::new(),
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
                ara_factory_class_id,
                ara_document_state,
            } => {
                let component_state = match inline_bytes(component_state) {
                    Ok(bytes) => bytes,
                    Err(message) => return control_error(message),
                };
                let controller_state = match inline_bytes(controller_state) {
                    Ok(bytes) => bytes,
                    Err(message) => return control_error(message),
                };
                let ara_document_state = match inline_bytes(ara_document_state) {
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
                    ara_factory_class_id,
                    ara_document_state,
                })
            }
            ControlCommand::UnloadPlugin { instance_id } => self.unload_plugin(&instance_id),
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

    /// Remove a live instance from the UI registry.
    ///
    /// Instances with outstanding audio-graph leases move to `retired_instances`. The UI thread
    /// later reclaims them after the audio engine has retired the graph generation that owns the
    /// final lease.
    pub fn unload_plugin(&mut self, instance_id: &str) -> ControlResult {
        if let Some(instance) = self.instances.remove(instance_id) {
            if instance.has_outstanding_processor_leases() {
                self.retired_instances.push(GuardedInstance {
                    instance_id: instance_id.to_owned(),
                    instance,
                });
            } else {
                self.finish_unload(instance_id, instance);
            }
        }
        ControlResult::Accepted
    }

    /// Reclaims instances whose final audio-graph lease has been dropped.
    ///
    /// This must run on the VST3 UI thread because dropping an instance invokes controller and
    /// component teardown on their owning thread.
    pub fn reclaim_retired_instances(&mut self) -> usize {
        let retired = std::mem::take(&mut self.retired_instances);
        let mut reclaimed = 0;
        for guard in retired {
            if guard.instance.has_outstanding_processor_leases() {
                self.retired_instances.push(guard);
            } else {
                self.finish_unload(&guard.instance_id, guard.instance);
                reclaimed += 1;
            }
        }
        reclaimed
    }

    #[must_use]
    pub fn has_retired_instances(&self) -> bool {
        !self.retired_instances.is_empty()
    }

    fn finish_unload(&mut self, instance_id: &str, instance: Instance) {
        let last_benchmark_instance = is_audio_benchmark_instance(instance_id)
            && !self
                .instances
                .keys()
                .any(|loaded_id| is_audio_benchmark_instance(loaded_id));
        if last_benchmark_instance {
            // Keep one non-graph instance alive until helper shutdown. Some VST3 modules use
            // process-global entrypoint state, and tearing down the final module while the helper
            // continues serving IPC can terminate the process before the unload reply is delivered.
            // Benchmark IDs are stable, so retain one exact configuration and reuse it later.
            if self.benchmark_lifetime_guards.iter().all(|guard| {
                guard.instance.benchmark_configuration != instance.benchmark_configuration
            }) {
                self.benchmark_lifetime_guards.push(GuardedInstance {
                    instance_id: instance_id.to_owned(),
                    instance,
                });
            }
        } else if self.instances.is_empty() {
            let previous = self.process_lifetime_guard.replace(instance);
            drop(previous);
        }
    }

    #[cfg(test)]
    pub(crate) fn retired_instance_count(&self) -> usize {
        self.retired_instances.len()
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
            ControlResult::Error { error } => Err(error.user_message_key),
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

    pub fn flush_output_parameters(&mut self) -> Result<usize, String> {
        let mut applied = 0;
        for (instance_id, instance) in &mut self.instances {
            applied += instance
                .plugin
                .flush_output_parameters()
                .map_err(|error| format!("{instance_id}: {error}"))?;
            if let Some(secondary) = &mut instance.secondary {
                applied += secondary
                    .flush_output_parameters()
                    .map_err(|error| format!("{instance_id} (secondary): {error}"))?;
            }
        }
        Ok(applied)
    }

    pub fn sync_ara_graph(&mut self, graph: Option<&LiveMixerGraph>) -> Result<(), String> {
        for instance in self.instances.values_mut() {
            let Instance { ara, plugin, .. } = instance;
            if let Some(ara) = ara {
                plugin.with_processing_paused(|| ara.sync_live_graph(graph))?;
            }
        }
        Ok(())
    }

    fn load_plugin(&mut self, request: LoadPluginRequest) -> ControlResult {
        let benchmark_configuration = is_audio_benchmark_instance(&request.instance_id)
            .then(|| InstanceConfiguration::from_request(&request));
        let LoadPluginRequest {
            instance_id,
            module_path,
            class_id,
            plugin_kind,
            audio_mode,
            sample_rate,
            component_state,
            controller_state,
            ara_factory_class_id,
            ara_document_state,
        } = request;
        if let Some(instance) = self.instances.get(&instance_id) {
            return ControlResult::PluginLoaded {
                runtime_handle: instance.runtime_handle,
                latency_samples: instance.latency_samples(),
                tail_samples: instance.tail_samples(),
            };
        }
        if let Some(index) = self.benchmark_lifetime_guards.iter().position(|guard| {
            guard.instance_id == instance_id
                && guard.instance.benchmark_configuration == benchmark_configuration
        }) {
            let guard = self.benchmark_lifetime_guards.swap_remove(index);
            let runtime_handle = guard.instance.runtime_handle;
            let latency_samples = guard.instance.latency_samples();
            let tail_samples = guard.instance.tail_samples();
            self.instances.insert(instance_id, guard.instance);
            return ControlResult::PluginLoaded {
                runtime_handle,
                latency_samples,
                tail_samples,
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
        if ara_factory_class_id.is_some() && audio_mode == PluginAudioMode::DualMono {
            return control_error("ARA plug-ins do not support the dual-mono hosting mode");
        }
        let (plugin, ara) = match ara_factory_class_id {
            Some(factory_class_id) => {
                let factory_key = (module_path.clone(), factory_class_id.clone());
                let parsed_factory_class_id = match factory_class_id.parse::<ClassId>() {
                    Ok(class_id) => class_id,
                    Err(error) => return control_error(&error.to_string()),
                };
                let shared_factory = self.ara_factories.get(&factory_key).cloned();
                let ara_instance_id = instance_id.clone();
                let initial_archive = ara_document_state.clone();
                match HostedPlugin::create_with_layout_and_hook(
                    &module_path,
                    class_id,
                    sample_rate,
                    kind,
                    layout,
                    move |module, component| {
                        let factory = match shared_factory {
                            Some(factory) => factory,
                            None => AraFactoryHost::create(module, parsed_factory_class_id)?,
                        };
                        let document = AraDocument::create(
                            ara_instance_id,
                            component,
                            Rc::clone(&factory),
                            initial_archive,
                        )?;
                        Ok((document, factory))
                    },
                ) {
                    Ok((plugin, (ara, factory))) => {
                        self.ara_factories.entry(factory_key).or_insert(factory);
                        (plugin, Some(ara))
                    }
                    Err(error) => return control_error(&error.to_string()),
                }
            }
            None => match HostedPlugin::create_with_layout(
                &module_path,
                class_id,
                sample_rate,
                kind,
                layout,
            ) {
                Ok(plugin) => (plugin, None),
                Err(error) => return control_error(&error.to_string()),
            },
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
                benchmark_configuration,
                ara,
                plugin,
                secondary,
                runtime_handle,
                display_name,
                ara_document_state,
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

    fn save_state(&mut self, instance_id: &str) -> ControlResult {
        let Some(instance) = self.instances.get_mut(instance_id) else {
            return control_error("VST3 instance is not loaded");
        };
        let ara_document_state = match &mut instance.ara {
            Some(ara) => match instance
                .plugin
                .with_processing_paused(|| ara.save_archive())
            {
                Ok(archive) => archive,
                Err(error) => return control_error(&error),
            },
            None => instance.ara_document_state.clone(),
        };
        match instance.plugin.save_state() {
            Ok((component_state, controller_state)) => ControlResult::PluginState {
                component_state: BinaryPayload::inline(component_state),
                controller_state: BinaryPayload::inline(controller_state),
                ara_document_state: BinaryPayload::inline(ara_document_state),
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

fn is_audio_benchmark_instance(instance_id: &str) -> bool {
    instance_id.starts_with("__yadaw-audio-benchmark-")
}

fn control_error(message: &str) -> ControlResult {
    control_error! {
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
    fn unload_of_a_missing_instance_is_accepted_without_retirement() {
        let mut runtime = Vst3Runtime::new();
        assert!(matches!(
            runtime.unload_plugin("missing"),
            ControlResult::Accepted
        ));
        assert!(matches!(
            runtime.unload_plugin("missing"),
            ControlResult::Accepted
        ));
        assert_eq!(runtime.retired_instance_count(), 0);
    }

    #[test]
    fn only_reserved_instance_ids_use_benchmark_lifetime_reuse() {
        assert!(is_audio_benchmark_instance(
            "__yadaw-audio-benchmark-gain-63"
        ));
        assert!(!is_audio_benchmark_instance("project-plugin"));
    }

    #[test]
    fn an_infinite_dual_mono_tail_dominates_a_finite_tail() {
        assert_eq!(max_tail(Some(128), None), None);
        assert_eq!(max_tail(Some(128), Some(256)), Some(256));
    }
}
