use super::{EmbeddedUiHost, LiveMixerGraph, Vst3HostRequest, engine};

pub(super) fn milliseconds_to_samples(milliseconds: f64, sample_rate: u32) -> u32 {
    if !milliseconds.is_finite() || milliseconds <= 0.0 || sample_rate == 0 {
        return 0;
    }
    (milliseconds * f64::from(sample_rate) / 1_000.0)
        .ceil()
        .min(f64::from(u32::MAX)) as u32
}

pub(in crate::runtime) fn vst3_host_request_payload(
    request: &Vst3HostRequest,
) -> Option<(&'static str, String)> {
    match request {
        Vst3HostRequest::DirtyChanged(dirty) => Some(("dirty-changed", dirty.to_string())),
        Vst3HostRequest::OpenEditor { view_name } => Some(("open-editor", view_name.clone())),
        Vst3HostRequest::GroupEditStarted => Some(("group-edit-started", String::new())),
        Vst3HostRequest::GroupEditFinished => Some(("group-edit-finished", String::new())),
        Vst3HostRequest::UnitSelected { unit_id } => Some(("unit-selected", unit_id.to_string())),
        Vst3HostRequest::ProgramListChanged {
            list_id,
            program_index,
        } => Some(("program-list-changed", format!("{list_id}:{program_index}"))),
        Vst3HostRequest::UnitByBusChanged => Some(("unit-by-bus-changed", String::new())),
        Vst3HostRequest::BusActivation { .. } => None,
    }
}

pub(super) fn presentation_latency_bases(
    audio_engine: &engine::AudioEngine,
    graph: Option<&LiveMixerGraph>,
) -> (u32, u32) {
    let Some(graph) = graph else {
        return (0, 0);
    };
    let Ok(snapshot) = audio_engine.audio_engine_snapshot() else {
        return (0, 0);
    };
    let output_ms = snapshot.output_latency_ms.unwrap_or(0.0)
        + snapshot.ring_buffer_latency_ms.unwrap_or(0.0)
        + snapshot.engine_latency_ms.unwrap_or(0.0);
    (
        milliseconds_to_samples(snapshot.input_latency_ms.unwrap_or(0.0), graph.sample_rate),
        milliseconds_to_samples(output_ms, graph.sample_rate),
    )
}

pub(in crate::runtime) fn should_drain_ui_request(
    drained: usize,
    elapsed: std::time::Duration,
) -> bool {
    drained < EmbeddedUiHost::UI_BATCH && (drained == 0 || elapsed < EmbeddedUiHost::UI_BUDGET)
}
