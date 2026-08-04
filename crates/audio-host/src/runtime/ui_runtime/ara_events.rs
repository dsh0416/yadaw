use super::{ControlResult, HostEvent, WinitHost, std_mpsc};

impl WinitHost {
    pub(super) fn poll_ara_callbacks(&mut self) {
        self.flush_pending_ara_events();
        let include_model_events = self.pending_ara_events.is_empty();
        let batches = self
            .vst3
            .as_mut()
            .map(|runtime| runtime.poll_ara_callbacks(include_model_events))
            .unwrap_or_default();
        for batch in batches {
            for (sequence, event) in batch.events {
                self.pending_ara_events.push_back(HostEvent::AraCallback {
                    instance_id: batch.instance_id.clone(),
                    sequence,
                    event,
                });
            }
            for command in batch.transport {
                let result =
                    match command {
                        crate::ara::AraTransportCommand::Play => self
                            .audio_engine
                            .transport_command("play".to_owned(), None, None, None, None),
                        crate::ara::AraTransportCommand::Pause => self
                            .audio_engine
                            .transport_command("pause".to_owned(), None, None, None, None),
                        crate::ara::AraTransportCommand::SeekFrames(position) => self
                            .audio_engine
                            .transport_command("seek".to_owned(), Some(position), None, None, None),
                        crate::ara::AraTransportCommand::SetLoop {
                            enabled,
                            start_tick,
                            end_tick,
                        } => self.audio_engine.transport_command(
                            "set-loop".to_owned(),
                            None,
                            Some(enabled),
                            Some(start_tick),
                            Some(end_tick),
                        ),
                    };
                if let Err(error) = result {
                    self.publish_ara_runtime_failure(&batch.instance_id, error);
                }
            }
            for failure in batch.failures {
                self.publish_ara_runtime_failure(&batch.instance_id, failure);
            }
        }
        self.flush_pending_ara_events();
    }

    pub(super) fn flush_pending_ara_events(&mut self) {
        while let Some(event) = self.pending_ara_events.pop_front() {
            match self.host_events.try_send(event) {
                Ok(()) => {}
                Err(std_mpsc::TrySendError::Full(event)) => {
                    self.pending_ara_events.push_front(event);
                    break;
                }
                Err(std_mpsc::TrySendError::Disconnected(_)) => {
                    self.pending_ara_events.clear();
                    break;
                }
            }
        }
    }

    pub(super) fn publish_ara_runtime_failure(
        &self,
        instance_id: &str,
        diagnostic: impl std::fmt::Display,
    ) {
        self.publish_plugin_runtime_failure(instance_id, "ara-playback-callback", diagnostic);
    }

    pub(super) fn publish_plugin_runtime_failure(
        &self,
        instance_id: &str,
        phase: &str,
        diagnostic: impl std::fmt::Display,
    ) {
        if let ControlResult::Error { error } = crate::control_error_result(diagnostic) {
            let _ = self.host_events.try_send(HostEvent::RuntimeFailure {
                error,
                plugin_instance_id: Some(instance_id.to_owned()),
                phase: Some(phase.to_owned()),
            });
        }
    }
}
