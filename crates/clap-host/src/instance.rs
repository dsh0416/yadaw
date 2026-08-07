use std::{
    ffi::{CStr, CString, c_char, c_void},
    marker::PhantomData,
    panic::{AssertUnwindSafe, catch_unwind},
    ptr::NonNull,
    rc::Rc,
    sync::{
        Arc,
        atomic::{AtomicU8, AtomicUsize, Ordering},
    },
};

#[cfg(unix)]
use clap_sys::ext::posix_fd_support::{CLAP_EXT_POSIX_FD_SUPPORT, clap_plugin_posix_fd_support};
use clap_sys::{
    ext::{
        audio_ports::{CLAP_EXT_AUDIO_PORTS, clap_audio_port_info, clap_plugin_audio_ports},
        audio_ports_config::{
            CLAP_EXT_AUDIO_PORTS_CONFIG, clap_audio_ports_config, clap_plugin_audio_ports_config,
        },
        gui::{CLAP_EXT_GUI, clap_plugin_gui, clap_window, clap_window_handle},
        latency::{CLAP_EXT_LATENCY, clap_plugin_latency},
        note_ports::{CLAP_EXT_NOTE_PORTS, clap_note_port_info, clap_plugin_note_ports},
        params::{CLAP_EXT_PARAMS, clap_param_info, clap_plugin_params},
        state::{CLAP_EXT_STATE, clap_plugin_state},
        tail::{CLAP_EXT_TAIL, clap_plugin_tail},
        timer_support::{CLAP_EXT_TIMER_SUPPORT, clap_plugin_timer_support},
    },
    plugin::clap_plugin,
    stream::{clap_istream, clap_ostream},
};

use crate::{
    ClapHostRequests, ClapModule, ClapModuleError, ClapProcessorHandle, host::HostContext,
};

/// CLAP core lifecycle state. Audio-thread transitions are exposed only to the
/// processor endpoint owned by the runtime.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClapLifecycleState {
    Inactive,
    ActiveStopped,
    ActiveStarted,
}

#[derive(Debug, thiserror::Error)]
pub enum ClapInstanceError {
    #[error(transparent)]
    Module(#[from] ClapModuleError),
    #[error("CLAP plug-in ID contains a NUL byte")]
    InvalidPluginId,
    #[error("CLAP plug-in is missing `{0}`")]
    MissingFunction(&'static str),
    #[error("CLAP plug-in initialization failed")]
    InitializationFailed,
    #[error("CLAP plug-in activation failed")]
    ActivationFailed,
    #[error("CLAP extension `{extension}` is missing `{function}`")]
    MissingExtensionFunction {
        extension: &'static str,
        function: &'static str,
    },
    #[error("CLAP extension `{extension}` rejected item {index}")]
    ExtensionItemFailed { extension: &'static str, index: u32 },
    #[error("CLAP text field `{0}` is not valid UTF-8")]
    InvalidUtf8(&'static str),
    #[error("CLAP state stream failed")]
    StateStreamFailed,
    #[error("invalid CLAP lifecycle transition from {from:?} to {to:?}")]
    InvalidTransition {
        from: ClapLifecycleState,
        to: ClapLifecycleState,
    },
    #[error("CLAP GUI operation `{0}` is unavailable or was rejected")]
    Gui(&'static str),
    #[error("CLAP audio-port configuration {0} was rejected")]
    AudioPortConfigRejected(u32),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClapAudioPort {
    pub id: u32,
    pub name: String,
    pub is_input: bool,
    pub flags: u32,
    pub channel_count: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClapNotePort {
    pub id: u32,
    pub name: String,
    pub is_input: bool,
    pub supported_dialects: u32,
    pub preferred_dialect: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClapAudioPortConfig {
    pub id: u32,
    pub name: String,
    pub input_port_count: u32,
    pub output_port_count: u32,
    pub main_input_channels: Option<u32>,
    pub main_output_channels: Option<u32>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ClapParameter {
    pub id: u32,
    pub name: String,
    pub module: String,
    pub flags: u32,
    pub min_value: f64,
    pub max_value: f64,
    pub default_value: f64,
    pub value: f64,
    pub formatted: String,
}

/// Main-thread control object for one CLAP instance.
pub struct ClapInstance {
    plugin: NonNull<clap_plugin>,
    state: ClapLifecycleState,
    host: Option<std::pin::Pin<Box<HostContext>>>,
    requests: Arc<ClapHostRequests>,
    module: Option<ClapModule>,
    processor_state: Arc<AtomicU8>,
    processor_leases: Arc<AtomicUsize>,
    gui_created: bool,
    _main_thread_only: PhantomData<Rc<()>>,
}

impl ClapInstance {
    pub fn create(module: ClapModule, plugin_id: &str) -> Result<Self, ClapInstanceError> {
        let requests = Arc::new(ClapHostRequests::default());
        let host = HostContext::new(Arc::clone(&requests));
        let plugin_id = CString::new(plugin_id).map_err(|_| ClapInstanceError::InvalidPluginId)?;
        let plugin = module.create_plugin(host.raw(), plugin_id.as_ptr())?;
        // SAFETY: The factory returned a checked instance owned by `module`.
        let init = unsafe { plugin.as_ref() }
            .init
            .ok_or(ClapInstanceError::MissingFunction("init"))?;
        // SAFETY: Host and module remain alive in the returned control object.
        if !unsafe { init(plugin.as_ptr()) } {
            destroy(plugin);
            return Err(ClapInstanceError::InitializationFailed);
        }
        Ok(Self {
            plugin,
            state: ClapLifecycleState::Inactive,
            host: Some(host),
            requests,
            module: Some(module),
            processor_state: Arc::new(AtomicU8::new(0)),
            processor_leases: Arc::new(AtomicUsize::new(0)),
            gui_created: false,
            _main_thread_only: PhantomData,
        })
    }

    #[must_use]
    pub const fn state(&self) -> ClapLifecycleState {
        self.state
    }

    #[must_use]
    pub fn requests(&self) -> Arc<ClapHostRequests> {
        Arc::clone(&self.requests)
    }

    #[must_use]
    pub fn processor_lease_count(&self) -> usize {
        self.processor_leases.load(Ordering::Acquire)
    }

    pub fn activate(
        &mut self,
        sample_rate: f64,
        minimum_frames: u32,
        maximum_frames: u32,
    ) -> Result<(), ClapInstanceError> {
        if self.state != ClapLifecycleState::Inactive {
            return Err(ClapInstanceError::InvalidTransition {
                from: self.state,
                to: ClapLifecycleState::ActiveStopped,
            });
        }
        // SAFETY: The instance is initialized and called on the main thread.
        let activate = unsafe { self.plugin.as_ref() }
            .activate
            .ok_or(ClapInstanceError::MissingFunction("activate"))?;
        // SAFETY: Frame bounds and sample rate are host-owned scalar values.
        if !unsafe {
            activate(
                self.plugin.as_ptr(),
                sample_rate,
                minimum_frames,
                maximum_frames,
            )
        } {
            return Err(ClapInstanceError::ActivationFailed);
        }
        self.state = ClapLifecycleState::ActiveStopped;
        self.processor_state.store(1, Ordering::Release);
        Ok(())
    }

    pub fn deactivate(&mut self) -> Result<(), ClapInstanceError> {
        if self.state != ClapLifecycleState::ActiveStopped {
            return Err(ClapInstanceError::InvalidTransition {
                from: self.state,
                to: ClapLifecycleState::Inactive,
            });
        }
        // SAFETY: This is the matching main-thread call after processing stopped.
        let deactivate = unsafe { self.plugin.as_ref() }
            .deactivate
            .ok_or(ClapInstanceError::MissingFunction("deactivate"))?;
        // SAFETY: Lifecycle state guarantees a matching successful activation.
        unsafe { deactivate(self.plugin.as_ptr()) };
        self.state = ClapLifecycleState::Inactive;
        self.processor_state.store(0, Ordering::Release);
        Ok(())
    }

    pub fn on_main_thread(&mut self) {
        // SAFETY: This method is available only through the main-thread object.
        if let Some(callback) = unsafe { self.plugin.as_ref() }.on_main_thread {
            // SAFETY: Plug-in remains initialized for this call.
            unsafe { callback(self.plugin.as_ptr()) };
        }
    }

    /// Dispatches due timer and, on Linux/Unix, ready POSIX-FD callbacks from
    /// the host control thread without blocking.
    pub fn dispatch_host_events(&mut self) {
        let due_timers = self.host.as_ref().map_or_else(Vec::new, |host| {
            host.take_due_timers(std::time::Instant::now())
        });
        if !due_timers.is_empty()
            && let Some(extension) =
                self.extension::<clap_plugin_timer_support>(CLAP_EXT_TIMER_SUPPORT)
            // SAFETY: The extension belongs to this initialized instance.
            && let Some(on_timer) = unsafe { extension.as_ref() }.on_timer
        {
            for timer_id in due_timers {
                let _ = catch_unwind(AssertUnwindSafe(|| {
                    // SAFETY: Timer IDs originate from this instance's host registration.
                    unsafe { on_timer(self.plugin.as_ptr(), timer_id) };
                }));
            }
        }

        #[cfg(unix)]
        {
            let ready = self
                .host
                .as_ref()
                .map_or_else(Vec::new, |host| host.ready_posix_fds());
            if !ready.is_empty()
                && let Some(extension) =
                    self.extension::<clap_plugin_posix_fd_support>(CLAP_EXT_POSIX_FD_SUPPORT)
                // SAFETY: The extension belongs to this initialized instance.
                && let Some(on_fd) = unsafe { extension.as_ref() }.on_fd
            {
                for event in ready {
                    let _ = catch_unwind(AssertUnwindSafe(|| {
                        // SAFETY: FDs and flags originate from this instance's host registration.
                        unsafe { on_fd(self.plugin.as_ptr(), event.fd, event.flags) };
                    }));
                }
            }
        }
    }

    pub fn processor_handle(
        &self,
        maximum_frames: usize,
    ) -> Result<ClapProcessorHandle, ClapInstanceError> {
        if self.state != ClapLifecycleState::ActiveStopped {
            return Err(ClapInstanceError::InvalidTransition {
                from: self.state,
                to: ClapLifecycleState::ActiveStarted,
            });
        }
        ClapProcessorHandle::new(
            self.plugin,
            self.audio_ports()?,
            self.note_ports()?,
            maximum_frames,
            Arc::clone(&self.requests),
            Arc::clone(&self.processor_state),
            Arc::clone(&self.processor_leases),
        )
        .map_err(|_| ClapInstanceError::ActivationFailed)
    }

    pub fn audio_ports(&self) -> Result<Vec<ClapAudioPort>, ClapInstanceError> {
        let Some(extension) = self.extension::<clap_plugin_audio_ports>(CLAP_EXT_AUDIO_PORTS)
        else {
            return Ok(Vec::new());
        };
        // SAFETY: The extension pointer belongs to the initialized instance.
        let extension = unsafe { extension.as_ref() };
        let count = extension
            .count
            .ok_or(ClapInstanceError::MissingExtensionFunction {
                extension: "audio-ports",
                function: "count",
            })?;
        let get = extension
            .get
            .ok_or(ClapInstanceError::MissingExtensionFunction {
                extension: "audio-ports",
                function: "get",
            })?;
        let mut result = Vec::new();
        for is_input in [true, false] {
            // SAFETY: The instance and extension are alive for the call.
            let count = unsafe { count(self.plugin.as_ptr(), is_input) };
            result.reserve(count as usize);
            for index in 0..count {
                // SAFETY: CLAP audio port info is a C POD with all-zero valid
                // initial storage before the plug-in fills it.
                let mut info = unsafe { std::mem::zeroed::<clap_audio_port_info>() };
                // SAFETY: `index` is bounded by the extension's own count.
                if !unsafe { get(self.plugin.as_ptr(), index, is_input, &mut info) } {
                    return Err(ClapInstanceError::ExtensionItemFailed {
                        extension: "audio-ports",
                        index,
                    });
                }
                result.push(ClapAudioPort {
                    id: info.id,
                    name: fixed_string(&info.name, "audio-port.name")?,
                    is_input,
                    flags: info.flags,
                    channel_count: info.channel_count,
                });
            }
        }
        Ok(result)
    }

    pub fn audio_port_configs(&self) -> Result<Vec<ClapAudioPortConfig>, ClapInstanceError> {
        let Some(extension) =
            self.extension::<clap_plugin_audio_ports_config>(CLAP_EXT_AUDIO_PORTS_CONFIG)
        else {
            return Ok(Vec::new());
        };
        // SAFETY: The extension belongs to this initialized instance.
        let extension = unsafe { extension.as_ref() };
        let count = extension
            .count
            .ok_or(ClapInstanceError::MissingExtensionFunction {
                extension: "audio-ports-config",
                function: "count",
            })?;
        let get = extension
            .get
            .ok_or(ClapInstanceError::MissingExtensionFunction {
                extension: "audio-ports-config",
                function: "get",
            })?;
        // SAFETY: The instance and extension remain live during enumeration.
        let count = unsafe { count(self.plugin.as_ptr()) };
        let mut result = Vec::with_capacity(count as usize);
        for index in 0..count {
            // SAFETY: The CLAP structure is plain data and zero is a valid output baseline.
            let mut config = unsafe { std::mem::zeroed::<clap_audio_ports_config>() };
            // SAFETY: `config` is a valid writable output for this synchronous call.
            if !unsafe { get(self.plugin.as_ptr(), index, &mut config) } {
                return Err(ClapInstanceError::ExtensionItemFailed {
                    extension: "audio-ports-config",
                    index,
                });
            }
            result.push(ClapAudioPortConfig {
                id: config.id,
                name: fixed_string(&config.name, "audio-port-config.name")?,
                input_port_count: config.input_port_count,
                output_port_count: config.output_port_count,
                main_input_channels: config
                    .has_main_input
                    .then_some(config.main_input_channel_count),
                main_output_channels: config
                    .has_main_output
                    .then_some(config.main_output_channel_count),
            });
        }
        Ok(result)
    }

    pub fn select_audio_port_config(&mut self, config_id: u32) -> Result<(), ClapInstanceError> {
        if self.state != ClapLifecycleState::Inactive {
            return Err(ClapInstanceError::InvalidTransition {
                from: self.state,
                to: ClapLifecycleState::Inactive,
            });
        }
        let extension = self
            .extension::<clap_plugin_audio_ports_config>(CLAP_EXT_AUDIO_PORTS_CONFIG)
            .ok_or(ClapInstanceError::MissingExtensionFunction {
                extension: "audio-ports-config",
                function: "extension",
            })?;
        // SAFETY: The extension belongs to this inactive main-thread instance.
        let select = unsafe { extension.as_ref() }.select.ok_or(
            ClapInstanceError::MissingExtensionFunction {
                extension: "audio-ports-config",
                function: "select",
            },
        )?;
        // SAFETY: Selection is performed while inactive as required by CLAP.
        if unsafe { select(self.plugin.as_ptr(), config_id) } {
            Ok(())
        } else {
            Err(ClapInstanceError::AudioPortConfigRejected(config_id))
        }
    }

    #[must_use]
    pub fn supports_gui(&self) -> bool {
        self.extension::<clap_plugin_gui>(CLAP_EXT_GUI).is_some()
    }

    /// Creates and embeds the platform-native CLAP GUI in a host-owned child.
    pub fn create_gui(
        &mut self,
        parent: usize,
        scale: f64,
    ) -> Result<(u32, u32, bool), ClapInstanceError> {
        if self.gui_created || parent == 0 {
            return Err(ClapInstanceError::Gui("create"));
        }
        let extension = self
            .extension::<clap_plugin_gui>(CLAP_EXT_GUI)
            .ok_or(ClapInstanceError::Gui("extension"))?;
        // SAFETY: The extension belongs to this initialized main-thread instance.
        let gui = unsafe { extension.as_ref() };
        let api = platform_gui_api().ok_or(ClapInstanceError::Gui("platform"))?;
        let supported =
            gui.is_api_supported
                .ok_or(ClapInstanceError::MissingExtensionFunction {
                    extension: "gui",
                    function: "is_api_supported",
                })?;
        // SAFETY: The static API string and instance remain live for this call.
        if !unsafe { supported(self.plugin.as_ptr(), api.as_ptr(), false) } {
            return Err(ClapInstanceError::Gui("api"));
        }
        let create = gui
            .create
            .ok_or(ClapInstanceError::MissingExtensionFunction {
                extension: "gui",
                function: "create",
            })?;
        // SAFETY: This is a non-floating GUI created on the main thread.
        if !unsafe { create(self.plugin.as_ptr(), api.as_ptr(), false) } {
            return Err(ClapInstanceError::Gui("create"));
        }
        self.gui_created = true;
        if scale.is_finite()
            && scale > 0.0
            && let Some(set_scale) = gui.set_scale
        {
            // SAFETY: GUI was successfully created above.
            let _ = unsafe { set_scale(self.plugin.as_ptr(), scale) };
        }
        let window = platform_gui_window(api, parent);
        let Some(set_parent) = gui.set_parent else {
            self.destroy_gui();
            return Err(ClapInstanceError::MissingExtensionFunction {
                extension: "gui",
                function: "set_parent",
            });
        };
        // SAFETY: The platform-specific handle belongs to the host container.
        if !unsafe { set_parent(self.plugin.as_ptr(), &window) } {
            self.destroy_gui();
            return Err(ClapInstanceError::Gui("set_parent"));
        }
        let (mut width, mut height) = (800, 600);
        if let Some(get_size) = gui.get_size {
            // SAFETY: Both size outputs are valid for this synchronous call.
            let _ = unsafe { get_size(self.plugin.as_ptr(), &mut width, &mut height) };
        }
        let resizable = if let Some(can_resize) = gui.can_resize {
            // SAFETY: The GUI is created and the plug-in remains initialized.
            unsafe { can_resize(self.plugin.as_ptr()) }
        } else {
            false
        };
        if let Some(show) = gui.show {
            // SAFETY: The GUI is created and parented.
            let _ = unsafe { show(self.plugin.as_ptr()) };
        }
        Ok((width, height, resizable))
    }

    pub fn resize_gui(&mut self, width: u32, height: u32, scale: f64) -> bool {
        if !self.gui_created {
            return false;
        }
        let Some(extension) = self.extension::<clap_plugin_gui>(CLAP_EXT_GUI) else {
            return false;
        };
        // SAFETY: GUI extension remains live with the instance.
        let gui = unsafe { extension.as_ref() };
        if scale.is_finite()
            && scale > 0.0
            && let Some(set_scale) = gui.set_scale
        {
            // SAFETY: The GUI is currently created.
            let _ = unsafe { set_scale(self.plugin.as_ptr(), scale) };
        }
        let Some(set_size) = gui.set_size else {
            return false;
        };
        // SAFETY: The GUI is created and both dimensions are host-owned values.
        unsafe { set_size(self.plugin.as_ptr(), width, height) }
    }

    pub fn hide_gui(&mut self) {
        if self.gui_created
            && let Some(gui) = self.extension::<clap_plugin_gui>(CLAP_EXT_GUI)
            // SAFETY: Extension is live and hide is a main-thread GUI call.
            && let Some(hide) = unsafe { gui.as_ref() }.hide
        {
            // SAFETY: The GUI is currently created.
            let _ = unsafe { hide(self.plugin.as_ptr()) };
        }
    }

    pub fn destroy_gui(&mut self) {
        if !self.gui_created {
            return;
        }
        if let Some(gui) = self.extension::<clap_plugin_gui>(CLAP_EXT_GUI)
            // SAFETY: Extension is live and destroy is a main-thread GUI call.
            && let Some(destroy) = unsafe { gui.as_ref() }.destroy
        {
            // SAFETY: This balances the one successful create call.
            unsafe { destroy(self.plugin.as_ptr()) };
        }
        self.gui_created = false;
    }

    pub fn note_ports(&self) -> Result<Vec<ClapNotePort>, ClapInstanceError> {
        let Some(extension) = self.extension::<clap_plugin_note_ports>(CLAP_EXT_NOTE_PORTS) else {
            return Ok(Vec::new());
        };
        // SAFETY: The extension pointer belongs to the initialized instance.
        let extension = unsafe { extension.as_ref() };
        let count = extension
            .count
            .ok_or(ClapInstanceError::MissingExtensionFunction {
                extension: "note-ports",
                function: "count",
            })?;
        let get = extension
            .get
            .ok_or(ClapInstanceError::MissingExtensionFunction {
                extension: "note-ports",
                function: "get",
            })?;
        let mut result = Vec::new();
        for is_input in [true, false] {
            // SAFETY: The instance and extension are alive for the call.
            let count = unsafe { count(self.plugin.as_ptr(), is_input) };
            result.reserve(count as usize);
            for index in 0..count {
                // SAFETY: CLAP note port info is a C POD with all-zero valid
                // initial storage before the plug-in fills it.
                let mut info = unsafe { std::mem::zeroed::<clap_note_port_info>() };
                // SAFETY: `index` is bounded by the extension's own count.
                if !unsafe { get(self.plugin.as_ptr(), index, is_input, &mut info) } {
                    return Err(ClapInstanceError::ExtensionItemFailed {
                        extension: "note-ports",
                        index,
                    });
                }
                result.push(ClapNotePort {
                    id: info.id,
                    name: fixed_string(&info.name, "note-port.name")?,
                    is_input,
                    supported_dialects: info.supported_dialects,
                    preferred_dialect: info.preferred_dialect,
                });
            }
        }
        Ok(result)
    }

    pub fn parameters(&self) -> Result<Vec<ClapParameter>, ClapInstanceError> {
        let Some(extension) = self.extension::<clap_plugin_params>(CLAP_EXT_PARAMS) else {
            return Ok(Vec::new());
        };
        // SAFETY: The extension pointer belongs to the initialized instance.
        let extension = unsafe { extension.as_ref() };
        let count = extension
            .count
            .ok_or(ClapInstanceError::MissingExtensionFunction {
                extension: "params",
                function: "count",
            })?;
        let get_info = extension
            .get_info
            .ok_or(ClapInstanceError::MissingExtensionFunction {
                extension: "params",
                function: "get_info",
            })?;
        let get_value = extension
            .get_value
            .ok_or(ClapInstanceError::MissingExtensionFunction {
                extension: "params",
                function: "get_value",
            })?;
        // SAFETY: The instance and extension are alive for the call.
        let count = unsafe { count(self.plugin.as_ptr()) };
        let mut result = Vec::with_capacity(count as usize);
        for index in 0..count {
            // SAFETY: CLAP param info is a C POD with all-zero valid storage.
            let mut info = unsafe { std::mem::zeroed::<clap_param_info>() };
            // SAFETY: `index` is bounded by the extension's count.
            if !unsafe { get_info(self.plugin.as_ptr(), index, &mut info) } {
                return Err(ClapInstanceError::ExtensionItemFailed {
                    extension: "params",
                    index,
                });
            }
            let mut value = 0.0;
            // SAFETY: The output pointer is valid and writable for this call.
            if !unsafe { get_value(self.plugin.as_ptr(), info.id, &mut value) } {
                return Err(ClapInstanceError::ExtensionItemFailed {
                    extension: "params.value",
                    index,
                });
            }
            let formatted = extension.value_to_text.map_or_else(
                || Ok(String::new()),
                |format| {
                    let mut buffer = [0 as c_char; 256];
                    // SAFETY: The buffer is writable and its capacity is exact.
                    if unsafe {
                        format(
                            self.plugin.as_ptr(),
                            info.id,
                            value,
                            buffer.as_mut_ptr(),
                            buffer.len() as u32,
                        )
                    } {
                        fixed_string(&buffer, "parameter.formatted")
                    } else {
                        Ok(String::new())
                    }
                },
            )?;
            result.push(ClapParameter {
                id: info.id,
                name: fixed_string(&info.name, "parameter.name")?,
                module: fixed_string(&info.module, "parameter.module")?,
                flags: info.flags,
                min_value: info.min_value,
                max_value: info.max_value,
                default_value: info.default_value,
                value,
                formatted,
            });
        }
        Ok(result)
    }

    pub fn save_state(&self) -> Result<Vec<u8>, ClapInstanceError> {
        let extension = self
            .extension::<clap_plugin_state>(CLAP_EXT_STATE)
            .ok_or(ClapInstanceError::StateStreamFailed)?;
        // SAFETY: The extension pointer belongs to the initialized instance.
        let save = unsafe { extension.as_ref() }.save.ok_or(
            ClapInstanceError::MissingExtensionFunction {
                extension: "state",
                function: "save",
            },
        )?;
        let mut bytes = Vec::new();
        let stream = clap_ostream {
            ctx: (&mut bytes as *mut Vec<u8>).cast(),
            write: Some(write_state),
        };
        // SAFETY: The stream and its backing vector remain valid for the call.
        if unsafe { save(self.plugin.as_ptr(), &stream) } {
            Ok(bytes)
        } else {
            Err(ClapInstanceError::StateStreamFailed)
        }
    }

    pub fn load_state(&mut self, bytes: &[u8]) -> Result<(), ClapInstanceError> {
        let extension = self
            .extension::<clap_plugin_state>(CLAP_EXT_STATE)
            .ok_or(ClapInstanceError::StateStreamFailed)?;
        // SAFETY: The extension pointer belongs to the initialized instance.
        let load = unsafe { extension.as_ref() }.load.ok_or(
            ClapInstanceError::MissingExtensionFunction {
                extension: "state",
                function: "load",
            },
        )?;
        let mut reader = StateReader { bytes, offset: 0 };
        let stream = clap_istream {
            ctx: (&mut reader as *mut StateReader<'_>).cast(),
            read: Some(read_state),
        };
        // SAFETY: The stream and its backing slice remain valid for the call.
        if unsafe { load(self.plugin.as_ptr(), &stream) } {
            Ok(())
        } else {
            Err(ClapInstanceError::StateStreamFailed)
        }
    }

    #[must_use]
    pub fn latency_samples(&self) -> u32 {
        let Some(extension) = self.extension::<clap_plugin_latency>(CLAP_EXT_LATENCY) else {
            return 0;
        };
        // SAFETY: The extension and plug-in pointers remain valid.
        unsafe { extension.as_ref() }
            .get
            .map_or(0, |get| unsafe { get(self.plugin.as_ptr()) })
    }

    #[must_use]
    pub fn tail_samples(&self) -> Option<u32> {
        let extension = self.extension::<clap_plugin_tail>(CLAP_EXT_TAIL)?;
        // SAFETY: The extension and plug-in pointers remain valid.
        unsafe { extension.as_ref() }
            .get
            .map(|get| unsafe { get(self.plugin.as_ptr()) })
    }

    fn extension<T>(&self, identifier: &CStr) -> Option<NonNull<T>> {
        // SAFETY: The plug-in is initialized and kept alive by this object.
        let get = unsafe { self.plugin.as_ref() }.get_extension?;
        // SAFETY: The identifier is a static NUL-terminated CLAP extension ID.
        let extension = unsafe { get(self.plugin.as_ptr(), identifier.as_ptr()) };
        NonNull::new(extension.cast::<T>().cast_mut())
    }
}

impl Drop for ClapInstance {
    fn drop(&mut self) {
        if self.processor_leases.load(Ordering::Acquire) != 0 {
            // A malformed graph teardown must not turn an outstanding real-time
            // endpoint into a dangling pointer. Leak the ABI objects; the
            // runtime reports the outstanding lease and quarantines the instance.
            if let Some(module) = self.module.take() {
                std::mem::forget(module);
            }
            if let Some(host) = self.host.take() {
                std::mem::forget(host);
            }
            return;
        }
        self.destroy_gui();
        if self.state == ClapLifecycleState::ActiveStopped {
            // SAFETY: Drop occurs on the main thread and no processor endpoint
            // has been published by this control-only implementation.
            if let Some(deactivate) = unsafe { self.plugin.as_ref() }.deactivate {
                // SAFETY: This balances the successful activation.
                unsafe { deactivate(self.plugin.as_ptr()) };
            }
        }
        destroy(self.plugin);
        drop(self.module.take());
        drop(self.host.take());
    }
}

fn platform_gui_api() -> Option<&'static CStr> {
    #[cfg(target_os = "windows")]
    {
        Some(clap_sys::ext::gui::CLAP_WINDOW_API_WIN32)
    }
    #[cfg(target_os = "macos")]
    {
        Some(clap_sys::ext::gui::CLAP_WINDOW_API_COCOA)
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // Heron intentionally does not advertise Wayland embedding. XWayland
        // hosts may still expose an X11 parent; native Wayland uses parameters.
        Some(clap_sys::ext::gui::CLAP_WINDOW_API_X11)
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", unix)))]
    {
        None
    }
}

fn platform_gui_window(api: &CStr, parent: usize) -> clap_window {
    let specific = if api == clap_sys::ext::gui::CLAP_WINDOW_API_WIN32 {
        clap_window_handle {
            win32: parent as *mut c_void,
        }
    } else if api == clap_sys::ext::gui::CLAP_WINDOW_API_COCOA {
        clap_window_handle {
            cocoa: parent as *mut c_void,
        }
    } else {
        clap_window_handle {
            x11: parent as std::ffi::c_ulong,
        }
    };
    clap_window {
        api: api.as_ptr(),
        specific,
    }
}

fn destroy(plugin: NonNull<clap_plugin>) {
    // SAFETY: The pointer is factory-owned and destruction occurs at most once.
    if let Some(destroy) = unsafe { plugin.as_ref() }.destroy {
        // SAFETY: All other plug-in calls have ended before destruction.
        unsafe { destroy(plugin.as_ptr()) };
    }
}

fn fixed_string(values: &[c_char], field: &'static str) -> Result<String, ClapInstanceError> {
    let length = values
        .iter()
        .position(|value| *value == 0)
        .unwrap_or(values.len());
    // SAFETY: `c_char` and `u8` have identical size/alignment and the slice is
    // limited to the fixed CLAP field storage.
    let bytes = unsafe { std::slice::from_raw_parts(values.as_ptr().cast::<u8>(), length) };
    std::str::from_utf8(bytes)
        .map(str::to_owned)
        .map_err(|_| ClapInstanceError::InvalidUtf8(field))
}

struct StateReader<'a> {
    bytes: &'a [u8],
    offset: usize,
}

unsafe extern "C" fn write_state(
    stream: *const clap_ostream,
    buffer: *const c_void,
    size: u64,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let size = usize::try_from(size).map_err(|_| ())?;
        if stream.is_null() || (buffer.is_null() && size != 0) {
            return Err(());
        }
        // SAFETY: The stream context was created from a live `Vec<u8>` and the
        // plug-in promises `buffer` is readable for `size` bytes.
        let target = unsafe { (*stream).ctx.cast::<Vec<u8>>().as_mut() }.ok_or(())?;
        // SAFETY: Null is allowed only for the already-handled zero-size case.
        let source = unsafe { std::slice::from_raw_parts(buffer.cast::<u8>(), size) };
        target.extend_from_slice(source);
        i64::try_from(size).map_err(|_| ())
    }))
    .unwrap_or(Err(()))
    .unwrap_or(-1)
}

unsafe extern "C" fn read_state(
    stream: *const clap_istream,
    buffer: *mut c_void,
    size: u64,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let requested = usize::try_from(size).map_err(|_| ())?;
        if stream.is_null() || (buffer.is_null() && requested != 0) {
            return Err(());
        }
        // SAFETY: The stream context was created from a live `StateReader`.
        let reader = unsafe { (*stream).ctx.cast::<StateReader<'static>>().as_mut() }.ok_or(())?;
        let remaining = reader.bytes.len().saturating_sub(reader.offset);
        let count = requested.min(remaining);
        // SAFETY: The destination is plug-in-provided writable storage and the
        // source range is bounded by the host-owned slice.
        unsafe {
            std::ptr::copy_nonoverlapping(
                reader.bytes.as_ptr().add(reader.offset),
                buffer.cast::<u8>(),
                count,
            )
        };
        reader.offset += count;
        i64::try_from(count).map_err(|_| ())
    }))
    .unwrap_or(Err(()))
    .unwrap_or(-1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap_sys::ext::{
        audio_ports::CLAP_AUDIO_PORT_IS_MAIN,
        latency::CLAP_EXT_LATENCY,
        note_ports::{CLAP_NOTE_DIALECT_CLAP, CLAP_NOTE_DIALECT_MIDI},
        tail::CLAP_EXT_TAIL,
    };

    const AUDIO_PORTS: u32 = 1 << 0;
    const AUDIO_CONFIGS: u32 = 1 << 1;
    const GUI: u32 = 1 << 2;
    const NOTE_PORTS: u32 = 1 << 3;
    const PARAMETERS: u32 = 1 << 4;
    const STATE: u32 = 1 << 5;
    const LATENCY: u32 = 1 << 6;
    const TAIL: u32 = 1 << 7;
    const ALL_EXTENSIONS: u32 = (1 << 8) - 1;

    struct FakePlugin {
        raw: clap_plugin,
        audio_ports: clap_plugin_audio_ports,
        audio_configs: clap_plugin_audio_ports_config,
        gui: clap_plugin_gui,
        note_ports: clap_plugin_note_ports,
        parameters: clap_plugin_params,
        state: clap_plugin_state,
        latency: clap_plugin_latency,
        tail: clap_plugin_tail,
        extensions: u32,
        activate_result: bool,
        selected_config: Option<u32>,
        loaded_state: Vec<u8>,
        calls: Vec<&'static str>,
    }

    struct Harness {
        instance: ClapInstance,
        fake: Box<FakePlugin>,
    }

    impl Harness {
        fn new() -> Self {
            let mut fake = Box::new(FakePlugin {
                raw: clap_plugin {
                    desc: std::ptr::null(),
                    plugin_data: std::ptr::null_mut(),
                    init: Some(plugin_init),
                    destroy: Some(plugin_destroy),
                    activate: Some(plugin_activate),
                    deactivate: Some(plugin_deactivate),
                    start_processing: None,
                    stop_processing: None,
                    reset: None,
                    process: None,
                    get_extension: Some(get_extension),
                    on_main_thread: Some(on_main_thread),
                },
                audio_ports: clap_plugin_audio_ports {
                    count: Some(audio_port_count),
                    get: Some(audio_port_get),
                },
                audio_configs: clap_plugin_audio_ports_config {
                    count: Some(audio_config_count),
                    get: Some(audio_config_get),
                    select: Some(audio_config_select),
                },
                gui: clap_plugin_gui {
                    is_api_supported: Some(gui_is_api_supported),
                    get_preferred_api: None,
                    create: Some(gui_create),
                    destroy: Some(gui_destroy),
                    set_scale: Some(gui_set_scale),
                    get_size: Some(gui_get_size),
                    can_resize: Some(gui_can_resize),
                    get_resize_hints: None,
                    adjust_size: None,
                    set_size: Some(gui_set_size),
                    set_parent: Some(gui_set_parent),
                    set_transient: None,
                    suggest_title: None,
                    show: Some(gui_show),
                    hide: Some(gui_hide),
                },
                note_ports: clap_plugin_note_ports {
                    count: Some(note_port_count),
                    get: Some(note_port_get),
                },
                parameters: clap_plugin_params {
                    count: Some(parameter_count),
                    get_info: Some(parameter_get_info),
                    get_value: Some(parameter_get_value),
                    value_to_text: Some(parameter_value_to_text),
                    text_to_value: None,
                    flush: None,
                },
                state: clap_plugin_state {
                    save: Some(state_save),
                    load: Some(state_load),
                },
                latency: clap_plugin_latency {
                    get: Some(latency_get),
                },
                tail: clap_plugin_tail {
                    get: Some(tail_get),
                },
                extensions: ALL_EXTENSIONS,
                activate_result: true,
                selected_config: None,
                loaded_state: Vec::new(),
                calls: Vec::new(),
            });
            fake.raw.plugin_data = (&mut *fake as *mut FakePlugin).cast();
            let plugin = NonNull::from(&mut fake.raw);
            let instance = ClapInstance {
                plugin,
                state: ClapLifecycleState::Inactive,
                host: None,
                requests: Arc::new(ClapHostRequests::default()),
                module: None,
                processor_state: Arc::new(AtomicU8::new(0)),
                processor_leases: Arc::new(AtomicUsize::new(0)),
                gui_created: false,
                _main_thread_only: PhantomData,
            };
            Self { instance, fake }
        }
    }

    fn fake(plugin: *const clap_plugin) -> &'static mut FakePlugin {
        // SAFETY: Every callback receives the live plug-in pointer owned by its harness.
        unsafe { &mut *((*plugin).plugin_data.cast::<FakePlugin>()) }
    }

    fn copy_text<const N: usize>(target: &mut [c_char; N], value: &[u8]) {
        for (target, source) in target.iter_mut().zip(value.iter().copied()) {
            *target = source as c_char;
        }
    }

    unsafe extern "C" fn plugin_init(_plugin: *const clap_plugin) -> bool {
        true
    }

    unsafe extern "C" fn plugin_destroy(plugin: *const clap_plugin) {
        fake(plugin).calls.push("destroy");
    }

    unsafe extern "C" fn plugin_activate(
        plugin: *const clap_plugin,
        _sample_rate: f64,
        _minimum: u32,
        _maximum: u32,
    ) -> bool {
        fake(plugin).calls.push("activate");
        fake(plugin).activate_result
    }

    unsafe extern "C" fn plugin_deactivate(plugin: *const clap_plugin) {
        fake(plugin).calls.push("deactivate");
    }

    unsafe extern "C" fn on_main_thread(plugin: *const clap_plugin) {
        fake(plugin).calls.push("main-thread");
    }

    unsafe extern "C" fn get_extension(
        plugin: *const clap_plugin,
        id: *const c_char,
    ) -> *const c_void {
        let fake = fake(plugin);
        // SAFETY: CLAP supplies a NUL-terminated extension identifier.
        let id = unsafe { CStr::from_ptr(id) };
        let (mask, pointer): (u32, *const c_void) = if id == CLAP_EXT_AUDIO_PORTS {
            (AUDIO_PORTS, (&raw const fake.audio_ports).cast())
        } else if id == CLAP_EXT_AUDIO_PORTS_CONFIG {
            (AUDIO_CONFIGS, (&raw const fake.audio_configs).cast())
        } else if id == CLAP_EXT_GUI {
            (GUI, (&raw const fake.gui).cast())
        } else if id == CLAP_EXT_NOTE_PORTS {
            (NOTE_PORTS, (&raw const fake.note_ports).cast())
        } else if id == CLAP_EXT_PARAMS {
            (PARAMETERS, (&raw const fake.parameters).cast())
        } else if id == CLAP_EXT_STATE {
            (STATE, (&raw const fake.state).cast())
        } else if id == CLAP_EXT_LATENCY {
            (LATENCY, (&raw const fake.latency).cast())
        } else if id == CLAP_EXT_TAIL {
            (TAIL, (&raw const fake.tail).cast())
        } else {
            return std::ptr::null();
        };
        if fake.extensions & mask == 0 {
            std::ptr::null()
        } else {
            pointer
        }
    }

    unsafe extern "C" fn audio_port_count(_plugin: *const clap_plugin, _is_input: bool) -> u32 {
        1
    }

    unsafe extern "C" fn audio_port_get(
        _plugin: *const clap_plugin,
        index: u32,
        is_input: bool,
        info: *mut clap_audio_port_info,
    ) -> bool {
        if index != 0 {
            return false;
        }
        // SAFETY: The host provides writable output storage for this callback.
        let info = unsafe { &mut *info };
        info.id = if is_input { 10 } else { 20 };
        info.flags = CLAP_AUDIO_PORT_IS_MAIN;
        info.channel_count = if is_input { 1 } else { 2 };
        copy_text(&mut info.name, if is_input { b"Input" } else { b"Output" });
        true
    }

    unsafe extern "C" fn audio_config_count(_plugin: *const clap_plugin) -> u32 {
        1
    }

    unsafe extern "C" fn audio_config_get(
        _plugin: *const clap_plugin,
        index: u32,
        config: *mut clap_audio_ports_config,
    ) -> bool {
        if index != 0 {
            return false;
        }
        // SAFETY: The host provides writable output storage for this callback.
        let config = unsafe { &mut *config };
        config.id = 42;
        copy_text(&mut config.name, b"Stereo");
        config.input_port_count = 1;
        config.output_port_count = 1;
        config.has_main_input = true;
        config.main_input_channel_count = 2;
        config.has_main_output = false;
        true
    }

    unsafe extern "C" fn audio_config_select(plugin: *const clap_plugin, config_id: u32) -> bool {
        fake(plugin).selected_config = Some(config_id);
        config_id == 42
    }

    unsafe extern "C" fn note_port_count(_plugin: *const clap_plugin, is_input: bool) -> u32 {
        u32::from(is_input)
    }

    unsafe extern "C" fn note_port_get(
        _plugin: *const clap_plugin,
        index: u32,
        is_input: bool,
        info: *mut clap_note_port_info,
    ) -> bool {
        if index != 0 || !is_input {
            return false;
        }
        // SAFETY: The host provides writable output storage for this callback.
        let info = unsafe { &mut *info };
        info.id = 30;
        info.supported_dialects = CLAP_NOTE_DIALECT_CLAP | CLAP_NOTE_DIALECT_MIDI;
        info.preferred_dialect = CLAP_NOTE_DIALECT_CLAP;
        copy_text(&mut info.name, b"Notes");
        true
    }

    unsafe extern "C" fn parameter_count(_plugin: *const clap_plugin) -> u32 {
        1
    }

    unsafe extern "C" fn parameter_get_info(
        _plugin: *const clap_plugin,
        index: u32,
        info: *mut clap_param_info,
    ) -> bool {
        if index != 0 {
            return false;
        }
        // SAFETY: The host provides writable output storage for this callback.
        let info = unsafe { &mut *info };
        info.id = 7;
        info.flags = 9;
        info.min_value = -1.0;
        info.max_value = 1.0;
        info.default_value = 0.0;
        copy_text(&mut info.name, b"Gain");
        copy_text(&mut info.module, b"Main");
        true
    }

    unsafe extern "C" fn parameter_get_value(
        _plugin: *const clap_plugin,
        id: u32,
        value: *mut f64,
    ) -> bool {
        if id != 7 {
            return false;
        }
        // SAFETY: The host provides writable output storage for this callback.
        unsafe { *value = 0.25 };
        true
    }

    unsafe extern "C" fn parameter_value_to_text(
        _plugin: *const clap_plugin,
        _id: u32,
        _value: f64,
        text: *mut c_char,
        capacity: u32,
    ) -> bool {
        let value = b"25%\0";
        if capacity < value.len() as u32 {
            return false;
        }
        // SAFETY: The host advertises enough writable output capacity above.
        unsafe { std::ptr::copy_nonoverlapping(value.as_ptr().cast(), text, value.len()) };
        true
    }

    unsafe extern "C" fn state_save(
        _plugin: *const clap_plugin,
        stream: *const clap_ostream,
    ) -> bool {
        let bytes = b"state";
        // SAFETY: The host stream is valid for this synchronous callback.
        unsafe {
            (*stream).write.is_some_and(|write| {
                write(stream, bytes.as_ptr().cast(), bytes.len() as u64) == bytes.len() as i64
            })
        }
    }

    unsafe extern "C" fn state_load(
        plugin: *const clap_plugin,
        stream: *const clap_istream,
    ) -> bool {
        let mut bytes = [0_u8; 16];
        // SAFETY: The host stream is valid for this synchronous callback.
        let count = unsafe {
            (*stream)
                .read
                .map_or(-1, |read| read(stream, bytes.as_mut_ptr().cast(), 16))
        };
        if count < 0 {
            return false;
        }
        fake(plugin).loaded_state = bytes[..count as usize].to_vec();
        true
    }

    unsafe extern "C" fn latency_get(_plugin: *const clap_plugin) -> u32 {
        64
    }

    unsafe extern "C" fn tail_get(_plugin: *const clap_plugin) -> u32 {
        512
    }

    unsafe extern "C" fn gui_is_api_supported(
        _plugin: *const clap_plugin,
        api: *const c_char,
        floating: bool,
    ) -> bool {
        // SAFETY: CLAP supplies a NUL-terminated API identifier.
        !floating
            && platform_gui_api()
                .is_some_and(|platform_api| unsafe { CStr::from_ptr(api) } == platform_api)
    }

    unsafe extern "C" fn gui_create(
        plugin: *const clap_plugin,
        _api: *const c_char,
        _: bool,
    ) -> bool {
        fake(plugin).calls.push("gui-create");
        true
    }

    unsafe extern "C" fn gui_destroy(plugin: *const clap_plugin) {
        fake(plugin).calls.push("gui-destroy");
    }

    unsafe extern "C" fn gui_set_scale(plugin: *const clap_plugin, _: f64) -> bool {
        fake(plugin).calls.push("gui-scale");
        true
    }

    unsafe extern "C" fn gui_get_size(
        _plugin: *const clap_plugin,
        width: *mut u32,
        height: *mut u32,
    ) -> bool {
        // SAFETY: The host provides both writable size outputs.
        unsafe {
            *width = 640;
            *height = 480;
        }
        true
    }

    unsafe extern "C" fn gui_can_resize(_plugin: *const clap_plugin) -> bool {
        true
    }

    unsafe extern "C" fn gui_set_size(plugin: *const clap_plugin, _: u32, _: u32) -> bool {
        fake(plugin).calls.push("gui-size");
        true
    }

    unsafe extern "C" fn gui_set_parent(
        plugin: *const clap_plugin,
        _window: *const clap_window,
    ) -> bool {
        fake(plugin).calls.push("gui-parent");
        true
    }

    unsafe extern "C" fn gui_show(plugin: *const clap_plugin) -> bool {
        fake(plugin).calls.push("gui-show");
        true
    }

    unsafe extern "C" fn gui_hide(plugin: *const clap_plugin) -> bool {
        fake(plugin).calls.push("gui-hide");
        true
    }

    unsafe extern "C" fn reject_audio_port(
        _plugin: *const clap_plugin,
        _index: u32,
        _is_input: bool,
        _info: *mut clap_audio_port_info,
    ) -> bool {
        false
    }

    unsafe extern "C" fn reject_audio_config(
        _plugin: *const clap_plugin,
        _index: u32,
        _config: *mut clap_audio_ports_config,
    ) -> bool {
        false
    }

    unsafe extern "C" fn reject_note_port(
        _plugin: *const clap_plugin,
        _index: u32,
        _is_input: bool,
        _info: *mut clap_note_port_info,
    ) -> bool {
        false
    }

    unsafe extern "C" fn reject_parameter_info(
        _plugin: *const clap_plugin,
        _index: u32,
        _info: *mut clap_param_info,
    ) -> bool {
        false
    }

    unsafe extern "C" fn reject_parameter_value(
        _plugin: *const clap_plugin,
        _id: u32,
        _value: *mut f64,
    ) -> bool {
        false
    }

    #[test]
    fn lifecycle_tracks_valid_transitions_and_callbacks() {
        let mut harness = Harness::new();
        assert_eq!(harness.instance.state(), ClapLifecycleState::Inactive);
        assert_eq!(harness.instance.processor_lease_count(), 0);
        assert!(Arc::ptr_eq(
            &harness.instance.requests(),
            &harness.instance.requests
        ));
        assert!(matches!(
            harness.instance.deactivate(),
            Err(ClapInstanceError::InvalidTransition { .. })
        ));
        harness.instance.activate(48_000.0, 16, 512).unwrap();
        assert_eq!(harness.instance.state(), ClapLifecycleState::ActiveStopped);
        assert!(matches!(
            harness.instance.activate(48_000.0, 16, 512),
            Err(ClapInstanceError::InvalidTransition { .. })
        ));
        harness.instance.on_main_thread();
        harness.instance.deactivate().unwrap();
        assert_eq!(harness.instance.state(), ClapLifecycleState::Inactive);
        assert!(harness.fake.calls.contains(&"activate"));
        assert!(harness.fake.calls.contains(&"main-thread"));
        assert!(harness.fake.calls.contains(&"deactivate"));

        harness.fake.activate_result = false;
        assert!(matches!(
            harness.instance.activate(48_000.0, 16, 512),
            Err(ClapInstanceError::ActivationFailed)
        ));
    }

    #[test]
    fn enumerates_audio_note_and_parameter_metadata() {
        let mut harness = Harness::new();
        assert_eq!(
            harness.instance.audio_ports().unwrap(),
            [
                ClapAudioPort {
                    id: 10,
                    name: "Input".into(),
                    is_input: true,
                    flags: CLAP_AUDIO_PORT_IS_MAIN,
                    channel_count: 1,
                },
                ClapAudioPort {
                    id: 20,
                    name: "Output".into(),
                    is_input: false,
                    flags: CLAP_AUDIO_PORT_IS_MAIN,
                    channel_count: 2,
                }
            ]
        );
        assert_eq!(
            harness.instance.audio_port_configs().unwrap(),
            [ClapAudioPortConfig {
                id: 42,
                name: "Stereo".into(),
                input_port_count: 1,
                output_port_count: 1,
                main_input_channels: Some(2),
                main_output_channels: None,
            }]
        );
        harness.instance.select_audio_port_config(42).unwrap();
        assert_eq!(harness.fake.selected_config, Some(42));
        assert!(matches!(
            harness.instance.select_audio_port_config(99),
            Err(ClapInstanceError::AudioPortConfigRejected(99))
        ));
        assert_eq!(
            harness.instance.note_ports().unwrap(),
            [ClapNotePort {
                id: 30,
                name: "Notes".into(),
                is_input: true,
                supported_dialects: CLAP_NOTE_DIALECT_CLAP | CLAP_NOTE_DIALECT_MIDI,
                preferred_dialect: CLAP_NOTE_DIALECT_CLAP,
            }]
        );
        assert_eq!(
            harness.instance.parameters().unwrap(),
            [ClapParameter {
                id: 7,
                name: "Gain".into(),
                module: "Main".into(),
                flags: 9,
                min_value: -1.0,
                max_value: 1.0,
                default_value: 0.0,
                value: 0.25,
                formatted: "25%".into(),
            }]
        );
    }

    #[test]
    fn round_trips_state_and_reports_latency_and_tail() {
        let mut harness = Harness::new();
        assert_eq!(harness.instance.save_state().unwrap(), b"state");
        harness.instance.load_state(b"restored").unwrap();
        assert_eq!(harness.fake.loaded_state, b"restored");
        assert_eq!(harness.instance.latency_samples(), 64);
        assert_eq!(harness.instance.tail_samples(), Some(512));

        harness.fake.extensions = 0;
        assert!(matches!(
            harness.instance.save_state(),
            Err(ClapInstanceError::StateStreamFailed)
        ));
        assert!(matches!(
            harness.instance.load_state(b"x"),
            Err(ClapInstanceError::StateStreamFailed)
        ));
        assert_eq!(harness.instance.latency_samples(), 0);
        assert_eq!(harness.instance.tail_samples(), None);
        assert!(harness.instance.audio_ports().unwrap().is_empty());
        assert!(harness.instance.audio_port_configs().unwrap().is_empty());
        assert!(harness.instance.note_ports().unwrap().is_empty());
        assert!(harness.instance.parameters().unwrap().is_empty());
    }

    #[test]
    fn creates_resizes_hides_and_destroys_gui() {
        let mut harness = Harness::new();
        assert!(harness.instance.supports_gui());
        assert!(matches!(
            harness.instance.create_gui(0, 1.0),
            Err(ClapInstanceError::Gui("create"))
        ));
        assert_eq!(
            harness.instance.create_gui(123, 1.25).unwrap(),
            (640, 480, true)
        );
        assert!(harness.instance.resize_gui(800, 600, 2.0));
        harness.instance.hide_gui();
        harness.instance.destroy_gui();
        harness.instance.destroy_gui();
        assert!(!harness.instance.resize_gui(1, 1, 1.0));
        assert!(harness.fake.calls.contains(&"gui-create"));
        assert!(harness.fake.calls.contains(&"gui-parent"));
        assert!(harness.fake.calls.contains(&"gui-show"));
        assert!(harness.fake.calls.contains(&"gui-size"));
        assert!(harness.fake.calls.contains(&"gui-hide"));
        assert!(harness.fake.calls.contains(&"gui-destroy"));

        harness.fake.extensions = 0;
        assert!(!harness.instance.supports_gui());
        assert!(matches!(
            harness.instance.create_gui(1, 1.0),
            Err(ClapInstanceError::Gui("extension"))
        ));
    }

    #[test]
    fn fixed_strings_and_state_streams_reject_invalid_pointers() {
        let mut valid = [0 as c_char; 8];
        copy_text(&mut valid, b"hello");
        assert_eq!(fixed_string(&valid, "test").unwrap(), "hello");
        let invalid = [-1 as c_char, 0];
        assert!(matches!(
            fixed_string(&invalid, "test"),
            Err(ClapInstanceError::InvalidUtf8("test"))
        ));

        // SAFETY: These calls intentionally exercise the callbacks' null checks.
        unsafe {
            assert_eq!(write_state(std::ptr::null(), std::ptr::null(), 0), -1);
            assert_eq!(read_state(std::ptr::null(), std::ptr::null_mut(), 0), -1);
        }
    }

    #[test]
    fn missing_callbacks_and_rejected_items_return_typed_errors() {
        let mut harness = Harness::new();
        harness.fake.raw.activate = None;
        assert!(matches!(
            harness.instance.activate(48_000.0, 16, 512),
            Err(ClapInstanceError::MissingFunction("activate"))
        ));
        harness.fake.raw.on_main_thread = None;
        harness.instance.on_main_thread();

        harness.fake.audio_ports.count = None;
        assert!(matches!(
            harness.instance.audio_ports(),
            Err(ClapInstanceError::MissingExtensionFunction {
                extension: "audio-ports",
                function: "count"
            })
        ));
        harness.fake.audio_ports.count = Some(audio_port_count);
        harness.fake.audio_ports.get = None;
        assert!(matches!(
            harness.instance.audio_ports(),
            Err(ClapInstanceError::MissingExtensionFunction {
                extension: "audio-ports",
                function: "get"
            })
        ));
        harness.fake.audio_ports.get = Some(reject_audio_port);
        assert!(matches!(
            harness.instance.audio_ports(),
            Err(ClapInstanceError::ExtensionItemFailed {
                extension: "audio-ports",
                index: 0
            })
        ));

        harness.fake.audio_configs.count = None;
        assert!(matches!(
            harness.instance.audio_port_configs(),
            Err(ClapInstanceError::MissingExtensionFunction {
                extension: "audio-ports-config",
                function: "count"
            })
        ));
        harness.fake.audio_configs.count = Some(audio_config_count);
        harness.fake.audio_configs.get = Some(reject_audio_config);
        assert!(matches!(
            harness.instance.audio_port_configs(),
            Err(ClapInstanceError::ExtensionItemFailed {
                extension: "audio-ports-config",
                index: 0
            })
        ));
        harness.fake.audio_configs.select = None;
        assert!(matches!(
            harness.instance.select_audio_port_config(42),
            Err(ClapInstanceError::MissingExtensionFunction {
                extension: "audio-ports-config",
                function: "select"
            })
        ));

        harness.fake.note_ports.count = None;
        assert!(matches!(
            harness.instance.note_ports(),
            Err(ClapInstanceError::MissingExtensionFunction {
                extension: "note-ports",
                function: "count"
            })
        ));
        harness.fake.note_ports.count = Some(note_port_count);
        harness.fake.note_ports.get = Some(reject_note_port);
        assert!(matches!(
            harness.instance.note_ports(),
            Err(ClapInstanceError::ExtensionItemFailed {
                extension: "note-ports",
                index: 0
            })
        ));

        harness.fake.parameters.count = None;
        assert!(matches!(
            harness.instance.parameters(),
            Err(ClapInstanceError::MissingExtensionFunction {
                extension: "params",
                function: "count"
            })
        ));
        harness.fake.parameters.count = Some(parameter_count);
        harness.fake.parameters.get_info = Some(reject_parameter_info);
        assert!(matches!(
            harness.instance.parameters(),
            Err(ClapInstanceError::ExtensionItemFailed {
                extension: "params",
                index: 0
            })
        ));
        harness.fake.parameters.get_info = Some(parameter_get_info);
        harness.fake.parameters.get_value = Some(reject_parameter_value);
        assert!(matches!(
            harness.instance.parameters(),
            Err(ClapInstanceError::ExtensionItemFailed {
                extension: "params.value",
                index: 0
            })
        ));

        harness.fake.state.save = None;
        assert!(matches!(
            harness.instance.save_state(),
            Err(ClapInstanceError::MissingExtensionFunction {
                extension: "state",
                function: "save"
            })
        ));
        harness.fake.state.load = None;
        assert!(matches!(
            harness.instance.load_state(b"state"),
            Err(ClapInstanceError::MissingExtensionFunction {
                extension: "state",
                function: "load"
            })
        ));
        harness.fake.latency.get = None;
        harness.fake.tail.get = None;
        assert_eq!(harness.instance.latency_samples(), 0);
        assert_eq!(harness.instance.tail_samples(), None);

        harness.fake.extensions = 0;
        assert!(matches!(
            harness.instance.select_audio_port_config(42),
            Err(ClapInstanceError::MissingExtensionFunction {
                extension: "audio-ports-config",
                function: "extension"
            })
        ));
    }
}
