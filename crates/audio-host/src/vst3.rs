use std::{collections::HashMap, path::Path};

use yadaw_dsp_runtime::protocol::{
    BinaryPayload, ControlCommand, ControlResult, ParameterCommand, ParameterGesture,
    PluginEditorPreference, PluginParameter,
};
use yadaw_vst3_host::{
    ClassId, HostProcessContext, HostedPlugin, PlugView, PluginKind, ProcessorLease,
};

pub type ProcessContext = HostProcessContext;
pub type Vst3ProcessorHandle = ProcessorLease;

pub struct Vst3Runtime {
    instances: HashMap<String, Instance>,
    retired_instances: Vec<Instance>,
    next_runtime_handle: u32,
}

struct Instance {
    plugin: HostedPlugin,
    runtime_handle: u32,
    display_name: String,
}

struct LoadPluginRequest {
    instance_id: String,
    module_path: String,
    class_id: String,
    plugin_kind: String,
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
            .map(|instance| instance.plugin.processor_lease())
    }

    pub fn processor_handles(&self) -> HashMap<String, Vst3ProcessorHandle> {
        self.instances
            .iter()
            .map(|(id, instance)| (id.clone(), instance.plugin.processor_lease()))
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
            .filter(|(_, instance)| instance.plugin.take_latency_changed())
            .map(|(id, instance)| {
                (
                    id.clone(),
                    instance.plugin.latency_samples(),
                    instance.plugin.tail_samples(),
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
            sample_rate,
            component_state,
            controller_state,
        } = request;
        if let Some(instance) = self.instances.get(&instance_id) {
            return ControlResult::PluginLoaded {
                runtime_handle: instance.runtime_handle,
                latency_samples: instance.plugin.latency_samples(),
                tail_samples: instance.plugin.tail_samples(),
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
        let plugin = match HostedPlugin::create(&module_path, class_id, sample_rate, kind) {
            Ok(plugin) => plugin,
            Err(error) => return control_error(&error.to_string()),
        };
        if (!component_state.is_empty() || !controller_state.is_empty())
            && let Err(error) = plugin.restore_state(&component_state, &controller_state)
        {
            return control_error(&error.to_string());
        }
        let latency_samples = plugin.latency_samples();
        let tail_samples = plugin.tail_samples();
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
        match instance.plugin.set_parameter(
            parameter_id,
            normalized,
            gesture == ParameterGesture::End,
        ) {
            Ok(()) => ControlResult::Accepted,
            Err(error) => control_error(&error.to_string()),
        }
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
}
