fn run_ipc() -> Result<(), Box<dyn std::error::Error>> {
    const UI_MAILBOX_CAPACITY: usize = 64;
    let mut arguments = env::args_os().skip(1);
    let mut ipc_token = None;
    let mut crash_marker_path = None;
    let mut editor_owner_window = None;
    let mut runtime_config = RuntimeConfig::auto();
    while let Some(argument) = arguments.next() {
        if argument == "--ipc-token" {
            ipc_token = arguments.next().and_then(|value| value.into_string().ok());
        } else if argument == "--crash-marker" {
            crash_marker_path = arguments.next().map(PathBuf::from);
        } else if argument == "--worker-threads" {
            runtime_config.worker_threads = arguments
                .next()
                .and_then(|value| value.into_string().ok())
                .ok_or("missing --worker-threads value")?
                .parse()?;
        } else if argument == "--max-blocking-threads" {
            runtime_config.max_blocking_threads = arguments
                .next()
                .and_then(|value| value.into_string().ok())
                .ok_or("missing --max-blocking-threads value")?
                .parse()?;
        } else if argument == "--egress-concurrency" {
            runtime_config.egress_concurrency = arguments
                .next()
                .and_then(|value| value.into_string().ok())
                .ok_or("missing --egress-concurrency value")?
                .parse()?;
        } else if argument == "--editor-owner-window" {
            editor_owner_window = Some(parse_editor_owner_window(
                &arguments
                    .next()
                    .and_then(|value| value.into_string().ok())
                    .ok_or("missing --editor-owner-window value")?,
            )?);
        }
    }
    let runtime_config = runtime_config.validate()?;
    // Complete the rendezvous before any platform or crash-marker setup that
    // can fail. AudioHostIpcClient constructs synchronously on Electron's main
    // thread; connecting first guarantees an early helper failure is observed
    // by its IPC routers instead of leaving the parent blocked in accept().
    let token = ipc_token.ok_or("missing --ipc-token")?;
    let rendezvous = IpcSender::<IpcSender<HostBootstrap>>::connect(token)?;
    let (bootstrap_sender, bootstrap_receiver) = ipc::channel::<HostBootstrap>()?;
    rendezvous.send(bootstrap_sender)?;

    editor_platform::configure_process_application_identity()
        .map_err(|error| format!("could not configure application identity: {error}"))?;
    // VSTGUI performs process-thread platform initialization from InitDll. On
    // Windows that includes COM-backed WIC creation, so OLE must already be
    // initialized before any plug-in module is loaded. Keep this guard alive
    // until after every editor, controller, and module owned below is dropped.
    let _native_ui_context = NativeUiContext::initialize()
        .map_err(|error| format!("could not initialize native UI context: {error}"))?;
    if let Some(path) = crash_marker_path.as_deref() {
        crash_marker::initialize(path)
            .map_err(|error| format!("could not initialize crash marker: {error}"))?;
    }
    let bootstrap = bootstrap_receiver.recv()?;

    let mut event_loop_builder = EventLoop::<UiEvent>::with_user_event();
    #[cfg(target_os = "macos")]
    event_loop_builder.with_activation_policy(ActivationPolicy::Accessory);
    let event_loop = event_loop_builder.build()?;
    let compositor = iced_tiny_skia::window::compositor::new(
        iced_tiny_skia::Settings::default(),
        event_loop.owned_display_handle(),
    );
    let proxy = event_loop.create_proxy();
    let application_proxy = proxy.clone();
    let (ui_sender, ui_inbox) = std_mpsc::sync_channel(UI_MAILBOX_CAPACITY);
    let (host_event_sender, host_event_inbox) = std_mpsc::sync_channel(UI_MAILBOX_CAPACITY);
    let (background_sender, background_inbox) = mpsc::channel(UI_MAILBOX_CAPACITY);
    let winit_background_sender = background_sender.clone();
    let processors = Arc::new(Mutex::new(HashMap::new()));
    let protocol_processors = processors.clone();
    let winit_generation = Arc::new(AtomicU64::new(0));
    let protocol_winit_generation = winit_generation.clone();
    let protocol_thread = thread::Builder::new()
        .name("yadaw-control".into())
        .spawn(move || {
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .worker_threads(runtime_config.worker_threads)
                .max_blocking_threads(runtime_config.max_blocking_threads)
                .thread_name("yadaw-tokio")
                .enable_all()
                .build()
                .expect("multi-thread Tokio runtime must start");
            let local = tokio::task::LocalSet::new();
            local.block_on(&runtime, async move {
                if let Err(error) = run_protocol_actor(
                    bootstrap,
                    ProtocolActorDeps {
                        ui_proxy: proxy.clone(),
                        ui_sender,
                        host_event_inbox,
                        processors: protocol_processors,
                        winit_generation: protocol_winit_generation,
                        runtime_config,
                        background_sender,
                        background_inbox,
                    },
                )
                .await
                {
                    eprintln!("audio-host: protocol actor stopped: {error}");
                    let _ = proxy.send_event(UiEvent::Exit);
                }
            });
        })?;
    let mut application = WinitHost {
        generation: winit_generation,
        proxy: application_proxy,
        inbox: ui_inbox,
        processors,
        background_sender: winit_background_sender,
        host_events: host_event_sender,
        vst3: Some(vst3::Vst3Runtime::new()),
        compositor,
        editor_owner_window,
        editors: HashMap::new(),
        editor_instances: HashMap::new(),
    };
    event_loop.run_app(&mut application)?;
    protocol_thread
        .join()
        .map_err(|_| "audio-host protocol thread panicked")?;
    Ok(())
}
