fn send_release_leases(outbound: &SyncSender<WirePacket>, lease_ids: Vec<u64>) {
    let request = PriorityRequest {
        request_id: 0,
        command: PriorityCommand::ReleaseLeases { lease_ids },
    };
    if let Ok(packet) = encode_priority(&request) {
        let _ = outbound.try_send(packet);
    }
}

fn resolve_pending(
    pending: &Mutex<HashMap<u64, Pending>>,
    request_id: u64,
    bytes: Vec<u8>,
    attachments: Vec<Vec<u8>>,
) {
    let value = pending
        .lock()
        .ok()
        .and_then(|mut values| values.remove(&request_id));
    if let Some(value) = value {
        value.deferred.resolve(Box::new(move |_env| {
            Ok(IpcResponse {
                body: bytes.into(),
                attachments: attachments.into_iter().map(Buffer::from).collect(),
            })
        }));
    }
}

fn reject_pending(pending: &Mutex<HashMap<u64, Pending>>, request_id: u64, error: Error) {
    let value = pending
        .lock()
        .ok()
        .and_then(|mut values| values.remove(&request_id));
    if let Some(value) = value {
        value.deferred.reject(error);
    }
}

fn expire_pending(pending: &Mutex<HashMap<u64, Pending>>, request_timeouts: &AtomicU64) {
    let now = Instant::now();
    let expired = pending
        .lock()
        .map(|values| {
            values
                .iter()
                .filter_map(|(id, value)| (value.deadline <= now).then_some(*id))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if !expired.is_empty() {
        request_timeouts.fetch_add(expired.len() as u64, Ordering::Relaxed);
    }
    for request_id in expired {
        reject_pending(
            pending,
            request_id,
            failure("audio-host request", "deadline exceeded"),
        );
    }
}

fn router_timeout(pending: &Mutex<HashMap<u64, Pending>>) -> Duration {
    let now = Instant::now();
    pending
        .lock()
        .ok()
        .and_then(|values| values.values().map(|value| value.deadline).min())
        .map_or(ROUTER_POLL, |deadline| {
            deadline.saturating_duration_since(now).min(ROUTER_POLL)
        })
}

fn reject_all(pending: &Mutex<HashMap<u64, Pending>>, error: Error) {
    let values = pending
        .lock()
        .map(|mut pending| pending.drain().map(|(_, value)| value).collect::<Vec<_>>())
        .unwrap_or_default();
    for value in values {
        value
            .deferred
            .reject(Error::new(error.status, error.reason.clone()));
    }
}

fn close_state(state: &ClientState) -> Result<()> {
    if state.closing.swap(true, Ordering::AcqRel) {
        return Ok(());
    }
    state
        .normal_outbound
        .lock()
        .map_err(|_| failure("normal outbound queue", "poisoned"))?
        .take();
    state
        .priority_outbound
        .lock()
        .map_err(|_| failure("priority outbound queue", "poisoned"))?
        .take();
    let mut child = state
        .child
        .lock()
        .map_err(|_| failure("audio host process lock", "poisoned"))?;
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut exited = child
        .try_wait()
        .map_err(|error| failure("could not inspect audio host", error))?
        .is_some();
    while !exited && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
        exited = child
            .try_wait()
            .map_err(|error| failure("could not inspect audio host", error))?
            .is_some();
    }
    if !exited {
        child
            .kill()
            .map_err(|error| failure("could not stop audio host", error))?;
        child
            .wait()
            .map_err(|error| failure("could not reap audio host", error))?;
    }
    reject_all(
        &state.pending,
        failure("audio-host request", "client closed"),
    );
    reject_all(
        &state.priority_pending,
        failure("audio-host request", "client closed"),
    );
    if let Ok(mut threads) = state.threads.lock() {
        for thread in threads.drain(..) {
            let _ = thread.join();
        }
    }
    Ok(())
}

impl Drop for ClientState {
    fn drop(&mut self) {
        let _ = close_state(self);
    }
}
