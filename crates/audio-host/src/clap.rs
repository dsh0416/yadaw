use std::{collections::HashMap, path::Path};

use clap_sys::ext::params::{
    CLAP_PARAM_IS_AUTOMATABLE, CLAP_PARAM_IS_BYPASS, CLAP_PARAM_IS_HIDDEN, CLAP_PARAM_IS_READONLY,
    CLAP_PARAM_IS_STEPPED,
};
use heron_audio_plugin::{AudioPluginProcessorHandle, ParameterTokenMap};
use heron_clap_host::{
    ClapInstance, ClapModule, ClapParameterGesture, ClapProcessorHandle, HostRequestSnapshot,
};
use heron_dsp_runtime::{
    block::MAX_PLUGIN_BLOCK_FRAMES,
    protocol::{
        BinaryPayload, ControlCommand, ControlResult, ParameterCommand, ParameterGesture,
        PluginFormat, PluginParameter, PluginStateChunk, PluginStateEnvelope,
    },
};

use crate::control_error_result;
use crate::editor_platform::{NativeContainer, NativeContainerGeometry, NativeParentHandle};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ClapGuiSnapshot {
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) resizable: bool,
}

#[derive(Clone, Copy)]
pub(crate) struct ClapGuiHostConfig {
    pub(crate) parent: NativeParentHandle,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) top_inset: u32,
    pub(crate) display_scale: f64,
    pub(crate) zoom_percent: u16,
}

struct ClapGuiContainer {
    container: NativeContainer,
    snapshot: ClapGuiSnapshot,
}

struct InstanceRecord {
    // Drop the endpoint before the main-thread instance so the plug-in can be
    // stopped, deactivated, and destroyed in the required order.
    processor: Option<ClapProcessorHandle>,
    instance: ClapInstance,
    gui: Option<ClapGuiContainer>,
    plugin_type_key: String,
    runtime_handle: u32,
    parameter_tokens: ParameterTokenMap<u32>,
    sample_rate: f64,
    pending_reconfigure_state: Option<Vec<u8>>,
}

pub(crate) struct ClapReconfigureCompletion {
    pub(crate) instance_id: String,
    pub(crate) result: Result<AudioPluginProcessorHandle, String>,
    pub(crate) warning: Option<String>,
}

pub(crate) struct ClapRuntime {
    instances: HashMap<String, InstanceRecord>,
    next_runtime_handle: u32,
}

impl Default for ClapRuntime {
    fn default() -> Self {
        Self {
            instances: HashMap::new(),
            next_runtime_handle: 1,
        }
    }
}

impl ClapRuntime {
    pub(crate) fn contains(&self, instance_id: &str) -> bool {
        self.instances.contains_key(instance_id)
    }

    pub(crate) fn contains_runtime_handle(&self, runtime_handle: u32) -> bool {
        self.instances
            .values()
            .any(|record| record.runtime_handle == runtime_handle)
    }

    pub(crate) fn plugin_type_key(&self, instance_id: &str) -> Option<&str> {
        self.instances
            .get(instance_id)
            .map(|record| record.plugin_type_key.as_str())
    }

    pub(crate) fn execute(&mut self, command: ControlCommand) -> ControlResult {
        match command {
            ControlCommand::LoadPlugin {
                instance_id,
                locator,
                sample_rate,
                state,
                ..
            } => {
                if locator.format != PluginFormat::Clap {
                    return control_error_result("plug-in locator is not CLAP");
                }
                let module = match ClapModule::open(Path::new(&locator.artifact_path)) {
                    Ok(module) => module,
                    Err(error) => return control_error_result(error),
                };
                let mut instance = match ClapInstance::create(module, &locator.native_id) {
                    Ok(instance) => instance,
                    Err(error) => return control_error_result(error),
                };
                if let Some(chunk) = state.chunks.iter().find(|chunk| chunk.key == "main") {
                    let Some(bytes) = chunk.bytes.as_inline() else {
                        return control_error_result("CLAP state was not resolved inline");
                    };
                    if let Err(error) = instance.load_state(bytes) {
                        return control_error_result(error);
                    }
                }
                let parameter_tokens = match allocate_parameter_tokens(&instance) {
                    Ok(tokens) => tokens,
                    Err(error) => return control_error_result(error),
                };
                if let Err(error) =
                    instance.activate(sample_rate, 1, MAX_PLUGIN_BLOCK_FRAMES as u32)
                {
                    return control_error_result(error);
                }
                let latency_samples = instance.latency_samples();
                let tail_samples = instance.tail_samples();
                let processor = match instance.processor_handle(MAX_PLUGIN_BLOCK_FRAMES) {
                    Ok(processor) => processor,
                    Err(error) => return control_error_result(error),
                };
                let runtime_handle = self.next_runtime_handle;
                self.next_runtime_handle = self.next_runtime_handle.wrapping_add(1).max(1);
                self.instances.insert(
                    instance_id,
                    InstanceRecord {
                        processor: Some(processor),
                        instance,
                        gui: None,
                        plugin_type_key: format!("clap:{}", locator.native_id),
                        runtime_handle,
                        parameter_tokens,
                        sample_rate,
                        pending_reconfigure_state: None,
                    },
                );
                ControlResult::PluginLoaded {
                    runtime_handle,
                    latency_samples,
                    tail_samples,
                }
            }
            ControlCommand::UnloadPlugin { instance_id } => {
                self.close_gui(&instance_id);
                self.instances.remove(&instance_id);
                ControlResult::Accepted
            }
            ControlCommand::PluginParameters { instance_id } => {
                let Some(record) = self.instances.get(&instance_id) else {
                    return control_error_result("CLAP instance is not loaded");
                };
                match record.instance.parameters() {
                    Ok(parameters) => match parameters
                        .into_iter()
                        .map(|parameter| {
                            let Some(runtime_token) = record.parameter_tokens.token(parameter.id)
                            else {
                                return Err("CLAP parameter token table is stale".to_owned());
                            };
                            let range = parameter.max_value - parameter.min_value;
                            let normalized = if range.abs() <= f64::EPSILON {
                                0.0
                            } else {
                                ((parameter.value - parameter.min_value) / range).clamp(0.0, 1.0)
                            };
                            let default_normalized = if range.abs() <= f64::EPSILON {
                                0.0
                            } else {
                                ((parameter.default_value - parameter.min_value) / range)
                                    .clamp(0.0, 1.0)
                            };
                            Ok(PluginParameter {
                                parameter_key: format!("clap:{}", parameter.id),
                                runtime_token,
                                title: parameter.name,
                                units: String::new(),
                                step_count: 0,
                                default_normalized,
                                normalized,
                                min_value: parameter.min_value,
                                max_value: parameter.max_value,
                                default_value: parameter.default_value,
                                value: parameter.value,
                                normalized_value: normalized,
                                module_path: parameter.module,
                                read_only: parameter.flags & CLAP_PARAM_IS_READONLY != 0,
                                hidden: parameter.flags & CLAP_PARAM_IS_HIDDEN != 0,
                                stepped: parameter.flags & CLAP_PARAM_IS_STEPPED != 0,
                                automatable: parameter.flags & CLAP_PARAM_IS_AUTOMATABLE != 0,
                                bypass: parameter.flags & CLAP_PARAM_IS_BYPASS != 0,
                                formatted: parameter.formatted,
                            })
                        })
                        .collect::<Result<Vec<_>, String>>()
                    {
                        Ok(parameters) => ControlResult::PluginParameters { parameters },
                        Err(error) => control_error_result(error),
                    },
                    Err(error) => control_error_result(error),
                }
            }
            ControlCommand::SavePluginState { instance_id } => {
                let Some(record) = self.instances.get(&instance_id) else {
                    return control_error_result("CLAP instance is not loaded");
                };
                match record.instance.save_state() {
                    Ok(bytes) => ControlResult::PluginState {
                        state: PluginStateEnvelope {
                            version: 1,
                            chunks: vec![PluginStateChunk {
                                key: "main".to_owned(),
                                bytes: BinaryPayload::inline(bytes),
                            }],
                        },
                    },
                    Err(error) => control_error_result(error),
                }
            }
            ControlCommand::SetPluginParameter {
                instance_id,
                parameter_key,
                value,
                gesture,
            } => match parameter_key
                .strip_prefix("clap:")
                .and_then(|id| id.parse().ok())
            {
                Some(parameter_id) => {
                    self.set_parameter(&instance_id, parameter_id, value, gesture)
                }
                None => control_error_result("CLAP parameter key is invalid"),
            },
            _ => control_error_result("command is not a CLAP runtime command"),
        }
    }

    pub(crate) fn processor_handle(&self, instance_id: &str) -> Option<AudioPluginProcessorHandle> {
        self.instances
            .get(instance_id)
            .and_then(|record| record.processor.as_ref())
            .map(|processor| AudioPluginProcessorHandle::new(processor.clone()))
    }

    pub(crate) fn open_gui(
        &mut self,
        instance_id: &str,
        config: ClapGuiHostConfig,
    ) -> Result<ClapGuiSnapshot, String> {
        let ClapGuiHostConfig {
            parent,
            width,
            height,
            top_inset,
            display_scale,
            zoom_percent,
        } = config;
        let record = self
            .instances
            .get_mut(instance_id)
            .ok_or_else(|| "CLAP instance is not loaded".to_owned())?;
        if let Some(gui) = record.gui.as_ref() {
            gui.container.focus();
            return Ok(gui.snapshot);
        }
        if !record.instance.supports_gui() {
            return Err("The CLAP plug-in does not expose a native editor".to_owned());
        }
        let scale = clap_gui_scale(display_scale, zoom_percent);
        let Some(mut container) = NativeContainer::create_for_parent(
            parent,
            clap_gui_geometry(width, height, top_inset, display_scale),
            false,
        )?
        else {
            return Err(
                "This display server does not support embedded CLAP editors; use the parameter editor on Wayland."
                    .to_owned(),
            );
        };
        let (width, height, resizable) = record
            .instance
            .create_gui(container.attach_handle() as usize, scale)
            .map_err(|error| format!("Could not open the CLAP editor: {error}"))?;
        container.resize(clap_gui_geometry(width, height, top_inset, display_scale));
        container.focus();
        let snapshot = ClapGuiSnapshot {
            width: width.max(1),
            height: height.max(1),
            resizable,
        };
        record.gui = Some(ClapGuiContainer {
            container,
            snapshot,
        });
        Ok(snapshot)
    }

    pub(crate) fn resize_gui(
        &mut self,
        instance_id: &str,
        width: u32,
        height: u32,
        top_inset: u32,
        display_scale: f64,
        zoom_percent: u16,
    ) -> bool {
        let Some(record) = self.instances.get_mut(instance_id) else {
            return false;
        };
        let Some(gui) = record.gui.as_mut() else {
            return false;
        };
        let width = width.max(1);
        let height = height.max(1);
        if gui.snapshot.resizable
            && !record.instance.resize_gui(
                width,
                height,
                clap_gui_scale(display_scale, zoom_percent),
            )
        {
            return false;
        }
        gui.container
            .resize(clap_gui_geometry(width, height, top_inset, display_scale));
        gui.snapshot.width = width;
        gui.snapshot.height = height;
        true
    }

    pub(crate) fn close_gui(&mut self, instance_id: &str) -> bool {
        let Some(record) = self.instances.get_mut(instance_id) else {
            return false;
        };
        if record.gui.is_none() {
            return false;
        }
        record.instance.hide_gui();
        record.instance.destroy_gui();
        record.gui = None;
        true
    }

    pub(crate) fn focus_gui(&self, instance_id: &str) -> bool {
        let Some(gui) = self
            .instances
            .get(instance_id)
            .and_then(|record| record.gui.as_ref())
        else {
            return false;
        };
        gui.container.focus();
        true
    }

    pub(crate) fn gui_snapshot(&self, instance_id: &str) -> Option<ClapGuiSnapshot> {
        self.instances
            .get(instance_id)
            .and_then(|record| record.gui.as_ref())
            .map(|gui| gui.snapshot)
    }

    pub(crate) fn editor_state(&self, instance_id: &str) -> Result<PluginStateEnvelope, String> {
        let record = self
            .instances
            .get(instance_id)
            .ok_or_else(|| "CLAP instance is not loaded".to_owned())?;
        let bytes = record
            .instance
            .save_state()
            .map_err(|error| error.to_string())?;
        Ok(PluginStateEnvelope {
            version: 1,
            chunks: vec![PluginStateChunk {
                key: "main".to_owned(),
                bytes: BinaryPayload::inline(bytes),
            }],
        })
    }

    pub(crate) fn restore_editor_state(
        &mut self,
        instance_id: &str,
        state: &PluginStateEnvelope,
    ) -> Result<(), String> {
        let record = self
            .instances
            .get_mut(instance_id)
            .ok_or_else(|| "CLAP instance is not loaded".to_owned())?;
        let chunk = state
            .chunks
            .iter()
            .find(|chunk| chunk.key == "main")
            .ok_or_else(|| "CLAP state does not contain a main chunk".to_owned())?;
        let bytes = chunk
            .bytes
            .as_inline()
            .ok_or_else(|| "CLAP editor state was not resolved inline".to_owned())?;
        record
            .instance
            .load_state(bytes)
            .map_err(|error| error.to_string())
    }

    pub(crate) fn processor_handles(&self) -> HashMap<String, AudioPluginProcessorHandle> {
        self.instances
            .iter()
            .filter_map(|(id, record)| {
                let processor = record.processor.as_ref()?;
                (
                    id.clone(),
                    AudioPluginProcessorHandle::new(processor.clone()),
                )
                    .into()
            })
            .collect()
    }

    pub(crate) fn take_host_requests(
        &mut self,
    ) -> Vec<(String, HostRequestSnapshot, u32, Option<u32>)> {
        let mut requests = Vec::new();
        for (instance_id, record) in &mut self.instances {
            record.instance.dispatch_host_events();
            let request = record.instance.requests().take();
            if request.callback {
                record.instance.on_main_thread();
            }
            if request.parameter_rescan != 0
                && let Ok(parameter_tokens) = allocate_parameter_tokens(&record.instance)
            {
                record.parameter_tokens = parameter_tokens;
            }
            if record.pending_reconfigure_state.is_none()
                && (request.restart
                    || request.parameter_rescan != 0
                    || request.audio_port_rescan != 0)
                && let Ok(state) = record.instance.save_state()
            {
                record.pending_reconfigure_state = Some(state);
            }
            if request.restart
                || request.callback
                || request.parameter_rescan != 0
                || request.audio_port_rescan != 0
                || request.latency_changed
                || request.tail_changed
            {
                requests.push((
                    instance_id.clone(),
                    request,
                    record.instance.latency_samples(),
                    record.instance.tail_samples(),
                ));
            }
        }
        requests
    }

    pub(crate) fn complete_reconfigures(&mut self) -> Vec<ClapReconfigureCompletion> {
        let mut completions = Vec::new();
        for (instance_id, record) in &mut self.instances {
            if record.pending_reconfigure_state.is_none()
                || record.instance.processor_lease_count() != 1
            {
                continue;
            }
            let state = record.pending_reconfigure_state.take().unwrap_or_default();
            record.processor = None;
            let mut warning = None;
            let result = (|| {
                record
                    .instance
                    .deactivate()
                    .map_err(|error| error.to_string())?;
                if let Err(error) = record.instance.load_state(&state) {
                    warning = Some(format!(
                        "CLAP state restore failed during reactivation; retained in-memory state: {error}"
                    ));
                }
                record
                    .instance
                    .activate(record.sample_rate, 1, MAX_PLUGIN_BLOCK_FRAMES as u32)
                    .map_err(|error| error.to_string())?;
                record.parameter_tokens = allocate_parameter_tokens(&record.instance)?;
                let processor = record
                    .instance
                    .processor_handle(MAX_PLUGIN_BLOCK_FRAMES)
                    .map_err(|error| error.to_string())?;
                record.processor = Some(processor.clone());
                Ok(AudioPluginProcessorHandle::new(processor))
            })();
            completions.push(ClapReconfigureCompletion {
                instance_id: instance_id.clone(),
                result,
                warning,
            });
        }
        completions
    }

    pub(crate) fn take_parameter_outputs(&self) -> Vec<(String, u32, f64, ClapParameterGesture)> {
        let mut outputs = Vec::new();
        for (instance_id, record) in &self.instances {
            let Some(processor) = record.processor.as_ref() else {
                continue;
            };
            while let Some((parameter_id, value, gesture)) = processor.take_output_parameter() {
                outputs.push((instance_id.clone(), parameter_id, value, gesture));
            }
        }
        outputs
    }

    pub(crate) fn apply_parameter_command(&self, command: ParameterCommand) -> ControlResult {
        let Some((instance_id, _)) = self
            .instances
            .iter()
            .find(|(_, record)| record.runtime_handle == command.runtime_handle)
        else {
            return control_error_result("CLAP parameter runtime handle is stale");
        };
        let Some(parameter_id) = self.instances[instance_id]
            .parameter_tokens
            .native_id(command.parameter_token)
        else {
            return control_error_result("CLAP parameter token is stale");
        };
        self.set_parameter(instance_id, parameter_id, command.value, command.gesture)
    }

    fn set_parameter(
        &self,
        instance_id: &str,
        parameter_id: u32,
        value: f64,
        gesture: ParameterGesture,
    ) -> ControlResult {
        if !value.is_finite() {
            return control_error_result("CLAP parameter value is invalid");
        }
        let Some(record) = self.instances.get(instance_id) else {
            return control_error_result("CLAP instance is not loaded");
        };
        let parameter = match record.instance.parameters() {
            Ok(parameters) => parameters
                .into_iter()
                .find(|parameter| parameter.id == parameter_id),
            Err(error) => return control_error_result(error),
        };
        let Some(parameter) = parameter else {
            return control_error_result("CLAP parameter key is stale");
        };
        if value < parameter.min_value || value > parameter.max_value {
            return control_error_result("CLAP parameter value is outside its declared range");
        }
        let gesture = match gesture {
            ParameterGesture::Begin => ClapParameterGesture::Begin,
            ParameterGesture::Perform => ClapParameterGesture::Perform,
            ParameterGesture::End => ClapParameterGesture::End,
        };
        if record
            .processor
            .as_ref()
            .is_some_and(|processor| processor.queue_parameter(parameter_id, value, gesture))
        {
            ControlResult::Accepted
        } else {
            control_error_result("CLAP realtime parameter queue is full")
        }
    }
}

fn allocate_parameter_tokens(instance: &ClapInstance) -> Result<ParameterTokenMap<u32>, String> {
    let native_ids = instance
        .parameters()
        .map_err(|error| error.to_string())?
        .into_iter()
        .map(|parameter| parameter.id)
        .collect::<Vec<_>>();
    ParameterTokenMap::from_native_ids(native_ids)
        .ok_or_else(|| "CLAP parameter count exceeds runtime token capacity".to_owned())
}

fn clap_gui_scale(display_scale: f64, zoom_percent: u16) -> f64 {
    display_scale.max(0.01) * f64::from(zoom_percent) / 100.0
}

fn clap_gui_geometry(
    width: u32,
    height: u32,
    top_inset: u32,
    display_scale: f64,
) -> NativeContainerGeometry {
    let width = width.max(1);
    let height = height.max(1);
    let frame_scale = if cfg!(target_os = "macos") {
        1.0
    } else {
        display_scale.max(0.01)
    };
    let frame_width = (f64::from(width) * frame_scale).round().max(1.0) as u32;
    let frame_height = (f64::from(height) * frame_scale).round().max(1.0) as u32;
    NativeContainerGeometry {
        x: 0,
        y: top_inset.min(i32::MAX as u32) as i32,
        parent_height: top_inset.saturating_add(frame_height),
        frame_width,
        frame_height,
        content_width: width,
        content_height: height,
    }
}
