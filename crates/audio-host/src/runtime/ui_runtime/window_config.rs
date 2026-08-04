use super::{
    HashMap, LiveMixerGraph, LogicalSize, Vst3HostRequest, WindowAttributes, WinitHost, engine,
};

#[cfg(target_os = "linux")]
use crate::editor_platform;

impl WinitHost {}

pub(in crate::runtime) fn replace_owned_popup<Id>(
    owners: &mut HashMap<Id, Id>,
    owner: Id,
    popup: Id,
) -> Option<Id>
where
    Id: Copy + Eq + std::hash::Hash,
{
    owners.insert(owner, popup)
}

pub(in crate::runtime) fn remove_owned_popup<Id>(
    owners: &mut HashMap<Id, Id>,
    owner: Id,
) -> Option<Id>
where
    Id: Copy + Eq + std::hash::Hash,
{
    owners.remove(&owner)
}

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
    drained < WinitHost::UI_BATCH && (drained == 0 || elapsed < WinitHost::UI_BUDGET)
}

pub(in crate::runtime) fn plugin_editor_window_attributes(
    channel_name: &str,
    plugin_name: &str,
    editor_owner_window: Option<usize>,
) -> WindowAttributes {
    let attributes = WindowAttributes::default()
        .with_title(format!("{channel_name} — {plugin_name} — Heron"))
        .with_inner_size(LogicalSize::new(720.0, 640.0))
        // Do not expose a half-initialized surface. `present` makes the fully
        // attached editor visible and activates it in one sequence.
        .with_visible(false);
    configure_editor_window_attributes(attributes, editor_owner_window)
}

pub(super) fn configure_editor_window_attributes(
    attributes: WindowAttributes,
    _editor_owner_window: Option<usize>,
) -> WindowAttributes {
    #[cfg(target_os = "windows")]
    {
        use winit::platform::windows::WindowAttributesExtWindows;

        match _editor_owner_window {
            Some(owner) => attributes
                .with_owner_window(owner as isize)
                .with_skip_taskbar(true),
            None => attributes,
        }
    }

    #[cfg(target_os = "linux")]
    {
        use winit::platform::{wayland::WindowAttributesExtWayland, x11::WindowAttributesExtX11};

        let attributes =
            WindowAttributesExtX11::with_name(attributes, editor_platform::APPLICATION_ID, "heron");
        WindowAttributesExtWayland::with_name(attributes, editor_platform::APPLICATION_ID, "heron")
    }

    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    attributes
}

pub(in crate::runtime) fn parse_editor_owner_window(value: &str) -> Result<usize, &'static str> {
    let handle = value
        .parse::<usize>()
        .map_err(|_| "invalid --editor-owner-window value")?;
    if handle == 0 {
        Err("--editor-owner-window must not be null")
    } else {
        Ok(handle)
    }
}
