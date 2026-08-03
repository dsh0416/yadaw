const TOOLBAR_MENU_ROW_HEIGHT: f32 = 24.0;
const TOOLBAR_MENU_PADDING: f32 = 4.0;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum EditorMenuAction {
    Dismiss,
    Selected(ToolbarMenuChoice),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ToolbarMenuGeometry {
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    visible_rows: usize,
    opens_upward: bool,
}

#[derive(Debug, Clone, Copy)]
enum EditorMenuMessage {
    Select(usize),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MenuKeyResult {
    None,
    Dismiss,
    Select,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct MenuFocusState {
    ignore_initial_focus_lost: bool,
}

impl MenuFocusState {
    const fn new(ignore_initial_focus_lost: bool) -> Self {
        Self {
            ignore_initial_focus_lost,
        }
    }

    fn should_dismiss(&mut self, focused: bool) -> bool {
        if focused {
            return false;
        }
        if self.ignore_initial_focus_lost {
            self.ignore_initial_focus_lost = false;
            return false;
        }
        true
    }
}

type EditorMenuElement<'a> = Element<'a, EditorMenuMessage, Theme, Renderer>;

struct EditorMenuState {
    options: Vec<ToolbarMenuOption>,
    selected: ToolbarMenuChoice,
    highlighted: usize,
    appearance: Appearance,
    effective_scale: f64,
    cursor: Cursor,
    modifiers: ModifiersState,
    focus: MenuFocusState,
}

impl EditorMenuState {
    fn new(request: ToolbarMenuRequest) -> (ToolbarMenu, Self) {
        let highlighted = initial_toolbar_highlight(&request.options, &request.selected);
        (
            request.menu,
            Self {
                options: request.options,
                selected: request.selected,
                highlighted,
                appearance: request.appearance,
                effective_scale: request.effective_scale,
                cursor: Cursor::Unavailable,
                modifiers: ModifiersState::default(),
                // winit's macOS backend queues one synthetic `Focused(false)` as
                // part of window creation. `focus_window` can make the real
                // `Focused(true)` arrive first, so the first lost-focus event must
                // be consumed regardless of event order.
                focus: MenuFocusState::new(cfg!(target_os = "macos")),
            },
        )
    }

    fn focus_changed(&mut self, focused: bool) -> Option<EditorMenuAction> {
        self.focus
            .should_dismiss(focused)
            .then_some(EditorMenuAction::Dismiss)
    }

    fn cursor_moved(&mut self, position: PhysicalPosition<f64>) {
        let logical = position.to_logical::<f64>(self.effective_scale);
        self.cursor = Cursor::Available(Point::new(logical.x as f32, logical.y as f32));
    }

    fn cursor_left(&mut self) {
        self.cursor = Cursor::Unavailable;
    }

    fn modifiers_changed(&mut self, modifiers: ModifiersState) {
        self.modifiers = modifiers;
    }

    fn key_pressed(&mut self, key: &Key) -> Option<EditorMenuAction> {
        match toolbar_menu_key(key, &mut self.highlighted, self.options.len()) {
            MenuKeyResult::Select => self.select(self.highlighted),
            MenuKeyResult::Dismiss => Some(EditorMenuAction::Dismiss),
            MenuKeyResult::None => None,
        }
    }

    fn select(&self, index: usize) -> Option<EditorMenuAction> {
        self.options
            .get(index)
            .map(|option| EditorMenuAction::Selected(option.choice.clone()))
    }

    fn view(&self) -> EditorMenuElement<'_> {
        let rows = self.options.iter().enumerate().fold(
            Column::new().spacing(0),
            |column, (index, option)| {
                column.push(
                    button(
                        container(text(&option.label).size(type_size::CONTROL))
                            .padding([0, 6])
                            .center_y(Length::Fill),
                    )
                    .on_press(EditorMenuMessage::Select(index))
                    .width(Length::Fill)
                    .height(Length::Fixed(TOOLBAR_MENU_ROW_HEIGHT))
                    .padding(0)
                    .style(heron_iced_ui::popup_menu_row(
                        self.appearance,
                        option.choice == self.selected,
                        index == self.highlighted,
                    )),
                )
            },
        );
        container(scrollable(rows).width(Length::Fill).height(Length::Fill))
            .padding(TOOLBAR_MENU_PADDING as u16)
            .width(Length::Fill)
            .height(Length::Fill)
            .style(heron_iced_ui::popup_surface(self.appearance))
            .into()
    }
}

pub(crate) struct EditorMenuWindow {
    pub(crate) owner_id: winit::window::WindowId,
    pub(crate) menu: ToolbarMenu,
    window: Arc<Window>,
    state: EditorMenuState,
    viewport: Viewport,
    renderer: Renderer,
    surface: iced_wgpu::wgpu::Surface<'static>,
    cache: Cache,
    clipboard: Clipboard,
}

impl EditorMenuWindow {
    pub(crate) fn new(
        owner_id: winit::window::WindowId,
        request: ToolbarMenuRequest,
        window: Arc<Window>,
        compositor: &mut Compositor,
    ) -> Self {
        let physical_size = window.inner_size();
        let renderer = compositor.create_renderer();
        let surface = compositor.create_surface(
            window.clone(),
            physical_size.width.max(1),
            physical_size.height.max(1),
        );
        let viewport = Viewport::with_physical_size(
            Size::new(physical_size.width.max(1), physical_size.height.max(1)),
            request.effective_scale as f32,
        );
        let (menu, state) = EditorMenuState::new(request);
        Self {
            owner_id,
            menu,
            window: window.clone(),
            state,
            viewport,
            renderer,
            surface,
            cache: Cache::new(),
            clipboard: Clipboard::connect(window),
        }
    }

    pub(crate) fn present(&self) {
        self.window.set_visible(true);
        self.window.focus_window();
        self.window.request_redraw();
    }

    pub(crate) fn handle_event(
        &mut self,
        event: WindowEvent,
        compositor: &mut Compositor,
    ) -> Option<EditorMenuAction> {
        match &event {
            WindowEvent::CloseRequested => return Some(EditorMenuAction::Dismiss),
            // On Retina displays, winit queues an initial scale-factor event
            // for every newly created AppKit window. The popup already uses
            // its owner's effective scale, and a real owner DPI transition is
            // handled by `WinitHost` before it reaches this window.
            WindowEvent::ScaleFactorChanged { .. } => {}
            WindowEvent::Focused(focused) => {
                if let Some(action) = self.state.focus_changed(*focused) {
                    return Some(action);
                }
            }
            WindowEvent::Resized(size) => self.resize_surface(*size, compositor),
            WindowEvent::CursorMoved { position, .. } => self.state.cursor_moved(*position),
            WindowEvent::CursorLeft { .. } => self.state.cursor_left(),
            WindowEvent::ModifiersChanged(modifiers) => {
                self.state.modifiers_changed(modifiers.state());
            }
            WindowEvent::KeyboardInput { event, .. }
                if event.state == ElementState::Pressed && !event.repeat =>
            {
                if let Some(action) = self.state.key_pressed(&event.logical_key) {
                    return Some(action);
                }
                self.window.request_redraw();
                return None;
            }
            _ => {}
        }

        let event = conversion::window_event(
            event,
            self.state.effective_scale as f32,
            self.state.modifiers,
        )?;
        let logical_size = self.viewport.logical_size();
        let view = self.state.view();
        let mut interface = UserInterface::build(
            view,
            logical_size,
            std::mem::take(&mut self.cache),
            &mut self.renderer,
        );
        let mut messages = Vec::new();
        interface.update(
            &[event],
            self.state.cursor,
            &mut self.renderer,
            &mut self.clipboard,
            &mut messages,
        );
        self.cache = interface.into_cache();
        if let Some(EditorMenuMessage::Select(index)) = messages.into_iter().next() {
            return self.state.select(index);
        }
        None
    }

    pub(crate) fn draw(
        &mut self,
        compositor: &mut Compositor,
    ) -> Result<(), iced_wgpu::graphics::compositor::SurfaceError> {
        let logical_size = self.viewport.logical_size();
        let view = self.state.view();
        let mut interface = UserInterface::build(
            view,
            logical_size,
            std::mem::take(&mut self.cache),
            &mut self.renderer,
        );
        let theme = self.state.appearance.theme();
        let colors = self.state.appearance.palette();
        interface.draw(
            &mut self.renderer,
            &theme,
            &renderer::Style {
                text_color: colors.text,
            },
            self.state.cursor,
        );
        self.cache = interface.into_cache();
        compositor.present(
            &mut self.renderer,
            &mut self.surface,
            &self.viewport,
            colors.surface_raised,
            || {},
        )
    }

    fn resize_surface(&mut self, size: PhysicalSize<u32>, compositor: &mut Compositor) {
        if size.width == 0 || size.height == 0 {
            return;
        }
        compositor.configure_surface(&mut self.surface, size.width, size.height);
        self.viewport = Viewport::with_physical_size(
            Size::new(size.width, size.height),
            self.state.effective_scale as f32,
        );
        self.window.request_redraw();
    }
}

fn toolbar_menu_key(key: &Key, highlighted: &mut usize, len: usize) -> MenuKeyResult {
    match key {
        Key::Named(NamedKey::Escape | NamedKey::Tab) => MenuKeyResult::Dismiss,
        Key::Named(NamedKey::Enter | NamedKey::Space) => MenuKeyResult::Select,
        _ if len == 0 => MenuKeyResult::None,
        Key::Named(NamedKey::ArrowUp) => {
            *highlighted = highlighted.checked_sub(1).unwrap_or(len - 1);
            MenuKeyResult::None
        }
        Key::Named(NamedKey::ArrowDown) => {
            *highlighted = (*highlighted + 1) % len;
            MenuKeyResult::None
        }
        Key::Named(NamedKey::Home) => {
            *highlighted = 0;
            MenuKeyResult::None
        }
        Key::Named(NamedKey::End) => {
            *highlighted = len - 1;
            MenuKeyResult::None
        }
        _ => MenuKeyResult::None,
    }
}

fn initial_toolbar_highlight(
    options: &[ToolbarMenuOption],
    selected: &ToolbarMenuChoice,
) -> usize {
    options
        .iter()
        .position(|option| &option.choice == selected)
        .unwrap_or(0)
}

fn toolbar_menu_geometry(
    anchor: Rectangle,
    option_count: usize,
    editor_origin: PhysicalPosition<i32>,
    editor_size: PhysicalSize<u32>,
    effective_scale: f64,
) -> ToolbarMenuGeometry {
    let scale = effective_scale.max(f64::EPSILON);
    let anchor_left = (f64::from(anchor.x) * scale).round() as i32;
    let anchor_top = (f64::from(anchor.y) * scale).round() as i32;
    let anchor_bottom = (f64::from(anchor.y + anchor.height) * scale).round() as i32;
    let width = (f64::from(anchor.width) * scale).round().max(1.0) as u32;
    let row_height = (f64::from(TOOLBAR_MENU_ROW_HEIGHT) * scale).round().max(1.0) as u32;
    let padding = (f64::from(TOOLBAR_MENU_PADDING * 2.0) * scale)
        .round()
        .max(1.0) as u32;
    let desired_height = row_height
        .saturating_mul(option_count.max(1) as u32)
        .saturating_add(padding);
    let below = editor_size.height.saturating_sub(anchor_bottom.max(0) as u32);
    let above = anchor_top.max(0) as u32;
    let opens_upward = desired_height > below && above > below;
    let available = if opens_upward { above } else { below }.max(row_height + padding);
    let height = desired_height.min(available).min(editor_size.height.max(1));
    let max_x = editor_size.width.saturating_sub(width) as i32;
    let x = anchor_left.clamp(0, max_x.max(0));
    let y = if opens_upward {
        anchor_top.saturating_sub(height as i32).max(0)
    } else {
        anchor_bottom.max(0).min(editor_size.height.saturating_sub(height) as i32)
    };
    ToolbarMenuGeometry {
        position: PhysicalPosition::new(editor_origin.x + x, editor_origin.y + y),
        size: PhysicalSize::new(width.min(editor_size.width.max(1)), height.max(1)),
        visible_rows: height.saturating_sub(padding) as usize / row_height as usize,
        opens_upward,
    }
}

pub(crate) fn toolbar_menu_window_attributes(
    parent: &Arc<Window>,
    request: &ToolbarMenuRequest,
) -> Result<winit::window::WindowAttributes, String> {
    let origin = parent
        .inner_position()
        .map_err(|error| format!("could not locate the editor window: {error}"))?;
    let geometry = toolbar_menu_geometry(
        request.anchor,
        request.options.len(),
        origin,
        parent.inner_size(),
        request.effective_scale,
    );
    let attributes = winit::window::WindowAttributes::default()
        .with_title("Heron toolbar menu")
        .with_decorations(false)
        .with_resizable(false)
        .with_visible(false)
        .with_active(true)
        .with_position(geometry.position)
        .with_inner_size(geometry.size);
    configure_toolbar_menu_window_attributes(attributes, parent)
}

fn configure_toolbar_menu_window_attributes(
    attributes: winit::window::WindowAttributes,
    parent: &Arc<Window>,
) -> Result<winit::window::WindowAttributes, String> {
    #[cfg(target_os = "windows")]
    {
        use raw_window_handle::{HasWindowHandle, RawWindowHandle};
        use winit::platform::windows::WindowAttributesExtWindows;

        let handle = parent
            .window_handle()
            .map_err(|error| format!("could not read editor window handle: {error}"))?;
        let RawWindowHandle::Win32(handle) = handle.as_raw() else {
            return Err("editor window does not expose a Win32 handle".to_owned());
        };
        Ok(attributes
            .with_owner_window(handle.hwnd.get())
            .with_skip_taskbar(true))
    }

    #[cfg(target_os = "macos")]
    {
        use raw_window_handle::HasWindowHandle;

        let handle = parent
            .window_handle()
            .map_err(|error| format!("could not read editor window handle: {error}"))?;
        let attributes = unsafe {
            // SAFETY: the runtime retains `parent` until the owned menu is destroyed.
            attributes.with_parent_window(Some(handle.as_raw()))
        };
        Ok(attributes)
    }

    #[cfg(target_os = "linux")]
    {
        use winit::platform::x11::{WindowAttributesExtX11, WindowType};

        let _ = parent;
        Ok(attributes
            .with_override_redirect(true)
            .with_x11_window_type(vec![WindowType::DropdownMenu]))
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = parent;
        Ok(attributes)
    }
}
