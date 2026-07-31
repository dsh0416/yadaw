#[napi]
pub struct AudioHostIpcClient {
    state: Arc<ClientState>,
}

#[napi]
impl AudioHostIpcClient {
    #[napi(constructor)]
    pub fn new(
        executable_path: String,
        crash_marker_path: String,
        worker_threads: Option<u32>,
        max_blocking_threads: Option<u32>,
        egress_concurrency: Option<u32>,
        editor_owner_window_handle: Option<Buffer>,
    ) -> Result<Self> {
        let runtime_config =
            resolve_runtime_config(worker_threads, max_blocking_threads, egress_concurrency)?;
        let editor_owner_window_handle =
            decode_native_window_handle(editor_owner_window_handle.as_deref())?;
        let (server, token) = IpcOneShotServer::<IpcSender<HostBootstrap>>::new()
            .map_err(|error| failure("could not create helper IPC server", error))?;
        let mut command = Command::new(&executable_path);
        command
            .arg("--ipc-token")
            .arg(token)
            .arg("--crash-marker")
            .arg(crash_marker_path)
            .arg("--worker-threads")
            .arg(runtime_config.worker_threads.to_string())
            .arg("--max-blocking-threads")
            .arg(runtime_config.max_blocking_threads.to_string())
            .arg("--egress-concurrency")
            .arg(runtime_config.egress_concurrency.to_string());
        if let Some(handle) = editor_owner_window_handle {
            command.arg("--editor-owner-window").arg(handle.to_string());
        }
        let mut child = command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|error| failure("could not start audio host", error))?;

        let (requests, request_receiver) =
            ipc::channel().map_err(|error| failure("could not create request channel", error))?;
        let (response_sender, responses) =
            ipc::channel().map_err(|error| failure("could not create response channel", error))?;
        let (priority_requests, priority_request_receiver) = ipc::channel()
            .map_err(|error| failure("could not create priority request channel", error))?;
        let (priority_response_sender, priority_responses) = ipc::channel()
            .map_err(|error| failure("could not create priority response channel", error))?;
        let (event_sender, events) =
            ipc::channel().map_err(|error| failure("could not create event channel", error))?;

        let session_epoch = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(1, |value| {
                (value.as_nanos() as u64) ^ u64::from(std::process::id())
            })
            .max(1);
        let telemetry_page = create_telemetry_page(64, session_epoch)
            .map_err(|error| failure("could not create telemetry page", error))?;
        let parameter_ring = create_parameter_ring(session_epoch)
            .map_err(|error| failure("could not create parameter ring", error))?;
        let telemetry = TelemetryReader::map(telemetry_page.clone())
            .map_err(|error| failure("could not map telemetry page", error))?;
        let parameters = ParameterProducer::map(parameter_ring.clone())
            .map_err(|error| failure("could not map parameter ring", error))?;

        let (_, bootstrap_sender) = server.accept().map_err(|error| {
            let _ = child.kill();
            let _ = child.wait();
            failure("audio host did not connect to IPC", error)
        })?;
        bootstrap_sender
            .send(HostBootstrap {
                protocol_version: IPC_PROTOCOL_VERSION,
                native_build_fingerprint: NATIVE_BUILD_FINGERPRINT.to_owned(),
                requests: request_receiver,
                responses: response_sender,
                priority_requests: priority_request_receiver,
                priority_responses: priority_response_sender,
                events: event_sender,
                telemetry_page,
                parameter_ring,
                session_epoch,
            })
            .map_err(|error| {
                let _ = child.kill();
                let _ = child.wait();
                failure("could not transfer helper channels", error)
            })?;

        let (normal_outbound, normal_inbox) = mpsc::sync_channel(OUTBOUND_CAPACITY);
        let (priority_outbound, priority_inbox) = mpsc::sync_channel(OUTBOUND_CAPACITY);
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let priority_pending = Arc::new(Mutex::new(HashMap::new()));
        let leases = Arc::new(Mutex::new(LeaseRegistry::with_session_epoch(session_epoch)));
        let response_arena = Arc::new(Mutex::new(ArenaReceiver::new(session_epoch)));
        let telemetry = Arc::new(RwLock::new(telemetry));
        let event_queue = Arc::new(Mutex::new(VecDeque::new()));
        let closing = Arc::new(AtomicBool::new(false));
        let request_timeouts = Arc::new(AtomicU64::new(0));
        let transport_traffic = Arc::new(TransportTraffic::default());

        let mut threads = Vec::with_capacity(5);
        let startup_result = (|| -> Result<()> {
            threads.push(spawn_response_router(
                responses,
                Arc::clone(&pending),
                priority_outbound.clone(),
                Arc::clone(&closing),
                Arc::clone(&request_timeouts),
                Arc::clone(&transport_traffic),
                Arc::clone(&response_arena),
            )?);
            threads.push(spawn_priority_router(
                priority_responses,
                Arc::clone(&priority_pending),
                Arc::clone(&closing),
                Arc::clone(&request_timeouts),
            )?);
            threads.push(spawn_event_router(
                events,
                Arc::clone(&leases),
                Arc::clone(&telemetry),
                Arc::clone(&event_queue),
                priority_outbound.clone(),
                Arc::clone(&closing),
            )?);
            threads.push(spawn_egress(
                "yadaw-ipc-request",
                requests,
                normal_inbox,
            )?);
            threads.push(spawn_egress(
                "yadaw-ipc-priority-request",
                priority_requests,
                priority_inbox,
            )?);
            Ok(())
        })();
        if let Err(error) = startup_result {
            closing.store(true, Ordering::Release);
            drop(normal_outbound);
            drop(priority_outbound);
            let _ = child.kill();
            let _ = child.wait();
            for thread in threads {
                let _ = thread.join();
            }
            return Err(error);
        }

        Ok(Self {
            state: Arc::new(ClientState {
                normal_outbound: Mutex::new(Some(normal_outbound)),
                priority_outbound: Mutex::new(Some(priority_outbound)),
                pending,
                priority_pending,
                leases,
                telemetry,
                last_telemetry: Mutex::new(TelemetrySnapshot {
                    epoch: session_epoch,
                    graph_revision: 0,
                    callback_generation: 0,
                    transport_state: 0,
                    position_frames: 0,
                    sample_rate: 0,
                    meters: Vec::new(),
                }),
                parameters,
                events: event_queue,
                child: Mutex::new(child),
                threads: Mutex::new(threads),
                closing,
                session_epoch,
                parameter_sequence: AtomicU64::new(1),
                internal_request_id: AtomicU64::new(u64::MAX / 2),
                telemetry_fallback_reads: AtomicU64::new(0),
                parameter_soft_full: AtomicU64::new(0),
                parameter_hard_full: AtomicU64::new(0),
                parameter_boundary_fallbacks: AtomicU64::new(0),
                parameter_stale_epoch: AtomicU64::new(0),
                request_timeouts,
                transport_traffic,
                runtime_config,
            }),
        })
    }

    #[napi(ts_return_type = "Promise<IpcResponse>")]
    pub fn request<'env>(
        &self,
        env: &'env Env,
        message_pack_request: Buffer,
        attachments: Option<Vec<Buffer>>,
    ) -> Result<Object<'env>> {
        if self.state.closing.load(Ordering::Acquire) {
            return Err(failure("audio-host request", "client is closing"));
        }
        if message_pack_request.len() > MAX_LOGICAL_REQUEST_BYTES {
            return Err(Error::new(
                Status::InvalidArg,
                "audio-host logical request exceeds 128 MiB",
            ));
        }
        let request = rmp_serde::from_slice::<ControlRequest>(&message_pack_request)
            .map_err(|error| failure("invalid audio-host request", error))?;
        let request_id = request.request_id;
        let deadline = Instant::now() + request_deadline(&request.command);
        let packet = {
            let attachments = attachments.unwrap_or_default();
            let attachment_slices = attachments
                .iter()
                .map(|attachment| attachment.as_ref())
                .collect::<Vec<_>>();
            let mut leases = self
                .state
                .leases
                .lock()
                .map_err(|_| failure("audio-host lease registry", "poisoned"))?;
            encode_request_with_attachments(request, &attachment_slices, &mut leases)
                .map_err(|error| failure("could not encode audio-host request", error))?
        };
        record_packet(&packet, &self.state.transport_traffic);
        self.create_request_promise(env, request_id, deadline, packet, false)
    }

    #[napi(ts_return_type = "Promise<IpcResponse>")]
    pub fn heartbeat<'env>(
        &self,
        env: &'env Env,
        message_pack_request: Buffer,
    ) -> Result<Object<'env>> {
        let request = rmp_serde::from_slice::<PriorityRequest>(&message_pack_request)
            .map_err(|error| failure("invalid heartbeat request", error))?;
        let request_id = request.request_id;
        let packet = encode_priority(&request)
            .map_err(|error| failure("could not encode heartbeat request", error))?;
        self.create_request_promise(
            env,
            request_id,
            Instant::now() + Duration::from_secs(2),
            packet,
            true,
        )
    }

    #[napi]
    pub fn read_telemetry(&self) -> Result<Buffer> {
        let snapshot = self
            .state
            .telemetry
            .read()
            .map_err(|_| failure("telemetry page", "poisoned"))?
            .read();
        let snapshot = match snapshot {
            Some(snapshot) => {
                if let Ok(mut previous) = self.state.last_telemetry.lock() {
                    *previous = snapshot.clone();
                }
                snapshot
            }
            None => {
                self.state
                    .telemetry_fallback_reads
                    .fetch_add(1, Ordering::Relaxed);
                self.state
                    .last_telemetry
                    .lock()
                    .map_err(|_| failure("last telemetry snapshot", "poisoned"))?
                    .clone()
            }
        };
        rmp_serde::to_vec_named(&(
            snapshot.epoch,
            snapshot.graph_revision,
            snapshot.callback_generation,
            snapshot.transport_state,
            snapshot.position_frames,
            snapshot.sample_rate,
            snapshot
                .meters
                .into_iter()
                .map(|meter| {
                    (
                        meter.runtime_handle,
                        meter.pre_left,
                        meter.pre_right,
                        meter.post_left,
                        meter.post_right,
                        meter.held_left,
                        meter.held_right,
                        meter.clipped,
                    )
                })
                .collect::<Vec<_>>(),
        ))
        .map(Buffer::from)
        .map_err(|error| failure("could not encode telemetry snapshot", error))
    }

    #[napi]
    pub fn enqueue_parameter(
        &self,
        request: ParameterEnqueueRequest,
    ) -> Result<ParameterEnqueueResult> {
        let target_kind = match request.target_kind.as_str() {
            "plugin" => ParameterTargetKind::Plugin,
            "mixer-channel" => ParameterTargetKind::MixerChannel,
            "mixer-send" => ParameterTargetKind::MixerSend,
            _ => return Err(Error::new(Status::InvalidArg, "invalid parameter target")),
        };
        let gesture = parse_gesture(&request.gesture)?;
        let sequence = request.sequence.map_or_else(
            || {
                Ok(self
                    .state
                    .parameter_sequence
                    .fetch_add(1, Ordering::Relaxed))
            },
            |value| value.parse::<u64>().map_err(|error| failure("invalid parameter sequence", error)),
        )?;
        let command = ParameterCommand {
            session_epoch: self.state.session_epoch,
            sequence,
            target_kind,
            runtime_handle: request.runtime_handle,
            parameter_id: request.parameter_id,
            normalized: request.normalized,
            target_generation: request.target_generation.unwrap_or(0),
            gesture,
        };
        match self.state.parameters.enqueue(command) {
            ParameterEnqueue::Queued { wake } => {
                if wake {
                    self.send_internal_priority(PriorityCommand::ParameterWake)?;
                }
                Ok(ParameterEnqueueResult {
                    outcome: "queued".into(),
                    sequence: sequence.to_string(),
                })
            }
            ParameterEnqueue::SoftFull => {
                self.state
                    .parameter_soft_full
                    .fetch_add(1, Ordering::Relaxed);
                Ok(ParameterEnqueueResult {
                    outcome: "soft-full".into(),
                    sequence: sequence.to_string(),
                })
            }
            ParameterEnqueue::Full => {
                self.state
                    .parameter_hard_full
                    .fetch_add(1, Ordering::Relaxed);
                if matches!(gesture, ParameterGesture::Begin | ParameterGesture::End) {
                    self.send_internal_priority(PriorityCommand::ParameterBoundary { command })?;
                    self.state
                        .parameter_boundary_fallbacks
                        .fetch_add(1, Ordering::Relaxed);
                    Ok(ParameterEnqueueResult {
                        outcome: "fallback".into(),
                        sequence: sequence.to_string(),
                    })
                } else {
                    Ok(ParameterEnqueueResult {
                        outcome: "full".into(),
                        sequence: sequence.to_string(),
                    })
                }
            }
            ParameterEnqueue::StaleEpoch => {
                self.state
                    .parameter_stale_epoch
                    .fetch_add(1, Ordering::Relaxed);
                Ok(ParameterEnqueueResult {
                    outcome: "stale".into(),
                    sequence: sequence.to_string(),
                })
            }
        }
    }

    #[napi]
    pub fn transport_diagnostics(&self) -> Result<Buffer> {
        let normal_pending = self
            .state
            .pending
            .lock()
            .map_err(|_| failure("normal pending requests", "poisoned"))?
            .len();
        let priority_pending = self
            .state
            .priority_pending
            .lock()
            .map_err(|_| failure("priority pending requests", "poisoned"))?
            .len();
        let (outstanding_leases, outstanding_lease_bytes, arena_diagnostics) = {
            let leases = self
                .state
                .leases
                .lock()
                .map_err(|_| failure("lease registry", "poisoned"))?;
            (leases.len(), leases.bytes(), leases.diagnostics())
        };
        let event_queue_depth = self
            .state
            .events
            .lock()
            .map_err(|_| failure("event queue", "poisoned"))?
            .len();
        let (telemetry_epoch, telemetry_capacity, telemetry_snapshot) = {
            let telemetry = self
                .state
                .telemetry
                .read()
                .map_err(|_| failure("telemetry page", "poisoned"))?;
            (telemetry.epoch(), telemetry.capacity(), telemetry.read())
        };
        let telemetry = match telemetry_snapshot {
            Some(snapshot) => {
                *self
                    .state
                    .last_telemetry
                    .lock()
                    .map_err(|_| failure("last telemetry snapshot", "poisoned"))? =
                    snapshot.clone();
                snapshot
            }
            None => {
                self.state
                    .telemetry_fallback_reads
                    .fetch_add(1, Ordering::Relaxed);
                self.state
                    .last_telemetry
                    .lock()
                    .map_err(|_| failure("last telemetry snapshot", "poisoned"))?
                    .clone()
            }
        };
        let (parameter_ring_used, parameter_ring_capacity) = self.state.parameters.usage();
        rmp_serde::to_vec_named(&(
            NATIVE_BUILD_FINGERPRINT,
            self.state.session_epoch.to_string(),
            (
                normal_pending,
                priority_pending,
                OUTBOUND_CAPACITY,
                self.state.request_timeouts.load(Ordering::Relaxed),
            ),
            (
                outstanding_leases,
                outstanding_lease_bytes,
                MAX_OUTSTANDING_LEASES,
                MAX_OUTSTANDING_LEASE_BYTES,
                self.state
                    .transport_traffic
                    .inline_packets
                    .load(Ordering::Relaxed),
                self.state
                    .transport_traffic
                    .inline_bytes
                    .load(Ordering::Relaxed),
                self.state
                    .transport_traffic
                    .shared_packets
                    .load(Ordering::Relaxed),
                self.state
                    .transport_traffic
                    .shared_regions
                    .load(Ordering::Relaxed),
                self.state
                    .transport_traffic
                    .shared_bytes
                    .load(Ordering::Relaxed),
            ),
            event_queue_depth,
            (
                telemetry_epoch.to_string(),
                telemetry_capacity,
                telemetry.graph_revision,
                telemetry.callback_generation,
                telemetry.meters.len(),
                self.state.telemetry_fallback_reads.load(Ordering::Relaxed),
            ),
            (
                parameter_ring_used,
                parameter_ring_capacity,
                self.state.parameter_soft_full.load(Ordering::Relaxed),
                self.state.parameter_hard_full.load(Ordering::Relaxed),
                self.state
                    .parameter_boundary_fallbacks
                    .load(Ordering::Relaxed),
                self.state.parameter_stale_epoch.load(Ordering::Relaxed),
            ),
            self.state.closing.load(Ordering::Acquire),
            (
                self.state.runtime_config.worker_threads,
                self.state.runtime_config.max_blocking_threads,
                self.state.runtime_config.egress_concurrency,
                arena_diagnostics.region_count,
                arena_diagnostics.capacity_bytes,
                arena_diagnostics.used_bytes,
                arena_diagnostics.high_water_bytes,
                arena_diagnostics.offers,
                arena_diagnostics.busy,
                arena_diagnostics.quarantined_regions,
                arena_diagnostics.copied_bytes,
            ),
        ))
        .map(Buffer::from)
        .map_err(|error| failure("could not encode transport diagnostics", error))
    }

    #[napi(getter)]
    pub fn session_epoch(&self) -> i64 {
        self.state.session_epoch as i64
    }

    #[napi(getter)]
    pub fn helper_epoch(&self) -> String {
        self.state.session_epoch.to_string()
    }

    #[napi]
    pub fn drain_events(&self) -> Result<Vec<Buffer>> {
        let mut events = self
            .state
            .events
            .lock()
            .map_err(|_| failure("audio-host event queue", "poisoned"))?;
        Ok(events.drain(..).map(Buffer::from).collect())
    }

    #[napi]
    pub fn close(&self) -> Result<()> {
        close_state(&self.state)
    }
}
