use std::{
    cell::{Cell, RefCell},
    collections::HashSet,
    fmt,
    rc::Rc,
    sync::Arc,
};

use iced_core::{Color, Element, Length, Point, Size, mouse::Cursor, renderer};
use iced_tiny_skia::{
    Renderer,
    graphics::{Compositor as _, Viewport},
    window::{Compositor, Surface},
};
use iced_widget::{
    Column, Row, Theme, container, pick_list, scrollable, slider, space, text, text_input,
};
use iced_winit::{
    Clipboard, conversion,
    runtime::user_interface::{Cache, UserInterface},
};
use winit::{
    dpi::{PhysicalSize, Size as WinitSize},
    event::{ElementState, MouseButton, WindowEvent},
    keyboard::{Key, ModifiersState, NamedKey},
    window::Window,
};
use yadaw_dsp_runtime::protocol::{
    ParameterGesture, PluginEditorMode, PluginEditorPreference, PluginParameter,
};
use yadaw_vst3_host::{PlugFrame, PlugView, ViewRect};

use crate::{
    editor_platform::{NativeContainer, NativeUiContext},
    vst3::Vst3Runtime,
};

const TOOLBAR_HEIGHT: f64 = 72.0;
const DEFAULT_PARAMETER_WIDTH: f64 = 720.0;
const DEFAULT_PARAMETER_HEIGHT: f64 = 640.0;
const MIN_PARAMETER_WIDTH: f64 = 480.0;
const MIN_PARAMETER_HEIGHT: f64 = 240.0;
const ZOOM_PRESETS: [u16; 6] = [75, 100, 125, 150, 175, 200];
const MODE_OPTIONS: [EditorModeOption; 2] =
    [EditorModeOption::Native, EditorModeOption::Parameters];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EditorModeOption {
    Native,
    Parameters,
}

impl From<PluginEditorMode> for EditorModeOption {
    fn from(mode: PluginEditorMode) -> Self {
        match mode {
            PluginEditorMode::Native => Self::Native,
            PluginEditorMode::Parameters => Self::Parameters,
        }
    }
}

impl From<EditorModeOption> for PluginEditorMode {
    fn from(option: EditorModeOption) -> Self {
        match option {
            EditorModeOption::Native => Self::Native,
            EditorModeOption::Parameters => Self::Parameters,
        }
    }
}

impl fmt::Display for EditorModeOption {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Native => "Plug-in UI",
            Self::Parameters => "Parameters",
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ZoomOption(u16);

impl fmt::Display for ZoomOption {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}%", self.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ToolbarMenu {
    Mode,
    Zoom,
}

type EditorElement<'a> = Element<'a, Message, Theme, Renderer>;

#[derive(Debug, Clone)]
enum Message {
    UseMode(PluginEditorMode),
    ZoomPreset(u16),
    ZoomInput(String),
    ZoomSubmit,
    MenuOpened(ToolbarMenu),
    MenuClosed(ToolbarMenu),
    ParameterChanged(u32, f64),
    ParameterReleased(u32),
}

#[derive(Clone)]
struct EditorViewModel {
    zoom_input: String,
    zoom_percent: u16,
    active_mode: PluginEditorMode,
    warning: Option<String>,
    parameters: Vec<PluginParameter>,
}

#[derive(Debug)]
pub enum EditorAction {
    Close,
    PreferenceChanged(PluginEditorPreference),
    Parameter {
        parameter_id: u32,
        normalized: f64,
        gesture: ParameterGesture,
    },
}

struct NativeAttachment {
    view: PlugView,
    frame: Box<PlugFrame>,
    container: Rc<RefCell<NativeContainer>>,
    scale_supported: bool,
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
    active_mode: PluginEditorMode,
    parameters: Vec<PluginParameter>,
    warning: Option<String>,
    zoom_input: String,
    zoom_dirty: bool,
    open_menu: Option<ToolbarMenu>,
    active_gestures: HashSet<u32>,
    monitor_scale: Rc<Cell<f64>>,
    user_zoom: Rc<Cell<f64>>,
    viewport: Viewport,
    renderer: Renderer,
    surface: Surface,
    cache: Cache,
    clipboard: Clipboard,
    cursor: Cursor,
    modifiers: ModifiersState,
    platform_context: Option<NativeUiContext>,
    native: Option<NativeAttachment>,
}

include!("editor_window/lifecycle.rs");
include!("editor_window/view.rs");
include!("editor_window/native.rs");
include!("editor_window/helpers.rs");
include!("editor_window/tests.rs");
