fn transport_state_code(state: &str) -> u32 {
    match state {
        "playing" => 1,
        "recording" => 2,
        "waiting" => 3,
        "counting-in" => 4,
        _ => 0,
    }
}

struct TelemetryPages {
    active: Mutex<TelemetryWriter>,
    pending: Mutex<Option<TelemetryWriter>>,
    next_generation: AtomicU64,
    persistent: bool,
}

async fn publish_telemetry(
    pages: &TelemetryPages,
    outbound: &mpsc::Sender<OutboundMessage>,
    graph_revision: u64,
    session_epoch: u64,
    audio_engine: &engine::AudioEngine,
) {
    let (callback_generation, transport_state) = audio_engine.heartbeat_snapshot();
    let transport = audio_engine.transport_snapshot().ok();
    let meter_values = audio_engine.mixer_snapshot()
        .map(|snapshot| snapshot.meters)
        .unwrap_or_default();
    let meters = meter_values
        .iter()
        .map(|meter| TelemetryMeter {
            runtime_handle: stable_runtime_handle(1, &meter.channel_id),
            pre_left: meter.pre_left as f32,
            pre_right: meter.pre_right as f32,
            post_left: meter.post_left as f32,
            post_right: meter.post_right as f32,
            held_left: meter.held_left as f32,
            held_right: meter.held_right as f32,
            clipped: meter.clipped,
        })
        .collect::<Vec<_>>();
    let current_capacity = pages
        .active
        .lock()
        .map(|writer| writer.capacity())
        .unwrap_or_default();
    let has_pending = pages
        .pending
        .lock()
        .map(|value| value.is_some())
        .unwrap_or(true);
    if pages.persistent && !has_pending && meters.len() > current_capacity as usize {
        let Some(capacity) = u32::try_from(meters.len())
            .ok()
            .and_then(u32::checked_next_power_of_two)
        else {
            return;
        };
        let generation = pages.next_generation.fetch_add(1, Ordering::AcqRel);
        let epoch = session_epoch.wrapping_add(generation);
        if let Ok(memory) = create_telemetry_page(capacity, epoch, generation)
            && let Ok(next) = TelemetryWriter::map(memory)
        {
            let descriptor = next.descriptor();
            if let Ok(mut value) = pages.pending.lock() {
                *value = Some(next);
            }
            if let Ok(packet) = encode_event(
                &HostEvent::TelemetryPageOffer {
                    epoch,
                    capacity,
                    descriptor_version: descriptor.descriptor_version(),
                    object_id: descriptor.object_id(),
                    byte_len: descriptor.byte_len(),
                    generation,
                },
                Vec::new(),
            ) {
                let _ = outbound.send(OutboundMessage::Event(packet)).await;
            }
        }
    }
    let snapshot = TelemetrySnapshot {
        epoch: pages
            .active
            .lock()
            .map(|value| value.epoch())
            .unwrap_or(session_epoch),
        graph_revision,
        callback_generation,
        transport_state: transport_state_code(&transport_state),
        position_frames: transport.as_ref().map_or(0, |value| value.position_frames),
        sample_rate: transport.as_ref().map_or(0, |value| value.sample_rate),
        meters,
    };
    if let Ok(writer) = pages.active.lock() {
        let _ = writer.publish(&snapshot);
    }
}
