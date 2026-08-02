fn transport_state_code(state: &str) -> u32 {
    match state {
        "playing" => 1,
        "recording" => 2,
        "waiting" => 3,
        "counting-in" => 4,
        _ => 0,
    }
}

async fn publish_telemetry(
    writer: &Arc<Mutex<TelemetryWriter>>,
    outbound: &mpsc::Sender<OutboundMessage>,
    graph_revision: u64,
    session_epoch: u64,
    page_epoch: &AtomicU64,
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
    let current_capacity = writer
        .lock()
        .map(|writer| writer.capacity())
        .unwrap_or_default();
    if meters.len() > current_capacity as usize {
        let Some(capacity) = u32::try_from(meters.len())
            .ok()
            .and_then(u32::checked_next_power_of_two)
        else {
            return;
        };
        let epoch = session_epoch.wrapping_add(page_epoch.fetch_add(1, Ordering::AcqRel) + 1);
        if let Ok(memory) = create_telemetry_page(capacity, epoch)
            && let Ok(next) = TelemetryWriter::map(memory.clone())
        {
            if let Ok(mut current) = writer.lock() {
                *current = next;
            }
            if let Ok(packet) = encode_event(
                &HostEvent::TelemetryPageOffer { epoch, capacity },
                vec![RegionOffer {
                    session_epoch,
                    region_id: 0,
                    region_generation: epoch,
                    capacity: memory.len() as u64,
                    memory,
                }],
            ) {
                let _ = outbound.send(OutboundMessage::Event(packet)).await;
            }
        }
    }
    let snapshot = TelemetrySnapshot {
        epoch: writer
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
    if let Ok(writer) = writer.lock() {
        let _ = writer.publish(&snapshot);
    }
}
