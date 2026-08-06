use super::{EmbeddedUiHost, Instant, Ordering, UiEvent, should_drain_ui_request, std_mpsc};

impl EmbeddedUiHost {
    pub(in crate::runtime) fn drain_embedded_ui_mailbox(&mut self) -> bool {
        self.generation.fetch_add(1, Ordering::Release);
        let pending = self.drain_ui_mailbox();
        let now = Instant::now();
        if self
            .next_retirement_tick
            .is_some_and(|deadline| now >= deadline)
        {
            if let Err(error) = self.audio_engine.reclaim_retired_graphs() {
                eprintln!("audio-host: could not reclaim retired audio graph: {error}");
            }
            if let Some(runtime) = self.vst3.as_mut() {
                runtime.reclaim_retired_instances();
                self.next_retirement_tick = runtime
                    .has_retired_instances()
                    .then_some(now + Self::RETIREMENT_TICK);
            } else {
                self.next_retirement_tick = None;
            }
        }
        if self.next_ara_tick.is_some_and(|deadline| now >= deadline) {
            self.poll_ara_callbacks();
            self.next_ara_tick = self
                .vst3
                .as_ref()
                .is_some_and(super::vst3::Vst3Runtime::has_ara_documents)
                .then_some(now + Self::ARA_CALLBACK_TICK);
        }
        self.refresh_embedded_editor_gestures();
        let _ = self.dispatch_embedded_editor_run_loops(now);
        pending
    }

    fn drain_ui_mailbox(&mut self) -> bool {
        let started = std::time::Instant::now();
        let mut drained = 0;
        while should_drain_ui_request(drained, started.elapsed()) {
            match self.inbox.try_recv() {
                Ok(request) => {
                    self.execute_audio_plugin_request(request);
                    drained += 1;
                }
                Err(std_mpsc::TryRecvError::Empty | std_mpsc::TryRecvError::Disconnected) => {
                    return false;
                }
            }
        }
        self.proxy.send_event(UiEvent::Wake);
        true
    }
}
