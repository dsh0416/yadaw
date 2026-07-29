/// Immutable input for a supervised graph-worker compile.
pub struct GraphBuildInput {
    graph: NativeMixerGraph,
    build_generation: u64,
    transport: Arc<TransportShared>,
    input_peaks: Arc<InputPeakBank>,
}

impl GraphBuildInput {
    pub fn build_generation(&self) -> u64 {
        self.build_generation
    }
}

/// Preallocated runtime + diagnostic snapshot produced by a graph worker.
pub struct CompiledGraphBuild {
    runtime: Box<NativeMixerRuntime>,
    snapshot: CompiledAudioGraphSnapshot,
}

impl CompiledGraphBuild {
    pub fn build_generation(&self) -> u64 {
        self.runtime.build_generation
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PublishOutcome {
    Published,
    Superseded,
}

fn engine_transport_handles(
    sample_rate: u32,
) -> Result<(Arc<TransportShared>, Arc<InputPeakBank>)> {
    let guard = engine_slot()
        .lock()
        .map_err(|_| audio_error("audio engine lock", "poisoned"))?;
    if let Some(engine) = guard.as_ref() {
        validate_session_sample_rate(engine.metrics.sample_rate, sample_rate)?;
    }
    Ok(guard.as_ref().map_or_else(
        || {
            (
                Arc::new(TransportShared {
                    state: AtomicU32::new(TRANSPORT_STOPPED),
                    position_frames: AtomicU64::new(0),
                    sample_rate: AtomicU32::new(sample_rate),
                }),
                Arc::new(InputPeakBank::new()),
            )
        },
        |engine| {
            (
                Arc::clone(&engine.transport),
                Arc::clone(&engine.input_peaks),
            )
        },
    ))
}

fn validate_session_sample_rate(engine_sample_rate: u32, graph_sample_rate: u32) -> Result<()> {
    if engine_sample_rate != graph_sample_rate {
        return Err(invalid_config(
            "mixer sample rate does not match the audio engine session rate",
        ));
    }
    Ok(())
}

/// Store the candidate graph, allocate a build generation, and capture transport
/// handles. Heavy compile work must run on a supervised graph worker via
/// [`compile_graph_build`].
pub fn begin_graph_build(graph: NativeMixerGraph) -> Result<GraphBuildInput> {
    *LAST_NATIVE_GRAPH
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| audio_error("last mixer graph lock", "poisoned"))? = Some(graph.clone());
    let build_generation = NEXT_BUILD_GENERATION.fetch_add(1, Ordering::Relaxed);
    let (transport, input_peaks) = engine_transport_handles(graph.sample_rate)?;
    Ok(GraphBuildInput {
        graph,
        build_generation,
        transport,
        input_peaks,
    })
}

/// Compile routing, PDC, clip storage, and callback buffers. Safe to run on a
/// background worker; must not touch controllers, winit, devices, or the active
/// graph.
pub fn compile_graph_build(input: GraphBuildInput) -> Result<CompiledGraphBuild> {
    let snapshot = compiled_graph_snapshot(&input.graph, input.build_generation);
    let runtime = Box::new(build_mixer_runtime(
        input.graph,
        input.build_generation,
        input.transport,
        input.input_peaks,
    )?);
    Ok(CompiledGraphBuild { runtime, snapshot })
}

fn latest_build_generation() -> u64 {
    NEXT_BUILD_GENERATION
        .load(Ordering::Acquire)
        .saturating_sub(1)
}

#[cfg(test)]
pub(crate) fn latest_build_generation_for_test() -> u64 {
    latest_build_generation()
}

/// Queue a compiled runtime for block-boundary publication. Stale generations
/// that lost to a newer build are discarded without publishing.
pub fn publish_mixer_runtime(built: CompiledGraphBuild) -> Result<PublishOutcome> {
    let build_generation = built.runtime.build_generation;
    if build_generation != latest_build_generation() {
        return Ok(PublishOutcome::Superseded);
    }
    if let Ok(mut snapshots) = COMPILED_GRAPH_SNAPSHOTS
        .get_or_init(|| Mutex::new(BTreeMap::new()))
        .lock()
    {
        snapshots.insert(build_generation, built.snapshot);
        while snapshots.len() > 16 {
            let Some(oldest) = snapshots.keys().next().copied() else {
                break;
            };
            snapshots.remove(&oldest);
        }
    }
    let mut guard = engine_slot()
        .lock()
        .map_err(|_| audio_error("audio engine lock", "poisoned"))?;
    if build_generation != latest_build_generation() {
        return Ok(PublishOutcome::Superseded);
    }
    if let Some(engine) = guard.as_mut() {
        validate_session_sample_rate(engine.metrics.sample_rate, built.runtime.sample_rate)?;
        engine.reclaim_retired_mixers();
        engine.meter_bank = Arc::clone(&built.runtime.meter_bank);
        engine
            .commands
            .try_push(EngineCommand::LoadMixer(built.runtime))
            .map_err(|_| audio_error("mixer control queue", "full"))?;
    } else {
        *pending_mixer_slot()
            .lock()
            .map_err(|_| audio_error("pending mixer lock", "poisoned"))? = Some(built.runtime);
    }
    Ok(PublishOutcome::Published)
}

/// Synchronous build+publish helper for the MessagePack compatibility path.
pub fn load_mixer_graph(graph: NativeMixerGraph) -> Result<()> {
    let input = begin_graph_build(graph)?;
    let built = compile_graph_build(input)?;
    match publish_mixer_runtime(built)? {
        PublishOutcome::Published | PublishOutcome::Superseded => Ok(()),
    }
}

/// Mutate the last native graph's plug-in timing. Returns a replacement graph
/// when a rebuild is required.
pub fn apply_plugin_timing(
    instance_id: &str,
    latency_samples: u32,
    tail_samples: Option<u32>,
) -> Result<Option<NativeMixerGraph>> {
    let mut guard = LAST_NATIVE_GRAPH
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| audio_error("last mixer graph lock", "poisoned"))?;
    let Some(graph) = guard.as_mut() else {
        return Ok(None);
    };
    let Some(plugin) = graph
        .plugins
        .iter_mut()
        .find(|plugin| plugin.instance_id == instance_id)
    else {
        return Ok(None);
    };
    if plugin.latency_samples == latency_samples && plugin.tail_samples == tail_samples {
        return Ok(None);
    }
    plugin.latency_samples = latency_samples;
    plugin.tail_samples = tail_samples;
    Ok(Some(graph.clone()))
}

/// Synchronous timing rebuild for the MessagePack compatibility path.
pub fn update_plugin_timing(
    instance_id: &str,
    latency_samples: u32,
    tail_samples: Option<u32>,
) -> Result<bool> {
    let Some(replacement) = apply_plugin_timing(instance_id, latency_samples, tail_samples)? else {
        return Ok(false);
    };
    load_mixer_graph(replacement)?;
    Ok(true)
}

pub fn preview_mixer_parameter(preview: NativeMixerParameterPreview) -> Result<()> {
    let mut guard = engine_slot()
        .lock()
        .map_err(|_| audio_error("audio engine lock", "poisoned"))?;
    let Some(engine) = guard.as_mut() else {
        return Ok(());
    };
    engine
        .commands
        .try_push(EngineCommand::Preview(
            RealtimeParameterCommand::from_preview(preview)?,
        ))
        .map_err(|_| audio_error("mixer control queue", "full"))
}

pub fn mixer_snapshot() -> Result<NativeMixerSnapshot> {
    let guard = engine_slot()
        .lock()
        .map_err(|_| audio_error("audio engine lock", "poisoned"))?;
    Ok(NativeMixerSnapshot {
        meters: guard.as_ref().map_or_else(Vec::new, |engine| {
            engine
                .meter_bank
                .channels
                .iter()
                .map(MeterAtomics::snapshot)
                .collect()
        }),
    })
}

pub fn transport_command(
    kind: String,
    position_frames: Option<i64>,
) -> Result<NativeTransportSnapshot> {
    let mut guard = engine_slot()
        .lock()
        .map_err(|_| audio_error("audio engine lock", "poisoned"))?;
    let engine = guard
        .as_mut()
        .ok_or_else(|| invalid_config("audio engine must be running before transport"))?;
    let position = position_frames.unwrap_or(0).max(0) as u64;
    let command = match kind.as_str() {
        "clear-meter-clips" => EngineCommand::ClearMeterClips,
        "play" => EngineCommand::Transport(TransportAction::Play, position),
        "pause" => EngineCommand::Transport(TransportAction::Pause, position),
        "stop" => EngineCommand::Transport(TransportAction::Stop, position),
        "seek" => EngineCommand::Transport(TransportAction::Seek, position),
        "record" => EngineCommand::Transport(TransportAction::Record, position),
        _ => return Err(invalid_config("unknown transport command")),
    };
    engine
        .commands
        .try_push(command)
        .map_err(|_| audio_error("mixer control queue", "full"))?;
    Ok(engine.transport.snapshot())
}

pub fn transport_snapshot() -> Result<NativeTransportSnapshot> {
    let guard = engine_slot()
        .lock()
        .map_err(|_| audio_error("audio engine lock", "poisoned"))?;
    Ok(guard.as_ref().map_or(
        NativeTransportSnapshot {
            state: "stopped".to_owned(),
            position_frames: 0,
            sample_rate: 0,
        },
        |engine| engine.transport.snapshot(),
    ))
}

pub fn heartbeat_snapshot() -> (u64, String) {
    let Ok(guard) = engine_slot().lock() else {
        return (0, "error".to_owned());
    };
    guard.as_ref().map_or((0, "stopped".to_owned()), |engine| {
        (
            engine.metrics.callback_generation.load(Ordering::Acquire),
            engine.transport.snapshot().state,
        )
    })
}

/// Returns true when the last candidate/native mixer graph still lists `instance_id`.
///
/// Unload callers use this to decide whether the VST3 allocation must be retained for a mixer
/// generation that may still hold a processor lease.
pub fn native_graph_references_plugin(instance_id: &str) -> bool {
    LAST_NATIVE_GRAPH
        .get_or_init(|| Mutex::new(None))
        .lock()
        .ok()
        .and_then(|graph| {
            graph.as_ref().map(|graph| {
                graph
                    .plugins
                    .iter()
                    .any(|plugin| plugin.instance_id == instance_id)
            })
        })
        .unwrap_or(false)
}

#[cfg(test)]
pub(crate) fn set_last_native_graph_for_test(graph: Option<NativeMixerGraph>) {
    *LAST_NATIVE_GRAPH
        .get_or_init(|| Mutex::new(None))
        .lock()
        .expect("last mixer graph lock") = graph;
}

pub fn published_graph_generation() -> u64 {
    engine_slot()
        .lock()
        .ok()
        .and_then(|engine| {
            engine.as_ref().map(|engine| {
                engine
                    .metrics
                    .published_graph_generation
                    .load(Ordering::Acquire)
            })
        })
        .unwrap_or(0)
}

pub fn compiled_audio_graph_snapshot() -> Option<CompiledAudioGraphSnapshot> {
    let build_generation = engine_slot()
        .lock()
        .ok()
        .and_then(|engine| {
            engine.as_ref().map(|engine| {
                engine
                    .metrics
                    .published_graph_build_generation
                    .load(Ordering::Acquire)
            })
        })
        .unwrap_or(0);
    if build_generation == 0 {
        return None;
    }
    COMPILED_GRAPH_SNAPSHOTS
        .get_or_init(|| Mutex::new(BTreeMap::new()))
        .lock()
        .ok()
        .and_then(|snapshots| snapshots.get(&build_generation).cloned())
}
