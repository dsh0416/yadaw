use super::{
    CountInState, EngineCommand, NativeMixerRuntime, Ordering, RealtimeParameter,
    TRANSPORT_COUNTING_IN, TRANSPORT_PLAYING, TRANSPORT_RECORDING, TRANSPORT_STOPPED,
    TRANSPORT_WAITING, TransportAction,
};

impl NativeMixerRuntime {
    pub(in crate::runtime) fn activate_application_captures(&self) {
        for capture in self.application_captures.iter().flatten() {
            capture.activate();
        }
    }

    pub(in crate::runtime) fn retire_plugin_processors(&mut self) {
        for plugin in self.plugins_by_channel.iter_mut().flatten() {
            if let Some(processor) = plugin.processor.as_mut() {
                processor.retire();
            }
        }
    }

    pub(in crate::runtime) fn set_plugin_enabled(
        &mut self,
        instance_id: &str,
        enabled: bool,
    ) -> bool {
        let Some(plugin) = self
            .plugins_by_channel
            .iter_mut()
            .flatten()
            .find(|plugin| plugin.instance_id == instance_id)
        else {
            return false;
        };
        plugin.set_enabled(enabled);
        true
    }

    pub(in crate::runtime) fn handle_command(
        &mut self,
        command: EngineCommand,
    ) -> Option<Box<NativeMixerRuntime>> {
        match command {
            EngineCommand::LoadMixer(mut runtime) => {
                self.all_notes_off();
                runtime.external_sync_enabled = self.external_sync_enabled;
                let state = runtime.transport.state.load(Ordering::Relaxed);
                if state == TRANSPORT_COUNTING_IN {
                    if let Some(count_in) = self.count_in {
                        runtime.count_in = Some(count_in);
                        runtime.chase_notes(count_in.virtual_position);
                    } else {
                        runtime.count_in = None;
                        // The shared transport says count-in is active but the
                        // private scheduler state was lost. Enter recording so
                        // the already-committed session cannot remain silent.
                        runtime
                            .transport
                            .state
                            .store(TRANSPORT_RECORDING, Ordering::Relaxed);
                        let position = runtime.transport.position_frames.load(Ordering::Relaxed);
                        runtime.chase_notes(position);
                    }
                } else {
                    runtime.count_in = None;
                    let position = runtime.transport.position_frames.load(Ordering::Relaxed);
                    runtime.metronome.reposition(
                        &runtime.tempo_map,
                        runtime.sample_rate,
                        position,
                        true,
                    );
                }
                runtime.activate_application_captures();
                return Some(runtime);
            }
            EngineCommand::Preview(preview) => {
                let result = match preview.parameter {
                    RealtimeParameter::ChannelGain => {
                        self.graph.channel_index(preview.id()).and_then(|index| {
                            self.graph.preview_channel_gain(index, preview.value).ok()
                        })
                    }
                    RealtimeParameter::ChannelPan => {
                        self.graph.channel_index(preview.id()).and_then(|index| {
                            self.graph.preview_channel_pan(index, preview.value).ok()
                        })
                    }
                    RealtimeParameter::SendLevel => self
                        .graph
                        .send_index(preview.id())
                        .and_then(|index| self.graph.preview_send_level(index, preview.value).ok()),
                    RealtimeParameter::PluginEnabled => self
                        .set_plugin_enabled(preview.id(), preview.value >= 0.5)
                        .then_some(()),
                };
                let _ = result;
            }
            EngineCommand::Transport(action, position) => match action {
                TransportAction::Play => {
                    self.count_in = None;
                    let mut position = self.transport.position_frames.load(Ordering::Relaxed);
                    if !self.external_sync_enabled
                        && let Some((loop_start, loop_end)) = self.configured_loop_frames()
                        && position >= loop_end
                    {
                        self.rewind_playback_loop(loop_start);
                        position = loop_start;
                    }
                    // Restart from the beginning when parked at/past the soft project end.
                    if self.configured_loop_frames().is_none() && position >= self.project_end_frame
                    {
                        position = 0;
                        self.transport.position_frames.store(0, Ordering::Relaxed);
                    }
                    self.chase_notes(position);
                    if self.external_sync_enabled {
                        self.transport.clock_source.store(1, Ordering::Relaxed);
                        self.transport.waiting_for.store(1, Ordering::Relaxed);
                        self.transport
                            .state
                            .store(TRANSPORT_WAITING, Ordering::Relaxed);
                    } else {
                        self.transport
                            .state
                            .store(TRANSPORT_PLAYING, Ordering::Relaxed);
                    }
                }
                TransportAction::Pause => {
                    self.count_in = None;
                    self.all_notes_off();
                    self.transport.waiting_for.store(0, Ordering::Relaxed);
                    self.transport
                        .state
                        .store(TRANSPORT_STOPPED, Ordering::Relaxed);
                }
                TransportAction::Stop => {
                    self.count_in = None;
                    self.all_notes_off();
                    self.transport.waiting_for.store(0, Ordering::Relaxed);
                    self.graph.clear_delays();
                    for plugin in self.plugins_by_channel.iter_mut().flatten() {
                        plugin.main_delay.clear();
                        plugin.bypass_delay.clear();
                        for input in &mut plugin.aux_inputs {
                            input.delay.clear();
                        }
                    }
                    self.transport
                        .state
                        .store(TRANSPORT_STOPPED, Ordering::Relaxed);
                    self.transport.position_frames.store(0, Ordering::Relaxed);
                    self.midi_cursor = 0;
                    self.metronome
                        .reposition(&self.tempo_map, self.sample_rate, 0, true);
                }
                TransportAction::Seek => {
                    self.count_in = None;
                    self.transport
                        .position_frames
                        .store(position, Ordering::Relaxed);
                    let tick = self
                        .tempo_map
                        .frame_to_tick(position, self.sample_rate)
                        .unwrap_or(0);
                    self.transport.position_ticks.store(tick, Ordering::Relaxed);
                    self.chase_notes(position);
                }
                TransportAction::Record { count_in } => {
                    let position = self.transport.position_frames.load(Ordering::Relaxed);
                    self.count_in = None;
                    if self.external_sync_enabled {
                        self.chase_notes(position);
                        self.transport.clock_source.store(1, Ordering::Relaxed);
                        self.transport.waiting_for.store(2, Ordering::Relaxed);
                        self.transport
                            .state
                            .store(TRANSPORT_WAITING, Ordering::Relaxed);
                    } else if count_in
                        && let Some(count_in) =
                            CountInState::one_bar(&self.tempo_map, self.sample_rate, position)
                    {
                        self.chase_notes(count_in.virtual_position);
                        self.count_in = Some(count_in);
                        self.transport
                            .state
                            .store(TRANSPORT_COUNTING_IN, Ordering::Relaxed);
                    } else {
                        self.chase_notes(position);
                        self.transport
                            .state
                            .store(TRANSPORT_RECORDING, Ordering::Relaxed);
                    }
                }
            },
            EngineCommand::ClearMeterClips => {
                self.held_peaks.fill([0.0, 0.0]);
                self.held_until.fill([0, 0]);
                for meter in &self.meter_bank.channels {
                    meter.clear_clip();
                }
            }
        }
        None
    }
}
