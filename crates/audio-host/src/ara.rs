use std::{
    collections::{HashMap, VecDeque},
    ffi::{c_char, c_void},
    fmt::Write as _,
    path::Path,
    rc::Rc,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU8, Ordering},
    },
};

use ara2_bridge_core::{
    ApiGeneration, AraBool, AraError, AudioModificationProperties, AudioSourceProperties,
    ContentTimeRange, DocumentProperties, MusicalContextProperties, PlaybackRegionProperties,
    RegionSequenceProperties,
};
use ara2_bridge_host::{
    AudioModificationHandle, AudioSourceHandle, AudioSourceId, DocumentSession,
    ExtensionController, ExtensionRoles, HostServices, HostServicesBuilder, LoadedFactory,
    MusicalContextHandle, PlaybackRegionAssignment, PlaybackRegionHandle, RegionSequenceAssignment,
    RegionSequenceHandle, RendererRole,
};
use ara2_bridge_sys::{ARAAssertCategory, ARAFactory, ARAPlugInExtensionInstance};
use bwavfile::WaveReader;
use heron_dsp_runtime::protocol::{
    AraAnalysisProgressState, AraArchiveDirection, AraCallbackEvent, AraCallbackFailureCategory,
    AraObjectKind, LiveMixerClip, LiveMixerGraph, LiveTempoEvent, LiveTimeSignatureEvent,
};
use heron_vst3_host::{AraMainFactory, AraPluginEntry, ClassId, HostError, Module};
use sha2::{Digest, Sha256};

mod providers;

#[cfg(test)]
use ara2_bridge_host::HostAudioReader;
#[cfg(test)]
use providers::AudioReader;
use providers::{
    ArchiveRegistry, AudioRegistry, ModelUpdates, PlaybackRequests, TimelineContent, tempo_map,
};

const ARA_2_FINAL: i32 = 4;
const ARA_2_3_FINAL: i32 = 6;

#[derive(Clone, Debug, PartialEq)]
struct TrackGraph {
    sample_rate: u32,
    channel_id: String,
    clips: Vec<LiveMixerClip>,
    tempo_events: Vec<LiveTempoEvent>,
    time_signature_events: Vec<LiveTimeSignatureEvent>,
}

#[derive(Clone)]
struct SourceSpec {
    path: String,
    sample_rate: u32,
    sample_count: i64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum AraTransportRequest {
    Start,
    Stop,
    SetPosition(f64),
    SetCycleRange { start: f64, duration: f64 },
    EnableCycle(bool),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum CallbackObjectKind {
    AudioSource,
    AudioModification,
    PlaybackRegion,
}

impl CallbackObjectKind {
    const fn protocol(self) -> AraObjectKind {
        match self {
            Self::AudioSource => AraObjectKind::AudioSource,
            Self::AudioModification => AraObjectKind::AudioModification,
            Self::PlaybackRegion => AraObjectKind::PlaybackRegion,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct CallbackObjectKey {
    kind: CallbackObjectKind,
    address: usize,
}

#[derive(Clone, Debug)]
struct PendingContentChange {
    object_id: String,
    range: Option<(f64, f64)>,
    scopes: u32,
}

#[derive(Default)]
struct CallbackState {
    identities: HashMap<CallbackObjectKey, String>,
    analysis: HashMap<usize, (String, AraAnalysisProgressState, f32)>,
    content: HashMap<CallbackObjectKey, PendingContentChange>,
    document_dirty: bool,
    archive_store_progress: Option<f32>,
    archive_restore_progress: Option<f32>,
    transport: VecDeque<AraTransportRequest>,
}

#[derive(Clone, Default)]
struct AraCallbackSink {
    state: Arc<Mutex<CallbackState>>,
    active: Arc<AtomicBool>,
    quarantine_reason: Arc<AtomicU8>,
}

pub(crate) struct AraCallbackBatch {
    pub(crate) instance_id: String,
    pub(crate) events: Vec<(u64, AraCallbackEvent)>,
    pub(crate) transport: Vec<AraTransportCommand>,
    pub(crate) failures: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AraTransportCommand {
    Play,
    Pause,
    SeekFrames(i64),
    SetLoop {
        enabled: bool,
        start_tick: i64,
        end_tick: i64,
    },
}

impl AraCallbackSink {
    const TRANSPORT_CAPACITY: usize = 64;

    fn activate(&self) {
        self.active.store(true, Ordering::Release);
    }

    fn deactivate(&self) {
        self.active.store(false, Ordering::Release);
        if let Ok(mut state) = self.state.lock() {
            state.transport.clear();
        }
    }

    fn is_quarantined(&self) -> bool {
        self.quarantine_reason.load(Ordering::Acquire) != 0
    }

    fn quarantine(&self, category: AraCallbackFailureCategory) {
        let value = match category {
            AraCallbackFailureCategory::InvalidReference => 1,
            AraCallbackFailureCategory::QueueOverflow => 2,
            AraCallbackFailureCategory::ProviderPanic => 3,
            AraCallbackFailureCategory::HostState => 4,
        };
        let _ =
            self.quarantine_reason
                .compare_exchange(0, value, Ordering::AcqRel, Ordering::Acquire);
    }

    fn quarantine_category(&self) -> Option<AraCallbackFailureCategory> {
        match self.quarantine_reason.load(Ordering::Acquire) {
            1 => Some(AraCallbackFailureCategory::InvalidReference),
            2 => Some(AraCallbackFailureCategory::QueueOverflow),
            3 => Some(AraCallbackFailureCategory::ProviderPanic),
            4 => Some(AraCallbackFailureCategory::HostState),
            _ => None,
        }
    }

    fn with_state<T>(
        &self,
        operation: impl FnOnce(&mut CallbackState) -> Result<T, AraError>,
    ) -> Result<T, AraError> {
        if !self.active.load(Ordering::Acquire) {
            return Err(AraError::InvalidState("ARA callback sink is inactive"));
        }
        if self.is_quarantined() {
            return Err(AraError::InvalidState("ARA callback sink is quarantined"));
        }
        let mut state = self.state.lock().map_err(|_| {
            self.quarantine(AraCallbackFailureCategory::ProviderPanic);
            AraError::Poisoned
        })?;
        operation(&mut state)
    }

    fn register(
        &self,
        kind: CallbackObjectKind,
        address: usize,
        id: String,
    ) -> Result<(), AraError> {
        self.with_state(|state| {
            let key = CallbackObjectKey { kind, address };
            if state.identities.insert(key, id).is_some() {
                return Err(AraError::InvalidState(
                    "duplicate ARA host object reference",
                ));
            }
            Ok(())
        })
        .inspect_err(|_| self.quarantine(AraCallbackFailureCategory::InvalidReference))
    }

    fn unregister(&self, kind: CallbackObjectKind, address: usize) {
        if let Ok(mut state) = self.state.lock() {
            let key = CallbackObjectKey { kind, address };
            state.identities.remove(&key);
            state.content.remove(&key);
            if kind == CallbackObjectKind::AudioSource {
                state.analysis.remove(&address);
            }
        }
    }

    fn identity(
        state: &CallbackState,
        kind: CallbackObjectKind,
        address: usize,
    ) -> Result<String, AraError> {
        state
            .identities
            .get(&CallbackObjectKey { kind, address })
            .cloned()
            .ok_or(AraError::InvalidArgument(
                "unknown or stale ARA host object reference",
            ))
    }

    fn analysis_progress(
        &self,
        source: AudioSourceId,
        raw_state: i32,
        progress: f32,
    ) -> Result<(), AraError> {
        if !progress.is_finite() || !(0.0..=1.0).contains(&progress) {
            return Err(AraError::InvalidArgument("invalid ARA analysis progress"));
        }
        let state = match raw_state {
            value if value == ara2_bridge_sys::kARAAnalysisProgressStarted as i32 => {
                AraAnalysisProgressState::Started
            }
            value if value == ara2_bridge_sys::kARAAnalysisProgressUpdated as i32 => {
                AraAnalysisProgressState::Updated
            }
            value if value == ara2_bridge_sys::kARAAnalysisProgressCompleted as i32 => {
                AraAnalysisProgressState::Completed
            }
            _ => {
                return Err(AraError::InvalidArgument(
                    "unknown ARA analysis progress state",
                ));
            }
        };
        self.with_state(|pending| {
            let id = Self::identity(pending, CallbackObjectKind::AudioSource, source.address())?;
            pending
                .analysis
                .insert(source.address(), (id, state, progress));
            Ok(())
        })
        .inspect_err(|_| self.quarantine(AraCallbackFailureCategory::InvalidReference))
    }

    fn content_changed(
        &self,
        kind: CallbackObjectKind,
        address: usize,
        range: Option<ContentTimeRange>,
        scopes: i32,
    ) -> Result<(), AraError> {
        let scopes = u32::try_from(scopes)
            .map_err(|_| AraError::InvalidArgument("negative ARA content scope flags"))?;
        self.with_state(|state| {
            let object_id = Self::identity(state, kind, address)?;
            let key = CallbackObjectKey { kind, address };
            let range = range.map(|value| (value.start(), value.duration()));
            state
                .content
                .entry(key)
                .and_modify(|pending| {
                    pending.scopes |= scopes;
                    pending.range = merge_content_ranges(pending.range, range);
                })
                .or_insert(PendingContentChange {
                    object_id,
                    range,
                    scopes,
                });
            Ok(())
        })
        .inspect_err(|_| self.quarantine(AraCallbackFailureCategory::InvalidReference))
    }

    fn archive_progress(
        &self,
        direction: AraArchiveDirection,
        progress: f32,
    ) -> Result<(), AraError> {
        if !progress.is_finite() || !(0.0..=1.0).contains(&progress) {
            return Err(AraError::InvalidArgument("invalid ARA archive progress"));
        }
        self.with_state(|state| {
            match direction {
                AraArchiveDirection::Store => state.archive_store_progress = Some(progress),
                AraArchiveDirection::Restore => state.archive_restore_progress = Some(progress),
            }
            Ok(())
        })
    }

    fn transport(&self, request: AraTransportRequest) -> Result<(), AraError> {
        self.with_state(|state| {
            if state.transport.len() >= Self::TRANSPORT_CAPACITY {
                return Err(AraError::InvalidState("ARA transport callback queue is full"));
            }
            state.transport.push_back(request);
            Ok(())
        })
        .inspect_err(|error| {
            if matches!(error, AraError::InvalidState(message) if *message == "ARA transport callback queue is full") {
                self.quarantine(AraCallbackFailureCategory::QueueOverflow);
            }
        })
    }

    fn drain(
        &self,
        include_model_events: bool,
    ) -> Result<(Vec<AraCallbackEvent>, Vec<AraTransportRequest>), AraError> {
        let mut state = self.state.lock().map_err(|_| AraError::Poisoned)?;
        if !include_model_events {
            return Ok((Vec::new(), state.transport.drain(..).collect()));
        }
        let mut events = Vec::with_capacity(
            state.analysis.len()
                + state.content.len()
                + usize::from(state.document_dirty)
                + usize::from(state.archive_store_progress.is_some())
                + usize::from(state.archive_restore_progress.is_some()),
        );
        events.extend(
            state
                .analysis
                .drain()
                .map(
                    |(_, (object_id, state, progress))| AraCallbackEvent::AnalysisProgress {
                        object_id,
                        state,
                        progress,
                    },
                ),
        );
        events.extend(state.content.drain().map(|(key, pending)| {
            let (start_seconds, duration_seconds) =
                pending.range.map_or((None, None), |(start, duration)| {
                    (Some(start), Some(duration))
                });
            AraCallbackEvent::ContentChanged {
                object_kind: key.kind.protocol(),
                object_id: pending.object_id,
                start_seconds,
                duration_seconds,
                scopes: pending.scopes,
            }
        }));
        if std::mem::take(&mut state.document_dirty) {
            events.push(AraCallbackEvent::DocumentDataChanged);
        }
        if let Some(progress) = state.archive_store_progress.take() {
            events.push(AraCallbackEvent::ArchiveProgress {
                direction: AraArchiveDirection::Store,
                progress,
            });
        }
        if let Some(progress) = state.archive_restore_progress.take() {
            events.push(AraCallbackEvent::ArchiveProgress {
                direction: AraArchiveDirection::Restore,
                progress,
            });
        }
        Ok((events, state.transport.drain(..).collect()))
    }
}

fn merge_content_ranges(left: Option<(f64, f64)>, right: Option<(f64, f64)>) -> Option<(f64, f64)> {
    match (left, right) {
        (Some((left_start, left_duration)), Some((right_start, right_duration))) => {
            let start = left_start.min(right_start);
            let end = (left_start + left_duration).max(right_start + right_duration);
            Some((start, end - start))
        }
        (Some(range), None) | (None, Some(range)) => Some(range),
        (None, None) => None,
    }
}

#[derive(Clone, Default)]
struct GraphHandles {
    context: Option<MusicalContextHandle>,
    sequence: Option<RegionSequenceHandle>,
    sources: Vec<AudioSourceHandle>,
    modifications: Vec<AudioModificationHandle>,
    regions: Vec<PlaybackRegionHandle>,
}

pub(crate) struct AraDocument {
    instance_id: String,
    entry: AraPluginEntry,
    factory: Rc<AraFactoryHost>,
    services: Option<Box<HostServices>>,
    session: Option<DocumentSession<'static, 'static>>,
    extension: Option<ExtensionController<'static>>,
    playback_assignments: Vec<PlaybackRegionAssignment>,
    sequence_assignments: Vec<RegionSequenceAssignment>,
    audio: AudioRegistry,
    timeline: TimelineContent,
    archives: ArchiveRegistry,
    callbacks: AraCallbackSink,
    quarantine_reported: bool,
    archive_id: String,
    pending_archive: Option<Vec<u8>>,
    model: GraphHandles,
    graph: Option<TrackGraph>,
    cycle_range_ticks: Option<(i64, i64)>,
    cycle_enabled: bool,
}

pub(crate) struct AraFactoryHost {
    loaded_factory: Box<LoadedFactory<'static>>,
    main_factory: AraMainFactory,
    generation: ApiGeneration,
}

impl AraFactoryHost {
    pub(crate) fn create(
        module: &Module,
        factory_class_id: ClassId,
    ) -> Result<Rc<Self>, HostError> {
        let info = module.ara_factory_info(factory_class_id)?;
        let selected = info.highest_api_generation.min(ARA_2_3_FINAL);
        if selected < ARA_2_FINAL || info.lowest_api_generation > selected {
            return Err(HostError::Ara(
                "plug-in does not expose a compatible ARA 2 generation".into(),
            ));
        }
        let generation = ApiGeneration::try_from_raw(selected)
            .map_err(|error| HostError::Ara(error.to_string()))?;
        let main_factory = module.create_ara_main_factory(factory_class_id)?;
        let loaded_factory: Box<LoadedFactory<'static>> = Box::new(unsafe {
            // SAFETY: main_factory retains the immutable ARA factory. Field order drops this
            // loaded guard (and uninitializes ARA) before releasing that provider.
            LoadedFactory::load(
                main_factory.factory_ptr().cast::<ARAFactory>(),
                generation,
                Some(ara_assertion),
            )
            .map_err(|error| HostError::Ara(error.to_string()))?
        });
        Ok(Rc::new(Self {
            loaded_factory,
            main_factory,
            generation,
        }))
    }

    fn loaded(&self) -> &'static LoadedFactory<'static> {
        unsafe {
            // SAFETY: the Box allocation is stable and every document retains this factory host
            // until its session and companion entry have been torn down.
            &*std::ptr::from_ref(self.loaded_factory.as_ref())
        }
    }
}

impl AraDocument {
    pub(crate) fn create(
        instance_id: String,
        component: *mut c_void,
        factory: Rc<AraFactoryHost>,
        archive: Vec<u8>,
    ) -> Result<Self, HostError> {
        let entry = unsafe {
            // SAFETY: the hook runs after VST3 component initialization and the component is
            // retained by the HostedPlugin that will own the returned document.
            AraPluginEntry::discover(component)?
        };
        if entry.factory_ptr() != factory.main_factory.factory_ptr() {
            return Err(HostError::Ara(
                "VST3 ARA entry point and main factory disagree".into(),
            ));
        }
        let audio = AudioRegistry::default();
        let timeline = TimelineContent::default();
        let callbacks = AraCallbackSink::default();
        callbacks.activate();
        let archives = ArchiveRegistry::new(callbacks.clone());
        let services = Box::new(
            HostServicesBuilder::new()
                .audio(audio.clone())
                .archiving(archives.clone())
                .content(timeline.clone())
                .model_updates(ModelUpdates {
                    callbacks: callbacks.clone(),
                })
                .playback(PlaybackRequests {
                    callbacks: callbacks.clone(),
                })
                .build(factory.generation)
                .map_err(|error| HostError::Ara(error.to_string()))?,
        );
        let services_ref: &'static HostServices = unsafe {
            // SAFETY: this stable Box is stored in the document and explicit Drop closes the
            // session before releasing it.
            &*std::ptr::from_ref(services.as_ref())
        };
        let mut session = DocumentSession::new(
            factory.loaded(),
            services_ref,
            DocumentProperties::new(Some("Heron ARA document"))
                .map_err(|error| HostError::Ara(error.to_string()))?,
        )
        .map_err(|error| HostError::Ara(error.to_string()))?;
        let roles = ExtensionRoles::all();
        let extension_instance = unsafe {
            // SAFETY: this is the single mandatory bind, before VST3 activation or state access.
            entry.bind(session.controller_ref().cast(), roles.bits(), roles.bits())?
        };
        let extension: ExtensionController<'static> = unsafe {
            // SAFETY: entry and the VST3 component remain live until after extension teardown.
            session
                .bind_extension(
                    extension_instance.cast::<ARAPlugInExtensionInstance>(),
                    roles,
                    roles,
                )
                .map_err(|error| HostError::Ara(error.to_string()))?
        };
        let archive_id = factory
            .loaded_factory
            .metadata()
            .document_archive_id()
            .to_owned();
        Ok(Self {
            instance_id,
            entry,
            factory,
            services: Some(services),
            session: Some(session),
            extension: Some(extension),
            playback_assignments: Vec::new(),
            sequence_assignments: Vec::new(),
            audio,
            timeline,
            archives,
            callbacks,
            quarantine_reported: false,
            archive_id,
            pending_archive: (!archive.is_empty()).then_some(archive),
            model: GraphHandles::default(),
            graph: None,
            cycle_range_ticks: None,
            cycle_enabled: false,
        })
    }

    pub(crate) fn poll_host_callbacks(
        &mut self,
        include_model_events: bool,
        callback_sequence: &mut u64,
    ) -> AraCallbackBatch {
        if !self.callbacks.is_quarantined() {
            let notify_result = self
                .session
                .as_mut()
                .ok_or(AraError::InvalidState("ARA document session is closed"))
                .and_then(DocumentSession::notify_model_updates);
            if notify_result.is_err() {
                let category = if self
                    .services
                    .as_ref()
                    .is_some_and(|services| services.is_poisoned())
                {
                    AraCallbackFailureCategory::ProviderPanic
                } else {
                    AraCallbackFailureCategory::HostState
                };
                self.callbacks.quarantine(category);
            }
        }

        let (events, transport) = self
            .callbacks
            .drain(include_model_events)
            .unwrap_or_else(|_| {
                self.callbacks
                    .quarantine(AraCallbackFailureCategory::ProviderPanic);
                (Vec::new(), Vec::new())
            });
        let mut events = events
            .into_iter()
            .map(|event| (next_callback_sequence(callback_sequence), event))
            .collect::<Vec<_>>();
        if include_model_events
            && !self.quarantine_reported
            && let Some(category) = self.callbacks.quarantine_category()
        {
            self.quarantine_reported = true;
            let sequence = next_callback_sequence(callback_sequence);
            events.push((
                sequence,
                AraCallbackEvent::Quarantined {
                    category,
                    recoverable: false,
                },
            ));
        }
        let (transport, failures) = if self.callbacks.is_quarantined() {
            (Vec::new(), Vec::new())
        } else {
            let mut commands = Vec::with_capacity(transport.len());
            let mut failures = Vec::new();
            for request in transport {
                match self.resolve_transport_request(request) {
                    Ok(command) => commands.push(command),
                    Err(error) => failures.push(error.to_string()),
                }
            }
            (commands, failures)
        };
        AraCallbackBatch {
            instance_id: self.instance_id.clone(),
            events,
            transport,
            failures,
        }
    }

    fn resolve_transport_request(
        &mut self,
        request: AraTransportRequest,
    ) -> Result<AraTransportCommand, AraError> {
        match request {
            AraTransportRequest::Start => Ok(AraTransportCommand::Play),
            AraTransportRequest::Stop => Ok(AraTransportCommand::Pause),
            AraTransportRequest::SetPosition(seconds) => {
                let sample_rate = self
                    .graph
                    .as_ref()
                    .map(|graph| graph.sample_rate)
                    .filter(|sample_rate| *sample_rate > 0)
                    .ok_or(AraError::InvalidState(
                        "ARA document has no active sample rate",
                    ))?;
                let frame = (seconds * f64::from(sample_rate)).round();
                if frame > i64::MAX as f64 {
                    return Err(AraError::InvalidArgument(
                        "ARA playback position is too large",
                    ));
                }
                Ok(AraTransportCommand::SeekFrames(frame as i64))
            }
            AraTransportRequest::SetCycleRange { start, duration } => {
                let graph = self.graph.as_ref().ok_or(AraError::InvalidState(
                    "ARA document has no active tempo map",
                ))?;
                let tempo_map = tempo_map(graph)?;
                let start_tick = i64::try_from(tempo_map.seconds_to_tick(start))
                    .map_err(|_| AraError::InvalidArgument("ARA cycle start is too large"))?;
                let end_tick = i64::try_from(tempo_map.seconds_to_tick(start + duration))
                    .map_err(|_| AraError::InvalidArgument("ARA cycle end is too large"))?;
                if end_tick <= start_tick {
                    return Err(AraError::InvalidArgument("ARA cycle range is empty"));
                }
                self.cycle_range_ticks = Some((start_tick, end_tick));
                Ok(AraTransportCommand::SetLoop {
                    enabled: self.cycle_enabled,
                    start_tick,
                    end_tick,
                })
            }
            AraTransportRequest::EnableCycle(enabled) => {
                let (start_tick, end_tick) = self
                    .cycle_range_ticks
                    .ok_or(AraError::InvalidState("ARA cycle range is not set"))?;
                self.cycle_enabled = enabled;
                Ok(AraTransportCommand::SetLoop {
                    enabled,
                    start_tick,
                    end_tick,
                })
            }
        }
    }

    pub(crate) fn sync_live_graph(&mut self, graph: Option<&LiveMixerGraph>) -> Result<(), String> {
        let Some((graph, plugin)) = graph.and_then(|graph| {
            graph
                .plugins
                .iter()
                .find(|plugin| plugin.instance_id == self.instance_id)
                .map(|plugin| (graph, plugin))
        }) else {
            self.clear_graph().map_err(|error| error.to_string())?;
            self.graph = None;
            return Ok(());
        };
        let mut clips = graph
            .clips
            .iter()
            .filter(|clip| clip.channel_id == plugin.channel_id)
            .cloned()
            .collect::<Vec<_>>();
        clips.sort_by(|left, right| {
            left.start_frame
                .cmp(&right.start_frame)
                .then_with(|| left.id.cmp(&right.id))
        });
        let next = TrackGraph {
            sample_rate: graph.sample_rate,
            channel_id: plugin.channel_id.clone(),
            clips,
            tempo_events: graph.tempo_events.clone(),
            time_signature_events: graph.time_signature_events.clone(),
        };
        if self.graph.as_ref() == Some(&next) {
            return Ok(());
        }
        self.rebuild(&next).map_err(|error| error.to_string())?;
        self.graph = Some(next);
        Ok(())
    }

    pub(crate) fn save_archive(&mut self) -> Result<Vec<u8>, String> {
        if self.graph.is_none()
            && let Some(archive) = self.pending_archive.as_ref()
        {
            return Ok(archive.clone());
        }
        let archive_id = self.archive_id.clone();
        let archives = self.archives.clone();
        let session = self
            .session
            .as_mut()
            .ok_or_else(|| "ARA document session is closed".to_owned())?;
        session
            .notify_model_updates()
            .map_err(|error| error.to_string())?;
        archives
            .with_writer(archive_id, |writer| {
                session.store_objects_to_archive(writer, None)
            })
            .map_err(|error| error.to_string())
    }

    fn rebuild(&mut self, graph: &TrackGraph) -> Result<(), AraError> {
        self.clear_graph()?;
        self.timeline.set_graph(graph)?;
        let mut handles = GraphHandles::default();
        let result = self.build_graph(graph, &mut handles);
        if let Err(error) = result {
            self.model = handles;
            let _ = self.clear_graph();
            return Err(error);
        }
        self.model = handles;
        let session = self
            .session
            .as_mut()
            .ok_or(AraError::InvalidState("ARA document session is closed"))?;
        let extension = self
            .extension
            .as_ref()
            .ok_or(AraError::InvalidState("ARA extension is closed"))?;
        for region in self.model.regions.iter().copied() {
            self.playback_assignments
                .push(extension.assign_playback_region(session, RendererRole::Playback, region)?);
            self.playback_assignments
                .push(extension.assign_playback_region(session, RendererRole::Editor, region)?);
        }
        if let Some(sequence) = self.model.sequence {
            self.sequence_assignments
                .push(extension.assign_region_sequence(session, sequence)?);
        }
        session.notify_model_updates()?;
        Ok(())
    }

    fn build_graph(
        &mut self,
        graph: &TrackGraph,
        handles: &mut GraphHandles,
    ) -> Result<(), AraError> {
        let session = self
            .session
            .as_mut()
            .ok_or(AraError::InvalidState("ARA document session is closed"))?;
        let mut edit = session.edit()?;
        let context =
            edit.create_musical_context(MusicalContextProperties::new(Some("Project"), 0, None)?)?;
        handles.context = Some(context);
        let context_ref = edit.musical_context_ref(context)?;
        self.timeline
            .insert_context(context_ref.as_raw() as usize)?;
        let sequence = edit.create_region_sequence(RegionSequenceProperties::new(
            Some(&graph.channel_id),
            0,
            context_ref,
            None,
        )?)?;
        handles.sequence = Some(sequence);
        let sequence_ref = edit.region_sequence_ref(sequence)?;

        let mut sources = HashMap::<String, (AudioSourceHandle, AudioModificationHandle)>::new();
        for clip in &graph.clips {
            let (source, modification) = match sources.get(&clip.path).copied() {
                Some(handles) => handles,
                None => {
                    let spec = inspect_source(&clip.path, graph.sample_rate)?;
                    let source_id = persistent_id("source", &clip.path);
                    let name = Path::new(&clip.path)
                        .file_name()
                        .and_then(|name| name.to_str());
                    let source = edit.create_audio_source(AudioSourceProperties::new(
                        name,
                        &source_id,
                        spec.sample_count,
                        f64::from(spec.sample_rate),
                        2,
                        AraBool::new(false),
                    )?)?;
                    handles.sources.push(source);
                    let address = edit.audio_source_ref(source)?.as_raw() as usize;
                    self.callbacks
                        .register(CallbackObjectKind::AudioSource, address, source_id)?;
                    self.audio.insert(address, spec)?;
                    edit.set_audio_source_samples_access(source, true)?;
                    let modification_id = persistent_id(
                        "modification",
                        &format!("{}:{}", self.instance_id, clip.path),
                    );
                    let modification = edit.create_audio_modification(
                        source,
                        AudioModificationProperties::new(name, &modification_id)?,
                    )?;
                    handles.modifications.push(modification);
                    let modification_address =
                        edit.audio_modification_ref(modification)?.as_raw() as usize;
                    self.callbacks.register(
                        CallbackObjectKind::AudioModification,
                        modification_address,
                        modification_id,
                    )?;
                    sources.insert(clip.path.clone(), (source, modification));
                    (source, modification)
                }
            };
            let _ = source;
            let sample_rate = f64::from(graph.sample_rate);
            let source_start = clip.source_offset_frames.max(0) as f64 / sample_rate;
            let duration = clip.length_frames.max(0) as f64 / sample_rate;
            let playback_start = clip.start_frame.max(0) as f64 / sample_rate;
            let region = edit.create_playback_region(
                modification,
                PlaybackRegionProperties::for_ara2(
                    0,
                    source_start,
                    duration,
                    playback_start,
                    duration,
                    sequence_ref,
                    Some(&clip.id),
                    None,
                )?,
            )?;
            handles.regions.push(region);
            let region_address = edit.playback_region_ref(region)?.as_raw() as usize;
            self.callbacks.register(
                CallbackObjectKind::PlaybackRegion,
                region_address,
                clip.id.clone(),
            )?;
        }
        if let Some(archive) = self.pending_archive.take() {
            let archives = self.archives.clone();
            let archive_id = self.archive_id.clone();
            archives.with_reader(archive, archive_id, |reader| {
                edit.restore_objects_from_archive(reader, None)
            })?;
        }
        edit.finish()
    }

    fn clear_graph(&mut self) -> Result<(), AraError> {
        self.playback_assignments.clear();
        self.sequence_assignments.clear();
        if self.model.context.is_none()
            && self.model.sequence.is_none()
            && self.model.sources.is_empty()
            && self.model.modifications.is_empty()
            && self.model.regions.is_empty()
        {
            return Ok(());
        }
        let session = self
            .session
            .as_mut()
            .ok_or(AraError::InvalidState("ARA document session is closed"))?;
        let mut edit = session.edit()?;
        for region in self.model.regions.drain(..) {
            let address = edit.playback_region_ref(region)?.as_raw() as usize;
            self.callbacks
                .unregister(CallbackObjectKind::PlaybackRegion, address);
            edit.destroy_playback_region(region)?;
        }
        for modification in self.model.modifications.drain(..) {
            let address = edit.audio_modification_ref(modification)?.as_raw() as usize;
            self.callbacks
                .unregister(CallbackObjectKind::AudioModification, address);
            edit.destroy_audio_modification(modification)?;
        }
        for source in self.model.sources.drain(..) {
            let address = edit.audio_source_ref(source)?.as_raw() as usize;
            self.callbacks
                .unregister(CallbackObjectKind::AudioSource, address);
            edit.destroy_audio_source(source)?;
        }
        if let Some(sequence) = self.model.sequence.take() {
            edit.destroy_region_sequence(sequence)?;
        }
        if let Some(context) = self.model.context.take() {
            edit.destroy_musical_context(context)?;
        }
        edit.finish()?;
        self.audio.clear()?;
        self.timeline.clear()
    }
}

fn next_callback_sequence(sequence: &mut u64) -> u64 {
    *sequence = sequence.saturating_add(1);
    *sequence
}

impl Drop for AraDocument {
    fn drop(&mut self) {
        self.callbacks.deactivate();
        self.playback_assignments.clear();
        self.sequence_assignments.clear();
        self.extension.take();
        let _ = self.clear_graph();
        if let Some(session) = self.session.take() {
            let _ = session.close();
        }
        self.services.take();
        let _keep_companion_lifetimes = (&self.entry, &self.factory);
    }
}

fn inspect_source(path: &str, target_sample_rate: u32) -> Result<SourceSpec, AraError> {
    let mut reader =
        WaveReader::open(path).map_err(|_| AraError::Peer("could not open ARA audio source"))?;
    let format = reader
        .format()
        .map_err(|_| AraError::Peer("could not read ARA audio format"))?;
    let source_frames = reader
        .frame_length()
        .map_err(|_| AraError::Peer("could not read ARA audio length"))?
        as u128;
    if format.sample_rate == 0 || target_sample_rate == 0 {
        return Err(AraError::InvalidArgument("ARA audio sample rate is zero"));
    }
    let target_frames = (source_frames * u128::from(target_sample_rate)
        + u128::from(format.sample_rate) / 2)
        / u128::from(format.sample_rate);
    let sample_count = i64::try_from(target_frames)
        .map_err(|_| AraError::InvalidArgument("ARA audio source is too long"))?;
    Ok(SourceSpec {
        path: path.to_owned(),
        sample_rate: target_sample_rate,
        sample_count,
    })
}

fn persistent_id(namespace: &str, value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    let mut id = format!("heron.{namespace}.");
    for byte in digest {
        let _ = write!(&mut id, "{byte:02x}");
    }
    id
}

unsafe extern "C" fn ara_assertion(
    _category: ARAAssertCategory,
    _problem: *const c_void,
    _file: *const c_char,
) {
}

#[cfg(test)]
#[allow(clippy::wildcard_imports)]
mod tests;
