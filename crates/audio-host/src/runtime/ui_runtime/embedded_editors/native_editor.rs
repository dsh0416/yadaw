use std::{
    cell::{Cell, RefCell},
    collections::VecDeque,
    rc::Rc,
};

use heron_dsp_runtime::protocol::PluginEditorPreference;
use heron_vst3_host::{PlugFrame, PlugView, ViewRect};

use crate::{
    editor_platform::{
        NativeContainer, NativeContainerGeometry, NativeParentHandle,
        with_native_child_scale_context,
    },
    vst3::Vst3Runtime,
};

use super::EmbeddedEditorHostEvent;

const DEFAULT_WIDTH: i32 = 800;
const DEFAULT_HEIGHT: i32 = 600;

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

pub(super) struct EmbeddedNativeEditor {
    view: PlugView,
    frame: Box<PlugFrame>,
    container: Rc<RefCell<NativeContainer>>,
    size: Rc<Cell<ViewRect>>,
    strategy: ScaleStrategy,
    scale: Rc<Cell<EditorScale>>,
    pub(super) resizable: bool,
}

#[derive(Debug, Clone, Copy)]
struct EditorScale {
    zoom: f64,
    display: f64,
    top_inset: u32,
}

impl EmbeddedNativeEditor {
    pub(super) fn attach(
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

    pub(super) fn electron_extent(&self) -> (u32, u32) {
        let scale = self.scale.get();
        electron_extent(self.size.get(), self.strategy, scale.display, scale.zoom)
    }

    pub(super) fn resize(&mut self, width: u32, height: u32, top_inset: u32, display_scale: f64) {
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

    pub(super) fn set_zoom(&mut self, zoom_percent: u16) {
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

    pub(super) fn dispatch_run_loop(
        &mut self,
        now: std::time::Instant,
    ) -> Option<std::time::Instant> {
        self.frame.dispatch_run_loop(now)
    }

    pub(super) fn focus(&self) {
        self.container.borrow().focus();
    }

    pub(super) fn detach(self) {
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
pub(super) fn electron_dimension(value: u32, _display_scale: f64) -> u32 {
    value.max(1)
}

#[cfg(not(target_os = "macos"))]
pub(super) fn electron_dimension(value: u32, display_scale: f64) -> u32 {
    (f64::from(value) / display_scale.max(0.01))
        .round()
        .max(1.0) as u32
}
