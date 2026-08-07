use heron_audio_plugin::{AudioPluginProcessorHandle, ParameterTokenMap};
use heron_dsp_runtime::block::MAX_PLUGIN_BLOCK_FRAMES;
use heron_vst3_host::{HostedPlugin, Vst3AuxInputConfig, Vst3ProcessorHandle};

use super::{Instance, InstanceConfiguration, LoadPluginRequest};

impl InstanceConfiguration {
    pub(super) fn from_request(request: &LoadPluginRequest) -> Self {
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
    pub(super) fn set_bus_active(
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

    pub(super) fn has_outstanding_processor_leases(&self) -> bool {
        self.plugin.has_outstanding_processor_leases()
            || self
                .secondary
                .as_ref()
                .is_some_and(HostedPlugin::has_outstanding_processor_leases)
    }

    pub(super) fn processor_handle(&self) -> AudioPluginProcessorHandle {
        let primary_latency = self.plugin.latency_samples();
        let secondary_latency = self
            .secondary
            .as_ref()
            .map_or(primary_latency, HostedPlugin::latency_samples);
        let aux_inputs = self
            .aux_input_configs
            .iter()
            .map(|input| Vst3AuxInputConfig {
                bus_index: vst3_input_index(&input.input_port_key).unwrap_or_default(),
                channels: input.channels,
            })
            .collect::<Vec<_>>();
        AudioPluginProcessorHandle::new(Vst3ProcessorHandle::new_with_aux_inputs(
            self.plugin.processor_lease(),
            self.secondary.as_ref().map(HostedPlugin::processor_lease),
            primary_latency,
            secondary_latency,
            MAX_PLUGIN_BLOCK_FRAMES,
            &aux_inputs,
        ))
    }

    pub(super) fn latency_samples(&self) -> u32 {
        self.secondary
            .as_ref()
            .map_or(self.plugin.latency_samples(), |secondary| {
                self.plugin
                    .latency_samples()
                    .max(secondary.latency_samples())
            })
    }

    pub(super) fn tail_samples(&self) -> Option<u32> {
        self.secondary.as_ref().map_or_else(
            || self.plugin.tail_samples(),
            |secondary| max_tail(self.plugin.tail_samples(), secondary.tail_samples()),
        )
    }
}
pub(super) fn vst3_input_index(port_key: &str) -> Option<u32> {
    let prefix = "vst3:audio:input:";
    port_key.strip_prefix(prefix)?.parse().ok()
}

pub(super) fn allocate_parameter_tokens(
    plugin: &HostedPlugin,
) -> Result<ParameterTokenMap<u32>, String> {
    let native_ids = plugin
        .parameters()
        .map_err(|error| error.to_string())?
        .into_iter()
        .map(|parameter| parameter.id)
        .collect::<Vec<_>>();
    ParameterTokenMap::from_native_ids(native_ids)
        .ok_or_else(|| "VST3 parameter count exceeds runtime token capacity".to_owned())
}

pub(super) fn max_tail(left: Option<u32>, right: Option<u32>) -> Option<u32> {
    match (left, right) {
        (Some(left), Some(right)) => Some(left.max(right)),
        (Some(_), None) | (None, Some(_)) | (None, None) => None,
    }
}
