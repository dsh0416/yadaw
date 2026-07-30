fn request_deadline(command: &ControlCommand) -> Duration {
    if matches!(
        command,
        ControlCommand::UpdateGraph { .. }
            | ControlCommand::LoadPlugin { .. }
            | ControlCommand::UnloadPlugin { .. }
            | ControlCommand::SavePluginState { .. }
            | ControlCommand::OpenPluginEditor { .. }
            | ControlCommand::ClosePluginEditor { .. }
            | ControlCommand::RunAudioBenchmark { .. }
            | ControlCommand::BenchmarkEcho { .. }
    ) {
        Duration::from_secs(15)
    } else {
        Duration::from_secs(2)
    }
}

fn record_packet(packet: &WirePacket, traffic: &TransportTraffic) {
    if packet.region_offers.is_empty() {
        traffic.inline_packets.fetch_add(1, Ordering::Relaxed);
        traffic
            .inline_bytes
            .fetch_add(packet.body.len() as u64, Ordering::Relaxed);
        return;
    }
    traffic.shared_packets.fetch_add(1, Ordering::Relaxed);
    traffic
        .shared_regions
        .fetch_add(packet.region_offers.len() as u64, Ordering::Relaxed);
    traffic.shared_bytes.fetch_add(
        packet
            .region_offers
            .iter()
            .map(|offer| offer.capacity)
            .sum(),
        Ordering::Relaxed,
    );
}

fn parse_gesture(value: &str) -> Result<ParameterGesture> {
    match value {
        "begin" => Ok(ParameterGesture::Begin),
        "perform" => Ok(ParameterGesture::Perform),
        "end" => Ok(ParameterGesture::End),
        _ => Err(Error::new(Status::InvalidArg, "invalid parameter gesture")),
    }
}
