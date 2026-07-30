use std::{
    collections::{HashMap, HashSet},
    ffi::{c_char, c_void},
    fmt::Write as _,
    path::Path,
    rc::Rc,
    sync::{
        Arc, Mutex, RwLock,
        atomic::{AtomicBool, Ordering},
    },
};

use ara2_bridge_core::{
    ApiGeneration, AraBool, AraError, AudioModificationProperties, AudioSourceProperties,
    BarSignatureEvent, BarSignatures, ContentGrade, ContentKind, ContentTimeRange,
    DocumentProperties, MusicalContextProperties, PlaybackRegionProperties,
    RegionSequenceProperties, Tempo, TempoEvent,
};
use ara2_bridge_host::{
    ArchiveReaderId, ArchiveWriterId, ArchivingProvider, AudioAccessProvider,
    AudioModificationHandle, AudioModificationId, AudioSourceHandle, AudioSourceId,
    ContentAccessProvider, DocumentSession, ExtensionController, ExtensionRoles, HostAudioReader,
    HostContentReaderSnapshot, HostContentSnapshot, HostServices, HostServicesBuilder,
    LoadedFactory, ModelUpdateProvider, MusicalContextHandle, MusicalContextId,
    PlaybackRegionAssignment, PlaybackRegionHandle, PlaybackRegionId, RegionSequenceAssignment,
    RegionSequenceHandle, RendererRole,
};
use ara2_bridge_sys::{ARAAssertCategory, ARAFactory, ARAPlugInExtensionInstance};
use bwavfile::WaveReader;
use sha2::{Digest, Sha256};
use yadaw_dsp_runtime::{
    MUSICAL_TICKS_PER_QUARTER,
    protocol::{LiveMixerClip, LiveMixerGraph, LiveTempoEvent, LiveTimeSignatureEvent},
    tempo::{TempoEvent as RuntimeTempoEvent, TempoMap, TimeSignatureEvent},
};
use yadaw_vst3_host::{AraMainFactory, AraPluginEntry, ClassId, HostError, Module};

use crate::engine::decode_clip_audio;

const ARA_2_FINAL: i32 = 4;
const ARA_2_3_FINAL: i32 = 6;

type StereoFrames = Arc<Vec<[f32; 2]>>;
type DecodedAudioCache = Arc<Mutex<HashMap<(String, u32), StereoFrames>>>;
type TimelineEvents = (Vec<TempoEvent>, Vec<BarSignatureEvent>);

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

#[derive(Clone, Default)]
struct AudioRegistry {
    sources: Arc<RwLock<HashMap<usize, SourceSpec>>>,
    decoded: DecodedAudioCache,
}

impl AudioRegistry {
    fn insert(&self, address: usize, source: SourceSpec) -> Result<(), AraError> {
        self.sources
            .write()
            .map_err(|_| AraError::Poisoned)?
            .insert(address, source);
        Ok(())
    }

    fn clear(&self) -> Result<(), AraError> {
        self.sources
            .write()
            .map_err(|_| AraError::Poisoned)?
            .clear();
        Ok(())
    }
}

impl AudioAccessProvider for AudioRegistry {
    fn create_reader(
        &self,
        source: AudioSourceId,
        _use_64_bit_samples: bool,
    ) -> Result<Box<dyn HostAudioReader>, AraError> {
        let spec = self
            .sources
            .read()
            .map_err(|_| AraError::Poisoned)?
            .get(&source.address())
            .cloned()
            .ok_or(AraError::InvalidArgument("unknown ARA audio source"))?;
        let cache_key = (spec.path.clone(), spec.sample_rate);
        let cached = self
            .decoded
            .lock()
            .map_err(|_| AraError::Poisoned)?
            .get(&cache_key)
            .cloned();
        let frames = match cached {
            Some(frames) => frames,
            None => {
                let frames = Arc::new(
                    decode_clip_audio(&spec.path, spec.sample_rate)
                        .map_err(|_| AraError::Peer("could not decode ARA audio source"))?,
                );
                self.decoded
                    .lock()
                    .map_err(|_| AraError::Poisoned)?
                    .insert(cache_key, Arc::clone(&frames));
                frames
            }
        };
        Ok(Box::new(AudioReader { frames }))
    }
}

struct AudioReader {
    frames: StereoFrames,
}

impl HostAudioReader for AudioReader {
    fn channel_count(&self) -> usize {
        2
    }

    fn sample_count(&self) -> i64 {
        self.frames.len().min(i64::MAX as usize) as i64
    }

    fn read_f32(
        &mut self,
        sample_position: i64,
        buffers: &mut [&mut [f32]],
    ) -> Result<(), AraError> {
        if buffers.len() != 2 || buffers[0].len() != buffers[1].len() {
            return Err(AraError::InvalidArgument(
                "ARA audio read requires two equal planar buffers",
            ));
        }
        let (left, right) = buffers.split_at_mut(1);
        copy_audio(&self.frames, sample_position, left[0], right[0], f32::from);
        Ok(())
    }

    fn read_f64(
        &mut self,
        sample_position: i64,
        buffers: &mut [&mut [f64]],
    ) -> Result<(), AraError> {
        if buffers.len() != 2 || buffers[0].len() != buffers[1].len() {
            return Err(AraError::InvalidArgument(
                "ARA audio read requires two equal planar buffers",
            ));
        }
        let (left, right) = buffers.split_at_mut(1);
        copy_audio(&self.frames, sample_position, left[0], right[0], f64::from);
        Ok(())
    }
}

fn copy_audio<T: Copy + Default>(
    frames: &[[f32; 2]],
    sample_position: i64,
    left: &mut [T],
    right: &mut [T],
    convert: impl Fn(f32) -> T,
) {
    for (offset, (left, right)) in left.iter_mut().zip(right.iter_mut()).enumerate() {
        let position = sample_position.saturating_add(offset as i64);
        if let Ok(position) = usize::try_from(position)
            && let Some(frame) = frames.get(position)
        {
            *left = convert(frame[0]);
            *right = convert(frame[1]);
            continue;
        }
        *left = T::default();
        *right = T::default();
    }
}

#[derive(Clone)]
struct ArchiveEntry {
    bytes: Arc<Mutex<Vec<u8>>>,
    document_archive_id: String,
    writable: bool,
}

#[derive(Clone, Default)]
struct ArchiveRegistry {
    entries: Arc<Mutex<HashMap<usize, ArchiveEntry>>>,
}

struct ArchiveToken {
    _identity: u8,
}

impl ArchiveRegistry {
    fn with_reader<T>(
        &self,
        bytes: Vec<u8>,
        document_archive_id: String,
        action: impl FnOnce(&ArchiveToken) -> Result<T, AraError>,
    ) -> Result<T, AraError> {
        self.with_entry(bytes, document_archive_id, false, action)
            .map(|(value, _)| value)
    }

    fn with_writer(
        &self,
        document_archive_id: String,
        action: impl FnOnce(&ArchiveToken) -> Result<(), AraError>,
    ) -> Result<Vec<u8>, AraError> {
        self.with_entry(Vec::new(), document_archive_id, true, action)
            .map(|(_, bytes)| bytes)
    }

    fn with_entry<T>(
        &self,
        bytes: Vec<u8>,
        document_archive_id: String,
        writable: bool,
        action: impl FnOnce(&ArchiveToken) -> Result<T, AraError>,
    ) -> Result<(T, Vec<u8>), AraError> {
        let token = Box::new(ArchiveToken { _identity: 0 });
        let address = std::ptr::from_ref(token.as_ref()) as usize;
        let bytes = Arc::new(Mutex::new(bytes));
        self.entries.lock().map_err(|_| AraError::Poisoned)?.insert(
            address,
            ArchiveEntry {
                bytes: Arc::clone(&bytes),
                document_archive_id,
                writable,
            },
        );
        let result = action(&token);
        self.entries
            .lock()
            .map_err(|_| AraError::Poisoned)?
            .remove(&address);
        let result = result?;
        let bytes = bytes.lock().map_err(|_| AraError::Poisoned)?.clone();
        Ok((result, bytes))
    }

    fn entry(&self, address: usize) -> Result<ArchiveEntry, AraError> {
        self.entries
            .lock()
            .map_err(|_| AraError::Poisoned)?
            .get(&address)
            .cloned()
            .ok_or(AraError::InvalidArgument("unknown ARA archive token"))
    }
}

impl ArchivingProvider for ArchiveRegistry {
    fn len(&self, reader: ArchiveReaderId) -> Result<usize, AraError> {
        Ok(self
            .entry(reader.address())?
            .bytes
            .lock()
            .map_err(|_| AraError::Poisoned)?
            .len())
    }

    fn read_at(
        &self,
        reader: ArchiveReaderId,
        position: usize,
        buffer: &mut [u8],
    ) -> Result<(), AraError> {
        let entry = self.entry(reader.address())?;
        let bytes = entry.bytes.lock().map_err(|_| AraError::Poisoned)?;
        let end = position
            .checked_add(buffer.len())
            .ok_or(AraError::ArchiveTooLargeForTarget)?;
        let source = bytes.get(position..end).ok_or(AraError::InvalidArgument(
            "ARA archive read is out of bounds",
        ))?;
        buffer.copy_from_slice(source);
        Ok(())
    }

    fn write_at(
        &self,
        writer: ArchiveWriterId,
        position: usize,
        buffer: &[u8],
    ) -> Result<(), AraError> {
        let entry = self.entry(writer.address())?;
        if !entry.writable {
            return Err(AraError::InvalidState("ARA archive token is read-only"));
        }
        let mut bytes = entry.bytes.lock().map_err(|_| AraError::Poisoned)?;
        let end = position
            .checked_add(buffer.len())
            .ok_or(AraError::ArchiveTooLargeForTarget)?;
        let target_len = bytes.len().max(end);
        bytes.resize(target_len, 0);
        bytes[position..end].copy_from_slice(buffer);
        Ok(())
    }

    fn document_archive_id(&self, reader: ArchiveReaderId) -> Result<Option<String>, AraError> {
        Ok(Some(self.entry(reader.address())?.document_archive_id))
    }
}

#[derive(Clone, Default)]
struct ModelUpdates {
    dirty: Arc<AtomicBool>,
}

impl ModelUpdates {
    fn mark(&self) {
        self.dirty.store(true, Ordering::Release);
    }
}

impl ModelUpdateProvider for ModelUpdates {
    fn audio_source_content_changed(
        &self,
        _source: AudioSourceId,
        _range: Option<ContentTimeRange>,
        _flags: i32,
    ) -> Result<(), AraError> {
        self.mark();
        Ok(())
    }

    fn audio_modification_content_changed(
        &self,
        _modification: AudioModificationId,
        _range: Option<ContentTimeRange>,
        _flags: i32,
    ) -> Result<(), AraError> {
        self.mark();
        Ok(())
    }

    fn playback_region_content_changed(
        &self,
        _region: PlaybackRegionId,
        _range: Option<ContentTimeRange>,
        _flags: i32,
    ) -> Result<(), AraError> {
        self.mark();
        Ok(())
    }

    fn document_data_changed(&self) -> Result<(), AraError> {
        self.mark();
        Ok(())
    }
}

#[derive(Clone, Default)]
struct TimelineContent {
    contexts: Arc<RwLock<HashSet<usize>>>,
    timeline: Arc<RwLock<Option<TimelineEvents>>>,
}

impl TimelineContent {
    fn set_graph(&self, graph: &TrackGraph) -> Result<(), AraError> {
        let tempo_map = TempoMap::new(
            graph
                .tempo_events
                .iter()
                .map(|event| RuntimeTempoEvent {
                    tick: event.tick,
                    beats_per_minute: event.beats_per_minute,
                })
                .collect(),
            graph
                .time_signature_events
                .iter()
                .map(|event| TimeSignatureEvent {
                    tick: event.tick,
                    numerator: event.numerator,
                    denominator: event.denominator,
                })
                .collect(),
        )
        .map_err(|_| AraError::InvalidArgument("invalid ARA tempo map"))?;
        let tempos = graph
            .tempo_events
            .iter()
            .map(|event| {
                TempoEvent::new(
                    tempo_map.tick_to_seconds(event.tick),
                    event.tick as f64 / MUSICAL_TICKS_PER_QUARTER as f64,
                )
            })
            .collect::<Result<Vec<_>, _>>()?;
        let bars = graph
            .time_signature_events
            .iter()
            .map(|event| {
                BarSignatureEvent::new(
                    i32::from(event.numerator),
                    i32::from(event.denominator),
                    event.tick as f64 / MUSICAL_TICKS_PER_QUARTER as f64,
                )
            })
            .collect::<Result<Vec<_>, _>>()?;
        *self.timeline.write().map_err(|_| AraError::Poisoned)? = Some((tempos, bars));
        Ok(())
    }

    fn insert_context(&self, address: usize) -> Result<(), AraError> {
        self.contexts
            .write()
            .map_err(|_| AraError::Poisoned)?
            .insert(address);
        Ok(())
    }

    fn clear(&self) -> Result<(), AraError> {
        self.contexts
            .write()
            .map_err(|_| AraError::Poisoned)?
            .clear();
        Ok(())
    }

    fn supports(&self, context: MusicalContextId, content_type: i32) -> Result<bool, AraError> {
        let known = self
            .contexts
            .read()
            .map_err(|_| AraError::Poisoned)?
            .contains(&context.address());
        Ok(known && (content_type == Tempo::RAW_TYPE || content_type == BarSignatures::RAW_TYPE))
    }
}

impl ContentAccessProvider for TimelineContent {
    fn musical_context_grade(
        &self,
        context: MusicalContextId,
        content_type: i32,
    ) -> Result<Option<ContentGrade>, AraError> {
        Ok(self
            .supports(context, content_type)?
            .then_some(ContentGrade::APPROVED))
    }

    fn musical_context_reader(
        &self,
        context: MusicalContextId,
        content_type: i32,
        _range: Option<ContentTimeRange>,
    ) -> Result<Option<HostContentReaderSnapshot>, AraError> {
        if !self.supports(context, content_type)? {
            return Ok(None);
        }
        let timeline = self.timeline.read().map_err(|_| AraError::Poisoned)?;
        let Some((tempos, bars)) = timeline.as_ref() else {
            return Ok(None);
        };
        if content_type == Tempo::RAW_TYPE {
            return HostContentSnapshot::<Tempo>::new(tempos.iter().copied())
                .map(|snapshot| Some(snapshot.into_reader(ContentGrade::APPROVED)));
        }
        HostContentSnapshot::<BarSignatures>::new(bars.iter().copied())
            .map(|snapshot| Some(snapshot.into_reader(ContentGrade::APPROVED)))
    }

    fn audio_source_grade(
        &self,
        _source: AudioSourceId,
        _content_type: i32,
    ) -> Result<Option<ContentGrade>, AraError> {
        Ok(None)
    }

    fn audio_source_reader(
        &self,
        _source: AudioSourceId,
        _content_type: i32,
        _range: Option<ContentTimeRange>,
    ) -> Result<Option<HostContentReaderSnapshot>, AraError> {
        Ok(None)
    }
}

#[derive(Default)]
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
    archive_id: String,
    pending_archive: Option<Vec<u8>>,
    model: GraphHandles,
    graph: Option<TrackGraph>,
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
        let archives = ArchiveRegistry::default();
        let services = Box::new(
            HostServicesBuilder::new()
                .audio(audio.clone())
                .archiving(archives.clone())
                .content(timeline.clone())
                .model_updates(ModelUpdates::default())
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
            DocumentProperties::new(Some("YADAW ARA document"))
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
            archive_id,
            pending_archive: (!archive.is_empty()).then_some(archive),
            model: GraphHandles::default(),
            graph: None,
        })
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
            edit.destroy_playback_region(region)?;
        }
        for modification in self.model.modifications.drain(..) {
            edit.destroy_audio_modification(modification)?;
        }
        for source in self.model.sources.drain(..) {
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

impl Drop for AraDocument {
    fn drop(&mut self) {
        let _ = self.clear_graph();
        self.playback_assignments.clear();
        self.sequence_assignments.clear();
        self.extension.take();
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
    let mut id = format!("yadaw.{namespace}.");
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
mod tests;
