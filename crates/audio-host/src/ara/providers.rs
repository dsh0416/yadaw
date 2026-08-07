use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex, RwLock},
};

use ara2_bridge_core::{
    AraError, BarSignatureEvent, BarSignatures, ContentGrade, ContentKind, ContentTimeRange, Tempo,
    TempoEvent,
};
use ara2_bridge_host::{
    ArchiveReaderId, ArchiveWriterId, ArchivingProvider, AudioAccessProvider, AudioModificationId,
    AudioSourceId, ContentAccessProvider, HostAudioReader, HostContentReaderSnapshot,
    HostContentSnapshot, ModelUpdateProvider, MusicalContextId, PlaybackRegionId,
};
use heron_dsp_runtime::{
    MUSICAL_TICKS_PER_QUARTER,
    protocol::AraArchiveDirection,
    tempo::{TempoEvent as RuntimeTempoEvent, TempoMap, TimeSignatureEvent},
};

use crate::engine::decode_clip_audio;

use super::{AraCallbackSink, AraTransportRequest, CallbackObjectKind, SourceSpec, TrackGraph};

type StereoFrames = Arc<Vec<[f32; 2]>>;
type DecodedAudioCache = Arc<Mutex<HashMap<(String, u32), StereoFrames>>>;
type TimelineEvents = (Vec<TempoEvent>, Vec<BarSignatureEvent>);

#[derive(Clone, Default)]
pub(super) struct AudioRegistry {
    sources: Arc<RwLock<HashMap<usize, SourceSpec>>>,
    decoded: DecodedAudioCache,
}

impl AudioRegistry {
    pub(super) fn insert(&self, address: usize, source: SourceSpec) -> Result<(), AraError> {
        self.sources
            .write()
            .map_err(|_| AraError::Poisoned)?
            .insert(address, source);
        Ok(())
    }

    pub(super) fn clear(&self) -> Result<(), AraError> {
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

pub(super) struct AudioReader {
    pub(super) frames: StereoFrames,
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

#[derive(Clone)]
pub(super) struct ArchiveRegistry {
    entries: Arc<Mutex<HashMap<usize, ArchiveEntry>>>,
    callbacks: AraCallbackSink,
}

pub(super) struct ArchiveToken {
    _identity: u8,
}

impl ArchiveRegistry {
    pub(super) fn new(callbacks: AraCallbackSink) -> Self {
        Self {
            entries: Arc::new(Mutex::new(HashMap::new())),
            callbacks,
        }
    }

    pub(super) fn with_reader<T>(
        &self,
        bytes: Vec<u8>,
        document_archive_id: String,
        action: impl FnOnce(&ArchiveToken) -> Result<T, AraError>,
    ) -> Result<T, AraError> {
        self.with_entry(bytes, document_archive_id, false, action)
            .map(|(value, _)| value)
    }

    pub(super) fn with_writer(
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

    fn archiving_progress(&self, value: f32) -> Result<(), AraError> {
        self.callbacks
            .archive_progress(AraArchiveDirection::Store, value)
    }

    fn unarchiving_progress(&self, value: f32) -> Result<(), AraError> {
        self.callbacks
            .archive_progress(AraArchiveDirection::Restore, value)
    }
}

#[derive(Clone)]
pub(super) struct ModelUpdates {
    pub(super) callbacks: AraCallbackSink,
}

impl ModelUpdateProvider for ModelUpdates {
    fn audio_source_analysis_progress(
        &self,
        source: AudioSourceId,
        state: i32,
        value: f32,
    ) -> Result<(), AraError> {
        self.callbacks.analysis_progress(source, state, value)
    }

    fn audio_source_content_changed(
        &self,
        source: AudioSourceId,
        range: Option<ContentTimeRange>,
        flags: i32,
    ) -> Result<(), AraError> {
        self.callbacks.content_changed(
            CallbackObjectKind::AudioSource,
            source.address(),
            range,
            flags,
        )
    }

    fn audio_modification_content_changed(
        &self,
        modification: AudioModificationId,
        range: Option<ContentTimeRange>,
        flags: i32,
    ) -> Result<(), AraError> {
        self.callbacks.content_changed(
            CallbackObjectKind::AudioModification,
            modification.address(),
            range,
            flags,
        )
    }

    fn playback_region_content_changed(
        &self,
        region: PlaybackRegionId,
        range: Option<ContentTimeRange>,
        flags: i32,
    ) -> Result<(), AraError> {
        self.callbacks.content_changed(
            CallbackObjectKind::PlaybackRegion,
            region.address(),
            range,
            flags,
        )
    }

    fn document_data_changed(&self) -> Result<(), AraError> {
        self.callbacks.with_state(|state| {
            state.document_dirty = true;
            Ok(())
        })
    }
}

#[derive(Clone)]
pub(super) struct PlaybackRequests {
    pub(super) callbacks: AraCallbackSink,
}

impl ara2_bridge_host::PlaybackProvider for PlaybackRequests {
    fn start(&self) -> Result<(), AraError> {
        self.callbacks.transport(AraTransportRequest::Start)
    }

    fn stop(&self) -> Result<(), AraError> {
        self.callbacks.transport(AraTransportRequest::Stop)
    }

    fn set_position(&self, position: f64) -> Result<(), AraError> {
        if !position.is_finite() || position < 0.0 {
            return Err(AraError::InvalidArgument("invalid ARA playback position"));
        }
        self.callbacks
            .transport(AraTransportRequest::SetPosition(position))
    }

    fn set_cycle_range(&self, start: f64, duration: f64) -> Result<(), AraError> {
        if !start.is_finite() || !duration.is_finite() || start < 0.0 || duration <= 0.0 {
            return Err(AraError::InvalidArgument(
                "invalid ARA playback cycle range",
            ));
        }
        self.callbacks
            .transport(AraTransportRequest::SetCycleRange { start, duration })
    }

    fn enable_cycle(&self, enable: bool) -> Result<(), AraError> {
        self.callbacks
            .transport(AraTransportRequest::EnableCycle(enable))
    }
}

#[derive(Clone, Default)]
pub(super) struct TimelineContent {
    contexts: Arc<RwLock<HashSet<usize>>>,
    timeline: Arc<RwLock<Option<TimelineEvents>>>,
}

impl TimelineContent {
    pub(super) fn set_graph(&self, graph: &TrackGraph) -> Result<(), AraError> {
        let tempo_map = tempo_map(graph)?;
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

    pub(super) fn insert_context(&self, address: usize) -> Result<(), AraError> {
        self.contexts
            .write()
            .map_err(|_| AraError::Poisoned)?
            .insert(address);
        Ok(())
    }

    pub(super) fn clear(&self) -> Result<(), AraError> {
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

pub(super) fn tempo_map(graph: &TrackGraph) -> Result<TempoMap, AraError> {
    TempoMap::new(
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
    .map_err(|_| AraError::InvalidArgument("invalid ARA tempo map"))
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
