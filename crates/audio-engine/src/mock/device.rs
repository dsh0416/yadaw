use super::{
    Arc, BACKEND_LABEL, BufferSize, CHANNELS, DEFAULT_BUFFER_FRAMES, Data, DeviceDescription,
    DeviceDescriptionBuilder, DeviceDirection, DeviceId, DeviceTrait, DeviceType, Duration, Error,
    ErrorKind, FrameCount, Hash, Hasher, HeapCons, HeapProd, HeapRb, HostId, HostTrait,
    InputCallbackInfo, Instant, InterfaceType, LOOPBACK_CAPACITY_FRAMES, LoopbackFrame,
    MAX_BUFFER_FRAMES, MIN_BUFFER_FRAMES, MockStream, Mutex, OutputCallbackInfo, SAMPLE_FORMAT,
    SAMPLE_RATE, SampleFormat, Split, StreamConfig, SupportedBufferSize, SupportedStreamConfig,
    SupportedStreamConfigRange, fmt,
};

/// The mock devices the host enumerates.
///
/// A duplex device is offered so the common case matches a real audio
/// interface and reports a shared clock, while the dedicated capture and
/// playback devices allow exercising the engine's split-device resampling path.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(super) enum MockDeviceKind {
    Duplex,
    Input,
    Output,
}

impl MockDeviceKind {
    const ALL: [Self; 3] = [Self::Duplex, Self::Input, Self::Output];

    fn id(self) -> &'static str {
        match self {
            Self::Duplex => "mock-duplex",
            Self::Input => "mock-input",
            Self::Output => "mock-output",
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Duplex => "Mock Duplex",
            Self::Input => "Mock Input",
            Self::Output => "Mock Output",
        }
    }

    fn captures(self) -> bool {
        matches!(self, Self::Duplex | Self::Input)
    }

    fn plays(self) -> bool {
        matches!(self, Self::Duplex | Self::Output)
    }

    fn direction(self) -> DeviceDirection {
        match self {
            Self::Duplex => DeviceDirection::Duplex,
            Self::Input => DeviceDirection::Input,
            Self::Output => DeviceDirection::Output,
        }
    }

    fn device_type(self) -> DeviceType {
        match self {
            Self::Duplex | Self::Output => DeviceType::Virtual,
            Self::Input => DeviceType::Microphone,
        }
    }
}

/// State shared by every device and stream of a single mock host.
pub(super) struct MockBackend {
    /// The time base shared by all streams, so their timestamps are comparable.
    pub(super) origin: Instant,
    loopback: Mutex<LoopbackEnds>,
}

/// The two halves of the playback-to-capture loopback.
///
/// Each half is claimed at most once, by the first stream that needs it. The
/// mutex is only taken while building a stream, never from a stream worker.
struct LoopbackEnds {
    producer: Option<HeapProd<LoopbackFrame>>,
    consumer: Option<HeapCons<LoopbackFrame>>,
}

impl MockBackend {
    pub(super) fn new() -> Self {
        let (producer, consumer) = HeapRb::<LoopbackFrame>::new(LOOPBACK_CAPACITY_FRAMES).split();
        Self {
            origin: Instant::now(),
            loopback: Mutex::new(LoopbackEnds {
                producer: Some(producer),
                consumer: Some(consumer),
            }),
        }
    }

    pub(super) fn claim_loopback_producer(&self) -> Option<HeapProd<LoopbackFrame>> {
        self.loopback
            .lock()
            .ok()
            .and_then(|mut ends| ends.producer.take())
    }

    pub(super) fn claim_loopback_consumer(&self) -> Option<HeapCons<LoopbackFrame>> {
        self.loopback
            .lock()
            .ok()
            .and_then(|mut ends| ends.consumer.take())
    }
}

/// A cpal host that enumerates the mock devices.
#[derive(Clone)]
pub(super) struct MockHost {
    backend: Arc<MockBackend>,
}

impl MockHost {
    pub(super) fn new() -> Self {
        Self {
            backend: Arc::new(MockBackend::new()),
        }
    }

    pub(super) fn device(&self, kind: MockDeviceKind) -> MockDevice {
        MockDevice {
            kind,
            backend: Arc::clone(&self.backend),
        }
    }
}

impl HostTrait for MockHost {
    type Device = MockDevice;
    type Devices = std::vec::IntoIter<MockDevice>;

    fn is_available() -> bool {
        true
    }

    fn devices(&self) -> Result<Self::Devices, Error> {
        Ok(MockDeviceKind::ALL
            .iter()
            .map(|kind| self.device(*kind))
            .collect::<Vec<_>>()
            .into_iter())
    }

    fn default_input_device(&self) -> Option<Self::Device> {
        Some(self.device(MockDeviceKind::Duplex))
    }

    fn default_output_device(&self) -> Option<Self::Device> {
        Some(self.device(MockDeviceKind::Duplex))
    }
}

/// A mock capture and/or playback device.
#[derive(Clone)]
pub(super) struct MockDevice {
    kind: MockDeviceKind,
    backend: Arc<MockBackend>,
}

impl PartialEq for MockDevice {
    fn eq(&self, other: &Self) -> bool {
        self.kind == other.kind
    }
}

impl Eq for MockDevice {}

impl Hash for MockDevice {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.kind.hash(state);
    }
}

impl fmt::Debug for MockDevice {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MockDevice")
            .field("kind", &self.kind)
            .finish_non_exhaustive()
    }
}

impl fmt::Display for MockDevice {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.kind.name())
    }
}

fn supported_buffer_size() -> SupportedBufferSize {
    SupportedBufferSize::Range {
        min: MIN_BUFFER_FRAMES,
        max: MAX_BUFFER_FRAMES,
    }
}

fn supported_configs(available: bool) -> Vec<SupportedStreamConfigRange> {
    if !available {
        return Vec::new();
    }
    vec![SupportedStreamConfigRange::new(
        CHANNELS,
        SAMPLE_RATE,
        SAMPLE_RATE,
        supported_buffer_size(),
        SAMPLE_FORMAT,
    )]
}

fn default_config() -> SupportedStreamConfig {
    SupportedStreamConfig::new(
        CHANNELS,
        SAMPLE_RATE,
        supported_buffer_size(),
        SAMPLE_FORMAT,
    )
}

fn unsupported_direction(kind: MockDeviceKind, capture: bool) -> Error {
    let direction = if capture { "capture" } else { "playback" };
    Error::with_message(
        ErrorKind::UnsupportedOperation,
        format!("the {} device does not support {direction}", kind.name()),
    )
}

impl DeviceTrait for MockDevice {
    type SupportedInputConfigs = std::vec::IntoIter<SupportedStreamConfigRange>;
    type SupportedOutputConfigs = std::vec::IntoIter<SupportedStreamConfigRange>;
    type Stream = MockStream;

    fn description(&self) -> Result<DeviceDescription, Error> {
        Ok(DeviceDescriptionBuilder::new(self.kind.name())
            .manufacturer("Heron")
            .driver(BACKEND_LABEL)
            .device_type(self.kind.device_type())
            .interface_type(InterfaceType::Virtual)
            .direction(self.kind.direction())
            .add_extended_line("Playback is discarded and looped back into capture")
            .build())
    }

    fn id(&self) -> Result<DeviceId, Error> {
        Ok(DeviceId::new(HostId::Custom, self.kind.id()))
    }

    fn supported_input_configs(&self) -> Result<Self::SupportedInputConfigs, Error> {
        Ok(supported_configs(self.kind.captures()).into_iter())
    }

    fn supported_output_configs(&self) -> Result<Self::SupportedOutputConfigs, Error> {
        Ok(supported_configs(self.kind.plays()).into_iter())
    }

    fn default_input_config(&self) -> Result<SupportedStreamConfig, Error> {
        if !self.kind.captures() {
            return Err(unsupported_direction(self.kind, true));
        }
        Ok(default_config())
    }

    fn default_output_config(&self) -> Result<SupportedStreamConfig, Error> {
        if !self.kind.plays() {
            return Err(unsupported_direction(self.kind, false));
        }
        Ok(default_config())
    }

    fn build_input_stream_raw<D, E>(
        &self,
        config: StreamConfig,
        sample_format: SampleFormat,
        data_callback: D,
        _error_callback: E,
        _timeout: Option<Duration>,
    ) -> Result<Self::Stream, Error>
    where
        D: FnMut(&Data, &InputCallbackInfo) + Send + 'static,
        E: FnMut(Error) + Send + 'static,
    {
        if !self.kind.captures() {
            return Err(unsupported_direction(self.kind, true));
        }
        let frames = negotiate_frames(&config, sample_format)?;
        MockStream::capture(
            &self.backend,
            frames,
            usize::from(config.channels),
            data_callback,
        )
    }

    fn build_output_stream_raw<D, E>(
        &self,
        config: StreamConfig,
        sample_format: SampleFormat,
        data_callback: D,
        _error_callback: E,
        _timeout: Option<Duration>,
    ) -> Result<Self::Stream, Error>
    where
        D: FnMut(&mut Data, &OutputCallbackInfo) + Send + 'static,
        E: FnMut(Error) + Send + 'static,
    {
        if !self.kind.plays() {
            return Err(unsupported_direction(self.kind, false));
        }
        let frames = negotiate_frames(&config, sample_format)?;
        MockStream::playback(
            &self.backend,
            frames,
            usize::from(config.channels),
            data_callback,
        )
    }
}

/// Validates a requested stream configuration and resolves the block size.
///
/// The mock devices advertise a single configuration, so anything the engine
/// could not have taken from [`default_config`] is rejected the same way a real
/// backend would reject an unsupported format. Because the devices report a
/// buffer range, the engine always asks for a fixed size inside it;
/// [`BufferSize::Default`] resolves to the devices' own default block size for
/// any other cpal caller.
pub(super) fn negotiate_frames(
    config: &StreamConfig,
    sample_format: SampleFormat,
) -> Result<FrameCount, Error> {
    if sample_format != SAMPLE_FORMAT {
        return Err(Error::with_message(
            ErrorKind::UnsupportedConfig,
            format!("the mock audio backend only supports {SAMPLE_FORMAT} samples"),
        ));
    }
    if config.channels != CHANNELS {
        return Err(Error::with_message(
            ErrorKind::UnsupportedConfig,
            format!("the mock audio backend only supports {CHANNELS} channels"),
        ));
    }
    if config.sample_rate != SAMPLE_RATE {
        return Err(Error::with_message(
            ErrorKind::UnsupportedConfig,
            format!("the mock audio backend only runs at {SAMPLE_RATE} Hz"),
        ));
    }
    match config.buffer_size {
        BufferSize::Default => Ok(DEFAULT_BUFFER_FRAMES),
        BufferSize::Fixed(frames) if (MIN_BUFFER_FRAMES..=MAX_BUFFER_FRAMES).contains(&frames) => {
            Ok(frames)
        }
        BufferSize::Fixed(frames) => Err(Error::with_message(
            ErrorKind::UnsupportedConfig,
            format!(
                "the mock audio backend supports {MIN_BUFFER_FRAMES} to {MAX_BUFFER_FRAMES} \
                 frames per callback, not {frames}"
            ),
        )),
    }
}
