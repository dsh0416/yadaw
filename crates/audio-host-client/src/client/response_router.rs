fn spawn_response_router(
    receiver: IpcReceiver<WirePacket>,
    pending: Arc<Mutex<HashMap<u64, Pending>>>,
    priority_outbound: SyncSender<WirePacket>,
    closing: Arc<AtomicBool>,
    request_timeouts: Arc<AtomicU64>,
    transport_traffic: Arc<TransportTraffic>,
    response_arena: Arc<Mutex<ArenaReceiver>>,
) -> JoinHandle<()> {
    thread::Builder::new()
        .name("yadaw-ipc-response-router".into())
        .spawn(move || {
            while !closing.load(Ordering::Acquire) {
                match receiver.try_recv_timeout(router_timeout(&pending)) {
                    Ok(packet) => {
                        record_packet(&packet, &transport_traffic);
                        let decoded = response_arena
                            .lock()
                            .map_err(|_| failure("response arena", "poisoned"))
                            .and_then(|mut arena| {
                                decode_response_to_attachments(packet, &mut arena)
                                    .map_err(|error| failure("invalid audio-host response", error))
                            });
                        match decoded {
                            Ok((response, attachments, lease_ids)) => {
                                if !lease_ids.is_empty() {
                                    send_release_leases(&priority_outbound, lease_ids);
                                }
                                let request_id = response.request_id;
                                match encode_body(&response) {
                                    Ok(bytes) => {
                                        resolve_pending(&pending, request_id, bytes, attachments)
                                    }
                                    Err(error) => reject_pending(
                                        &pending,
                                        request_id,
                                        failure("could not encode audio-host response", error),
                                    ),
                                }
                            }
                            Err(error) => reject_all(&pending, error),
                        }
                    }
                    Err(TryRecvError::Empty) => expire_pending(&pending, &request_timeouts),
                    Err(TryRecvError::IpcError(error)) => {
                        reject_all(
                            &pending,
                            failure("audio-host response channel closed", error),
                        );
                        break;
                    }
                }
            }
        })
        .expect("response router thread must start")
}
