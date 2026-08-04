use super::*;

struct TestIngress {
    requests: Option<ipc_channel::ipc::IpcSender<WirePacket>>,
    priority_requests: Option<ipc_channel::ipc::IpcSender<WirePacket>>,
    priority_responses: ipc_channel::ipc::IpcReceiver<WirePacket>,
    inbound_sender: mpsc::Sender<InboundRequest>,
    inbound: mpsc::Receiver<InboundRequest>,
    priority_sender: mpsc::Sender<PriorityIngress>,
    priority: mpsc::Receiver<PriorityIngress>,
    outbound: mpsc::Receiver<OutboundMessage>,
    handle: Option<thread::JoinHandle<()>>,
}

impl TestIngress {
    fn new(capacity: usize) -> Self {
        let (requests, request_receiver) = ipc::channel().expect("request IPC channel");
        let (priority_requests, priority_request_receiver) =
            ipc::channel().expect("priority request IPC channel");
        let (priority_response_sender, priority_responses) =
            ipc::channel().expect("priority response IPC channel");
        let (inbound_sender, inbound) = mpsc::channel(capacity);
        let (priority_sender, priority) = mpsc::channel(capacity);
        let (outbound_sender, outbound) = mpsc::channel(capacity);
        let audio_engine = Arc::new(engine::AudioEngine::new());
        let metrics = Arc::new(EgressMetrics::default());
        let handle = spawn_ingress(
            IngressChannels {
                requests: request_receiver,
                priority_requests: priority_request_receiver,
                priority_responses: priority_response_sender,
            },
            IngressMailboxes {
                inbound: inbound_sender.clone(),
                priority: priority_sender.clone(),
                outbound: outbound_sender,
            },
            Arc::new(Mutex::new(LeaseRegistry::with_session_epoch(1))),
            Arc::new(Mutex::new(ArenaReceiver::new(1))),
            Liveness {
                audio_engine,
                ipc: Arc::new(AtomicU64::new(0)),
                tokio: Arc::new(AtomicU64::new(0)),
                winit: Arc::new(AtomicU64::new(0)),
                egress: metrics,
            },
        )
        .expect("spawn ingress");
        Self {
            requests: Some(requests),
            priority_requests: Some(priority_requests),
            priority_responses,
            inbound_sender,
            inbound,
            priority_sender,
            priority,
            outbound,
            handle: Some(handle),
        }
    }

    fn send_request(&self, request: ControlRequest) {
        let mut leases = LeaseRegistry::with_session_epoch(1);
        let packet =
            heron_ipc_transport::encode_request(request, &mut leases).expect("encode request");
        self.requests
            .as_ref()
            .expect("request sender")
            .send(packet)
            .expect("send request");
    }

    fn send_priority(&self, request: PriorityRequest) {
        let packet = encode_priority(&request).expect("encode priority request");
        self.priority_requests
            .as_ref()
            .expect("priority request sender")
            .send(packet)
            .expect("send priority request");
    }

    fn receive_priority_response(&self) -> PriorityResponse {
        let packet = self
            .priority_responses
            .try_recv_timeout(Duration::from_secs(2))
            .expect("priority response");
        decode_body(&packet.body).expect("decode priority response")
    }
}

impl Drop for TestIngress {
    fn drop(&mut self) {
        self.requests.take();
        self.priority_requests.take();
        if let Some(handle) = self.handle.take() {
            handle.join().expect("ingress thread should stop cleanly");
        }
    }
}

fn parameter_command(
    target_kind: heron_dsp_runtime::protocol::ParameterTargetKind,
    runtime_handle: u32,
    parameter_id: u32,
    normalized: f64,
) -> heron_dsp_runtime::protocol::ParameterCommand {
    heron_dsp_runtime::protocol::ParameterCommand {
        session_epoch: 1,
        sequence: 1,
        target_kind,
        runtime_handle,
        parameter_id,
        target_generation: 1,
        normalized,
        gesture: heron_dsp_runtime::protocol::ParameterGesture::Perform,
    }
}

async fn receive_ipc_packet(
    receiver: Arc<Mutex<ipc_channel::ipc::IpcReceiver<WirePacket>>>,
) -> WirePacket {
    tokio::task::spawn_blocking(move || {
        receiver
            .lock()
            .expect("IPC receiver lock")
            .try_recv_timeout(Duration::from_secs(2))
            .expect("IPC packet")
    })
    .await
    .expect("IPC receiver task")
}

fn graph_meta(epoch: &str, expected_revision: u64) -> RpcRequestMeta {
    RpcRequestMeta {
        protocol_version: IPC_PROTOCOL_VERSION,
        request_id: "request-1".to_owned(),
        target: Some(ResourceRef {
            kind: ResourceKind::AudioEngine,
            id: "engine".to_owned(),
            epoch: epoch.to_owned(),
            generation: 1,
        }),
        expected_revision: Some(expected_revision),
        mutation: Some(heron_dsp_runtime::protocol::RpcMutationMeta {
            operation_id: "operation-1".to_owned(),
            idempotency_key: "graph-1".to_owned(),
        }),
    }
}

fn graph_request(helper_epoch: &str, base_revision: u64) -> GraphTransactionRequest {
    GraphTransactionRequest {
        helper_epoch: helper_epoch.to_owned(),
        project_graph: ResourceRef {
            kind: ResourceKind::ProjectGraph,
            id: "project-graph".to_owned(),
            epoch: "main-epoch".to_owned(),
            generation: 4,
        },
        base_revision,
    }
}

fn engine_ref(epoch: &str, generation: u32) -> ResourceRef {
    ResourceRef {
        kind: ResourceKind::AudioEngine,
        id: "engine".to_owned(),
        epoch: epoch.to_owned(),
        generation,
    }
}

fn empty_live_graph() -> LiveMixerGraph {
    LiveMixerGraph {
        sample_rate: 48_000,
        latency_policy: LiveLatencyPolicy::Normal,
        channels: vec![],
        sends: vec![],
        clips: vec![],
        plugins: vec![],
        midi_clips: vec![],
        tempo_events: vec![],
        time_signature_events: vec![],
    }
}

fn mixer_parameter_graph() -> LiveMixerGraph {
    use heron_dsp_runtime::protocol::{LiveMixerChannel, LiveMixerSend, LiveMixerSendTap};
    LiveMixerGraph {
        channels: vec![LiveMixerChannel {
            id: "channel-1".into(),
            name: "Channel 1".into(),
            color: String::new(),
            kind: "audio".into(),
            system_role: None,
            gain_db: 0.0,
            pan: 0.0,
            muted: false,
            soloed: false,
            output_channel_id: None,
            output_bus: None,
            record_armed: false,
            input_monitoring: false,
            midi_input_port_id: None,
            midi_input_port_name: None,
            midi_input_channel: None,
            input_source: None,
            input_channels: Vec::new(),
            hardware_output_channels: Vec::new(),
        }],
        sends: vec![LiveMixerSend {
            id: "send-1".into(),
            source_channel_id: "channel-1".into(),
            target_channel_id: None,
            target_bus: None,
            enabled: true,
            tap: LiveMixerSendTap::Post,
            level_db: 0.0,
        }],
        ..empty_live_graph()
    }
}

fn minimal_native_graph(generation: u64) -> engine::NativeMixerGraph {
    use engine::NativeMixerChannel;
    use heron_dsp_runtime::tempo::{TempoEvent, TimeSignatureEvent};
    engine::NativeMixerGraph {
        generation,
        sample_rate: 48_000,
        latency_policy: engine::NativeLatencyPolicy::Normal,
        channels: vec![
            NativeMixerChannel {
                id: "audio".into(),
                name: "Audio".into(),
                color: String::new(),
                kind: "audio".into(),
                system_role: None,
                gain_db: 0.0,
                pan: 0.0,
                muted: false,
                soloed: false,
                output_index: Some(2),
                output_bus: None,
                record_armed: false,
                input_monitoring: false,
                input_source: Some("hardware".into()),
                input_channels: vec![1, 2],
                hardware_output_channels: vec![],
                midi_input_port_id: None,
                midi_input_channel: None,
            },
            NativeMixerChannel {
                id: "master".into(),
                name: "Master".into(),
                color: String::new(),
                kind: "master".into(),
                system_role: None,
                gain_db: 0.0,
                pan: 0.0,
                muted: false,
                soloed: false,
                output_index: None,
                output_bus: None,
                record_armed: false,
                input_monitoring: false,
                input_source: None,
                input_channels: vec![],
                hardware_output_channels: vec![],
                midi_input_port_id: None,
                midi_input_channel: None,
            },
            NativeMixerChannel {
                id: "output".into(),
                name: "Output".into(),
                color: String::new(),
                kind: "output".into(),
                system_role: None,
                gain_db: 0.0,
                pan: 0.0,
                muted: false,
                soloed: false,
                output_index: None,
                output_bus: None,
                record_armed: false,
                input_monitoring: false,
                input_source: None,
                input_channels: vec![],
                hardware_output_channels: vec![1, 2],
                midi_input_port_id: None,
                midi_input_channel: None,
            },
        ],
        sends: vec![],
        clips: vec![],
        plugins: vec![],
        midi_clips: vec![],
        tempo_events: vec![TempoEvent {
            tick: 0,
            beats_per_minute: 120.0,
        }],
        time_signature_events: vec![TimeSignatureEvent {
            tick: 0,
            numerator: 4,
            denominator: 4,
        }],
    }
}

fn prepared_candidate(
    operation_id: &str,
    project_graph: ResourceRef,
    base_revision: u64,
    graph_revision: u64,
) -> PreparedGraphCandidate {
    let audio_engine = engine::AudioEngine::new();
    let input = audio_engine
        .begin_graph_build(minimal_native_graph(graph_revision))
        .expect("begin graph build for transaction fixture");
    let built = engine::compile_graph_build(input).expect("compile graph build fixture");
    PreparedGraphCandidate {
        operation_id: operation_id.to_owned(),
        project_graph,
        base_revision,
        graph_revision,
        graph: empty_live_graph(),
        built,
    }
}

#[path = "tests/graph_transactions.rs"]
mod graph_transactions;
#[path = "tests/protocol.rs"]
mod protocol;
#[path = "tests/ui.rs"]
mod ui;
