use std::{
    cell::{Cell, RefCell},
    collections::{HashMap, HashSet, VecDeque},
    rc::Rc,
};

use heron_dsp_runtime::protocol::{
    ControlResult, PluginEditorAction, PluginEditorCompareSlot, PluginEditorMode,
    PluginEditorPreference, PluginEditorSidechainBus, PluginEditorSidechainSource,
    PluginEditorSidechainSourceKind, PluginEditorToolbarState, PluginStateEnvelope,
};
use heron_vst3_host::{EditorParameterGesture, PlugFrame, PlugView, ViewRect};

use crate::{
    clap::ClapGuiHostConfig,
    editor_platform::{
        NativeContainer, NativeContainerGeometry, NativeParentHandle,
        with_native_child_scale_context,
    },
    vst3::{EditorPluginState as Vst3EditorPluginState, Vst3Runtime},
};

use super::{
    EmbeddedEditorHostEvent, EmbeddedEditorHostRegistration, EmbeddedEditorHostSnapshot,
    EmbeddedUiHost,
};

const DEFAULT_WIDTH: i32 = 800;
const DEFAULT_HEIGHT: i32 = 600;

#[derive(Debug, Clone, PartialEq)]
pub(in crate::runtime) enum EditorPluginState {
    Vst3(Vst3EditorPluginState),
    Clap(PluginStateEnvelope),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SidechainSourceKind {
    Audio,
    Instrument,
    Aux,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SidechainSource {
    id: String,
    name: String,
    kind: SidechainSourceKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SidechainBus {
    input_port_key: String,
    name: String,
    source_channel_id: Option<String>,
}

fn sidechain_view_for_graph(
    graph: Option<&heron_dsp_runtime::protocol::LiveMixerGraph>,
    instance_id: &str,
) -> Option<(Vec<SidechainBus>, Vec<SidechainSource>)> {
    let graph = graph?;
    let plugin = graph
        .plugins
        .iter()
        .find(|plugin| plugin.instance_id == instance_id)?;
    let buses = plugin
        .aux_input_buses
        .iter()
        .map(|bus| SidechainBus {
            input_port_key: bus.input_port_key.clone(),
            name: bus.name.clone(),
            source_channel_id: bus.source_channel_id.clone(),
        })
        .collect();
    let sources = graph
        .channels
        .iter()
        .filter_map(|channel| {
            if channel.system_role.is_some() || channel.id == plugin.channel_id {
                return None;
            }
            let kind = match channel.kind.as_str() {
                "audio" => SidechainSourceKind::Audio,
                "instrument" => SidechainSourceKind::Instrument,
                "aux" => SidechainSourceKind::Aux,
                _ => return None,
            };
            (!sidechain_route_would_cycle(graph, &plugin.channel_id, &channel.id)).then(|| {
                SidechainSource {
                    id: channel.id.clone(),
                    name: channel.name.clone(),
                    kind,
                }
            })
        })
        .collect();
    Some((buses, sources))
}

fn sidechain_route_would_cycle(
    graph: &heron_dsp_runtime::protocol::LiveMixerGraph,
    target_channel_id: &str,
    source_channel_id: &str,
) -> bool {
    if source_channel_id == target_channel_id {
        return true;
    }
    let mut edges: HashMap<&str, Vec<&str>> = HashMap::new();
    for channel in &graph.channels {
        if let Some(target) = channel.output_channel_id.as_deref() {
            edges.entry(&channel.id).or_default().push(target);
        }
    }
    for send in graph.sends.iter().filter(|send| send.enabled) {
        if let Some(target) = send.target_channel_id.as_deref() {
            edges
                .entry(&send.source_channel_id)
                .or_default()
                .push(target);
        }
    }
    for plugin in &graph.plugins {
        for bus in &plugin.aux_input_buses {
            if let Some(source) = bus.source_channel_id.as_deref() {
                edges.entry(source).or_default().push(&plugin.channel_id);
            }
        }
    }
    let mut pending = vec![target_channel_id];
    let mut visited = HashSet::new();
    while let Some(channel) = pending.pop() {
        if channel == source_channel_id {
            return true;
        }
        if !visited.insert(channel) {
            continue;
        }
        if let Some(targets) = edges.get(channel) {
            pending.extend(targets.iter().copied());
        }
    }
    false
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ScaleStrategy {
    Plugin,
    Platform,
    Unscaled,
}

impl ScaleStrategy {
    fn resolve(plugin_scaled: bool) -> Self {
        if plugin_scaled {
            Self::Plugin
        } else if cfg!(any(target_os = "macos", target_os = "windows")) {
            Self::Platform
        } else {
            Self::Unscaled
        }
    }

    fn uses_platform_fallback(self) -> bool {
        self == Self::Platform
    }
}

struct EmbeddedNativeEditor {
    view: PlugView,
    frame: Box<PlugFrame>,
    container: Rc<RefCell<NativeContainer>>,
    size: Rc<Cell<ViewRect>>,
    strategy: ScaleStrategy,
    scale: Rc<Cell<EditorScale>>,
    resizable: bool,
}

#[derive(Debug, Clone, Copy)]
struct EditorScale {
    zoom: f64,
    display: f64,
    top_inset: u32,
}

#[derive(Debug, Clone, Copy)]
struct ParameterEdit {
    parameter_id: u32,
    before: f64,
    after: f64,
}

impl EmbeddedNativeEditor {
    fn attach(
        runtime: &Vst3Runtime,
        instance_id: &str,
        parent: NativeParentHandle,
        preference: PluginEditorPreference,
        display_scale: f64,
        top_inset: u32,
        events: Rc<RefCell<VecDeque<EmbeddedEditorHostEvent>>>,
    ) -> Result<Self, String> {
        let view = runtime.create_view(instance_id)?;
        let zoom = f64::from(preference.zoom_percent) / 100.0;
        let scale = EditorScale {
            zoom,
            display: display_scale,
            top_inset,
        };
        let plugin_scaled = view
            .set_content_scale_factor(plugin_content_scale(display_scale, zoom))
            .map_err(|error| format!("Could not set the plug-in UI scale: {error}"))?;
        let strategy = ScaleStrategy::resolve(plugin_scaled);
        let size = initial_view_rect(&view);
        let initial_geometry = geometry(size, strategy, display_scale, zoom, top_inset);
        let Some(container) = NativeContainer::create_for_parent(
            parent,
            initial_geometry,
            strategy.uses_platform_fallback(),
        )?
        else {
            return Err(
                "This display server does not support native VST3 editors; Wayland is not supported."
                    .into(),
            );
        };
        if !view.supports_platform(container.platform_type()) {
            return Err(
                "The plug-in does not support this platform's native editor container".into(),
            );
        }

        let container = Rc::new(RefCell::new(container));
        let callback_container = Rc::clone(&container);
        let attached_size = Rc::new(Cell::new(size));
        let callback_size = Rc::clone(&attached_size);
        // resizeView may arrive after a monitor-DPI or user-zoom update. Keep
        // the callback on the attachment's live scale instead of the values
        // captured when the plug-in was first attached.
        let scale = Rc::new(Cell::new(scale));
        let callback_scale = Rc::clone(&scale);
        let callback_instance_id = instance_id.to_owned();
        let callback_strategy = strategy;
        let mut frame = PlugFrame::new(move |raw_view, mut requested| {
            if rect_extent(requested).is_none() {
                return false;
            }
            let scale = callback_scale.get();
            callback_container.borrow_mut().resize(geometry(
                requested,
                callback_strategy,
                scale.display,
                scale.zoom,
                scale.top_inset,
            ));
            let accepted = unsafe {
                // SAFETY: VST3 supplied the live IPlugView associated with this boxed frame.
                PlugView::on_size_raw(raw_view, &mut requested).is_ok()
            };
            if accepted {
                callback_size.set(requested);
                let (width, height) =
                    electron_extent(requested, callback_strategy, scale.display, scale.zoom);
                events.borrow_mut().push_back(EmbeddedEditorHostEvent {
                    instance_id: callback_instance_id.clone(),
                    width,
                    height,
                    resizable: true,
                });
            }
            accepted
        });

        if let Err(error) = unsafe {
            // SAFETY: the boxed frame has a stable address and is retained until detach.
            view.set_frame(frame.as_interface())
        } {
            return Err(format!(
                "Could not set IPlugFrame for the plug-in UI: {error}"
            ));
        }
        let (attach_handle, platform_type) = {
            let container = container.borrow();
            (container.attach_handle(), container.platform_type())
        };
        let attach_result =
            with_native_child_scale_context(strategy.uses_platform_fallback(), || unsafe {
                // SAFETY: the native child and boxed frame outlive the attached view.
                view.attach(attach_handle, platform_type)
            });
        if let Err(error) = attach_result {
            let _ = unsafe {
                // SAFETY: null clears the frame before failed-attach resources are dropped.
                view.set_frame(std::ptr::null_mut())
            };
            return Err(format!("Could not attach the plug-in UI: {error}"));
        }

        let final_size = view
            .size()
            .ok()
            .filter(|rect| rect_extent(*rect).is_some())
            .unwrap_or_else(|| attached_size.get());
        attached_size.set(final_size);
        container.borrow_mut().resize(geometry(
            final_size,
            strategy,
            display_scale,
            zoom,
            top_inset,
        ));
        Ok(Self {
            resizable: view.can_resize(),
            view,
            frame,
            container,
            size: attached_size,
            strategy,
            scale,
        })
    }

    fn electron_extent(&self) -> (u32, u32) {
        let scale = self.scale.get();
        electron_extent(self.size.get(), self.strategy, scale.display, scale.zoom)
    }

    fn resize(&mut self, width: u32, height: u32, top_inset: u32, display_scale: f64) {
        let mut scale = self.scale.get();
        scale.display = display_scale.max(0.01);
        scale.top_inset = top_inset;
        self.scale.set(scale);
        let _ = self
            .view
            .set_content_scale_factor(plugin_content_scale(scale.display, scale.zoom));
        if self.resizable {
            let frame_scale = frame_scale(self.strategy, scale.display, scale.zoom).max(0.01);
            let mut requested = ViewRect {
                left: 0,
                top: 0,
                right: (f64::from(width) / frame_scale).round() as i32,
                bottom: (f64::from(height) / frame_scale).round() as i32,
            };
            if self.view.constrain_size(&mut requested).is_ok()
                && rect_extent(requested).is_some()
                && self.view.on_size(&mut requested).is_ok()
            {
                self.size.set(requested);
            }
        }
        self.container.borrow_mut().resize(geometry(
            self.size.get(),
            self.strategy,
            scale.display,
            scale.zoom,
            scale.top_inset,
        ));
    }

    fn set_zoom(&mut self, zoom_percent: u16) {
        let mut scale = self.scale.get();
        scale.zoom = f64::from(zoom_percent) / 100.0;
        self.scale.set(scale);
        let _ = self
            .view
            .set_content_scale_factor(plugin_content_scale(scale.display, scale.zoom));
        if let Ok(size) = self.view.size()
            && rect_extent(size).is_some()
        {
            self.size.set(size);
        }
        self.container.borrow_mut().resize(geometry(
            self.size.get(),
            self.strategy,
            scale.display,
            scale.zoom,
            scale.top_inset,
        ));
    }

    fn dispatch_run_loop(&mut self, now: std::time::Instant) -> Option<std::time::Instant> {
        self.frame.dispatch_run_loop(now)
    }

    fn focus(&self) {
        self.container.borrow().focus();
    }

    fn detach(self) {
        self.view.removed();
        let _ = unsafe {
            // SAFETY: null severs the plug-in's reference before frame/container teardown.
            self.view.set_frame(std::ptr::null_mut())
        };
        let Self {
            view,
            frame,
            container,
            ..
        } = self;
        drop(view);
        drop(frame);
        drop(container);
    }
}

pub(in crate::runtime) struct EmbeddedEditorHost {
    parent: NativeParentHandle,
    width: u32,
    height: u32,
    top_inset: u32,
    display_scale: f64,
    attachment: Option<EmbeddedNativeEditor>,
    class_id: Option<String>,
    preference: PluginEditorPreference,
    compare_slots: Option<[EditorPluginState; 2]>,
    compare_slot: usize,
    undo: VecDeque<ParameterEdit>,
    redo: VecDeque<ParameterEdit>,
    pending_edits: HashMap<u32, f64>,
    pub(super) pending_sidechain_request: Option<u64>,
    open: bool,
}

impl EmbeddedEditorHost {
    fn snapshot(&self, instance_id: &str) -> EmbeddedEditorHostSnapshot {
        let (width, height, resizable, attached) = self.attachment.as_ref().map_or(
            (
                electron_dimension(self.width, self.display_scale),
                electron_dimension(self.height, self.display_scale),
                false,
                false,
            ),
            |attachment| {
                let (width, height) = attachment.electron_extent();
                (width, height, attachment.resizable, true)
            },
        );
        EmbeddedEditorHostSnapshot {
            instance_id: instance_id.to_owned(),
            width,
            height,
            display_scale: self.display_scale,
            resizable,
            attached,
        }
    }

    fn toolbar_state(
        &self,
        clipboard: &Option<(String, EditorPluginState)>,
        sidechain: Option<(Vec<SidechainBus>, Vec<SidechainSource>)>,
    ) -> PluginEditorToolbarState {
        let (sidechain_buses, sidechain_sources) = sidechain.unwrap_or_default();
        PluginEditorToolbarState {
            active_mode: self.preference.mode,
            zoom_percent: self.preference.zoom_percent,
            compare_slot: if self.compare_slot == 0 {
                PluginEditorCompareSlot::A
            } else {
                PluginEditorCompareSlot::B
            },
            can_compare: self.compare_slots.is_some(),
            can_paste: self.class_id.as_ref().is_some_and(|class_id| {
                clipboard
                    .as_ref()
                    .is_some_and(|(copied_class, _)| copied_class == class_id)
            }),
            can_undo: !self.undo.is_empty(),
            can_redo: !self.redo.is_empty(),
            sidechain_buses: sidechain_buses
                .into_iter()
                .map(|bus| PluginEditorSidechainBus {
                    input_port_key: bus.input_port_key,
                    name: bus.name,
                    source_channel_id: bus.source_channel_id,
                })
                .collect(),
            sidechain_sources: sidechain_sources
                .into_iter()
                .map(|source| PluginEditorSidechainSource {
                    id: source.id,
                    name: source.name,
                    kind: match source.kind {
                        SidechainSourceKind::Audio => PluginEditorSidechainSourceKind::Audio,
                        SidechainSourceKind::Instrument => {
                            PluginEditorSidechainSourceKind::Instrument
                        }
                        SidechainSourceKind::Aux => PluginEditorSidechainSourceKind::Aux,
                    },
                })
                .collect(),
            sidechain_pending: self.pending_sidechain_request.is_some(),
        }
    }
}

fn attach_embedded_native_editor(
    runtime: &Vst3Runtime,
    instance_id: &str,
    host: &mut EmbeddedEditorHost,
    events: &Rc<RefCell<VecDeque<EmbeddedEditorHostEvent>>>,
) -> Result<(), String> {
    let attachment = EmbeddedNativeEditor::attach(
        runtime,
        instance_id,
        host.parent,
        host.preference,
        host.display_scale,
        host.top_inset,
        Rc::clone(events),
    )?;
    let (width, height) = attachment.electron_extent();
    events.borrow_mut().push_back(EmbeddedEditorHostEvent {
        instance_id: instance_id.to_owned(),
        width,
        height,
        resizable: attachment.resizable,
    });
    attachment.focus();
    host.attachment = Some(attachment);
    Ok(())
}

impl EmbeddedUiHost {
    pub(in crate::runtime) fn register_embedded_editor_host(
        &mut self,
        registration: EmbeddedEditorHostRegistration,
    ) -> Result<(), String> {
        if self
            .embedded_editor_hosts
            .get(&registration.instance_id)
            .is_some_and(|host| host.attachment.is_some())
            || self
                .clap
                .as_ref()
                .is_some_and(|runtime| runtime.gui_snapshot(&registration.instance_id).is_some())
        {
            return Err("the native plug-in editor is already attached".into());
        }
        let parent = unsafe {
            // SAFETY: the N-API caller owns this live Electron window and unregisters it
            // only after the plug-in has detached.
            NativeParentHandle::from_raw(registration.parent_window)
        }
        .ok_or_else(|| "the Electron editor parent handle is null".to_owned())?;
        self.embedded_editor_hosts.insert(
            registration.instance_id,
            EmbeddedEditorHost {
                parent,
                width: registration.width.max(1),
                height: registration.height.max(1),
                top_inset: registration.top_inset,
                display_scale: registration.display_scale.max(0.01),
                attachment: None,
                class_id: None,
                preference: PluginEditorPreference::default(),
                compare_slots: None,
                compare_slot: 0,
                undo: VecDeque::new(),
                redo: VecDeque::new(),
                pending_edits: HashMap::new(),
                pending_sidechain_request: None,
                open: false,
            },
        );
        Ok(())
    }

    pub(in crate::runtime) fn resize_embedded_editor_host(
        &mut self,
        instance_id: &str,
        width: u32,
        height: u32,
        top_inset: u32,
        display_scale: f64,
    ) -> Result<(), String> {
        let host = self
            .embedded_editor_hosts
            .get_mut(instance_id)
            .ok_or_else(|| "the Electron editor host surface is not registered".to_owned())?;
        host.width = width.max(1);
        host.height = height.max(1);
        host.top_inset = top_inset;
        host.display_scale = display_scale.max(0.01);
        if let Some(attachment) = host.attachment.as_mut() {
            attachment.resize(host.width, host.height, host.top_inset, host.display_scale);
        }
        let geometry = (
            host.width,
            host.height,
            host.top_inset,
            host.display_scale,
            host.preference.zoom_percent,
        );
        if let Some(runtime) = self.clap.as_mut() {
            let (width, height, top_inset, display_scale, zoom_percent) = geometry;
            let _ = runtime.resize_gui(
                instance_id,
                width,
                height,
                top_inset,
                display_scale,
                zoom_percent,
            );
        }
        Ok(())
    }

    pub(in crate::runtime) fn unregister_embedded_editor_host(&mut self, instance_id: &str) {
        if let Some(runtime) = self.clap.as_mut() {
            runtime.close_gui(instance_id);
        }
        if let Some(mut host) = self.embedded_editor_hosts.remove(instance_id)
            && let Some(attachment) = host.attachment.take()
        {
            attachment.detach();
        }
    }

    pub(in crate::runtime) fn embedded_editor_host_snapshot(
        &self,
        instance_id: &str,
    ) -> Option<EmbeddedEditorHostSnapshot> {
        let host = self.embedded_editor_hosts.get(instance_id)?;
        if let Some(snapshot) = self
            .clap
            .as_ref()
            .and_then(|runtime| runtime.gui_snapshot(instance_id))
        {
            return Some(EmbeddedEditorHostSnapshot {
                instance_id: instance_id.to_owned(),
                width: snapshot.width,
                height: snapshot.height,
                display_scale: host.display_scale,
                resizable: snapshot.resizable,
                attached: true,
            });
        }
        Some(host.snapshot(instance_id))
    }

    pub(in crate::runtime) fn focus_embedded_editor_host(&self, instance_id: &str) -> bool {
        if let Some(attachment) = self
            .embedded_editor_hosts
            .get(instance_id)
            .and_then(|host| host.attachment.as_ref())
        {
            attachment.focus();
            return true;
        }
        self.clap
            .as_ref()
            .is_some_and(|runtime| runtime.focus_gui(instance_id))
    }

    pub(in crate::runtime) fn drain_embedded_editor_events(
        &mut self,
    ) -> Vec<EmbeddedEditorHostEvent> {
        self.embedded_editor_events.borrow_mut().drain(..).collect()
    }

    pub(in crate::runtime) fn embedded_editor_toolbar_state(
        &self,
        instance_id: &str,
    ) -> Option<PluginEditorToolbarState> {
        let sidechain = sidechain_view_for_graph(self.ara_graph.as_ref(), instance_id);
        self.embedded_editor_hosts
            .get(instance_id)
            .map(|host| host.toolbar_state(&self.embedded_editor_clipboard, sidechain))
    }

    pub(in crate::runtime) fn apply_embedded_editor_action(
        &mut self,
        instance_id: &str,
        action: PluginEditorAction,
    ) -> Result<PluginEditorToolbarState, String> {
        if self
            .clap
            .as_ref()
            .is_some_and(|runtime| runtime.contains(instance_id))
        {
            return self.apply_clap_editor_action(instance_id, action);
        }
        let events = Rc::clone(&self.embedded_editor_events);
        let host_events = self.host_events.clone();
        let sidechain = sidechain_view_for_graph(self.ara_graph.as_ref(), instance_id);
        let sidechain_request_id = matches!(action, PluginEditorAction::SidechainRoute { .. })
            .then(|| {
                self.next_sidechain_request_id =
                    self.next_sidechain_request_id.wrapping_add(1).max(1);
                self.next_sidechain_request_id
            });
        let (hosts, clipboard, runtime) = (
            &mut self.embedded_editor_hosts,
            &mut self.embedded_editor_clipboard,
            self.vst3
                .as_mut()
                .ok_or_else(|| "VST3 UI runtime is shutting down".to_owned())?,
        );
        let host = hosts
            .get_mut(instance_id)
            .ok_or_else(|| "the Electron editor host surface is not registered".to_owned())?;
        match action {
            PluginEditorAction::Mode { mode } => {
                if mode != host.preference.mode {
                    match mode {
                        PluginEditorMode::Native => {
                            host.preference.mode = PluginEditorMode::Native;
                            if let Err(error) =
                                attach_embedded_native_editor(runtime, instance_id, host, &events)
                            {
                                host.preference.mode = PluginEditorMode::Parameters;
                                return Err(error);
                            }
                        }
                        PluginEditorMode::Parameters => {
                            if let Some(attachment) = host.attachment.take() {
                                attachment.detach();
                            }
                            host.preference.mode = PluginEditorMode::Parameters;
                        }
                    }
                    if let Some(plugin_type_key) = host.class_id.clone() {
                        let _ = host_events.try_send(
                            heron_dsp_runtime::protocol::HostEvent::PluginEditorPreferenceChanged {
                                plugin_type_key,
                                preference: host.preference,
                            },
                        );
                    }
                }
            }
            PluginEditorAction::Compare { slot } => {
                let target = usize::from(slot == PluginEditorCompareSlot::B);
                if target != host.compare_slot {
                    let current = EditorPluginState::Vst3(runtime.editor_state(instance_id)?);
                    let slots = host
                        .compare_slots
                        .as_mut()
                        .ok_or_else(|| "A/B comparison is unavailable".to_owned())?;
                    let target_state = slots[target].clone();
                    let EditorPluginState::Vst3(target_state) = &target_state else {
                        return Err("A/B state belongs to a different plug-in format".to_owned());
                    };
                    runtime.restore_editor_state(instance_id, target_state)?;
                    slots[host.compare_slot] = current;
                    host.compare_slot = target;
                    runtime.mark_editor_state_dirty(instance_id);
                    host.undo.clear();
                    host.redo.clear();
                    host.pending_edits.clear();
                }
            }
            PluginEditorAction::Copy => {
                let class_id = host
                    .class_id
                    .clone()
                    .ok_or_else(|| "VST3 instance class is unavailable".to_owned())?;
                *clipboard = Some((
                    class_id,
                    EditorPluginState::Vst3(runtime.editor_state(instance_id)?),
                ));
            }
            PluginEditorAction::Paste => {
                let class_id = host
                    .class_id
                    .as_ref()
                    .ok_or_else(|| "VST3 instance class is unavailable".to_owned())?;
                let state = clipboard
                    .as_ref()
                    .filter(|(copied_class, _)| copied_class == class_id)
                    .map(|(_, state)| state.clone())
                    .ok_or_else(|| "Copied settings belong to a different plug-in".to_owned())?;
                let EditorPluginState::Vst3(vst3_state) = &state else {
                    return Err("Copied settings belong to a different plug-in format".to_owned());
                };
                runtime.restore_editor_state(instance_id, vst3_state)?;
                runtime.mark_editor_state_dirty(instance_id);
                if let Some(slots) = host.compare_slots.as_mut() {
                    slots[host.compare_slot] = state;
                }
                host.undo.clear();
                host.redo.clear();
                host.pending_edits.clear();
            }
            PluginEditorAction::Undo => {
                if let Some(edit) = host.undo.pop_back() {
                    if let Err(error) =
                        apply_parameter_value(runtime, instance_id, edit.parameter_id, edit.before)
                    {
                        host.undo.push_back(edit);
                        return Err(error);
                    }
                    push_edit(&mut host.redo, edit);
                    update_compare_slot(runtime, instance_id, host);
                }
            }
            PluginEditorAction::Redo => {
                if let Some(edit) = host.redo.pop_back() {
                    if let Err(error) =
                        apply_parameter_value(runtime, instance_id, edit.parameter_id, edit.after)
                    {
                        host.redo.push_back(edit);
                        return Err(error);
                    }
                    push_edit(&mut host.undo, edit);
                    update_compare_slot(runtime, instance_id, host);
                }
            }
            PluginEditorAction::Zoom { zoom_percent } => {
                let zoom_percent = (50..=400)
                    .contains(&zoom_percent)
                    .then_some(zoom_percent)
                    .ok_or_else(|| "VST3 editor zoom is outside 50...400".to_owned())?;
                host.preference.zoom_percent = zoom_percent;
                if let Some(attachment) = host.attachment.as_mut() {
                    attachment.set_zoom(zoom_percent);
                    let (width, height) = attachment.electron_extent();
                    events.borrow_mut().push_back(EmbeddedEditorHostEvent {
                        instance_id: instance_id.to_owned(),
                        width,
                        height,
                        resizable: attachment.resizable,
                    });
                }
                if let Some(plugin_type_key) = host.class_id.clone() {
                    let _ = host_events.try_send(
                        heron_dsp_runtime::protocol::HostEvent::PluginEditorPreferenceChanged {
                            plugin_type_key,
                            preference: host.preference,
                        },
                    );
                }
            }
            PluginEditorAction::SidechainRoute {
                input_port_key,
                source_channel_id,
            } => {
                if host.pending_sidechain_request.is_some() {
                    return Err("a side-chain routing request is already pending".into());
                }
                let Some((buses, sources)) = sidechain.as_ref() else {
                    return Err("side-chain routing is unavailable".into());
                };
                if !buses.iter().any(|bus| bus.input_port_key == input_port_key) {
                    return Err("the selected side-chain input bus is unavailable".into());
                }
                if source_channel_id
                    .as_ref()
                    .is_some_and(|source_id| !sources.iter().any(|source| &source.id == source_id))
                {
                    return Err("the selected side-chain source is unavailable".into());
                }
                let request_id = sidechain_request_id
                    .ok_or_else(|| "side-chain request identifier is unavailable".to_owned())?;
                host.pending_sidechain_request = Some(request_id);
                if host_events
                    .try_send(
                        heron_dsp_runtime::protocol::HostEvent::PluginSidechainRouteRequested {
                            request_id,
                            instance_id: instance_id.to_owned(),
                            input_port_key,
                            source_channel_id,
                        },
                    )
                    .is_err()
                {
                    host.pending_sidechain_request = None;
                    return Err("the host event queue is busy; try again".into());
                }
            }
        }
        Ok(host.toolbar_state(clipboard, sidechain))
    }

    fn apply_clap_editor_action(
        &mut self,
        instance_id: &str,
        action: PluginEditorAction,
    ) -> Result<PluginEditorToolbarState, String> {
        let sidechain = sidechain_view_for_graph(self.ara_graph.as_ref(), instance_id);
        let sidechain_request_id = matches!(action, PluginEditorAction::SidechainRoute { .. })
            .then(|| {
                self.next_sidechain_request_id =
                    self.next_sidechain_request_id.wrapping_add(1).max(1);
                self.next_sidechain_request_id
            });
        let events = Rc::clone(&self.embedded_editor_events);
        let host_events = self.host_events.clone();
        let (runtime, hosts, clipboard) = (
            self.clap
                .as_mut()
                .ok_or_else(|| "CLAP UI runtime is shutting down".to_owned())?,
            &mut self.embedded_editor_hosts,
            &mut self.embedded_editor_clipboard,
        );
        let plugin_type_key = runtime.plugin_type_key(instance_id).map(str::to_owned);
        let host = hosts
            .get_mut(instance_id)
            .ok_or_else(|| "the Electron editor host surface is not registered".to_owned())?;
        match action {
            PluginEditorAction::Mode { mode } => {
                if mode != host.preference.mode {
                    match mode {
                        PluginEditorMode::Native => {
                            let snapshot = runtime.open_gui(
                                instance_id,
                                ClapGuiHostConfig {
                                    parent: host.parent,
                                    width: host.width,
                                    height: host.height,
                                    top_inset: host.top_inset,
                                    display_scale: host.display_scale,
                                    zoom_percent: host.preference.zoom_percent,
                                },
                            )?;
                            events.borrow_mut().push_back(EmbeddedEditorHostEvent {
                                instance_id: instance_id.to_owned(),
                                width: snapshot.width,
                                height: snapshot.height,
                                resizable: snapshot.resizable,
                            });
                            host.preference.mode = PluginEditorMode::Native;
                        }
                        PluginEditorMode::Parameters => {
                            runtime.close_gui(instance_id);
                            host.preference.mode = PluginEditorMode::Parameters;
                        }
                    }
                    if let Some(plugin_type_key) = plugin_type_key.clone() {
                        let _ = host_events.try_send(
                            heron_dsp_runtime::protocol::HostEvent::PluginEditorPreferenceChanged {
                                plugin_type_key,
                                preference: host.preference,
                            },
                        );
                    }
                }
            }
            PluginEditorAction::Zoom { zoom_percent } => {
                let zoom_percent = (50..=400)
                    .contains(&zoom_percent)
                    .then_some(zoom_percent)
                    .ok_or_else(|| "CLAP editor zoom is outside 50...400".to_owned())?;
                host.preference.zoom_percent = zoom_percent;
                if let Some(snapshot) = runtime.gui_snapshot(instance_id) {
                    let _ = runtime.resize_gui(
                        instance_id,
                        snapshot.width,
                        snapshot.height,
                        host.top_inset,
                        host.display_scale,
                        zoom_percent,
                    );
                }
                if let Some(plugin_type_key) = plugin_type_key {
                    let _ = host_events.try_send(
                        heron_dsp_runtime::protocol::HostEvent::PluginEditorPreferenceChanged {
                            plugin_type_key,
                            preference: host.preference,
                        },
                    );
                }
            }
            PluginEditorAction::SidechainRoute {
                input_port_key,
                source_channel_id,
            } => {
                if host.pending_sidechain_request.is_some() {
                    return Err("a side-chain routing request is already pending".into());
                }
                let Some((buses, sources)) = sidechain.as_ref() else {
                    return Err("side-chain routing is unavailable".into());
                };
                if !buses.iter().any(|bus| bus.input_port_key == input_port_key) {
                    return Err("the selected side-chain input port is unavailable".into());
                }
                if source_channel_id
                    .as_ref()
                    .is_some_and(|source_id| !sources.iter().any(|source| &source.id == source_id))
                {
                    return Err("the selected side-chain source is unavailable".into());
                }
                let request_id = sidechain_request_id
                    .ok_or_else(|| "side-chain request identifier is unavailable".to_owned())?;
                host.pending_sidechain_request = Some(request_id);
                if host_events
                    .try_send(
                        heron_dsp_runtime::protocol::HostEvent::PluginSidechainRouteRequested {
                            request_id,
                            instance_id: instance_id.to_owned(),
                            input_port_key,
                            source_channel_id,
                        },
                    )
                    .is_err()
                {
                    host.pending_sidechain_request = None;
                    return Err("the host event queue is busy; try again".into());
                }
            }
            PluginEditorAction::Compare { slot } => {
                let target = usize::from(slot == PluginEditorCompareSlot::B);
                if target != host.compare_slot {
                    let current = EditorPluginState::Clap(runtime.editor_state(instance_id)?);
                    let slots = host
                        .compare_slots
                        .as_mut()
                        .ok_or_else(|| "A/B comparison is unavailable".to_owned())?;
                    let target_state = slots[target].clone();
                    let EditorPluginState::Clap(target_state) = &target_state else {
                        return Err("A/B state belongs to a different plug-in format".to_owned());
                    };
                    runtime.restore_editor_state(instance_id, target_state)?;
                    slots[host.compare_slot] = current;
                    host.compare_slot = target;
                }
            }
            PluginEditorAction::Copy => {
                let plugin_type_key = host
                    .class_id
                    .clone()
                    .ok_or_else(|| "CLAP plug-in type is unavailable".to_owned())?;
                *clipboard = Some((
                    plugin_type_key,
                    EditorPluginState::Clap(runtime.editor_state(instance_id)?),
                ));
            }
            PluginEditorAction::Paste => {
                let plugin_type_key = host
                    .class_id
                    .as_ref()
                    .ok_or_else(|| "CLAP plug-in type is unavailable".to_owned())?;
                let state = clipboard
                    .as_ref()
                    .filter(|(copied_type, _)| copied_type == plugin_type_key)
                    .map(|(_, state)| state.clone())
                    .ok_or_else(|| "Copied settings belong to a different plug-in".to_owned())?;
                let EditorPluginState::Clap(clap_state) = &state else {
                    return Err("Copied settings belong to a different plug-in format".to_owned());
                };
                runtime.restore_editor_state(instance_id, clap_state)?;
                if let Some(slots) = host.compare_slots.as_mut() {
                    slots[host.compare_slot] = state;
                }
            }
            PluginEditorAction::Undo | PluginEditorAction::Redo => {
                return Err("this CLAP editor action is not available yet".to_owned());
            }
        }
        Ok(host.toolbar_state(clipboard, sidechain))
    }

    pub(super) fn refresh_embedded_editor_gestures(&mut self) {
        let Some(runtime) = self.vst3.as_mut() else {
            return;
        };
        for (instance_id, gestures) in runtime.take_editor_parameter_gestures() {
            let Some(host) = self.embedded_editor_hosts.get_mut(&instance_id) else {
                continue;
            };
            for gesture in gestures {
                match gesture {
                    EditorParameterGesture::Begin { parameter_id } => {
                        if let Some(before) = parameter_value(runtime, &instance_id, parameter_id) {
                            host.pending_edits.entry(parameter_id).or_insert(before);
                        }
                    }
                    EditorParameterGesture::Perform { .. } => {}
                    EditorParameterGesture::End { parameter_id } => {
                        let before = host.pending_edits.remove(&parameter_id);
                        let after = parameter_value(runtime, &instance_id, parameter_id);
                        if let (Some(before), Some(after)) = (before, after)
                            && (before - after).abs() > f64::EPSILON
                        {
                            push_edit(
                                &mut host.undo,
                                ParameterEdit {
                                    parameter_id,
                                    before,
                                    after,
                                },
                            );
                            host.redo.clear();
                            update_compare_slot(runtime, &instance_id, host);
                        }
                    }
                }
            }
        }
    }

    pub(super) fn open_embedded_editor(
        &mut self,
        instance_id: String,
        preference: PluginEditorPreference,
    ) -> ControlResult {
        if !preference.is_valid() {
            return control_error! {
                message: "VST3 editor zoom is outside 50...400".into(),
            };
        }
        let Some(runtime) = self.vst3.as_ref() else {
            return control_error! {
                message: "VST3 UI runtime is shutting down".into(),
            };
        };
        let Some(host) = self.embedded_editor_hosts.get_mut(&instance_id) else {
            return control_error! {
                message: "Electron editor host surface is not registered".into(),
            };
        };
        if !host.open {
            host.class_id = runtime
                .class_id(&instance_id)
                .map(|class_id| format!("vst3:{class_id}"));
            host.preference = preference;
            host.compare_slots = runtime.editor_state(&instance_id).ok().map(|state| {
                let state = EditorPluginState::Vst3(state);
                [state.clone(), state]
            });
            host.compare_slot = 0;
            host.undo.clear();
            host.redo.clear();
            host.pending_edits.clear();
            host.pending_sidechain_request = None;
            if preference.mode == PluginEditorMode::Native
                && let Err(_message) = attach_embedded_native_editor(
                    runtime,
                    &instance_id,
                    host,
                    &self.embedded_editor_events,
                )
            {
                host.preference.mode = PluginEditorMode::Parameters;
                host.open = true;
                return ControlResult::PluginEditor {
                    active_mode: PluginEditorMode::Parameters,
                    open: true,
                };
            }
            host.open = true;
        }
        ControlResult::PluginEditor {
            active_mode: host.preference.mode,
            open: true,
        }
    }

    pub(super) fn open_clap_editor(
        &mut self,
        instance_id: String,
        preference: PluginEditorPreference,
    ) -> ControlResult {
        if !preference.is_valid() {
            return control_error! {
                message: "CLAP editor zoom is outside 50...400".into(),
            };
        }
        let (runtime, hosts, events) = (
            self.clap.as_mut(),
            &mut self.embedded_editor_hosts,
            &self.embedded_editor_events,
        );
        let Some(runtime) = runtime else {
            return control_error! {
                message: "CLAP UI runtime is shutting down".into(),
            };
        };
        let Some(host) = hosts.get_mut(&instance_id) else {
            return control_error! {
                message: "Electron editor host surface is not registered".into(),
            };
        };
        if !host.open {
            host.class_id = runtime.plugin_type_key(&instance_id).map(str::to_owned);
            host.preference = preference;
            host.compare_slots = runtime.editor_state(&instance_id).ok().map(|state| {
                let state = EditorPluginState::Clap(state);
                [state.clone(), state]
            });
            host.compare_slot = 0;
            host.undo.clear();
            host.redo.clear();
            host.pending_edits.clear();
            host.pending_sidechain_request = None;
            if preference.mode == PluginEditorMode::Native {
                match runtime.open_gui(
                    &instance_id,
                    ClapGuiHostConfig {
                        parent: host.parent,
                        width: host.width,
                        height: host.height,
                        top_inset: host.top_inset,
                        display_scale: host.display_scale,
                        zoom_percent: preference.zoom_percent,
                    },
                ) {
                    Ok(snapshot) => events.borrow_mut().push_back(EmbeddedEditorHostEvent {
                        instance_id: instance_id.clone(),
                        width: snapshot.width,
                        height: snapshot.height,
                        resizable: snapshot.resizable,
                    }),
                    Err(_) => host.preference.mode = PluginEditorMode::Parameters,
                }
            }
            host.open = true;
        }
        ControlResult::PluginEditor {
            active_mode: host.preference.mode,
            open: true,
        }
    }

    pub(super) fn close_embedded_editor(&mut self, instance_id: &str, notify: bool) -> bool {
        let Some(host) = self.embedded_editor_hosts.get_mut(instance_id) else {
            return false;
        };
        if !host.open {
            return false;
        }
        host.open = false;
        host.pending_sidechain_request = None;
        if let Some(attachment) = host.attachment.take() {
            attachment.detach();
        }
        if let Some(runtime) = self.clap.as_mut() {
            runtime.close_gui(instance_id);
        }
        if notify {
            let _ = self.host_events.try_send(
                heron_dsp_runtime::protocol::HostEvent::PluginEditorClosed {
                    instance_id: instance_id.to_owned(),
                },
            );
        }
        true
    }

    pub(super) fn rebind_embedded_editor(&mut self, instance_id: &str) {
        let (runtime, hosts, events) = (
            self.vst3.as_ref(),
            &mut self.embedded_editor_hosts,
            &self.embedded_editor_events,
        );
        let (Some(runtime), Some(host)) = (runtime, hosts.get_mut(instance_id)) else {
            return;
        };
        if !host.open {
            return;
        }
        if let Some(attachment) = host.attachment.take() {
            attachment.detach();
        }
        if host.preference.mode == PluginEditorMode::Native
            && attach_embedded_native_editor(runtime, instance_id, host, events).is_err()
        {
            host.preference.mode = PluginEditorMode::Parameters;
        }
    }

    pub(super) fn dispatch_embedded_editor_run_loops(
        &mut self,
        now: std::time::Instant,
    ) -> Option<std::time::Instant> {
        #[cfg(target_os = "linux")]
        {
            let runtime = self.vst3.as_ref();
            self.embedded_editor_hosts
                .iter_mut()
                .filter_map(|(instance_id, host)| {
                    let attachment = host.attachment.as_mut()?;
                    let frame_deadline = attachment.dispatch_run_loop(now);
                    let module_deadline = runtime
                        .and_then(|runtime| runtime.dispatch_editor_run_loop(instance_id, now));
                    frame_deadline.into_iter().chain(module_deadline).min()
                })
                .min()
        }
        #[cfg(not(target_os = "linux"))]
        {
            self.embedded_editor_hosts
                .values_mut()
                .filter_map(|host| host.attachment.as_mut())
                .filter_map(|attachment| attachment.dispatch_run_loop(now))
                .min()
        }
    }
}

fn initial_view_rect(view: &PlugView) -> ViewRect {
    if let Ok(size) = view.size()
        && rect_extent(size).is_some()
    {
        return size;
    }
    let mut fallback = ViewRect {
        left: 0,
        top: 0,
        right: DEFAULT_WIDTH,
        bottom: DEFAULT_HEIGHT,
    };
    if view.constrain_size(&mut fallback).is_ok() && rect_extent(fallback).is_some() {
        fallback
    } else {
        ViewRect {
            left: 0,
            top: 0,
            right: DEFAULT_WIDTH,
            bottom: DEFAULT_HEIGHT,
        }
    }
}

fn parameter_value(runtime: &Vst3Runtime, instance_id: &str, parameter_id: u32) -> Option<f64> {
    let parameter_key = format!("vst3:{parameter_id}");
    runtime
        .parameters(instance_id)
        .ok()?
        .into_iter()
        .find(|parameter| parameter.parameter_key == parameter_key)
        .map(|parameter| parameter.normalized)
}

fn apply_parameter_value(
    runtime: &mut Vst3Runtime,
    instance_id: &str,
    parameter_id: u32,
    normalized: f64,
) -> Result<(), String> {
    use heron_dsp_runtime::protocol::ParameterGesture;
    runtime.set_parameter_from_editor(
        instance_id,
        parameter_id,
        normalized,
        ParameterGesture::Begin,
    )?;
    runtime.set_parameter_from_editor(
        instance_id,
        parameter_id,
        normalized,
        ParameterGesture::Perform,
    )?;
    runtime.set_parameter_from_editor(instance_id, parameter_id, normalized, ParameterGesture::End)
}

fn push_edit(history: &mut VecDeque<ParameterEdit>, edit: ParameterEdit) {
    const HISTORY_LIMIT: usize = 128;
    if history.len() == HISTORY_LIMIT {
        history.pop_front();
    }
    history.push_back(edit);
}

fn update_compare_slot(runtime: &Vst3Runtime, instance_id: &str, host: &mut EmbeddedEditorHost) {
    if let (Ok(state), Some(slots)) = (
        runtime.editor_state(instance_id),
        host.compare_slots.as_mut(),
    ) {
        slots[host.compare_slot] = EditorPluginState::Vst3(state);
    }
}

fn rect_extent(rect: ViewRect) -> Option<(u32, u32)> {
    let width = rect.right.saturating_sub(rect.left);
    let height = rect.bottom.saturating_sub(rect.top);
    (width > 0 && height > 0).then_some((width as u32, height as u32))
}

#[cfg(target_os = "macos")]
fn plugin_content_scale(_display_scale: f64, zoom: f64) -> f32 {
    zoom as f32
}

#[cfg(not(target_os = "macos"))]
fn plugin_content_scale(display_scale: f64, zoom: f64) -> f32 {
    (display_scale * zoom) as f32
}

fn frame_scale(strategy: ScaleStrategy, display_scale: f64, zoom: f64) -> f64 {
    if strategy != ScaleStrategy::Platform {
        1.0
    } else if cfg!(target_os = "macos") {
        zoom
    } else if cfg!(target_os = "windows") {
        display_scale
    } else {
        1.0
    }
}

fn geometry(
    rect: ViewRect,
    strategy: ScaleStrategy,
    display_scale: f64,
    zoom: f64,
    top_inset: u32,
) -> NativeContainerGeometry {
    let (content_width, content_height) = rect_extent(rect).unwrap_or((1, 1));
    let scale = frame_scale(strategy, display_scale, zoom);
    NativeContainerGeometry {
        x: 0,
        y: top_inset.min(i32::MAX as u32) as i32,
        parent_height: top_inset
            .saturating_add((f64::from(content_height) * scale).round().max(1.0) as u32),
        frame_width: (f64::from(content_width) * scale).round().max(1.0) as u32,
        frame_height: (f64::from(content_height) * scale).round().max(1.0) as u32,
        content_width,
        content_height,
    }
}

fn electron_extent(
    rect: ViewRect,
    strategy: ScaleStrategy,
    display_scale: f64,
    zoom: f64,
) -> (u32, u32) {
    let geometry = geometry(rect, strategy, display_scale, zoom, 0);
    (
        electron_dimension(geometry.frame_width, display_scale),
        electron_dimension(geometry.frame_height, display_scale),
    )
}

#[cfg(target_os = "macos")]
fn electron_dimension(value: u32, _display_scale: f64) -> u32 {
    value.max(1)
}

#[cfg(not(target_os = "macos"))]
fn electron_dimension(value: u32, display_scale: f64) -> u32 {
    (f64::from(value) / display_scale.max(0.01))
        .round()
        .max(1.0) as u32
}

#[cfg(test)]
mod tests {
    use super::*;
    use heron_dsp_runtime::protocol::{
        LiveLatencyPolicy, LiveMixerChannel, LiveMixerGraph, LivePluginAuxInputBus,
        LivePluginInstance, PluginAudioMode,
    };

    fn channel(id: &str, output: Option<&str>) -> LiveMixerChannel {
        LiveMixerChannel {
            id: id.to_owned(),
            name: id.to_owned(),
            color: String::new(),
            kind: "audio".to_owned(),
            system_role: None,
            gain_db: 0.0,
            pan: 0.0,
            muted: false,
            soloed: false,
            output_channel_id: output.map(str::to_owned),
            output_bus: None,
            record_armed: false,
            input_monitoring: false,
            application_capture: None,
            midi_input_port_id: None,
            midi_input_port_name: None,
            midi_input_channel: None,
            input_source: None,
            input_channels: Vec::new(),
            hardware_output_channels: Vec::new(),
        }
    }

    fn graph() -> LiveMixerGraph {
        LiveMixerGraph {
            sample_rate: 48_000,
            project_end_tick: 61_440,
            latency_policy: LiveLatencyPolicy::Normal,
            channels: vec![channel("target", None), channel("source", None)],
            sends: Vec::new(),
            clips: Vec::new(),
            plugins: vec![LivePluginInstance {
                instance_id: "effect".to_owned(),
                channel_id: "target".to_owned(),
                role: "effect".to_owned(),
                slot_order: 0,
                audio_mode: PluginAudioMode::Stereo,
                enabled: true,
                aux_input_buses: vec![LivePluginAuxInputBus {
                    input_port_key: "vst3:audio:input:1".into(),
                    name: "Side Chain".to_owned(),
                    channels: 2,
                    source_channel_id: None,
                }],
                latency_samples: 0,
                tail_samples: Some(0),
            }],
            midi_clips: Vec::new(),
            tempo_events: Vec::new(),
            time_signature_events: Vec::new(),
        }
    }

    #[test]
    fn sidechain_view_exposes_aux_bus_and_valid_source() {
        let graph = graph();
        let (buses, sources) = sidechain_view_for_graph(Some(&graph), "effect").unwrap();
        assert_eq!(buses[0].input_port_key, "vst3:audio:input:1");
        assert_eq!(sources[0].id, "source");
    }

    #[test]
    fn sidechain_cycle_detection_rejects_downstream_sources() {
        let mut graph = graph();
        graph.channels[0].output_channel_id = Some("source".to_owned());
        assert!(sidechain_route_would_cycle(&graph, "target", "source"));
    }
}
