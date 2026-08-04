use super::{
    ChannelKind, ChannelSpec, ClipSamples, ClipStoragePolicy, LoadedClip, NativeMidiClip,
    NativeMidiEventKind, NativeMixerClip, Result, ScheduledMidiEvent, ScheduledMidiEventKind,
    TempoMap, audio_error, clip_storage_policy, decode_clip_audio, fs, invalid_config,
    spawn_streaming_clip,
};

pub(super) struct MidiBuild {
    pub(super) events: Vec<ScheduledMidiEvent>,
    pub(super) event_data: Vec<u8>,
    pub(super) active_notes: Vec<bool>,
    pub(super) content_end_frame: u64,
}

pub(super) fn load_audio_clips(
    native_clips: Vec<NativeMixerClip>,
    channels: &[ChannelSpec],
    sample_rate: u32,
) -> Result<(Vec<LoadedClip>, u64)> {
    let mut clips = Vec::with_capacity(native_clips.len());
    let mut content_end_frame = 0_u64;
    for clip in native_clips {
        let channel_index = clip.channel_index as usize;
        if channels
            .get(channel_index)
            .is_none_or(|channel| channel.kind != ChannelKind::Audio)
            || clip.start_frame < 0
            || clip.source_offset_frames < 0
            || clip.length_frames <= 0
            || clip.fade_in_frames < 0
            || clip.fade_out_frames < 0
            || clip.fade_in_frames.saturating_add(clip.fade_out_frames) > clip.length_frames
        {
            return Err(invalid_config("mixer clip has invalid placement"));
        }
        let start_frame = clip.start_frame as u64;
        let source_offset_frames = clip.source_offset_frames as usize;
        let file_size = fs::metadata(&clip.path)
            .map_err(|error| audio_error("failed to inspect mixer clip cache", error))?
            .len();
        let (samples, sample_frames) = match clip_storage_policy(file_size) {
            ClipStoragePolicy::Memory => {
                let decoded = decode_clip_audio(&clip.path, sample_rate)?;
                let sample_frames = decoded.len();
                (ClipSamples::Memory(decoded), sample_frames)
            }
            ClipStoragePolicy::Streaming => {
                let (streaming, sample_frames) =
                    spawn_streaming_clip(clip.path, sample_rate, source_offset_frames)?;
                (ClipSamples::Streaming(streaming), sample_frames)
            }
        };
        let available = sample_frames.saturating_sub(source_offset_frames);
        let length_frames = (clip.length_frames as usize).min(available);
        let fade_in_frames = (clip.fade_in_frames as usize).min(length_frames);
        let fade_out_frames =
            (clip.fade_out_frames as usize).min(length_frames.saturating_sub(fade_in_frames));
        content_end_frame = content_end_frame.max(start_frame.saturating_add(length_frames as u64));
        clips.push(LoadedClip {
            channel_index,
            start_frame,
            source_offset_frames,
            length_frames,
            fade_in_frames,
            fade_out_frames,
            samples,
        });
    }
    Ok((clips, content_end_frame))
}

pub(super) fn build_midi_events(
    native_clips: Vec<NativeMidiClip>,
    channels: &[ChannelSpec],
    tempo_map: &TempoMap,
    sample_rate: u32,
    mut content_end_frame: u64,
) -> Result<MidiBuild> {
    let mut events = Vec::new();
    let mut next_note_id = 1_i32;
    let mut event_data = Vec::new();
    for clip in native_clips {
        let channel_index = clip.channel_index as usize;
        if channels
            .get(channel_index)
            .is_none_or(|channel| channel.kind != ChannelKind::Instrument)
        {
            return Err(invalid_config(
                "MIDI clip references a non-instrument track",
            ));
        }
        let clip_source_end = clip.source_offset_ticks.saturating_add(clip.length_ticks);
        for note in clip.notes {
            let note_source_end = note.start_tick.saturating_add(note.duration_ticks);
            if note_source_end <= clip.source_offset_ticks || note.start_tick >= clip_source_end {
                continue;
            }
            let clipped_start = note.start_tick.max(clip.source_offset_ticks);
            let clipped_end = note_source_end.min(clip_source_end);
            let project_start = clip
                .start_tick
                .saturating_add(clipped_start - clip.source_offset_ticks);
            let project_end = clip
                .start_tick
                .saturating_add(clipped_end - clip.source_offset_ticks);
            let start_frame = tempo_map
                .tick_to_frame(project_start, sample_rate)
                .map_err(|error| invalid_config(error.to_string()))?;
            let end_frame = tempo_map
                .tick_to_frame(project_end, sample_rate)
                .map_err(|error| invalid_config(error.to_string()))?;
            content_end_frame = content_end_frame.max(end_frame);
            events.push(ScheduledMidiEvent {
                frame: start_frame,
                channel_index,
                channel: note.channel,
                kind: ScheduledMidiEventKind::NoteOn {
                    note_id: next_note_id,
                    key: note.key,
                    velocity: note.velocity,
                },
            });
            events.push(ScheduledMidiEvent {
                frame: end_frame,
                channel_index,
                channel: note.channel,
                kind: ScheduledMidiEventKind::NoteOff {
                    note_id: next_note_id,
                    key: note.key,
                    velocity: note.release_velocity,
                },
            });
            next_note_id = next_note_id.saturating_add(1);
        }
        for event in clip.events {
            if event.tick < clip.source_offset_ticks || event.tick >= clip_source_end {
                continue;
            }
            let project_tick = clip
                .start_tick
                .saturating_add(event.tick - clip.source_offset_ticks);
            let frame = tempo_map
                .tick_to_frame(project_tick, sample_rate)
                .map_err(|error| invalid_config(error.to_string()))?;
            content_end_frame = content_end_frame.max(frame);
            let kind = match event.kind {
                NativeMidiEventKind::ControlChange { controller, value } => {
                    ScheduledMidiEventKind::ControlChange { controller, value }
                }
                NativeMidiEventKind::PitchBend { value } => {
                    ScheduledMidiEventKind::PitchBend { value }
                }
                NativeMidiEventKind::ProgramChange { program } => {
                    ScheduledMidiEventKind::ProgramChange { program }
                }
                NativeMidiEventKind::ChannelPressure { pressure } => {
                    ScheduledMidiEventKind::ChannelPressure { pressure }
                }
                NativeMidiEventKind::PolyPressure { key, pressure } => {
                    ScheduledMidiEventKind::PolyPressure { key, pressure }
                }
                NativeMidiEventKind::SysEx { data } => {
                    let offset = u32::try_from(event_data.len())
                        .map_err(|_| invalid_config("MIDI event data exceeds 4 GiB"))?;
                    let length = u32::try_from(data.len())
                        .map_err(|_| invalid_config("SysEx event exceeds 4 GiB"))?;
                    event_data.extend_from_slice(&data);
                    ScheduledMidiEventKind::SysEx { offset, length }
                }
            };
            events.push(ScheduledMidiEvent {
                frame,
                channel_index,
                channel: event.channel,
                kind,
            });
        }
    }
    events.sort_by_key(|event| (event.frame, event.kind.sort_rank()));
    Ok(MidiBuild {
        events,
        event_data,
        active_notes: vec![false; next_note_id as usize],
        content_end_frame,
    })
}
