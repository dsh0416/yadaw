use super::{LiveMixerGraph, MIDI_INPUT, RpcRequestMeta, graph_correlation};

pub(super) fn update_graph_midi_routes(graph: &LiveMixerGraph) {
    let Some(midi_input) = MIDI_INPUT.get() else {
        return;
    };
    let mut all_inputs = false;
    let port_ids = graph
        .channels
        .iter()
        .filter(|channel| {
            channel.kind == "instrument"
                && channel.system_role.is_none()
                && (channel.input_monitoring || channel.record_armed)
        })
        .filter_map(|channel| {
            if let Some(port_id) = &channel.midi_input_port_id {
                Some(port_id.clone())
            } else {
                all_inputs = true;
                None
            }
        })
        .collect();
    midi_input.update_routes(all_inputs, port_ids);
}

pub(super) fn log_graph_transaction_failure(
    meta: &RpcRequestMeta,
    phase: &str,
    error: &dyn std::fmt::Display,
) {
    eprintln!(
        "audio-host graph transaction [{}] {phase} failed: {error}",
        graph_correlation(meta, phase)
    );
}
