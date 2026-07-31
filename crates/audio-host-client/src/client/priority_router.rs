fn spawn_priority_router(
    receiver: IpcReceiver<WirePacket>,
    pending: Arc<Mutex<HashMap<u64, Pending>>>,
    closing: Arc<AtomicBool>,
    request_timeouts: Arc<AtomicU64>,
) -> Result<JoinHandle<()>> {
    thread::Builder::new()
        .name("yadaw-ipc-priority-router".into())
        .spawn(move || {
            while !closing.load(Ordering::Acquire) {
                match receiver.try_recv_timeout(router_timeout(&pending)) {
                    Ok(packet) => match decode_body::<PriorityResponse>(&packet.body) {
                        Ok(response) => {
                            resolve_pending(&pending, response.request_id, packet.body, Vec::new())
                        }
                        Err(error) => {
                            reject_all(&pending, failure("invalid priority response", error));
                        }
                    },
                    Err(TryRecvError::Empty) => expire_pending(&pending, &request_timeouts),
                    Err(TryRecvError::IpcError(error)) => {
                        reject_all(&pending, failure("priority response channel closed", error));
                        break;
                    }
                }
            }
        })
        .map_err(|error| failure("could not start priority response router thread", error))
}
