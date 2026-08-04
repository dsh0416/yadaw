use super::*;

#[test]
fn pause_sends_all_notes_off_and_clears_scheduled_and_live_note_state() {
    let mut runtime = transport_test_runtime(48_000, 1_000, 100, TRANSPORT_PLAYING);
    runtime.active_notes = vec![true, true];
    runtime.live_notes[0] = true;
    runtime.live_notes[16 * 128 + 60] = true;

    assert!(
        runtime
            .handle_command(EngineCommand::Transport(TransportAction::Pause, 0))
            .is_none()
    );

    assert!(runtime.active_notes.iter().all(|active| !active));
    assert!(runtime.live_notes.iter().all(|active| !active));
    assert_eq!(
        runtime.transport.state.load(Ordering::Relaxed),
        TRANSPORT_STOPPED
    );
}

#[test]
fn metronome_starts_on_an_exact_beat_and_releases_after_twenty_ms() {
    let map = TempoMap::default_120_bpm();
    let mut scheduler = MetronomeScheduler::new(Some(2), &map, 48_000, 0);

    let at_origin = scheduler.events_at(&map, 48_000, 0);
    let note_on = at_origin
        .into_iter()
        .flatten()
        .find(|event| matches!(event.kind, ScheduledMidiEventKind::NoteOn { .. }));
    assert!(note_on.is_some_and(|event| {
        event.channel_index == 2
            && matches!(
                event.kind,
                ScheduledMidiEventKind::NoteOn {
                    key: METRONOME_ACCENT_NOTE,
                    ..
                }
            )
    }));
    assert!(scheduler.events_at(&map, 48_000, 959)[0].is_none());
    let release = scheduler.events_at(&map, 48_000, 960);
    assert!(release.into_iter().flatten().any(|event| matches!(
        event.kind,
        ScheduledMidiEventKind::NoteOff {
            key: METRONOME_ACCENT_NOTE,
            ..
        }
    )));
    assert_eq!(scheduler.next.map(|boundary| boundary.frame), Some(24_000));
}

#[test]
fn metronome_seek_waits_for_the_next_beat_unless_seek_is_exact() {
    let map = TempoMap::default_120_bpm();
    let mut scheduler = MetronomeScheduler::new(Some(0), &map, 48_000, 12_000);
    assert_eq!(scheduler.next.map(|boundary| boundary.frame), Some(24_000));
    assert!(scheduler.events_at(&map, 48_000, 12_000)[0].is_none());

    scheduler.reposition(&map, 48_000, 24_000, true);
    let exact = scheduler.events_at(&map, 48_000, 24_000);
    assert!(exact.into_iter().flatten().any(|event| matches!(
        event.kind,
        ScheduledMidiEventKind::NoteOn {
            key: METRONOME_BEAT_NOTE,
            ..
        }
    )));
}

#[test]
fn metronome_uses_the_signature_denominator_and_restarts_at_markers() {
    let map = TempoMap::new(
        vec![TempoEvent {
            tick: 0,
            beats_per_minute: 120.0,
        }],
        vec![
            TimeSignatureEvent {
                tick: 0,
                numerator: 6,
                denominator: 8,
            },
            TimeSignatureEvent {
                tick: 3_000,
                numerator: 3,
                denominator: 4,
            },
        ],
    )
    .unwrap();
    let mut scheduler = MetronomeScheduler::new(Some(0), &map, 48_000, 1);
    assert_eq!(scheduler.next.map(|boundary| boundary.tick), Some(480));
    assert!(!scheduler.next.is_some_and(|boundary| boundary.accent));

    scheduler.reposition(&map, 48_000, 73_000, true);
    assert_eq!(scheduler.next.map(|boundary| boundary.tick), Some(3_000));
    assert!(scheduler.next.is_some_and(|boundary| boundary.accent));
}

#[test]
fn metronome_frames_follow_step_tempo_changes() {
    let map = TempoMap::new(
        vec![
            TempoEvent {
                tick: 0,
                beats_per_minute: 120.0,
            },
            TempoEvent {
                tick: 1_920,
                beats_per_minute: 60.0,
            },
        ],
        vec![TimeSignatureEvent {
            tick: 0,
            numerator: 4,
            denominator: 4,
        }],
    )
    .unwrap();
    let scheduler = MetronomeScheduler::new(Some(0), &map, 48_000, 48_001);
    assert_eq!(scheduler.next.map(|boundary| boundary.tick), Some(2_880));
    assert_eq!(scheduler.next.map(|boundary| boundary.frame), Some(96_000));
}

#[test]
fn play_at_project_end_rewinds_before_starting() {
    let mut runtime = transport_test_runtime(48_000, 1_000, 1_000, TRANSPORT_STOPPED);

    let _ = runtime.handle_command(EngineCommand::Transport(TransportAction::Play, 0));

    assert_eq!(
        runtime.transport.state.load(Ordering::Relaxed),
        TRANSPORT_PLAYING
    );
    assert_eq!(runtime.transport.position_frames.load(Ordering::Relaxed), 0);
}

#[test]
fn play_before_project_end_keeps_current_position() {
    let mut runtime = transport_test_runtime(48_000, 1_000, 250, TRANSPORT_STOPPED);

    let _ = runtime.handle_command(EngineCommand::Transport(TransportAction::Play, 0));

    assert_eq!(
        runtime.transport.state.load(Ordering::Relaxed),
        TRANSPORT_PLAYING
    );
    assert_eq!(
        runtime.transport.position_frames.load(Ordering::Relaxed),
        250
    );
}

#[test]
fn external_sync_mode_is_scoped_to_each_runtime() {
    let mut external = transport_test_runtime(48_000, 1_000, 250, TRANSPORT_STOPPED);
    external.external_sync_enabled = true;
    let _ = external.handle_command(EngineCommand::Transport(TransportAction::Play, 0));
    assert_eq!(
        external.transport.state.load(Ordering::Relaxed),
        TRANSPORT_WAITING
    );

    let mut internal = transport_test_runtime(48_000, 1_000, 250, TRANSPORT_STOPPED);
    let _ = internal.handle_command(EngineCommand::Transport(TransportAction::Play, 0));
    assert_eq!(
        internal.transport.state.load(Ordering::Relaxed),
        TRANSPORT_PLAYING
    );
}

#[test]
fn playback_loop_splits_a_block_and_suppresses_project_end_auto_stop() {
    let mut runtime = transport_test_runtime(960, 920, 900, TRANSPORT_PLAYING);
    runtime
        .transport
        .loop_start_tick
        .store(960, Ordering::Relaxed);
    runtime
        .transport
        .loop_end_tick
        .store(1_920, Ordering::Relaxed);
    runtime
        .transport
        .loop_has_range
        .store(true, Ordering::Release);
    runtime
        .transport
        .loop_enabled
        .store(true, Ordering::Release);
    let inputs = vec![[0.0; MAX_INPUT_CHANNELS]; 128];
    let mut outputs = vec![[0.0; MAX_OUTPUT_CHANNELS]; 128];

    assert!(!runtime.render_block(&inputs, &mut outputs, None));

    assert_eq!(
        runtime.transport.position_frames.load(Ordering::Relaxed),
        548
    );
    assert_eq!(
        runtime.transport.state.load(Ordering::Relaxed),
        TRANSPORT_PLAYING
    );
}

#[test]
fn playback_loop_is_inert_while_recording_or_using_external_clock() {
    for (state, external) in [(TRANSPORT_RECORDING, false), (TRANSPORT_PLAYING, true)] {
        let mut runtime = transport_test_runtime(960, 2_000, 900, state);
        runtime
            .transport
            .loop_start_tick
            .store(960, Ordering::Relaxed);
        runtime
            .transport
            .loop_end_tick
            .store(1_920, Ordering::Relaxed);
        runtime
            .transport
            .loop_has_range
            .store(true, Ordering::Release);
        runtime
            .transport
            .loop_enabled
            .store(true, Ordering::Release);
        runtime
            .transport
            .clock_source
            .store(u32::from(external), Ordering::Relaxed);
        let inputs = vec![[0.0; MAX_INPUT_CHANNELS]; 128];
        let mut outputs = vec![[0.0; MAX_OUTPUT_CHANNELS]; 128];

        assert!(!runtime.render_block(&inputs, &mut outputs, None));
        assert_eq!(
            runtime.transport.position_frames.load(Ordering::Relaxed),
            1_028
        );
    }
}

#[test]
fn record_count_in_holds_the_playhead_for_one_bar_before_recording() {
    let mut runtime = transport_test_runtime(48_000, 200_000, 250, TRANSPORT_STOPPED);
    let inputs = vec![[0.0; MAX_INPUT_CHANNELS]; 256];
    let mut outputs = vec![[0.0; MAX_OUTPUT_CHANNELS]; 256];

    let _ = runtime.handle_command(EngineCommand::Transport(
        TransportAction::Record { count_in: true },
        0,
    ));

    assert_eq!(
        runtime.transport.state.load(Ordering::Relaxed),
        TRANSPORT_COUNTING_IN
    );
    assert_eq!(
        runtime.transport.position_frames.load(Ordering::Relaxed),
        250
    );

    for _ in 0..375 {
        assert!(!runtime.render_block(&inputs, &mut outputs, None));
    }

    assert_eq!(
        runtime.transport.state.load(Ordering::Relaxed),
        TRANSPORT_RECORDING
    );
    assert_eq!(
        runtime.transport.position_frames.load(Ordering::Relaxed),
        250
    );

    assert!(!runtime.render_block(&inputs[..64], &mut outputs[..64], None));
    assert_eq!(
        runtime.transport.position_frames.load(Ordering::Relaxed),
        314
    );
}

#[test]
fn mixer_reload_preserves_active_record_count_in() {
    let mut runtime = transport_test_runtime(48_000, 200_000, 250, TRANSPORT_STOPPED);
    let inputs = vec![[0.0; MAX_INPUT_CHANNELS]; 256];
    let mut outputs = vec![[0.0; MAX_OUTPUT_CHANNELS]; 256];

    let _ = runtime.handle_command(EngineCommand::Transport(
        TransportAction::Record { count_in: true },
        0,
    ));
    assert!(!runtime.render_block(&inputs, &mut outputs, None));
    let count_in_before = runtime
        .count_in
        .expect("record count-in should have private scheduler state");

    let mut replacement = transport_test_runtime(48_000, 200_000, 250, TRANSPORT_STOPPED);
    replacement.transport = Arc::clone(&runtime.transport);
    runtime = runtime
        .handle_command(EngineCommand::LoadMixer(replacement))
        .expect("mixer load should replace the runtime");

    let count_in_after = runtime
        .count_in
        .expect("mixer reload should preserve count-in state");
    assert_eq!(
        count_in_after.virtual_position,
        count_in_before.virtual_position
    );
    assert_eq!(count_in_after.end_frame, count_in_before.end_frame);
    assert_eq!(
        runtime.transport.state.load(Ordering::Relaxed),
        TRANSPORT_COUNTING_IN
    );
    assert_eq!(
        runtime.transport.position_frames.load(Ordering::Relaxed),
        250
    );

    for _ in 0..375 {
        if runtime.transport.state.load(Ordering::Relaxed) == TRANSPORT_RECORDING {
            break;
        }
        assert!(!runtime.render_block(&inputs, &mut outputs, None));
    }

    assert_eq!(
        runtime.transport.state.load(Ordering::Relaxed),
        TRANSPORT_RECORDING
    );
    assert_eq!(
        runtime.transport.position_frames.load(Ordering::Relaxed),
        250
    );
}

#[test]
fn auto_stop_at_project_end_then_play_restarts_from_beginning() {
    let mut runtime = transport_test_runtime(48_000, 1_000, 980, TRANSPORT_PLAYING);
    let inputs = vec![[0.0; MAX_INPUT_CHANNELS]; 64];
    let mut outputs = vec![[0.0; MAX_OUTPUT_CHANNELS]; 64];

    let underrun = runtime.render_block(&inputs, &mut outputs, None);
    assert!(!underrun);
    assert_eq!(
        runtime.transport.state.load(Ordering::Relaxed),
        TRANSPORT_STOPPED
    );
    assert!(runtime.transport.position_frames.load(Ordering::Relaxed) >= 1_000);

    let _ = runtime.handle_command(EngineCommand::Transport(TransportAction::Play, 0));
    assert_eq!(
        runtime.transport.state.load(Ordering::Relaxed),
        TRANSPORT_PLAYING
    );
    assert_eq!(runtime.transport.position_frames.load(Ordering::Relaxed), 0);

    let underrun = runtime.render_block(&inputs[..32], &mut outputs[..32], None);
    assert!(!underrun);
    assert_eq!(
        runtime.transport.state.load(Ordering::Relaxed),
        TRANSPORT_PLAYING
    );
    assert_eq!(
        runtime.transport.position_frames.load(Ordering::Relaxed),
        32
    );
}

#[test]
fn record_count_in_plays_the_preceding_timeline_bar_without_advancing_the_playhead() {
    const BAR_FRAMES: usize = 96_000;
    let mut runtime = transport_test_runtime(
        48_000,
        (BAR_FRAMES * 2) as u64,
        BAR_FRAMES as u64,
        TRANSPORT_STOPPED,
    );
    let mut samples = vec![[0.0, 0.0]; BAR_FRAMES * 2];
    samples[..BAR_FRAMES].fill([0.25, -0.25]);
    runtime.clips[0].samples = ClipSamples::Memory(samples);
    let inputs = vec![[0.0; MAX_INPUT_CHANNELS]; 256];
    let mut outputs = vec![[0.0; MAX_OUTPUT_CHANNELS]; 256];

    let _ = runtime.handle_command(EngineCommand::Transport(
        TransportAction::Record { count_in: true },
        0,
    ));
    assert!(!runtime.render_block(&inputs, &mut outputs, None));

    assert!(
        outputs
            .iter()
            .any(|frame| frame[0].abs() > 0.1 || frame[1].abs() > 0.1),
        "the preceding backing-track bar should be audible during count-in"
    );
    assert_eq!(
        runtime.transport.state.load(Ordering::Relaxed),
        TRANSPORT_COUNTING_IN
    );
    assert_eq!(
        runtime.transport.position_frames.load(Ordering::Relaxed),
        BAR_FRAMES as u64
    );
}

#[test]
fn render_block_consumes_scheduled_midi_exactly_up_to_the_block_end() {
    let mut runtime = transport_test_runtime(48_000, 1_000, 5, TRANSPORT_PLAYING);
    let event = |frame: u64, note_id: i32| ScheduledMidiEvent {
        frame,
        channel_index: 0,
        channel: 0,
        kind: ScheduledMidiEventKind::NoteOn {
            note_id,
            key: 60,
            velocity: 100,
        },
    };
    runtime.midi_events = vec![
        event(2, 0),
        event(10, 1),
        event(63, 2),
        event(68, 3),
        event(69, 4),
    ];
    runtime.active_notes = vec![false; 5];
    let inputs = vec![[0.0; MAX_INPUT_CHANNELS]; 64];
    let mut outputs = vec![[0.0; MAX_OUTPUT_CHANNELS]; 64];

    let underrun = runtime.render_block(&inputs, &mut outputs, None);

    assert!(!underrun);
    // Rendering frames 5..69 consumes every event before the block end —
    // including the stale frame-2 event behind the playhead — exactly once,
    // while the frame-69 event stays queued for the next block.
    assert_eq!(runtime.midi_cursor, 4);
}

#[test]
fn external_start_spp_clock_and_stop_drive_the_strict_slave_transport() {
    let mut runtime = transport_test_runtime(48_000, 10_000, 0, TRANSPORT_WAITING);
    runtime.transport.clock_source.store(1, Ordering::Relaxed);
    runtime.transport.waiting_for.store(2, Ordering::Relaxed);

    runtime
        .handle_external_sync(crate::midi_input::RealtimeMidiMessage::SongPosition { position: 8 });
    assert_eq!(
        runtime.transport.position_ticks.load(Ordering::Relaxed),
        8 * heron_dsp_runtime::midi_input::MUSICAL_TICKS_PER_SONG_POSITION
    );

    runtime.handle_external_sync(crate::midi_input::RealtimeMidiMessage::Start);
    assert_eq!(
        runtime.transport.state.load(Ordering::Relaxed),
        TRANSPORT_RECORDING
    );
    assert_eq!(runtime.transport.position_ticks.load(Ordering::Relaxed), 0);

    runtime.handle_external_sync(crate::midi_input::RealtimeMidiMessage::Clock {
        effective_bpm_bits: 127.5_f64.to_bits(),
    });
    assert_eq!(
        runtime.transport.position_ticks.load(Ordering::Relaxed),
        heron_dsp_runtime::midi_input::MUSICAL_TICKS_PER_MIDI_CLOCK
    );
    assert_eq!(
        f64::from_bits(runtime.transport.effective_bpm_bits.load(Ordering::Relaxed)),
        127.5
    );

    runtime.handle_external_sync(crate::midi_input::RealtimeMidiMessage::Stop);
    assert_eq!(
        runtime.transport.state.load(Ordering::Relaxed),
        TRANSPORT_STOPPED
    );
    assert_eq!(
        runtime.transport.position_ticks.load(Ordering::Relaxed),
        heron_dsp_runtime::midi_input::MUSICAL_TICKS_PER_MIDI_CLOCK
    );
}

#[test]
fn transport_snapshot_maps_state_clock_and_waiting_flags() {
    let transport = test_transport(44_100);
    transport.state.store(TRANSPORT_PLAYING, Ordering::Relaxed);
    transport.position_frames.store(123, Ordering::Relaxed);
    transport.position_ticks.store(456, Ordering::Relaxed);
    transport
        .effective_bpm_bits
        .store(98.5_f64.to_bits(), Ordering::Relaxed);
    transport.clock_source.store(1, Ordering::Relaxed);
    transport.waiting_for.store(1, Ordering::Relaxed);

    let snapshot = transport.snapshot();
    assert_eq!(snapshot.state, "playing");
    assert_eq!(snapshot.position_frames, 123);
    assert_eq!(snapshot.position_ticks, 456);
    assert_eq!(snapshot.sample_rate, 44_100);
    assert_eq!(snapshot.effective_bpm, Some(98.5));
    assert_eq!(snapshot.clock_source, "external");
    assert_eq!(snapshot.waiting_for.as_deref(), Some("play"));

    transport
        .state
        .store(TRANSPORT_RECORDING, Ordering::Relaxed);
    transport.waiting_for.store(2, Ordering::Relaxed);
    let recording = transport.snapshot();
    assert_eq!(recording.state, "recording");
    assert_eq!(recording.waiting_for.as_deref(), Some("record"));

    transport.state.store(TRANSPORT_WAITING, Ordering::Relaxed);
    transport.clock_source.store(0, Ordering::Relaxed);
    transport.waiting_for.store(0, Ordering::Relaxed);
    transport
        .effective_bpm_bits
        .store(f64::NAN.to_bits(), Ordering::Relaxed);
    let waiting = transport.snapshot();
    assert_eq!(waiting.state, "waiting");
    assert_eq!(waiting.clock_source, "internal");
    assert_eq!(waiting.effective_bpm, None);
    assert_eq!(waiting.waiting_for, None);
}

#[test]
fn process_context_uses_internal_tempo_or_external_bpm() {
    let runtime = transport_test_runtime(48_000, 10_000, 0, TRANSPORT_PLAYING);
    let internal = runtime.process_context(0, TRANSPORT_PLAYING);
    assert!(internal.playing);
    assert!(!internal.recording);
    assert_eq!(internal.tempo, 120.0);
    assert_eq!(internal.time_signature_numerator, 4);
    assert_eq!(internal.time_signature_denominator, 4);

    runtime.transport.clock_source.store(1, Ordering::Relaxed);
    runtime
        .transport
        .effective_bpm_bits
        .store(99.0_f64.to_bits(), Ordering::Relaxed);
    runtime.transport.position_ticks.store(0, Ordering::Relaxed);
    let external = runtime.process_context(480, TRANSPORT_RECORDING);
    assert!(!external.playing);
    assert!(external.recording);
    assert_eq!(external.tempo, 99.0);
    assert_eq!(external.project_time_samples, 480);
}

#[test]
fn transport_commands_pause_stop_seek_record_and_clear_clips() {
    let mut runtime = transport_test_runtime(48_000, 5_000, 1_200, TRANSPORT_PLAYING);
    runtime.held_peaks[0] = [0.8, 0.7];
    runtime.held_until[0] = [9, 9];

    assert!(
        runtime
            .handle_command(EngineCommand::ClearMeterClips)
            .is_none()
    );
    assert_eq!(runtime.held_peaks[0], [0.0, 0.0]);
    assert_eq!(runtime.held_until[0], [0, 0]);

    assert!(
        runtime
            .handle_command(EngineCommand::Transport(TransportAction::Pause, 0))
            .is_none()
    );
    assert_eq!(
        runtime.transport.state.load(Ordering::Relaxed),
        TRANSPORT_STOPPED
    );

    runtime
        .transport
        .state
        .store(TRANSPORT_PLAYING, Ordering::Relaxed);
    runtime
        .transport
        .position_frames
        .store(900, Ordering::Relaxed);
    assert!(
        runtime
            .handle_command(EngineCommand::Transport(TransportAction::Stop, 0))
            .is_none()
    );
    assert_eq!(
        runtime.transport.state.load(Ordering::Relaxed),
        TRANSPORT_STOPPED
    );
    assert_eq!(runtime.transport.position_frames.load(Ordering::Relaxed), 0);
    assert_eq!(runtime.midi_cursor, 0);

    assert!(
        runtime
            .handle_command(EngineCommand::Transport(TransportAction::Seek, 2_400))
            .is_none()
    );
    assert_eq!(
        runtime.transport.position_frames.load(Ordering::Relaxed),
        2_400
    );

    assert!(
        runtime
            .handle_command(EngineCommand::Transport(
                TransportAction::Record { count_in: false },
                0,
            ))
            .is_none()
    );
    assert_eq!(
        runtime.transport.state.load(Ordering::Relaxed),
        TRANSPORT_RECORDING
    );
}

#[test]
fn external_continue_resumes_waiting_record_or_play() {
    let mut runtime = transport_test_runtime(48_000, 10_000, 100, TRANSPORT_WAITING);
    runtime.transport.waiting_for.store(2, Ordering::Relaxed);
    runtime.handle_external_sync(crate::midi_input::RealtimeMidiMessage::Continue);
    assert_eq!(
        runtime.transport.state.load(Ordering::Relaxed),
        TRANSPORT_RECORDING
    );
    assert_eq!(runtime.transport.waiting_for.load(Ordering::Relaxed), 0);

    runtime
        .transport
        .state
        .store(TRANSPORT_WAITING, Ordering::Relaxed);
    runtime.transport.waiting_for.store(1, Ordering::Relaxed);
    runtime.handle_external_sync(crate::midi_input::RealtimeMidiMessage::Continue);
    assert_eq!(
        runtime.transport.state.load(Ordering::Relaxed),
        TRANSPORT_PLAYING
    );
}

#[test]
fn render_block_auto_stops_when_playhead_reaches_project_end() {
    let mut runtime = transport_test_runtime(48_000, 32, 0, TRANSPORT_PLAYING);
    let inputs = vec![[0.0; MAX_INPUT_CHANNELS]; 64];
    let mut outputs = vec![[0.0; MAX_OUTPUT_CHANNELS]; 64];
    let underrun = runtime.render_block(&inputs, &mut outputs, None);
    assert!(!underrun);
    assert_eq!(
        runtime.transport.state.load(Ordering::Relaxed),
        TRANSPORT_STOPPED
    );
    assert!(runtime.transport.position_frames.load(Ordering::Relaxed) >= 32);
}

#[test]
fn soft_project_end_stops_playback_without_truncating_later_content() {
    let mut runtime = transport_test_runtime(48_000, 128, 0, TRANSPORT_PLAYING);
    runtime.project_end_frame = 32;
    let inputs = vec![[0.0; MAX_INPUT_CHANNELS]; 64];
    let mut outputs = vec![[0.0; MAX_OUTPUT_CHANNELS]; 64];

    assert!(!runtime.render_block(&inputs, &mut outputs, None));
    assert_eq!(runtime.content_end_frame, 128);
    assert_eq!(runtime.project_end_frame, 32);
    assert_eq!(
        runtime.transport.state.load(Ordering::Relaxed),
        TRANSPORT_STOPPED
    );
}
