use std::{
    cell::{Cell, RefCell},
    collections::{HashMap, HashSet, VecDeque},
    fmt,
    rc::Rc,
    sync::Arc,
    time::Instant,
};

use iced_core::{Border, Color, Element, Length, Point, Rectangle, Size, mouse::Cursor, renderer};
use iced_wgpu::{
    Renderer,
    graphics::{Compositor as _, Viewport},
    window::Compositor,
};
use iced_widget::{
    Column, Row, Theme, button, container, mouse_area, opaque, pick_list, scrollable, slider,
    space, stack, text,
};
use iced_winit::{
    Clipboard, conversion,
    runtime::user_interface::{Cache, UserInterface},
};
use winit::{
    dpi::{PhysicalPosition, PhysicalSize, Size as WinitSize},
    event::{ElementState, WindowEvent},
    keyboard::{Key, ModifiersState, NamedKey},
    window::Window,
};
use yadaw_dsp_runtime::protocol::{
    LiveMixerGraph, ParameterGesture, PluginEditorAppearance, PluginEditorContext,
    PluginEditorLocale, PluginEditorMode, PluginEditorPreference, PluginEditorTheme,
    PluginParameter,
};
use yadaw_iced_ui::{
    Appearance, CascadingMenuEntry, EDITOR_CHROME_HEIGHT, space as ui_space, type_size,
};
use yadaw_vst3_host::{PlugFrame, PlugView, ViewRect};

use crate::{
    editor_platform::{
        NativeContainer, NativeContainerGeometry, NativeUiContext, with_native_child_scale_context,
    },
    vst3::{EditorPluginState, Vst3Runtime},
};

const TOOLBAR_HEIGHT_WIDE: f64 = EDITOR_CHROME_HEIGHT as f64;
const TOOLBAR_HEIGHT_NARROW: f64 = 96.0;
const TOOLBAR_NARROW_BREAKPOINT: f32 = 520.0;
const COMPARE_SEGMENT_WIDTH: f32 = 28.0;
const DEFAULT_PARAMETER_WIDTH: f64 = 720.0;
const DEFAULT_PARAMETER_HEIGHT: f64 = 640.0;
/// Fallback content size when `IPlugView::getSize` fails or returns an empty
/// rect. Adaptive / HiDPI editors often defer a real size until `attached` or
/// `IPlugFrame::resizeView`.
const DEFAULT_NATIVE_EDITOR_WIDTH: i32 = 800;
const DEFAULT_NATIVE_EDITOR_HEIGHT: i32 = 600;
const MIN_PARAMETER_WIDTH: f64 = 480.0;
const MIN_PARAMETER_HEIGHT: f64 = 240.0;
const ZOOM_PRESETS: [u16; 10] = [50, 75, 100, 125, 150, 175, 200, 250, 300, 400];
const PARAMETER_HISTORY_LIMIT: usize = 128;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ZoomOption(u16);

impl fmt::Display for ZoomOption {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}%", self.0)
    }
}

fn zoom_options(current: u16) -> Vec<ZoomOption> {
    let mut options = ZOOM_PRESETS.map(ZoomOption).to_vec();
    if let Err(index) = options.binary_search_by_key(&current, |option| option.0) {
        options.insert(index, ZoomOption(current));
    }
    options
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum ToolbarMenu {
    Mode,
    Zoom,
    Sidechain,
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
    input_bus_index: u32,
    name: String,
    source_channel_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SidechainMenuState {
    bus: usize,
    group: Option<SidechainSourceKind>,
    level: usize,
    focused: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PendingSidechainRequest {
    request_id: u64,
    input_bus_index: u32,
    source_channel_id: Option<String>,
    displayed_source_channel_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ToolbarMenuChoice {
    Mode(PluginEditorMode),
    Zoom(u16),
    SidechainRoute {
        input_bus_index: u32,
        source_channel_id: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ToolbarMenuOption {
    pub(crate) choice: ToolbarMenuChoice,
    pub(crate) label: String,
}

#[derive(Debug, Clone)]
pub(crate) struct ToolbarMenuRequest {
    pub(crate) menu: ToolbarMenu,
    pub(crate) anchor: Rectangle,
    pub(crate) options: Vec<ToolbarMenuOption>,
    pub(crate) selected: ToolbarMenuChoice,
    pub(crate) appearance: Appearance,
    pub(crate) effective_scale: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct EditorModeOption {
    mode: PluginEditorMode,
    label: &'static str,
}

impl fmt::Display for EditorModeOption {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.label)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CompareSlot {
    A,
    B,
}

impl CompareSlot {
    const fn index(self) -> usize {
        match self {
            Self::A => 0,
            Self::B => 1,
        }
    }
}

fn restore_compare_slot(
    slots: &mut [EditorPluginState; 2],
    current_slot: CompareSlot,
    target_slot: CompareSlot,
    current_state: EditorPluginState,
    restore: impl FnOnce(&EditorPluginState) -> Result<(), String>,
) -> Result<(), String> {
    let target_state = slots[target_slot.index()].clone();
    restore(&target_state)?;
    slots[current_slot.index()] = current_state;
    Ok(())
}

fn update_active_compare_slot(
    slots: &mut Option<[EditorPluginState; 2]>,
    active_slot: CompareSlot,
    state: EditorPluginState,
) {
    if let Some(slots) = slots {
        slots[active_slot.index()] = state;
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct ParameterEdit {
    parameter_id: u32,
    before: f64,
    after: f64,
}

#[derive(Debug, Clone)]
pub(crate) struct EditorClipboard {
    pub(crate) class_id: String,
    pub(crate) state: EditorPluginState,
}

impl EditorClipboard {
    fn supports(&self, class_id: &str) -> bool {
        self.class_id == class_id
    }
}

#[derive(Debug, Clone, Copy)]
struct EditorStrings {
    editor: &'static str,
    parameters: &'static str,
    copy: &'static str,
    paste: &'static str,
    undo: &'static str,
    redo: &'static str,
    empty_parameters: &'static str,
    sidechain: &'static str,
    none: &'static str,
    audio: &'static str,
    instrument: &'static str,
    aux: &'static str,
    pending: &'static str,
}

impl EditorStrings {
    const fn for_locale(locale: PluginEditorLocale) -> Self {
        match locale {
            PluginEditorLocale::EnUs => Self {
                editor: "Editor",
                parameters: "Parameters",
                copy: "Copy",
                paste: "Paste",
                undo: "Undo",
                redo: "Redo",
                empty_parameters: "This plug-in has no editable parameters",
                sidechain: "Side-chain",
                none: "None",
                audio: "Audio",
                instrument: "Instrument",
                aux: "Aux",
                pending: "Pending…",
            },
            PluginEditorLocale::ZhCmnHansCn => Self {
                editor: "编辑器",
                parameters: "参数",
                copy: "拷贝",
                paste: "粘贴",
                undo: "撤销",
                redo: "重做",
                empty_parameters: "此插件没有可编辑参数",
                sidechain: "侧链",
                none: "无",
                audio: "音频",
                instrument: "乐器",
                aux: "辅助",
                pending: "正在提交…",
            },
        }
    }
}

type EditorElement<'a> = Element<'a, Message, Theme, Renderer>;

#[derive(Debug, Clone)]
enum Message {
    UseMode(PluginEditorMode),
    UseCompareSlot(CompareSlot),
    CopyState,
    PasteState,
    Undo,
    Redo,
    ZoomPreset(u16),
    ToolbarTriggerHovered(ToolbarMenu, Point),
    OpenToolbarMenu(ToolbarMenu),
    MenuOpened(ToolbarMenu),
    MenuClosed(ToolbarMenu),
    SidechainBus(usize),
    SidechainGroup(SidechainSourceKind),
    SidechainRoute(u32, Option<String>),
    ParameterChanged(u32, f64),
    ParameterReleased(u32),
}

#[derive(Clone)]
struct EditorViewModel {
    context: PluginEditorContext,
    zoom_percent: u16,
    toolbar_height: f32,
    narrow_toolbar: bool,
    active_mode: PluginEditorMode,
    open_menu: Option<ToolbarMenu>,
    warning: Option<String>,
    parameters: Vec<PluginParameter>,
    compare_slot: CompareSlot,
    can_compare: bool,
    can_paste: bool,
    can_undo: bool,
    can_redo: bool,
    sidechain_buses: Vec<SidechainBus>,
    sidechain_sources: Vec<SidechainSource>,
    sidechain_menu: Option<SidechainMenuState>,
    pending_sidechain: Option<PendingSidechainRequest>,
}

#[derive(Debug)]
pub(crate) enum EditorAction {
    Close,
    OpenToolbarMenu(ToolbarMenuRequest),
    PreferenceChanged(PluginEditorPreference),
    UseCompareSlot(CompareSlot),
    CopyState,
    PasteState,
    Undo,
    Redo,
    Parameter {
        parameter_id: u32,
        normalized: f64,
        gesture: ParameterGesture,
    },
    SidechainRoute {
        input_bus_index: u32,
        source_channel_id: Option<String>,
    },
}

struct NativeAttachment {
    view: PlugView,
    frame: Box<PlugFrame>,
    container: Rc<RefCell<NativeContainer>>,
    scale_strategy: NativeScaleStrategy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NativeScaleStrategy {
    /// The plug-in accepted `IPlugViewContentScaleSupport` and owns rendering
    /// and size changes for the requested scale.
    Plugin,
    /// The platform scales only the native plug-in child/container.
    Platform,
    /// Neither the plug-in nor this platform can scale the native child.
    Unscaled,
}

impl NativeScaleStrategy {
    fn resolve(plugin_scaled: bool, platform_fallback: bool) -> Self {
        if plugin_scaled {
            Self::Plugin
        } else if platform_fallback {
            Self::Platform
        } else {
            Self::Unscaled
        }
    }

    const fn uses_platform_fallback(self) -> bool {
        matches!(self, Self::Platform)
    }
}

impl NativeAttachment {
    fn detach(self) {
        self.view.removed();
        let _ = unsafe {
            // SAFETY: null clears the frame before the view and frame are released.
            self.view.set_frame(std::ptr::null_mut())
        };
        // Drop order is intentional: view, frame, and then the platform child.
        let NativeAttachment {
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

pub struct EditorWindow {
    pub instance_id: String,
    pub class_id: String,
    pub window: Arc<Window>,
    preference: PluginEditorPreference,
    context: PluginEditorContext,
    active_mode: PluginEditorMode,
    parameters: Vec<PluginParameter>,
    warning: Option<String>,
    native_scale_warning: Option<String>,
    open_menu: Option<ToolbarMenu>,
    toolbar_anchors: HashMap<ToolbarMenu, Rectangle>,
    compare_segment_focused: bool,
    active_gestures: HashSet<u32>,
    compare_slots: Option<[EditorPluginState; 2]>,
    compare_slot: CompareSlot,
    can_paste: bool,
    undo: VecDeque<ParameterEdit>,
    redo: VecDeque<ParameterEdit>,
    pending_edits: HashMap<u32, f64>,
    sidechain_buses: Vec<SidechainBus>,
    sidechain_sources: Vec<SidechainSource>,
    sidechain_menu: Option<SidechainMenuState>,
    pending_sidechain: Option<PendingSidechainRequest>,
    monitor_scale: Rc<Cell<f64>>,
    user_zoom: Rc<Cell<f64>>,
    viewport: Viewport,
    renderer: Renderer,
    surface: iced_wgpu::wgpu::Surface<'static>,
    cache: Cache,
    clipboard: Clipboard,
    cursor: Cursor,
    modifiers: ModifiersState,
    platform_context: Option<NativeUiContext>,
    platform_scale_fallback: bool,
    native: Option<NativeAttachment>,
}

include!("editor_window/lifecycle.rs");
include!("editor_window/view.rs");
include!("editor_window/menu_window.rs");
include!("editor_window/native.rs");
include!("editor_window/helpers.rs");
include!("editor_window/tests.rs");
