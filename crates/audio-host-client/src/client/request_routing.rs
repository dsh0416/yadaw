fn register_pending(
    pending: &Mutex<HashMap<u64, Pending>>,
    request_id: u64,
    value: Pending,
) -> Result<()> {
    let mut pending = pending
        .lock()
        .map_err(|_| failure("audio-host pending requests", "poisoned"))?;
    if pending.len() >= OUTBOUND_CAPACITY {
        return Err(failure("audio-host request", "too many requests in flight"));
    }
    match pending.entry(request_id) {
        std::collections::hash_map::Entry::Vacant(entry) => {
            entry.insert(value);
            Ok(())
        }
        std::collections::hash_map::Entry::Occupied(_) => Err(failure(
            "audio-host request",
            "duplicate request identifier",
        )),
    }
}

fn queue_pending_request(
    pending: &Mutex<HashMap<u64, Pending>>,
    outbound: &Mutex<Option<SyncSender<WirePacket>>>,
    request_id: u64,
    packet: WirePacket,
) -> Result<()> {
    let guard = match outbound.lock() {
        Ok(guard) => guard,
        Err(_) => {
            let error = failure("audio-host outbound queue", "poisoned");
            reject_pending(
                pending,
                request_id,
                Error::new(error.status, error.reason.clone()),
            );
            return Err(error);
        }
    };
    let Some(outbound) = guard.as_ref() else {
        let error = failure("audio-host outbound queue", "closed");
        reject_pending(
            pending,
            request_id,
            Error::new(error.status, error.reason.clone()),
        );
        return Err(error);
    };
    let send = outbound.try_send(packet);
    if let Err(error) = send {
        reject_pending(
            pending,
            request_id,
            failure("could not queue audio-host request", error),
        );
    }
    Ok(())
}

impl AudioHostIpcClient {
    fn create_request_promise<'env>(
        &self,
        env: &'env Env,
        request_id: u64,
        deadline: Instant,
        packet: WirePacket,
        priority: bool,
    ) -> Result<Object<'env>> {
        let (deferred, promise) = env.create_deferred::<IpcResponse, ResponseResolver>()?;
        let map = if priority {
            &self.state.priority_pending
        } else {
            &self.state.pending
        };
        register_pending(
            map,
            request_id,
            Pending {
                responder: Box::new(NapiPendingResponder(deferred)),
                deadline,
            },
        )?;
        let outbound = if priority {
            &self.state.priority_outbound
        } else {
            &self.state.normal_outbound
        };
        queue_pending_request(map, outbound, request_id, packet)?;
        Ok(promise)
    }

    fn send_internal_priority(&self, command: PriorityCommand) -> Result<()> {
        let request = PriorityRequest {
            request_id: self
                .state
                .internal_request_id
                .fetch_add(1, Ordering::Relaxed),
            command,
        };
        let packet = encode_priority(&request)
            .map_err(|error| failure("could not encode priority command", error))?;
        let guard = self
            .state
            .priority_outbound
            .lock()
            .map_err(|_| failure("priority outbound queue", "poisoned"))?;
        guard
            .as_ref()
            .ok_or_else(|| failure("priority outbound queue", "closed"))?
            .try_send(packet)
            .map_err(|error| failure("priority outbound queue", error))
    }
}
