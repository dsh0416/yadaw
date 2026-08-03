use std::{
    collections::{HashMap, VecDeque},
    path::Path,
    rc::Rc,
};

use heron_dsp_runtime::{
    block::MAX_PLUGIN_BLOCK_FRAMES,
    protocol::{
        BinaryPayload, ControlCommand, ControlResult, LiveMixerGraph, ParameterCommand,
        ParameterGesture, PluginAudioMode, PluginAuxInputConfiguration, PluginEditorPreference,
        PluginParameter,
    },
};
pub use heron_vst3_host::Vst3ProcessorHandle;
use heron_vst3_host::{
    AudioLayout, ClassId, HostedPlugin, PlugView, PluginKind, Vst3AuxInputConfig, Vst3HostRequest,
};

use crate::{
    ara::{AraCallbackBatch, AraDocument, AraFactoryHost},
    vst3_presentation_latency::calculate_presentation_latencies,
};

const HOST_REQUEST_CAPACITY: usize = 1_024;

pub struct Vst3Runtime {
    instances: HashMap<String, Instance>,
    retired_instances: Vec<GuardedInstance>,
    process_lifetime_guard: Option<Instance>,
    benchmark_lifetime_guards: Vec<GuardedInstance>,
    ara_factories: HashMap<(String, String), Rc<AraFactoryHost>>,
    next_runtime_handle: u32,
    next_ara_callback_sequence: u64,
    restart_failures: Vec<(String, String)>,
    pending_host_requests: VecDeque<(String, Vst3HostRequest)>,
    staged_graph_instances: HashMap<String, HashMap<String, Instance>>,
    rollback_graph_instances: HashMap<String, HashMap<String, Instance>>,
}

/// Opaque VST3 state used by host-owned editor compare and clipboard features.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditorPluginState {
    pub component_state: Vec<u8>,
    pub controller_state: Vec<u8>,
}

struct GuardedInstance {
    instance_id: String,
    instance: Instance,
}

struct Instance {
    configuration: InstanceConfiguration,
    benchmark_configuration: Option<InstanceConfiguration>,
    ara: Option<AraDocument>,
    plugin: HostedPlugin,
    secondary: Option<HostedPlugin>,
    runtime_handle: u32,
    display_name: String,
    ara_document_state: Vec<u8>,
    aux_input_configs: Vec<PluginAuxInputConfiguration>,
}

#[derive(Clone, PartialEq)]
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
    active_aux_inputs: Vec<PluginAuxInputConfiguration>,
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
            active_aux_inputs: request.active_aux_inputs.clone(),
        }
    }
}

impl Instance {
    fn set_bus_active(
        &self,
        media_type: i32,
        direction: i32,
        index: i32,
        active: bool,
    ) -> Result<(), String> {
        let primary = self
            .plugin
            .set_bus_active(media_type, direction, index, active);
        let secondary = self.secondary.as_ref().map_or(Ok(()), |plugin| {
            plugin.set_bus_active(media_type, direction, index, active)
        });
        match (primary, secondary) {
            (Ok(()), Ok(())) => Ok(()),
            (Err(primary), Ok(())) => Err(primary.to_string()),
            (Ok(()), Err(secondary)) => Err(format!("secondary dual-mono bus: {secondary}")),
            (Err(primary), Err(secondary)) => Err(format!(
                "primary bus: {primary}; secondary dual-mono bus: {secondary}"
            )),
        }
    }

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
        let aux_inputs = self
            .aux_input_configs
            .iter()
            .map(|input| Vst3AuxInputConfig {
                bus_index: input.input_bus_index,
                channels: input.channels,
            })
            .collect::<Vec<_>>();
        Vst3ProcessorHandle::new_with_aux_inputs(
            self.plugin.processor_lease(),
            self.secondary.as_ref().map(HostedPlugin::processor_lease),
            primary_latency,
            secondary_latency,
            MAX_PLUGIN_BLOCK_FRAMES,
            &aux_inputs,
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
    active_aux_inputs: Vec<PluginAuxInputConfiguration>,
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
            next_ara_callback_sequence: 0,
            restart_failures: Vec::new(),
            pending_host_requests: VecDeque::with_capacity(HOST_REQUEST_CAPACITY),
            staged_graph_instances: HashMap::new(),
            rollback_graph_instances: HashMap::new(),
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
                active_aux_inputs,
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
                    active_aux_inputs,
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
                ..
            } => self.editor_result(&instance_id, preference),
            ControlCommand::ClosePluginEditor { .. }
            | ControlCommand::ConfigurePluginEditorAppearance { .. }
            | ControlCommand::ResolvePluginSidechainRoute { .. } => ControlResult::Accepted,
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

    pub fn prepare_graph_instances(
        &mut self,
        operation_id: &str,
        graph: &LiveMixerGraph,
    ) -> Result<(), String> {
        if self.rollback_graph_instances.contains_key(operation_id) {
            return Err("plugin graph activation is already in progress".into());
        }
        self.abort_graph_instances(operation_id);
        let mut staged = HashMap::new();
        for plugin in &graph.plugins {
            let mut desired = plugin
                .aux_input_buses
                .iter()
                .filter(|bus| bus.source_channel_id.is_some())
                .map(|bus| PluginAuxInputConfiguration {
                    input_bus_index: bus.input_bus_index,
                    channels: bus.channels,
                })
                .collect::<Vec<_>>();
            desired.sort_by_key(|bus| bus.input_bus_index);
            let Some(current) = self.instances.get_mut(&plugin.instance_id) else {
                continue;
            };
            let mut current_aux = current.aux_input_configs.clone();
            current_aux.sort_by_key(|bus| bus.input_bus_index);
            if current_aux == desired {
                continue;
            }
            let (component_state, controller_state) = current
                .plugin
                .save_state()
                .map_err(|error| format!("could not capture plug-in state: {error}"))?;
            let ara_document_state = match &mut current.ara {
                Some(ara) => current
                    .plugin
                    .with_processing_paused(|| ara.save_archive())?,
                None => current.ara_document_state.clone(),
            };
            let mut configuration = current.configuration.clone();
            configuration.component_state = component_state.clone();
            configuration.controller_state = controller_state.clone();
            configuration.ara_document_state = ara_document_state.clone();
            configuration.active_aux_inputs = desired.clone();
            let runtime_handle = current.runtime_handle;
            let request = LoadPluginRequest {
                instance_id: plugin.instance_id.clone(),
                module_path: configuration.module_path.clone(),
                class_id: configuration.class_id.clone(),
                plugin_kind: configuration.plugin_kind.clone(),
                audio_mode: configuration.audio_mode,
                active_aux_inputs: desired,
                sample_rate: f64::from_bits(configuration.sample_rate_bits),
                component_state,
                controller_state,
                ara_factory_class_id: configuration.ara_factory_class_id.clone(),
                ara_document_state,
            };
            let old = self.instances.remove(&plugin.instance_id).ok_or_else(|| {
                "plug-in disappeared while staging its side-chain buses".to_owned()
            })?;
            let result = self.load_plugin(request);
            let candidate = if matches!(result, ControlResult::PluginLoaded { .. }) {
                self.instances.remove(&plugin.instance_id)
            } else {
                None
            };
            self.instances.insert(plugin.instance_id.clone(), old);
            let Some(mut candidate) = candidate else {
                drop(staged);
                return Err("could not create the candidate side-chain plug-in instance".into());
            };
            candidate.runtime_handle = runtime_handle;
            staged.insert(plugin.instance_id.clone(), candidate);
        }
        self.staged_graph_instances
            .insert(operation_id.to_owned(), staged);
        Ok(())
    }

    pub fn graph_processor_handles(
        &self,
        operation_id: &str,
    ) -> HashMap<String, Vst3ProcessorHandle> {
        let staged = self.staged_graph_instances.get(operation_id);
        self.instances
            .iter()
            .map(|(id, instance)| {
                let instance = staged.and_then(|values| values.get(id)).unwrap_or(instance);
                (id.clone(), instance.processor_handle())
            })
            .collect()
    }

    pub fn activate_graph_instances(&mut self, operation_id: &str) -> Result<Vec<String>, String> {
        let staged = self
            .staged_graph_instances
            .remove(operation_id)
            .ok_or_else(|| "plugin graph candidate was not prepared".to_owned())?;
        let mut rollback = HashMap::with_capacity(staged.len());
        let mut changed = Vec::with_capacity(staged.len());
        for (id, candidate) in staged {
            let old = self
                .instances
                .insert(id.clone(), candidate)
                .ok_or_else(|| format!("active VST3 instance `{id}` is missing"))?;
            rollback.insert(id.clone(), old);
            changed.push(id);
        }
        self.rollback_graph_instances
            .insert(operation_id.to_owned(), rollback);
        Ok(changed)
    }

    pub fn finish_graph_instances(&mut self, operation_id: &str) {
        if let Some(previous) = self.rollback_graph_instances.remove(operation_id) {
            for (instance_id, instance) in previous {
                if instance.has_outstanding_processor_leases() {
                    self.retired_instances.push(GuardedInstance {
                        instance_id,
                        instance,
                    });
                } else {
                    self.finish_unload(&instance_id, instance);
                }
            }
        }
    }

    pub fn rollback_graph_instances(&mut self, operation_id: &str) -> Vec<String> {
        let Some(previous) = self.rollback_graph_instances.remove(operation_id) else {
            return Vec::new();
        };
        let mut changed = Vec::with_capacity(previous.len());
        for (id, old) in previous {
            if let Some(candidate) = self.instances.insert(id.clone(), old)
                && candidate.has_outstanding_processor_leases()
            {
                self.retired_instances.push(GuardedInstance {
                    instance_id: id.clone(),
                    instance: candidate,
                });
            }
            changed.push(id);
        }
        changed
    }

    pub fn abort_graph_instances(&mut self, operation_id: &str) {
        self.staged_graph_instances.remove(operation_id);
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
                        formatted: parameter.formatted,
                        flags: parameter.flags,
                    })
                    .collect()
            })
            .map_err(|error| error.to_string())
    }

    pub fn format_parameter_value(
        &self,
        instance_id: &str,
        parameter_id: u32,
        normalized: f64,
    ) -> Result<String, String> {
        self.instances
            .get(instance_id)
            .ok_or_else(|| "VST3 instance is not loaded".to_owned())?
            .plugin
            .format_parameter_value(parameter_id, normalized)
            .map_err(|error| error.to_string())
    }

    pub fn mark_editor_state_dirty(&mut self, instance_id: &str) {
        if self.instances.contains_key(instance_id) {
            push_pending_host_request(
                &mut self.pending_host_requests,
                instance_id.to_owned(),
                Vst3HostRequest::DirtyChanged(true),
            );
        }
    }

    pub fn editor_state(&self, instance_id: &str) -> Result<EditorPluginState, String> {
        let instance = self
            .instances
            .get(instance_id)
            .ok_or_else(|| "VST3 instance is not loaded".to_owned())?;
        instance
            .plugin
            .save_state()
            .map(|(component_state, controller_state)| EditorPluginState {
                component_state,
                controller_state,
            })
            .map_err(|error| error.to_string())
    }

    pub fn restore_editor_state(
        &self,
        instance_id: &str,
        state: &EditorPluginState,
    ) -> Result<(), String> {
        let instance = self
            .instances
            .get(instance_id)
            .ok_or_else(|| "VST3 instance is not loaded".to_owned())?;
        let primary_before = instance
            .plugin
            .save_state()
            .map_err(|error| format!("could not preserve the current plug-in state: {error}"))?;
        let secondary_before = instance
            .secondary
            .as_ref()
            .map(HostedPlugin::save_state)
            .transpose()
            .map_err(|error| format!("could not preserve the current dual-mono state: {error}"))?;
        if let Err(error) = instance
            .plugin
            .restore_state(&state.component_state, &state.controller_state)
        {
            let rollback = instance
                .plugin
                .restore_state(&primary_before.0, &primary_before.1);
            return Err(match rollback {
                Ok(()) => format!("could not restore plug-in state: {error}"),
                Err(rollback_error) => format!(
                    "could not restore plug-in state: {error}; recovery also failed: {rollback_error}"
                ),
            });
        }
        if let Some(secondary) = &instance.secondary
            && let Err(error) =
                secondary.restore_state(&state.component_state, &state.controller_state)
        {
            let primary_rollback = instance
                .plugin
                .restore_state(&primary_before.0, &primary_before.1);
            let secondary_rollback = secondary_before.as_ref().map_or(Ok(()), |before| {
                secondary.restore_state(&before.0, &before.1)
            });
            return Err(match (primary_rollback, secondary_rollback) {
                (Ok(()), Ok(())) => {
                    format!("could not restore dual-mono plug-in state: {error}")
                }
                (primary, secondary) => format!(
                    "could not restore dual-mono plug-in state: {error}; recovery failed (primary: {primary:?}, secondary: {secondary:?})"
                ),
            });
        }
        Ok(())
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

    pub fn take_timing_changes(&mut self) -> Vec<(String, u32, Option<u32>)> {
        let mut timing = Vec::new();
        for (id, instance) in &mut self.instances {
            let mut bus_activation_changed = false;
            let primary_host_requests = instance.plugin.take_host_requests();
            let secondary_host_requests = instance
                .secondary
                .as_ref()
                .map(HostedPlugin::take_host_requests)
                .unwrap_or_default();
            for request in
                merge_dual_mono_host_requests(primary_host_requests, secondary_host_requests)
            {
                if let Vst3HostRequest::BusActivation {
                    media_type,
                    direction,
                    index,
                    active,
                } = request
                {
                    match instance.set_bus_active(media_type, direction, index, active) {
                        Ok(()) => bus_activation_changed = true,
                        Err(error) => self.restart_failures.push((id.clone(), error)),
                    }
                } else {
                    push_pending_host_request(&mut self.pending_host_requests, id.clone(), request);
                }
            }
            let primary = instance.plugin.take_restart_requests();
            let secondary = instance
                .secondary
                .as_ref()
                .map(HostedPlugin::take_restart_requests)
                .unwrap_or_default();
            let request = primary | secondary;
            if request.is_empty() && !bus_activation_changed {
                continue;
            }
            if let Err(error) = instance.plugin.apply_restart_requests(primary) {
                self.restart_failures.push((id.clone(), error.to_string()));
            }
            if let Some(secondary_plugin) = &mut instance.secondary
                && let Err(error) = secondary_plugin.apply_restart_requests(secondary)
            {
                self.restart_failures.push((id.clone(), error.to_string()));
            }
            if bus_activation_changed
                || request.contains(heron_vst3_host::Vst3RestartRequest::LATENCY_CHANGED)
                || request.contains(heron_vst3_host::Vst3RestartRequest::IO_CHANGED)
            {
                timing.push((
                    id.clone(),
                    instance.latency_samples(),
                    instance.tail_samples(),
                ));
            }
        }
        timing
    }

    pub fn take_editor_parameter_gestures(
        &self,
    ) -> Vec<(String, Vec<heron_vst3_host::EditorParameterGesture>)> {
        self.instances
            .iter()
            .filter_map(|(instance_id, instance)| {
                let gestures = instance.plugin.take_editor_parameter_gestures();
                (!gestures.is_empty()).then(|| (instance_id.clone(), gestures))
            })
            .collect()
    }

    pub fn take_restart_failures(&mut self) -> Vec<(String, String)> {
        std::mem::take(&mut self.restart_failures)
    }

    pub fn take_host_requests(&mut self) -> Vec<(String, Vst3HostRequest)> {
        self.pending_host_requests.drain(..).collect()
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

    pub fn sync_presentation_latencies(
        &mut self,
        graph: Option<&LiveMixerGraph>,
        input_device_samples: u32,
        output_pipeline_samples: u32,
    ) -> Result<(), String> {
        let latencies = graph
            .map(|graph| {
                calculate_presentation_latencies(
                    graph,
                    input_device_samples,
                    output_pipeline_samples,
                )
            })
            .transpose()?
            .unwrap_or_default();
        for (instance_id, instance) in &self.instances {
            let latency = latencies.get(instance_id).copied().unwrap_or_default();
            instance
                .plugin
                .set_presentation_latency(latency.input_samples, latency.output_samples)
                .map_err(|error| format!("{instance_id}: {error}"))?;
            if let Some(secondary) = &instance.secondary {
                secondary
                    .set_presentation_latency(latency.input_samples, latency.output_samples)
                    .map_err(|error| format!("{instance_id} (secondary): {error}"))?;
            }
        }
        Ok(())
    }

    #[must_use]
    pub fn has_ara_documents(&self) -> bool {
        self.instances
            .values()
            .any(|instance| instance.ara.is_some())
    }

    pub(crate) fn poll_ara_callbacks(
        &mut self,
        include_model_events: bool,
    ) -> Vec<AraCallbackBatch> {
        let callback_sequence = &mut self.next_ara_callback_sequence;
        self.instances
            .values_mut()
            .filter_map(|instance| {
                instance.ara.as_mut().map(|document| {
                    document.poll_host_callbacks(include_model_events, callback_sequence)
                })
            })
            .collect()
    }

    fn load_plugin(&mut self, request: LoadPluginRequest) -> ControlResult {
        let configuration = InstanceConfiguration::from_request(&request);
        let benchmark_configuration =
            is_audio_benchmark_instance(&request.instance_id).then(|| configuration.clone());
        let LoadPluginRequest {
            instance_id,
            module_path,
            class_id,
            plugin_kind,
            audio_mode,
            active_aux_inputs,
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
        let active_aux_bus_indices = active_aux_inputs
            .iter()
            .map(|input| input.input_bus_index)
            .collect::<Vec<_>>();
        if kind == PluginKind::Instrument
            && matches!(
                audio_mode,
                PluginAudioMode::MonoToStereo | PluginAudioMode::DualMono
            )
        {
            return crate::plugin_capability_error_result(
                "unsupported instrument audio mode",
                "audio_mode",
            );
        }
        if ara_factory_class_id.is_some() && audio_mode == PluginAudioMode::DualMono {
            return crate::plugin_capability_error_result(
                "ARA plug-ins do not support the dual-mono hosting mode",
                "audio_mode",
            );
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
                match HostedPlugin::create_with_layout_aux_and_hook(
                    &module_path,
                    class_id,
                    sample_rate,
                    kind,
                    layout,
                    &active_aux_bus_indices,
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
            None => match HostedPlugin::create_with_layout_and_aux_inputs(
                &module_path,
                class_id,
                sample_rate,
                kind,
                layout,
                &active_aux_bus_indices,
            ) {
                Ok(plugin) => (plugin, None),
                Err(error) => return control_error(&error.to_string()),
            },
        };
        let secondary = if audio_mode == PluginAudioMode::DualMono {
            match HostedPlugin::create_with_layout_and_aux_inputs(
                &module_path,
                class_id,
                sample_rate,
                kind,
                AudioLayout::Mono,
                &active_aux_bus_indices,
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
                configuration,
                benchmark_configuration,
                ara,
                plugin,
                secondary,
                runtime_handle,
                display_name,
                ara_document_state,
                aux_input_configs: active_aux_inputs,
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
        if gesture == ParameterGesture::Perform {
            push_pending_host_request(
                &mut self.pending_host_requests,
                instance_id.to_owned(),
                Vst3HostRequest::DirtyChanged(true),
            );
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

fn merge_dual_mono_host_requests(
    primary: Vec<Vst3HostRequest>,
    secondary: Vec<Vst3HostRequest>,
) -> Vec<Vst3HostRequest> {
    let primary_len = primary.len();
    let mut merged = primary;
    for request in secondary {
        if !merged[..primary_len].contains(&request) {
            merged.push(request);
        }
    }
    merged
}

fn push_pending_host_request(
    pending: &mut VecDeque<(String, Vst3HostRequest)>,
    instance_id: String,
    request: Vst3HostRequest,
) {
    if request == Vst3HostRequest::DirtyChanged(true)
        && pending.iter().any(|(pending_id, pending_request)| {
            pending_id == &instance_id && pending_request == &request
        })
    {
        return;
    }
    if pending.len() == HOST_REQUEST_CAPACITY {
        pending.pop_front();
    }
    pending.push_back((instance_id, request));
}

fn max_tail(left: Option<u32>, right: Option<u32>) -> Option<u32> {
    match (left, right) {
        (Some(left), Some(right)) => Some(left.max(right)),
        (Some(_), None) | (None, Some(_)) | (None, None) => None,
    }
}

fn is_audio_benchmark_instance(instance_id: &str) -> bool {
    instance_id.starts_with("__heron-audio-benchmark-")
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
                mode: heron_dsp_runtime::protocol::PluginEditorMode::Native,
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
            "__heron-audio-benchmark-gain-63"
        ));
        assert!(!is_audio_benchmark_instance("project-plugin"));
    }

    #[test]
    fn an_infinite_dual_mono_tail_dominates_a_finite_tail() {
        assert_eq!(max_tail(Some(128), None), None);
        assert_eq!(max_tail(Some(128), Some(256)), Some(256));
    }

    #[test]
    fn dual_mono_host_requests_are_forwarded_once_across_lanes() {
        let duplicated = Vst3HostRequest::DirtyChanged(true);
        let primary_only = Vst3HostRequest::GroupEditStarted;
        let secondary_only = Vst3HostRequest::OpenEditor {
            view_name: "editor".to_owned(),
        };

        let merged = merge_dual_mono_host_requests(
            vec![duplicated.clone(), primary_only.clone()],
            vec![duplicated, secondary_only.clone()],
        );

        assert_eq!(
            merged,
            vec![
                Vst3HostRequest::DirtyChanged(true),
                primary_only,
                secondary_only
            ]
        );
    }

    #[test]
    fn host_request_merge_preserves_repeated_requests_from_one_lane() {
        let repeated = Vst3HostRequest::GroupEditFinished;
        assert_eq!(
            merge_dual_mono_host_requests(Vec::new(), vec![repeated.clone(), repeated.clone()]),
            vec![repeated.clone(), repeated.clone()]
        );
        assert_eq!(
            merge_dual_mono_host_requests(vec![repeated.clone(), repeated.clone()], Vec::new()),
            vec![repeated.clone(), repeated]
        );
    }

    #[test]
    fn pending_dirty_requests_are_coalesced_per_instance() {
        let mut pending = VecDeque::new();
        push_pending_host_request(
            &mut pending,
            "first".to_owned(),
            Vst3HostRequest::DirtyChanged(true),
        );
        push_pending_host_request(
            &mut pending,
            "first".to_owned(),
            Vst3HostRequest::DirtyChanged(true),
        );
        push_pending_host_request(
            &mut pending,
            "second".to_owned(),
            Vst3HostRequest::DirtyChanged(true),
        );
        push_pending_host_request(
            &mut pending,
            "first".to_owned(),
            Vst3HostRequest::GroupEditStarted,
        );

        assert_eq!(
            pending,
            VecDeque::from([
                ("first".to_owned(), Vst3HostRequest::DirtyChanged(true)),
                ("second".to_owned(), Vst3HostRequest::DirtyChanged(true)),
                ("first".to_owned(), Vst3HostRequest::GroupEditStarted),
            ])
        );
    }

    #[test]
    fn ara_dual_mono_is_a_plugin_capability_error() {
        let mut runtime = Vst3Runtime::new();
        let result = runtime.load_plugin(LoadPluginRequest {
            instance_id: "ara-dual-mono".into(),
            module_path: "unused.vst3".into(),
            class_id: "00000000000000000000000000000000".into(),
            plugin_kind: "effect".into(),
            audio_mode: PluginAudioMode::DualMono,
            active_aux_inputs: Vec::new(),
            sample_rate: 48_000.0,
            component_state: Vec::new(),
            controller_state: Vec::new(),
            ara_factory_class_id: Some("00000000000000000000000000000001".into()),
            ara_document_state: Vec::new(),
        });
        let ControlResult::Error { error } = result else {
            panic!("ARA dual-mono must be rejected before module loading");
        };
        assert_eq!(
            error.code,
            heron_dsp_runtime::protocol::RpcErrorCode::ValidationFailed
        );
        assert_eq!(error.retry, heron_dsp_runtime::protocol::RpcRetry::Never);
        assert_eq!(error.user_message_key, "errors.pluginUnavailable");
    }
}
