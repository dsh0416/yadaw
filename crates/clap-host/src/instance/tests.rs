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

unsafe extern "C" fn get_extension(plugin: *const clap_plugin, id: *const c_char) -> *const c_void {
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

unsafe extern "C" fn state_save(_plugin: *const clap_plugin, stream: *const clap_ostream) -> bool {
    let bytes = b"state";
    // SAFETY: The host stream is valid for this synchronous callback.
    unsafe {
        (*stream).write.is_some_and(|write| {
            write(stream, bytes.as_ptr().cast(), bytes.len() as u64) == bytes.len() as i64
        })
    }
}

unsafe extern "C" fn state_load(plugin: *const clap_plugin, stream: *const clap_istream) -> bool {
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

unsafe extern "C" fn gui_create(plugin: *const clap_plugin, _api: *const c_char, _: bool) -> bool {
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
