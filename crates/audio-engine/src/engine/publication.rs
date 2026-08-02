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
    source_graph: NativeMixerGraph,
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

impl AudioEngine {
fn engine_transport_handles(
    &self,
    sample_rate: u32,
) -> Result<(Arc<TransportShared>, Arc<InputPeakBank>)> {
    let guard = self.running
        .lock()
        .map_err(|_| audio_error("audio engine lock", "poisoned"))?;
    if let Some(engine) = guard.as_ref() {
        Self::validate_session_sample_rate(engine.metrics.sample_rate, sample_rate)?;
    }
    Ok(guard.as_ref().map_or_else(
        || {
            (
                Arc::new(TransportShared {
                    state: Arc::new(AtomicU32::new(TRANSPORT_STOPPED)),
                    position_frames: Arc::new(AtomicU64::new(0)),
                    position_ticks: Arc::new(AtomicU64::new(0)),
                    sample_rate: AtomicU32::new(sample_rate),
                    effective_bpm_bits: AtomicU64::new(f64::NAN.to_bits()),
                    clock_source: AtomicU32::new(0),
                    waiting_for: AtomicU32::new(0),
                    loop_enabled: AtomicBool::new(false),
                    loop_has_range: AtomicBool::new(false),
                    loop_start_tick: AtomicU64::new(0),
                    loop_end_tick: AtomicU64::new(0),
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

/// Allocate a build generation and capture transport handles. Heavy compile
/// work must run on a supervised graph worker via
/// [`compile_graph_build`].
pub fn begin_graph_build(&self, graph: NativeMixerGraph) -> Result<GraphBuildInput> {
    let build_generation = self.next_build_generation.fetch_add(1, Ordering::Relaxed);
    let (transport, input_peaks) = self.engine_transport_handles(graph.sample_rate)?;
    Ok(GraphBuildInput {
        graph,
        build_generation,
        transport,
        input_peaks,
    })
}
}

/// Compile routing, PDC, clip storage, and callback buffers. Safe to run on a
/// background worker; must not touch controllers, winit, devices, or the active
/// graph.
pub fn compile_graph_build(input: GraphBuildInput) -> Result<CompiledGraphBuild> {
    let snapshot = compiled_graph_snapshot(&input.graph, input.build_generation);
    let source_graph = input.graph.clone();
    let runtime = Box::new(build_mixer_runtime(
        input.graph,
        input.build_generation,
        input.transport,
        input.input_peaks,
    )?);
    Ok(CompiledGraphBuild {
        runtime,
        snapshot,
        source_graph,
    })
}

impl AudioEngine {
fn latest_build_generation(&self) -> u64 {
    self.next_build_generation
        .load(Ordering::Acquire)
        .saturating_sub(1)
}

#[cfg(any(test, feature = "bench-internals"))]
pub fn latest_build_generation_for_test(&self) -> u64 {
    self.latest_build_generation()
}

/// Queue a compiled runtime for block-boundary publication. Stale generations
/// that lost to a newer build are discarded without publishing.
pub fn publish_mixer_runtime(&self, built: CompiledGraphBuild) -> Result<PublishOutcome> {
    let build_generation = built.runtime.build_generation;
    if build_generation != self.latest_build_generation() {
        return Ok(PublishOutcome::Superseded);
    }
    let source_graph = built.source_graph;
    let snapshot = built.snapshot;
    let mut last_graph = self.last_native_graph
        .lock()
        .map_err(|_| audio_error("last mixer graph lock", "poisoned"))?;
    let mut guard = self.running
        .lock()
        .map_err(|_| audio_error("audio engine lock", "poisoned"))?;
    if build_generation != self.latest_build_generation() {
        return Ok(PublishOutcome::Superseded);
    }
    if let Some(engine) = guard.as_mut() {
        Self::validate_session_sample_rate(engine.metrics.sample_rate, built.runtime.sample_rate)?;
        engine.reclaim_retired_mixers();
        engine.meter_bank = Arc::clone(&built.runtime.meter_bank);
        engine
            .commands
            .try_push(EngineCommand::LoadMixer(built.runtime))
            .map_err(|_| audio_error("mixer control queue", "full"))?;
    } else {
        *self.pending_mixer
            .lock()
            .map_err(|_| audio_error("pending mixer lock", "poisoned"))? = Some(built.runtime);
    }
    *last_graph = Some(source_graph);
    if let Ok(mut snapshots) = self.compiled_graph_snapshots.lock()
    {
        snapshots.insert(build_generation, snapshot);
        while snapshots.len() > 16 {
            let Some(oldest) = snapshots.keys().next().copied() else {
                break;
            };
            snapshots.remove(&oldest);
        }
    }
    Ok(PublishOutcome::Published)
}

/// Synchronous build+publish helper for the MessagePack compatibility path.
pub fn load_mixer_graph(&self, graph: NativeMixerGraph) -> Result<()> {
    let input = self.begin_graph_build(graph)?;
    let built = compile_graph_build(input)?;
    match self.publish_mixer_runtime(built)? {
        PublishOutcome::Published | PublishOutcome::Superseded => Ok(()),
    }
}

/// Mutate the last native graph's plug-in timing. Returns a replacement graph
/// when a rebuild is required.
pub fn apply_plugin_timing(
    &self,
    instance_id: &str,
    latency_samples: u32,
    tail_samples: Option<u32>,
) -> Result<Option<NativeMixerGraph>> {
    let mut guard = self.last_native_graph
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
    &self,
    instance_id: &str,
    latency_samples: u32,
    tail_samples: Option<u32>,
) -> Result<bool> {
    let Some(replacement) = self.apply_plugin_timing(instance_id, latency_samples, tail_samples)? else {
        return Ok(false);
    };
    self.load_mixer_graph(replacement)?;
    Ok(true)
}

pub fn preview_mixer_parameter(&self, preview: NativeMixerParameterPreview) -> Result<()> {
    let mut guard = self.running
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

pub fn mixer_snapshot(&self) -> Result<NativeMixerSnapshot> {
    let guard = self.running
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
    &self,
    kind: String,
    position_frames: Option<i64>,
    loop_enabled: Option<bool>,
    loop_start_tick: Option<i64>,
    loop_end_tick: Option<i64>,
) -> Result<NativeTransportSnapshot> {
    let mut guard = self.running
        .lock()
        .map_err(|_| audio_error("audio engine lock", "poisoned"))?;
    let engine = guard
        .as_mut()
        .ok_or_else(|| invalid_config("audio engine must be running before transport"))?;
    let position = position_frames.unwrap_or(0).max(0) as u64;
    if kind == "set-loop" {
        let range = match (loop_start_tick, loop_end_tick) {
            (Some(start), Some(end)) if start >= 0 && end > start => {
                Some((start as u64, end as u64))
            }
            (None, None) => None,
            _ => return Err(invalid_config("loop range must have increasing non-negative ticks")),
        };
        engine.transport.loop_enabled.store(false, Ordering::Release);
        if let Some((start, end)) = range {
            engine.transport.loop_start_tick.store(start, Ordering::Relaxed);
            engine.transport.loop_end_tick.store(end, Ordering::Relaxed);
            engine.transport.loop_has_range.store(true, Ordering::Release);
        } else {
            engine.transport.loop_has_range.store(false, Ordering::Release);
        }
        engine
            .transport
            .loop_enabled
            .store(loop_enabled.unwrap_or(false), Ordering::Release);
        return Ok(engine.transport.snapshot());
    }
    let command = match kind.as_str() {
        "clear-meter-clips" => EngineCommand::ClearMeterClips,
        "play" => EngineCommand::Transport(TransportAction::Play, position),
        "pause" => EngineCommand::Transport(TransportAction::Pause, position),
        "stop" => EngineCommand::Transport(TransportAction::Stop, position),
        "seek" => EngineCommand::Transport(TransportAction::Seek, position),
        "record" => EngineCommand::Transport(TransportAction::Record { count_in: false }, position),
        "record-count-in" => {
            EngineCommand::Transport(TransportAction::Record { count_in: true }, position)
        }
        _ => return Err(invalid_config("unknown transport command")),
    };
    engine
        .commands
        .try_push(command)
        .map_err(|_| audio_error("mixer control queue", "full"))?;
    Ok(engine.transport.snapshot())
}

pub fn transport_clock_handle(&self) -> Result<TransportClockHandle> {
    let guard = self.running
        .lock()
        .map_err(|_| audio_error("audio engine lock", "poisoned"))?;
    let engine = guard
        .as_ref()
        .ok_or_else(|| invalid_config("audio engine is not running"))?;
    Ok(TransportClockHandle {
        state: Arc::clone(&engine.transport.state),
        position_frames: Arc::clone(&engine.transport.position_frames),
        position_ticks: Arc::clone(&engine.transport.position_ticks),
        recording_state: TRANSPORT_RECORDING,
    })
}

pub fn transport_snapshot(&self) -> Result<NativeTransportSnapshot> {
    let guard = self.running
        .lock()
        .map_err(|_| audio_error("audio engine lock", "poisoned"))?;
    Ok(guard.as_ref().map_or(
        NativeTransportSnapshot {
            state: "stopped".to_owned(),
            position_frames: 0,
            position_ticks: 0,
            sample_rate: 0,
            effective_bpm: None,
            clock_source: "internal".to_owned(),
            waiting_for: None,
            loop_enabled: false,
            loop_start_tick: None,
            loop_end_tick: None,
        },
        |engine| engine.transport.snapshot(),
    ))
}

pub fn heartbeat_snapshot(&self) -> (u64, String) {
    let Ok(guard) = self.running.lock() else {
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
pub fn native_graph_references_plugin(&self, instance_id: &str) -> bool {
    self.last_native_graph
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

#[cfg(any(test, feature = "bench-internals"))]
pub fn set_last_native_graph_for_test(&self, graph: Option<NativeMixerGraph>) {
    *self.last_native_graph
        .lock()
        .expect("last mixer graph lock") = graph;
}

#[cfg(any(test, feature = "bench-internals"))]
pub fn last_native_graph_generation_for_test(&self) -> Option<u64> {
    self.last_native_graph
        .lock()
        .ok()
        .and_then(|graph| graph.as_ref().map(|graph| graph.generation))
}

pub fn published_graph_generation(&self) -> u64 {
    self.running
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

pub fn compiled_audio_graph_snapshot(&self) -> Option<CompiledAudioGraphSnapshot> {
    let build_generation = self.running
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
    self.compiled_graph_snapshots
        .lock()
        .ok()
        .and_then(|snapshots| snapshots.get(&build_generation).cloned())
}
}
