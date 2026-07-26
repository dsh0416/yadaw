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

impl EditorWindow {
    pub fn new(
        instance_id: String,
        class_id: String,
        preference: PluginEditorPreference,
        parameters: Vec<PluginParameter>,
        window: Arc<Window>,
        compositor: &mut Compositor,
    ) -> Self {
        let physical_size = window.inner_size();
        let monitor_scale = window.scale_factor();
        let user_zoom = f64::from(preference.zoom_percent) / 100.0;
        let effective_scale = effective_iced_scale(monitor_scale, user_zoom);
        let renderer = compositor.create_renderer();
        let surface = compositor.create_surface(
            window.clone(),
            physical_size.width.max(1),
            physical_size.height.max(1),
        );
        let viewport = Viewport::with_physical_size(
            Size::new(physical_size.width.max(1), physical_size.height.max(1)),
            effective_scale as f32,
        );
        Self {
            instance_id,
            class_id,
            window: window.clone(),
            preference,
            active_mode: PluginEditorMode::Parameters,
            parameters,
            warning: None,
            zoom_input: preference.zoom_percent.to_string(),
            zoom_dirty: false,
            open_menu: None,
            active_gestures: HashSet::new(),
            monitor_scale: Rc::new(Cell::new(monitor_scale)),
            user_zoom: Rc::new(Cell::new(user_zoom)),
            viewport,
            renderer,
            surface,
            cache: Cache::new(),
            clipboard: Clipboard::connect(window),
            cursor: Cursor::Unavailable,
            modifiers: ModifiersState::default(),
            platform_context: None,
            native: None,
        }
    }

    #[must_use]
    pub fn active_mode(&self) -> PluginEditorMode {
        self.active_mode
    }

    #[must_use]
    pub fn preference(&self) -> PluginEditorPreference {
        self.preference
    }

    pub fn activate_initial_mode(&mut self, runtime: &Vst3Runtime) {
        if self.preference.mode == PluginEditorMode::Native {
            if let Err(error) = self.attach_native(runtime) {
                self.warning = Some(match self.refresh_parameters(runtime) {
                    Ok(()) => error,
                    Err(parameter_error) => format!("{error} {parameter_error}"),
                });
                self.active_mode = PluginEditorMode::Parameters;
                self.request_parameter_window_size();
            }
        } else {
            if let Err(error) = self.refresh_parameters(runtime) {
                self.warning = Some(error);
            }
            self.request_parameter_window_size();
        }
        self.window.request_redraw();
    }

    pub fn focus(&self) {
        self.window.focus_window();
        if let Some(native) = &self.native {
            native.container.borrow().focus();
        }
    }

    pub fn close(&mut self) {
        if let Some(native) = self.native.take() {
            native.detach();
        }
        self.active_gestures.clear();
    }

    pub fn handle_event(
        &mut self,
        event: WindowEvent,
        compositor: &mut Compositor,
    ) -> Vec<EditorAction> {
        let mut actions = Vec::new();
        match &event {
            WindowEvent::CloseRequested => {
                actions.push(EditorAction::Close);
                return actions;
            }
            WindowEvent::Resized(size) => {
                self.resize_surface(*size, compositor);
                self.resize_native_to_window();
            }
            WindowEvent::ScaleFactorChanged { scale_factor, .. } => {
                self.monitor_scale.set(*scale_factor);
                self.rebuild_viewport();
                if let Some(native) = &self.native {
                    let factor =
                        plugin_content_scale(self.monitor_scale.get(), self.user_zoom.get());
                    match native.view.set_content_scale_factor(factor) {
                        Ok(true) => {}
                        Ok(false) | Err(_) => {
                            self.warning = Some(
                                "This plug-in does not support native UI scaling; \
                                 shell scaling is still applied."
                                    .into(),
                            );
                        }
                    }
                }
                self.layout_native_preferred();
            }
            WindowEvent::CursorMoved { position, .. } => {
                let logical = position.to_logical::<f64>(self.effective_scale());
                self.cursor = Cursor::Available(Point::new(logical.x as f32, logical.y as f32));
            }
            WindowEvent::CursorLeft { .. } => self.cursor = Cursor::Unavailable,
            WindowEvent::ModifiersChanged(modifiers) => self.modifiers = modifiers.state(),
            WindowEvent::Focused(false) => {
                if let Some(action) = self.commit_zoom_input() {
                    actions.push(action);
                }
            }
            WindowEvent::MouseInput {
                state: ElementState::Pressed,
                button: MouseButton::Left,
                ..
            } if self.zoom_dirty => {
                if let Some(action) = self.commit_zoom_input() {
                    actions.push(action);
                }
            }
            WindowEvent::KeyboardInput { event, .. }
                if event.state == ElementState::Pressed && !event.repeat =>
            {
                match &event.logical_key {
                    Key::Named(NamedKey::Escape) if self.zoom_dirty => {
                        self.zoom_input = self.preference.zoom_percent.to_string();
                        self.zoom_dirty = false;
                        self.window.request_redraw();
                    }
                    Key::Named(NamedKey::Enter) if self.zoom_dirty => {
                        if let Some(action) = self.commit_zoom_input() {
                            actions.push(action);
                        }
                    }
                    _ => {}
                }
            }
            _ => {}
        }

        let Some(event) =
            conversion::window_event(event, self.effective_scale() as f32, self.modifiers)
        else {
            return actions;
        };
        let logical_size = self.viewport.logical_size();
        let model = self.view_model();
        let view = Self::view(&model);
        let mut interface = UserInterface::build(
            view,
            logical_size,
            std::mem::take(&mut self.cache),
            &mut self.renderer,
        );
        let mut messages = Vec::new();
        interface.update(
            &[event],
            self.cursor,
            &mut self.renderer,
            &mut self.clipboard,
            &mut messages,
        );
        self.cache = interface.into_cache();
        let received_message = !messages.is_empty();
        for message in messages {
            self.update(message, &mut actions);
        }
        if received_message || !actions.is_empty() {
            self.window.request_redraw();
        }
        actions
    }

    pub fn draw(&mut self, compositor: &mut Compositor) {
        let logical_size = self.viewport.logical_size();
        let model = self.view_model();
        let view = Self::view(&model);
        let mut interface = UserInterface::build(
            view,
            logical_size,
            std::mem::take(&mut self.cache),
            &mut self.renderer,
        );
        // `UserInterface::build` restores widget state, but iced only computes
        // the overlay layout during `update`. Event handling and drawing use
        // separate interface instances here, so rebuild the overlay before
        // drawing open pick lists.
        let mut messages = Vec::new();
        interface.update(
            &[],
            self.cursor,
            &mut self.renderer,
            &mut self.clipboard,
            &mut messages,
        );
        interface.draw(
            &mut self.renderer,
            &Theme::TokyoNight,
            &renderer::Style {
                text_color: Color::from_rgb8(231, 235, 241),
            },
            self.cursor,
        );
        self.cache = interface.into_cache();
        if let Err(error) = compositor.present(
            &mut self.renderer,
            &mut self.surface,
            &self.viewport,
            Color::from_rgb8(19, 22, 29),
            || {},
        ) {
            self.warning = Some(format!("Editor shell rendering failed: {error}"));
        }
    }

    pub fn apply_action(
        &mut self,
        action: EditorAction,
        runtime: &mut Vst3Runtime,
    ) -> Option<PluginEditorPreference> {
        match action {
            EditorAction::Close => None,
            EditorAction::PreferenceChanged(preference) => {
                let mode_changed = preference.mode != self.preference.mode;
                let zoom_changed = preference.zoom_percent != self.preference.zoom_percent;
                self.preference = preference;
                self.zoom_input = preference.zoom_percent.to_string();
                self.zoom_dirty = false;
                self.user_zoom
                    .set(f64::from(preference.zoom_percent) / 100.0);
                self.rebuild_viewport();

                if mode_changed {
                    self.switch_mode(preference.mode, runtime);
                } else if zoom_changed {
                    self.update_native_scale();
                }
                self.window.request_redraw();
                Some(preference)
            }
            EditorAction::Parameter {
                parameter_id,
                normalized,
                gesture,
            } => {
                if let Err(error) = runtime.set_parameter_from_editor(
                    &self.instance_id,
                    parameter_id,
                    normalized,
                    gesture,
                ) {
                    self.warning = Some(error);
                }
                if gesture != ParameterGesture::Begin
                    && let Some(parameter) = self
                        .parameters
                        .iter_mut()
                        .find(|parameter| parameter.id == parameter_id)
                {
                    parameter.normalized = normalized;
                }
                self.window.request_redraw();
                None
            }
        }
    }

    fn update(&mut self, message: Message, actions: &mut Vec<EditorAction>) {
        match message {
            Message::UseMode(mode) => {
                self.close_toolbar_menu();
                if mode != self.preference.mode {
                    actions.push(EditorAction::PreferenceChanged(PluginEditorPreference {
                        mode,
                        zoom_percent: self.preference.zoom_percent,
                    }));
                }
            }
            Message::ZoomPreset(zoom_percent) => {
                self.close_toolbar_menu();
                actions.push(EditorAction::PreferenceChanged(PluginEditorPreference {
                    mode: self.preference.mode,
                    zoom_percent,
                }));
            }
            Message::ZoomInput(value) => {
                self.zoom_input = value;
                self.zoom_dirty = true;
            }
            Message::ZoomSubmit => {
                if let Some(action) = self.commit_zoom_input() {
                    actions.push(action);
                }
            }
            Message::MenuOpened(menu) => {
                self.open_menu = Some(menu);
                self.set_native_visible(false);
            }
            Message::MenuClosed(menu) => {
                if self.open_menu == Some(menu) {
                    self.open_menu = None;
                    self.set_native_visible(true);
                }
            }
            Message::ParameterChanged(parameter_id, normalized) => {
                if let Some(parameter) = self
                    .parameters
                    .iter_mut()
                    .find(|parameter| parameter.id == parameter_id)
                {
                    parameter.normalized = normalized;
                }
                if self.active_gestures.insert(parameter_id) {
                    actions.push(EditorAction::Parameter {
                        parameter_id,
                        normalized,
                        gesture: ParameterGesture::Begin,
                    });
                }
                actions.push(EditorAction::Parameter {
                    parameter_id,
                    normalized,
                    gesture: ParameterGesture::Perform,
                });
            }
            Message::ParameterReleased(parameter_id) => {
                if self.active_gestures.remove(&parameter_id) {
                    let normalized = self
                        .parameters
                        .iter()
                        .find(|parameter| parameter.id == parameter_id)
                        .map_or(0.0, |parameter| parameter.normalized);
                    actions.push(EditorAction::Parameter {
                        parameter_id,
                        normalized,
                        gesture: ParameterGesture::End,
                    });
                }
            }
        }
    }

    fn view_model(&self) -> EditorViewModel {
        EditorViewModel {
            zoom_input: self.zoom_input.clone(),
            zoom_percent: self.preference.zoom_percent,
            active_mode: self.active_mode,
            warning: self.warning.clone(),
            parameters: if self.active_mode == PluginEditorMode::Parameters {
                self.parameters.clone()
            } else {
                Vec::new()
            },
        }
    }

    fn view(model: &EditorViewModel) -> EditorElement<'_> {
        let mode = pick_list(
            MODE_OPTIONS,
            Some(EditorModeOption::from(model.active_mode)),
            |option| Message::UseMode(option.into()),
        )
        .on_open(Message::MenuOpened(ToolbarMenu::Mode))
        .on_close(Message::MenuClosed(ToolbarMenu::Mode))
        .width(112);
        let zoom_options = ZOOM_PRESETS.map(ZoomOption);
        let zoom = pick_list(
            zoom_options,
            Some(ZoomOption(model.zoom_percent)),
            |option| Message::ZoomPreset(option.0),
        )
        .on_open(Message::MenuOpened(ToolbarMenu::Zoom))
        .on_close(Message::MenuClosed(ToolbarMenu::Zoom))
        .width(76);
        let toolbar = Row::new()
            .spacing(6)
            .padding([12, 10])
            .height(Length::Fixed(TOOLBAR_HEIGHT as f32))
            .push(mode)
            .push(zoom)
            .push(space::horizontal())
            .push(
                text_input("50–400", &model.zoom_input)
                    .on_input(Message::ZoomInput)
                    .on_submit(Message::ZoomSubmit)
                    .width(62),
            )
            .push(text("%"));

        let mut content = Column::new().push(toolbar);
        if let Some(warning) = &model.warning {
            content = content.push(
                container(text(warning).size(13))
                    .padding([6, 14])
                    .width(Length::Fill),
            );
        }

        if model.active_mode == PluginEditorMode::Parameters {
            let parameter_list = if model.parameters.is_empty() {
                Column::new().push(
                    container(text("This plug-in has no editable parameters"))
                        .padding(24)
                        .width(Length::Fill),
                )
            } else {
                model.parameters.iter().fold(
                    Column::new().spacing(10).padding([12, 16]),
                    |column, parameter| {
                        let step = parameter_step(parameter.step_count);
                        let id = parameter.id;
                        let value = parameter.normalized.clamp(0.0, 1.0);
                        let value_text = if parameter.units.is_empty() {
                            format!("{:.1}%", value * 100.0)
                        } else {
                            format!("{:.1}%  {}", value * 100.0, parameter.units)
                        };
                        column.push(
                            Column::new()
                                .spacing(5)
                                .push(
                                    Row::new()
                                        .push(text(&parameter.title))
                                        .push(space::horizontal())
                                        .push(text(value_text).size(13)),
                                )
                                .push(
                                    slider(0.0..=1.0, value, move |normalized| {
                                        Message::ParameterChanged(id, normalized)
                                    })
                                    .step(step)
                                    .on_release(Message::ParameterReleased(id)),
                                ),
                        )
                    },
                )
            };
            content = content.push(
                scrollable(parameter_list)
                    .width(Length::Fill)
                    .height(Length::Fill),
            );
        } else {
            content = content.push(container(text("")).width(Length::Fill).height(Length::Fill));
        }
        container(content)
            .width(Length::Fill)
            .height(Length::Fill)
            .into()
    }

    fn commit_zoom_input(&mut self) -> Option<EditorAction> {
        let Ok(value) = self.zoom_input.parse::<u16>() else {
            return None;
        };
        if !(50..=400).contains(&value) {
            return None;
        }
        self.zoom_dirty = false;
        if value == self.preference.zoom_percent {
            return None;
        }
        Some(EditorAction::PreferenceChanged(PluginEditorPreference {
            mode: self.preference.mode,
            zoom_percent: value,
        }))
    }

    fn switch_mode(&mut self, mode: PluginEditorMode, runtime: &Vst3Runtime) {
        if let Some(native) = self.native.take() {
            native.detach();
        }
        self.warning = None;
        match mode {
            PluginEditorMode::Native => {
                if let Err(error) = self.attach_native(runtime) {
                    // The saved preference remains native. This fallback only describes the
                    // currently active view and is not written back to settings.
                    self.warning = Some(match self.refresh_parameters(runtime) {
                        Ok(()) => error,
                        Err(parameter_error) => format!("{error} {parameter_error}"),
                    });
                    self.active_mode = PluginEditorMode::Parameters;
                    self.request_parameter_window_size();
                } else {
                    self.parameters.clear();
                }
            }
            PluginEditorMode::Parameters => {
                if let Err(error) = self.refresh_parameters(runtime) {
                    self.warning = Some(error);
                }
                self.active_mode = PluginEditorMode::Parameters;
                self.request_parameter_window_size();
            }
        }
    }

    fn refresh_parameters(&mut self, runtime: &Vst3Runtime) -> Result<(), String> {
        match runtime.parameters(&self.instance_id) {
            Ok(parameters) => {
                self.parameters = parameters;
                Ok(())
            }
            Err(error) => {
                self.parameters.clear();
                Err(format!("Could not read the plug-in parameters: {error}"))
            }
        }
    }

    fn attach_native(&mut self, runtime: &Vst3Runtime) -> Result<(), String> {
        // Native editors own their preferred content extent. A minimum intended
        // for the parameter editor would otherwise force small plug-ins into an
        // oversized window and leave blank or clipped child-window space.
        self.window.set_min_inner_size(None::<WinitSize>);
        if self.platform_context.is_none() {
            self.platform_context = Some(NativeUiContext::initialize()?);
        }
        let view = runtime.create_view(&self.instance_id)?;
        let size = view
            .size()
            .map_err(|error| format!("Could not read the plug-in UI size: {error}"))?;
        let width = rect_width(size);
        let height = rect_height(size);
        if width == 0 || height == 0 {
            return Err("The plug-in did not provide a usable native editor size; \
                 switched to Parameters."
                .into());
        }
        self.window.set_resizable(view.can_resize());

        let scale = plugin_content_scale(self.monitor_scale.get(), self.user_zoom.get());
        let scale_supported = view
            .set_content_scale_factor(scale)
            .map_err(|error| format!("Could not set the plug-in UI scale: {error}"))?;
        if !scale_supported {
            self.warning = Some(
                "This plug-in does not support native UI scaling; shell scaling is still applied."
                    .into(),
            );
        }

        let (container_width, container_height) = container_extent(size, self.monitor_scale.get());
        let toolbar = toolbar_platform_extent(self.monitor_scale.get(), self.user_zoom.get());
        let Some(container) = NativeContainer::create(
            &self.window,
            0,
            container_origin(toolbar),
            container_width,
            container_height,
        )?
        else {
            return Err("This display server does not support native VST3 editors; \
                 Wayland currently supports Parameters only."
                .into());
        };
        if !view.supports_platform(container.platform_type()) {
            drop(view);
            drop(container);
            return Err(
                "The plug-in does not support a native editor container on this platform; \
                 switched to Parameters."
                    .into(),
            );
        }

        let container = Rc::new(RefCell::new(container));
        let callback_container = container.clone();
        let callback_window = self.window.clone();
        let callback_monitor_scale = self.monitor_scale.clone();
        let callback_user_zoom = self.user_zoom.clone();
        let attached_size = Rc::new(Cell::new(None));
        let callback_attached_size = attached_size.clone();
        let mut frame = PlugFrame::new(move |raw_view, mut requested| {
            let monitor_scale = callback_monitor_scale.get();
            let user_zoom = callback_user_zoom.get();
            let (width, height) = container_extent(requested, monitor_scale);
            let toolbar = toolbar_platform_extent(monitor_scale, user_zoom);
            callback_container
                .borrow_mut()
                .resize(0, container_origin(toolbar), width, height);
            let physical = outer_physical_extent(requested, monitor_scale, user_zoom);
            let _ = callback_window.request_inner_size(WinitSize::Physical(PhysicalSize::new(
                physical.width.max(1),
                physical.height.max(1),
            )));
            let accepted = unsafe {
                // SAFETY: raw_view is the live IPlugView supplied by this frame callback.
                PlugView::on_size_raw(raw_view, &mut requested).is_ok()
            };
            if accepted {
                callback_attached_size.set(Some(requested));
            }
            accepted
        });

        if let Err(error) = unsafe {
            // SAFETY: frame has a stable Box address and is retained through detach.
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
        if let Err(error) = unsafe {
            // SAFETY: the platform child remains owned by the attachment until removed.
            view.attach(attach_handle, platform_type)
        } {
            let _ = unsafe {
                // SAFETY: null clears the frame before cleanup of a failed attach.
                view.set_frame(std::ptr::null_mut())
            };
            drop(view);
            drop(frame);
            drop(container);
            return Err(format!("Could not attach the plug-in UI: {error}"));
        }
        // `attached` may synchronously call IPlugFrame::resizeView after the
        // plug-in has applied its content scale. Never overwrite that request
        // with the pre-attach rectangle read above.
        let final_size = attached_size
            .get()
            .or_else(|| view.size().ok())
            .unwrap_or(size);
        let (final_width, final_height) = container_extent(final_size, self.monitor_scale.get());
        let toolbar = toolbar_platform_extent(self.monitor_scale.get(), self.user_zoom.get());
        container
            .borrow_mut()
            .resize(0, container_origin(toolbar), final_width, final_height);
        let physical =
            outer_physical_extent(final_size, self.monitor_scale.get(), self.user_zoom.get());
        let _ = self
            .window
            .request_inner_size(WinitSize::Physical(physical));
        self.native = Some(NativeAttachment {
            view,
            frame,
            container,
            scale_supported,
        });
        self.set_native_visible(self.open_menu.is_none());
        self.active_mode = PluginEditorMode::Native;
        Ok(())
    }

    fn update_native_scale(&mut self) {
        let Some(native) = &mut self.native else {
            return;
        };
        let factor = plugin_content_scale(self.monitor_scale.get(), self.user_zoom.get());
        match native.view.set_content_scale_factor(factor) {
            Ok(true) => native.scale_supported = true,
            Ok(false) | Err(_) => {
                native.scale_supported = false;
                self.warning = Some(
                    "This plug-in does not support native UI scaling; \
                     shell scaling is still applied."
                        .into(),
                );
            }
        }
        self.layout_native_preferred();
    }

    fn layout_native_preferred(&mut self) {
        let Some(native) = &mut self.native else {
            return;
        };
        self.window.set_min_inner_size(None::<WinitSize>);
        let Ok(rect) = native.view.size() else {
            return;
        };
        let monitor_scale = self.monitor_scale.get();
        let user_zoom = self.user_zoom.get();
        let (width, height) = container_extent(rect, monitor_scale);
        let toolbar = toolbar_platform_extent(monitor_scale, user_zoom);
        native
            .container
            .borrow_mut()
            .resize(0, container_origin(toolbar), width, height);
        let physical = outer_physical_extent(rect, monitor_scale, user_zoom);
        let _ = self
            .window
            .request_inner_size(WinitSize::Physical(physical));
    }

    fn resize_native_to_window(&mut self) {
        let Some(native) = &mut self.native else {
            return;
        };
        if !native.view.can_resize() {
            return;
        }
        let physical = self.window.inner_size();
        let monitor_scale = self.monitor_scale.get();
        let user_zoom = self.user_zoom.get();
        let toolbar_physical = (TOOLBAR_HEIGHT * monitor_scale * user_zoom).round() as u32;
        let plugin_physical_height = physical.height.saturating_sub(toolbar_physical).max(1);
        let mut rect =
            view_rect_from_physical(physical.width.max(1), plugin_physical_height, monitor_scale);
        let _ = native.view.constrain_size(&mut rect);
        let (width, height) = container_extent(rect, monitor_scale);
        let toolbar = toolbar_platform_extent(monitor_scale, user_zoom);
        native
            .container
            .borrow_mut()
            .resize(0, container_origin(toolbar), width, height);
        let _ = native.view.on_size(&mut rect);
    }

    fn request_parameter_window_size(&self) {
        self.window.set_resizable(true);
        let minimum = PhysicalSize::new(
            (MIN_PARAMETER_WIDTH * self.effective_scale()).round() as u32,
            (MIN_PARAMETER_HEIGHT * self.effective_scale()).round() as u32,
        );
        self.window
            .set_min_inner_size(Some(WinitSize::Physical(minimum)));
        let physical = PhysicalSize::new(
            (DEFAULT_PARAMETER_WIDTH * self.effective_scale()).round() as u32,
            (DEFAULT_PARAMETER_HEIGHT * self.effective_scale()).round() as u32,
        );
        let _ = self
            .window
            .request_inner_size(WinitSize::Physical(physical));
    }

    fn resize_surface(&mut self, size: PhysicalSize<u32>, compositor: &mut Compositor) {
        if size.width == 0 || size.height == 0 {
            return;
        }
        compositor.configure_surface(&mut self.surface, size.width, size.height);
        self.viewport = Viewport::with_physical_size(
            Size::new(size.width, size.height),
            self.effective_scale() as f32,
        );
        self.window.request_redraw();
    }

    fn rebuild_viewport(&mut self) {
        let size = self.window.inner_size();
        self.viewport = Viewport::with_physical_size(
            Size::new(size.width.max(1), size.height.max(1)),
            self.effective_scale() as f32,
        );
    }

    fn effective_scale(&self) -> f64 {
        effective_iced_scale(self.monitor_scale.get(), self.user_zoom.get())
    }

    fn set_native_visible(&self, visible: bool) {
        if let Some(native) = &self.native {
            native.container.borrow().set_visible(visible);
        }
    }

    fn close_toolbar_menu(&mut self) {
        self.open_menu = None;
        self.set_native_visible(true);
    }
}

impl Drop for EditorWindow {
    fn drop(&mut self) {
        self.close();
    }
}

fn parameter_step(step_count: i32) -> f64 {
    if step_count > 0 {
        1.0 / f64::from(step_count)
    } else {
        0.001
    }
}

fn effective_iced_scale(monitor_scale: f64, user_zoom: f64) -> f64 {
    (monitor_scale * user_zoom).max(0.01)
}

#[cfg(target_os = "macos")]
fn plugin_content_scale(_monitor_scale: f64, user_zoom: f64) -> f32 {
    user_zoom as f32
}

#[cfg(not(target_os = "macos"))]
fn plugin_content_scale(monitor_scale: f64, user_zoom: f64) -> f32 {
    (monitor_scale * user_zoom) as f32
}

fn rect_width(rect: ViewRect) -> u32 {
    rect.right.saturating_sub(rect.left).max(0) as u32
}

fn rect_height(rect: ViewRect) -> u32 {
    rect.bottom.saturating_sub(rect.top).max(0) as u32
}

#[cfg(target_os = "macos")]
fn container_extent(rect: ViewRect, _monitor_scale: f64) -> (u32, u32) {
    (rect_width(rect), rect_height(rect))
}

#[cfg(not(target_os = "macos"))]
fn container_extent(rect: ViewRect, _monitor_scale: f64) -> (u32, u32) {
    (rect_width(rect), rect_height(rect))
}

#[cfg(target_os = "macos")]
fn toolbar_platform_extent(monitor_scale: f64, user_zoom: f64) -> u32 {
    let _ = monitor_scale;
    (TOOLBAR_HEIGHT * user_zoom).round() as u32
}

#[cfg(not(target_os = "macos"))]
fn toolbar_platform_extent(monitor_scale: f64, user_zoom: f64) -> u32 {
    (TOOLBAR_HEIGHT * monitor_scale * user_zoom).round() as u32
}

#[cfg(target_os = "macos")]
fn container_origin(_toolbar: u32) -> i32 {
    0
}

#[cfg(not(target_os = "macos"))]
fn container_origin(toolbar: u32) -> i32 {
    toolbar as i32
}

fn outer_physical_extent(rect: ViewRect, monitor_scale: f64, user_zoom: f64) -> PhysicalSize<u32> {
    #[cfg(target_os = "macos")]
    let (plugin_width, plugin_height) = (
        (f64::from(rect_width(rect)) * monitor_scale).round() as u32,
        (f64::from(rect_height(rect)) * monitor_scale).round() as u32,
    );
    #[cfg(not(target_os = "macos"))]
    let (plugin_width, plugin_height) = (rect_width(rect), rect_height(rect));
    PhysicalSize::new(
        plugin_width.max(1),
        plugin_height
            .saturating_add((TOOLBAR_HEIGHT * monitor_scale * user_zoom).round() as u32)
            .max(1),
    )
}

#[cfg(target_os = "macos")]
fn view_rect_from_physical(width: u32, height: u32, monitor_scale: f64) -> ViewRect {
    ViewRect {
        left: 0,
        top: 0,
        right: (f64::from(width) / monitor_scale).round() as i32,
        bottom: (f64::from(height) / monitor_scale).round() as i32,
    }
}

#[cfg(not(target_os = "macos"))]
fn view_rect_from_physical(width: u32, height: u32, _monitor_scale: f64) -> ViewRect {
    ViewRect {
        left: 0,
        top: 0,
        right: width as i32,
        bottom: height as i32,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn continuous_and_discrete_parameter_steps_are_distinct() {
        assert_eq!(parameter_step(0), 0.001);
        assert_eq!(parameter_step(4), 0.25);
    }

    #[test]
    fn iced_scale_multiplies_monitor_and_user_zoom() {
        assert_eq!(effective_iced_scale(1.5, 1.25), 1.875);
    }

    #[test]
    fn zoom_boundaries_are_representable() {
        assert_eq!(effective_iced_scale(1.0, 0.5), 0.5);
        assert_eq!(effective_iced_scale(1.0, 4.0), 4.0);
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn windows_and_x11_use_physical_view_rects() {
        assert_eq!(view_rect_from_physical(900, 600, 1.5).right, 900);
        assert_eq!(plugin_content_scale(1.5, 1.25), 1.875);
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn native_outer_extent_keeps_the_attached_plugin_pixel_size() {
        let attached = ViewRect {
            left: 0,
            top: 0,
            right: 525,
            bottom: 180,
        };
        assert_eq!(
            outer_physical_extent(attached, 1.5, 1.0),
            PhysicalSize::new(525, 288)
        );
    }

    #[test]
    fn toolbar_dropdown_options_have_compact_labels() {
        assert_eq!(EditorModeOption::Native.to_string(), "Plug-in UI");
        assert_eq!(EditorModeOption::Parameters.to_string(), "Parameters");
        assert_eq!(ZoomOption(125).to_string(), "125%");
    }
}
