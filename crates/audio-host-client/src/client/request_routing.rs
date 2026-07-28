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
        {
            let mut pending = map
                .lock()
                .map_err(|_| failure("audio-host pending requests", "poisoned"))?;
            if pending.len() >= OUTBOUND_CAPACITY {
                return Err(failure("audio-host request", "too many requests in flight"));
            }
            if pending
                .insert(request_id, Pending { deferred, deadline })
                .is_some()
            {
                return Err(failure(
                    "audio-host request",
                    "duplicate request identifier",
                ));
            }
        }
        let outbound = if priority {
            &self.state.priority_outbound
        } else {
            &self.state.normal_outbound
        };
        let send = outbound
            .lock()
            .map_err(|_| failure("audio-host outbound queue", "poisoned"))?
            .as_ref()
            .ok_or_else(|| failure("audio-host outbound queue", "closed"))?
            .try_send(packet);
        if let Err(error) = send
            && let Ok(mut pending) = map.lock()
            && let Some(value) = pending.remove(&request_id)
        {
            value
                .deferred
                .reject(failure("could not queue audio-host request", error));
        }
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
