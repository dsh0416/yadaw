use std::{collections::VecDeque, error::Error, fmt};

pub type StereoFrame = [f32; 2];
pub const MAX_BUS_CHANNELS: usize = 256;
pub const MAX_OUTPUT_CHANNELS: usize = 32;
pub type HardwareOutputFrame = [f32; MAX_OUTPUT_CHANNELS];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChannelKind {
    Audio,
    Instrument,
    Aux,
    Master,
    Output,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SendTap {
    Pre,
    Post,
    PostPan,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RouteTarget {
    Bus(usize),
    Output(usize),
}

#[derive(Debug, Clone)]
pub struct ChannelSpec {
    pub id: String,
    pub kind: ChannelKind,
    pub gain_db: f32,
    pub pan: f32,
    pub muted: bool,
    pub soloed: bool,
    pub output: Option<RouteTarget>,
    pub input_bus: Option<[usize; 2]>,
    pub hardware_output: Option<[usize; 2]>,
}

#[derive(Debug, Clone)]
pub struct SendSpec {
    pub id: String,
    pub source: usize,
    pub target: RouteTarget,
    pub enabled: bool,
    pub tap: SendTap,
    pub level_db: f32,
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct ChannelPeak {
    pub pre: StereoFrame,
    pub post: StereoFrame,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GraphError {
    MissingMaster,
    MultipleMasters,
    MissingOutput,
    InvalidOutput,
    InvalidSend,
    RoutingCycle,
    InvalidParameter,
}

impl fmt::Display for GraphError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::MissingMaster => "mixer graph requires one master channel",
            Self::MultipleMasters => "mixer graph contains more than one master channel",
            Self::MissingOutput => "mixer graph requires at least one hardware output channel",
            Self::InvalidOutput => "mixer channel has an invalid output",
            Self::InvalidSend => "mixer send has an invalid source or target",
            Self::RoutingCycle => "mixer routing must not contain a cycle",
            Self::InvalidParameter => "mixer parameter is outside its supported range",
        })
    }
}

impl Error for GraphError {}

#[derive(Debug, Clone, Copy)]
struct SmoothedValue {
    current: f32,
    target: f32,
    coefficient: f32,
}

impl SmoothedValue {
    fn new(value: f32, sample_rate: u32) -> Self {
        let smoothing_frames = (sample_rate as f32 * 0.010).max(1.0);
        Self {
            current: value,
            target: value,
            coefficient: 1.0 / smoothing_frames,
        }
    }

    fn set_target(&mut self, value: f32) {
        self.target = value;
    }

    fn next(&mut self) -> f32 {
        self.current += (self.target - self.current) * self.coefficient;
        if (self.current - self.target).abs() < 1.0e-6 {
            self.current = self.target;
        }
        self.current
    }
}

#[derive(Debug, Clone)]
struct ChannelRuntime {
    gain: SmoothedValue,
    pan: SmoothedValue,
    output_delay: StereoDelay,
}

#[derive(Debug, Clone)]
struct SendRuntime {
    gain: SmoothedValue,
    delay: StereoDelay,
}

#[derive(Debug, Clone, Default)]
struct StereoDelay {
    frames: Vec<StereoFrame>,
    cursor: usize,
}

impl StereoDelay {
    fn set_frames(&mut self, frames: usize) {
        self.frames = vec![[0.0; 2]; frames];
        self.cursor = 0;
    }

    fn process(&mut self, input: StereoFrame) -> StereoFrame {
        if self.frames.is_empty() {
            return input;
        }
        let output = self.frames[self.cursor];
        self.frames[self.cursor] = input;
        self.cursor += 1;
        if self.cursor == self.frames.len() {
            self.cursor = 0;
        }
        output
    }

    fn clear(&mut self) {
        self.frames.fill([0.0; 2]);
        self.cursor = 0;
    }
}

pub struct MixerGraph {
    channels: Vec<ChannelSpec>,
    sends: Vec<SendSpec>,
    order: Vec<usize>,
    audible: Vec<bool>,
    output_audible: Vec<bool>,
    send_audible: Vec<bool>,
    channel_runtime: Vec<ChannelRuntime>,
    send_runtime: Vec<SendRuntime>,
    accumulation: Vec<StereoFrame>,
    bus_accumulation: [f32; MAX_BUS_CHANNELS],
    peaks: Vec<ChannelPeak>,
    sends_by_source: Vec<Vec<usize>>,
    master: usize,
}

fn db_to_gain(db: f32) -> f32 {
    if db <= -90.0 {
        0.0
    } else {
        10.0_f32.powf(db / 20.0)
    }
}

fn valid_db(value: f32) -> bool {
    value.is_finite() && (-90.0..=12.0).contains(&value)
}

fn valid_pan(value: f32) -> bool {
    value.is_finite() && (-1.0..=1.0).contains(&value)
}

pub fn pan_mono(sample: f32, pan: f32) -> StereoFrame {
    let angle = (pan.clamp(-1.0, 1.0) + 1.0) * std::f32::consts::FRAC_PI_4;
    [sample * angle.cos(), sample * angle.sin()]
}

pub fn balance_stereo(frame: StereoFrame, pan: f32) -> StereoFrame {
    let pan = pan.clamp(-1.0, 1.0);
    [
        frame[0] * (1.0 - pan).min(1.0),
        frame[1] * (1.0 + pan).min(1.0),
    ]
}

fn add(target: &mut StereoFrame, source: StereoFrame) {
    target[0] += source[0];
    target[1] += source[1];
}

fn scale(frame: StereoFrame, gain: f32) -> StereoFrame {
    [frame[0] * gain, frame[1] * gain]
}

fn graph_edges(
    channels: &[ChannelSpec],
    sends: &[SendSpec],
) -> Result<Vec<Vec<usize>>, GraphError> {
    let mut edges = vec![Vec::new(); channels.len()];
    for (index, channel) in channels.iter().enumerate() {
        match (channel.kind, channel.output) {
            (ChannelKind::Master | ChannelKind::Output, None) => {}
            (ChannelKind::Master | ChannelKind::Output, Some(_)) | (_, None) => {
                return Err(GraphError::InvalidOutput);
            }
            (_, Some(RouteTarget::Output(output)))
                if output >= channels.len()
                    || output == index
                    || channels[output].kind != ChannelKind::Output =>
            {
                return Err(GraphError::InvalidOutput);
            }
            (_, Some(RouteTarget::Output(output))) => edges[index].push(output),
            (_, Some(RouteTarget::Bus(bus))) if bus >= MAX_BUS_CHANNELS => {
                return Err(GraphError::InvalidOutput);
            }
            (_, Some(RouteTarget::Bus(bus))) => {
                for (target, candidate) in channels.iter().enumerate() {
                    if candidate
                        .input_bus
                        .is_some_and(|inputs| inputs.contains(&bus))
                    {
                        edges[index].push(target);
                    }
                }
            }
        }
    }
    for send in sends {
        if send.source >= channels.len()
            || channels[send.source].kind == ChannelKind::Master
            || channels[send.source].kind == ChannelKind::Output
        {
            return Err(GraphError::InvalidSend);
        }
        match send.target {
            RouteTarget::Bus(bus) if bus >= MAX_BUS_CHANNELS => {
                return Err(GraphError::InvalidSend);
            }
            RouteTarget::Bus(bus) => {
                for (target, channel) in channels.iter().enumerate() {
                    if channel
                        .input_bus
                        .is_some_and(|inputs| inputs.contains(&bus))
                    {
                        edges[send.source].push(target);
                    }
                }
            }
            RouteTarget::Output(output)
                if output >= channels.len()
                    || output == send.source
                    || channels[output].kind != ChannelKind::Output =>
            {
                return Err(GraphError::InvalidSend);
            }
            RouteTarget::Output(output) => edges[send.source].push(output),
        }
    }
    Ok(edges)
}

fn topological_order(edges: &[Vec<usize>]) -> Result<Vec<usize>, GraphError> {
    let mut indegree = vec![0_usize; edges.len()];
    for targets in edges {
        for &target in targets {
            indegree[target] += 1;
        }
    }
    let mut ready: VecDeque<_> = indegree
        .iter()
        .enumerate()
        .filter_map(|(index, &degree)| (degree == 0).then_some(index))
        .collect();
    let mut result = Vec::with_capacity(edges.len());
    while let Some(source) = ready.pop_front() {
        result.push(source);
        for &target in &edges[source] {
            indegree[target] -= 1;
            if indegree[target] == 0 {
                ready.push_back(target);
            }
        }
    }
    if result.len() == edges.len() {
        Ok(result)
    } else {
        Err(GraphError::RoutingCycle)
    }
}

fn solo_audibility(
    channels: &[ChannelSpec],
    edges: &[Vec<usize>],
    sends: &[SendSpec],
) -> (Vec<bool>, Vec<bool>, Vec<bool>) {
    let soloed: Vec<_> = channels
        .iter()
        .enumerate()
        .filter_map(|(index, channel)| {
            (channel.kind != ChannelKind::Master && channel.soloed).then_some(index)
        })
        .collect();
    if soloed.is_empty() {
        return (
            vec![true; channels.len()],
            vec![true; channels.len()],
            vec![true; sends.len()],
        );
    }

    let mut reverse = vec![Vec::new(); channels.len()];
    for (source, targets) in edges.iter().enumerate() {
        for &target in targets {
            reverse[target].push(source);
        }
    }
    let mut upstream = vec![false; channels.len()];
    let mut queue: VecDeque<_> = soloed.iter().copied().collect();
    while let Some(index) = queue.pop_front() {
        if upstream[index] {
            continue;
        }
        upstream[index] = true;
        queue.extend(reverse[index].iter().copied());
    }

    let mut downstream = vec![false; channels.len()];
    queue.extend(soloed);
    while let Some(index) = queue.pop_front() {
        if downstream[index] {
            continue;
        }
        downstream[index] = true;
        queue.extend(edges[index].iter().copied());
    }

    let edge_is_audible = |source: usize, target: usize| {
        (upstream[source] && upstream[target]) || (downstream[source] && downstream[target])
    };
    let audible = upstream
        .iter()
        .zip(&downstream)
        .map(|(upstream, downstream)| *upstream || *downstream)
        .collect();
    let route_is_audible = |source: usize, route: RouteTarget| match route {
        RouteTarget::Output(target) => edge_is_audible(source, target),
        RouteTarget::Bus(bus) => channels.iter().enumerate().any(|(target, channel)| {
            channel
                .input_bus
                .is_some_and(|inputs| inputs.contains(&bus))
                && edge_is_audible(source, target)
        }),
    };
    let output_audible = channels
        .iter()
        .enumerate()
        .map(|(source, channel)| {
            channel
                .output
                .is_none_or(|target| route_is_audible(source, target))
        })
        .collect();
    let send_audible = sends
        .iter()
        .map(|send| route_is_audible(send.source, send.target))
        .collect();
    (audible, output_audible, send_audible)
}

impl MixerGraph {
    pub fn new(
        sample_rate: u32,
        channels: Vec<ChannelSpec>,
        sends: Vec<SendSpec>,
    ) -> Result<Self, GraphError> {
        if sample_rate == 0
            || channels
                .iter()
                .any(|channel| !valid_db(channel.gain_db) || !valid_pan(channel.pan))
            || sends.iter().any(|send| !valid_db(send.level_db))
        {
            return Err(GraphError::InvalidParameter);
        }
        let masters: Vec<_> = channels
            .iter()
            .enumerate()
            .filter_map(|(index, channel)| (channel.kind == ChannelKind::Master).then_some(index))
            .collect();
        let master = match masters.as_slice() {
            [] => return Err(GraphError::MissingMaster),
            [master] => *master,
            _ => return Err(GraphError::MultipleMasters),
        };
        if !channels
            .iter()
            .any(|channel| channel.kind == ChannelKind::Output)
        {
            return Err(GraphError::MissingOutput);
        }
        if channels.iter().any(|channel| match channel.kind {
            ChannelKind::Output => channel.hardware_output.is_none_or(|[left, right]| {
                left >= MAX_OUTPUT_CHANNELS || right >= MAX_OUTPUT_CHANNELS || left == right
            }),
            _ => channel.hardware_output.is_some(),
        }) {
            return Err(GraphError::InvalidOutput);
        }
        if channels.iter().any(|channel| match channel.input_bus {
            Some([left, right]) => {
                (channel.kind != ChannelKind::Audio && channel.kind != ChannelKind::Aux)
                    || left >= MAX_BUS_CHANNELS
                    || right >= MAX_BUS_CHANNELS
            }
            None => false,
        }) {
            return Err(GraphError::InvalidOutput);
        }
        let edges = graph_edges(&channels, &sends)?;
        let order = topological_order(&edges)?;
        let (audible, output_audible, send_audible) = solo_audibility(&channels, &edges, &sends);
        let channel_runtime = channels
            .iter()
            .map(|channel| ChannelRuntime {
                gain: SmoothedValue::new(db_to_gain(channel.gain_db), sample_rate),
                pan: SmoothedValue::new(channel.pan, sample_rate),
                output_delay: StereoDelay::default(),
            })
            .collect();
        let send_runtime = sends
            .iter()
            .map(|send| SendRuntime {
                gain: SmoothedValue::new(db_to_gain(send.level_db), sample_rate),
                delay: StereoDelay::default(),
            })
            .collect();
        let mut sends_by_source = vec![Vec::new(); channels.len()];
        for (index, send) in sends.iter().enumerate() {
            sends_by_source[send.source].push(index);
        }
        Ok(Self {
            accumulation: vec![[0.0, 0.0]; channels.len()],
            bus_accumulation: [0.0; MAX_BUS_CHANNELS],
            peaks: vec![ChannelPeak::default(); channels.len()],
            channels,
            sends,
            order,
            audible,
            output_audible,
            send_audible,
            channel_runtime,
            send_runtime,
            sends_by_source,
            master,
        })
    }

    pub fn channel_count(&self) -> usize {
        self.channels.len()
    }

    pub fn channel_index(&self, id: &str) -> Option<usize> {
        self.channels.iter().position(|channel| channel.id == id)
    }

    pub fn send_index(&self, id: &str) -> Option<usize> {
        self.sends.iter().position(|send| send.id == id)
    }

    pub fn set_channel_gain(&mut self, index: usize, gain_db: f32) -> Result<(), GraphError> {
        if index >= self.channels.len() || !valid_db(gain_db) {
            return Err(GraphError::InvalidParameter);
        }
        self.channels[index].gain_db = gain_db;
        self.channel_runtime[index]
            .gain
            .set_target(db_to_gain(gain_db));
        Ok(())
    }

    pub fn set_channel_pan(&mut self, index: usize, pan: f32) -> Result<(), GraphError> {
        if index >= self.channels.len() || !valid_pan(pan) {
            return Err(GraphError::InvalidParameter);
        }
        self.channels[index].pan = pan;
        self.channel_runtime[index].pan.set_target(pan);
        Ok(())
    }

    pub fn set_send_level(&mut self, index: usize, level_db: f32) -> Result<(), GraphError> {
        if index >= self.sends.len() || !valid_db(level_db) {
            return Err(GraphError::InvalidParameter);
        }
        self.sends[index].level_db = level_db;
        self.send_runtime[index]
            .gain
            .set_target(db_to_gain(level_db));
        Ok(())
    }

    pub fn set_channel_output_delay(
        &mut self,
        index: usize,
        frames: usize,
    ) -> Result<(), GraphError> {
        let Some(runtime) = self.channel_runtime.get_mut(index) else {
            return Err(GraphError::InvalidOutput);
        };
        runtime.output_delay.set_frames(frames);
        Ok(())
    }

    pub fn set_send_delay(&mut self, index: usize, frames: usize) -> Result<(), GraphError> {
        let Some(runtime) = self.send_runtime.get_mut(index) else {
            return Err(GraphError::InvalidSend);
        };
        runtime.delay.set_frames(frames);
        Ok(())
    }

    pub fn clear_delays(&mut self) {
        for runtime in &mut self.channel_runtime {
            runtime.output_delay.clear();
        }
        for runtime in &mut self.send_runtime {
            runtime.delay.clear();
        }
    }

    pub fn process_frame(&mut self, audio_inputs: &[StereoFrame]) -> HardwareOutputFrame {
        self.accumulation.fill([0.0, 0.0]);
        self.bus_accumulation.fill(0.0);
        for (input_index, channel_index) in self
            .channels
            .iter()
            .enumerate()
            .filter_map(|(index, channel)| (channel.kind == ChannelKind::Audio).then_some(index))
            .enumerate()
        {
            if let Some(input) = audio_inputs.get(input_index) {
                self.accumulation[channel_index] = *input;
            }
        }
        self.process_accumulated(&mut |_, frame| frame)
    }

    pub fn process_frame_with_sources(
        &mut self,
        channel_sources: &[StereoFrame],
        processor: &mut impl FnMut(usize, StereoFrame) -> StereoFrame,
    ) -> HardwareOutputFrame {
        self.accumulation.fill([0.0, 0.0]);
        self.bus_accumulation.fill(0.0);
        for (target, source) in self.accumulation.iter_mut().zip(channel_sources) {
            *target = *source;
        }
        self.process_accumulated(processor)
    }

    fn process_accumulated(
        &mut self,
        processor: &mut impl FnMut(usize, StereoFrame) -> StereoFrame,
    ) -> HardwareOutputFrame {
        let mut hardware_output = [0.0; MAX_OUTPUT_CHANNELS];
        let master = &self.channels[self.master];
        let master_gate = if master.muted { 0.0 } else { 1.0 };
        let master_gain = self.channel_runtime[self.master].gain.next() * master_gate;
        let master_pan = self.channel_runtime[self.master].pan.next();
        let mut master_pre = [0.0_f32, 0.0_f32];
        let mut master_post = [0.0_f32, 0.0_f32];

        for &index in &self.order {
            if index == self.master {
                continue;
            }
            let channel = &self.channels[index];
            if let Some([left, right]) = channel.input_bus {
                self.accumulation[index][0] += self.bus_accumulation[left];
                self.accumulation[index][1] += self.bus_accumulation[right];
            }
            let pre = processor(index, self.accumulation[index]);
            self.peaks[index].pre = [
                self.peaks[index].pre[0].max(pre[0].abs()),
                self.peaks[index].pre[1].max(pre[1].abs()),
            ];
            let gate = if channel.muted || !self.audible[index] {
                0.0
            } else {
                1.0
            };
            let post_fader = scale(pre, self.channel_runtime[index].gain.next() * gate);
            let post = balance_stereo(post_fader, self.channel_runtime[index].pan.next());

            for &send_index in &self.sends_by_source[index] {
                let send = &self.sends[send_index];
                if !send.enabled || !self.send_audible[send_index] {
                    continue;
                }
                let tap = match send.tap {
                    SendTap::Pre => pre,
                    SendTap::Post => post_fader,
                    SendTap::PostPan => post,
                };
                let sent = scale(tap, self.send_runtime[send_index].gain.next());
                let sent = self.send_runtime[send_index].delay.process(sent);
                match send.target {
                    RouteTarget::Bus(bus) => {
                        self.bus_accumulation[bus] += (sent[0] + sent[1]) * 0.5;
                    }
                    RouteTarget::Output(output) => add(&mut self.accumulation[output], sent),
                }
            }

            self.peaks[index].post = [
                self.peaks[index].post[0].max(post[0].abs()),
                self.peaks[index].post[1].max(post[1].abs()),
            ];
            if let Some(output) = channel.output.filter(|_| self.output_audible[index]) {
                let routed = self.channel_runtime[index].output_delay.process(post);
                match output {
                    RouteTarget::Bus(bus) => {
                        self.bus_accumulation[bus] += (routed[0] + routed[1]) * 0.5;
                    }
                    RouteTarget::Output(output) => add(&mut self.accumulation[output], routed),
                }
            }
            if let Some([left, right]) = channel.hardware_output {
                master_pre[0] = master_pre[0].max(post[0].abs());
                master_pre[1] = master_pre[1].max(post[1].abs());
                let mastered = balance_stereo(scale(post, master_gain), master_pan);
                master_post[0] = master_post[0].max(mastered[0].abs());
                master_post[1] = master_post[1].max(mastered[1].abs());
                hardware_output[left] += mastered[0];
                hardware_output[right] += mastered[1];
            }
        }
        self.peaks[self.master].pre = [
            self.peaks[self.master].pre[0].max(master_pre[0]),
            self.peaks[self.master].pre[1].max(master_pre[1]),
        ];
        self.peaks[self.master].post = [
            self.peaks[self.master].post[0].max(master_post[0]),
            self.peaks[self.master].post[1].max(master_post[1]),
        ];
        hardware_output
    }

    pub fn write_peaks(&mut self, target: &mut [ChannelPeak]) {
        for (target, peak) in target.iter_mut().zip(&self.peaks) {
            *target = *peak;
        }
        self.peaks.fill(ChannelPeak::default());
    }
}

#[cfg(test)]
mod tests {
    use super::{
        ChannelKind, ChannelSpec, GraphError, MixerGraph, RouteTarget, SendSpec, SendTap,
        balance_stereo, pan_mono,
    };

    fn channel(id: &str, kind: ChannelKind, output: Option<usize>) -> ChannelSpec {
        ChannelSpec {
            id: id.to_owned(),
            kind,
            gain_db: 0.0,
            pan: 0.0,
            muted: false,
            soloed: false,
            output: output.map(RouteTarget::Output),
            input_bus: (kind == ChannelKind::Aux).then_some([0, 0]),
            hardware_output: (kind == ChannelKind::Output).then_some([0, 1]),
        }
    }

    fn rendered(graph: &mut MixerGraph, inputs: &[super::StereoFrame]) -> super::StereoFrame {
        let output = graph.process_frame(inputs);
        [output[0], output[1]]
    }

    #[test]
    fn mono_pan_is_equal_power() {
        let center = pan_mono(1.0, 0.0);
        assert!((center[0] - std::f32::consts::FRAC_1_SQRT_2).abs() < 1.0e-6);
        assert!((center[1] - std::f32::consts::FRAC_1_SQRT_2).abs() < 1.0e-6);
        assert_eq!(pan_mono(1.0, -1.0), [1.0, 0.0]);
    }

    #[test]
    fn stereo_pan_behaves_as_balance() {
        assert_eq!(balance_stereo([0.25, 0.5], -1.0), [0.25, 0.0]);
        assert_eq!(balance_stereo([0.25, 0.5], 1.0), [0.0, 0.5]);
    }

    #[test]
    fn renders_independent_stereo_pairs_to_multiple_hardware_outputs() {
        let mut second_output = channel("headphones", ChannelKind::Output, None);
        second_output.hardware_output = Some([2, 3]);
        let channels = vec![
            channel("speakers-track", ChannelKind::Audio, Some(3)),
            channel("headphones-track", ChannelKind::Audio, Some(4)),
            channel("master", ChannelKind::Master, None),
            channel("speakers", ChannelKind::Output, None),
            second_output,
        ];
        let mut graph = MixerGraph::new(48_000, channels, vec![]).unwrap();

        let output = graph.process_frame(&[[0.25, 0.5], [0.75, 1.0]]);

        assert_eq!(&output[..4], &[0.25, 0.5, 0.75, 1.0]);
    }

    #[test]
    fn master_is_an_unrouted_global_output_control() {
        let mut master = channel("master", ChannelKind::Master, None);
        master.muted = true;
        let channels = vec![
            channel("audio", ChannelKind::Audio, Some(2)),
            master,
            channel("speakers", ChannelKind::Output, None),
        ];
        let mut graph = MixerGraph::new(48_000, channels, vec![]).unwrap();

        assert_eq!(rendered(&mut graph, &[[1.0, 0.5]]), [0.0, 0.0]);

        let invalid_channels = vec![
            channel("audio", ChannelKind::Audio, Some(1)),
            channel("master", ChannelKind::Master, None),
            channel("speakers", ChannelKind::Output, None),
        ];
        assert!(matches!(
            MixerGraph::new(48_000, invalid_channels, vec![]),
            Err(GraphError::InvalidOutput)
        ));
    }

    #[test]
    fn rejects_output_and_send_cycles() {
        let channels = vec![
            channel("aux-a", ChannelKind::Aux, Some(3)),
            channel("aux-b", ChannelKind::Aux, Some(3)),
            channel("master", ChannelKind::Master, None),
            channel("output", ChannelKind::Output, None),
        ];
        let sends = vec![
            SendSpec {
                id: "a-to-b".to_owned(),
                source: 0,
                target: RouteTarget::Bus(1),
                enabled: true,
                tap: SendTap::Post,
                level_db: 0.0,
            },
            SendSpec {
                id: "b-to-a".to_owned(),
                source: 1,
                target: RouteTarget::Bus(0),
                enabled: true,
                tap: SendTap::Post,
                level_db: 0.0,
            },
        ];
        let mut channels = channels;
        channels[0].input_bus = Some([0, 0]);
        channels[1].input_bus = Some([1, 1]);
        assert!(matches!(
            MixerGraph::new(48_000, channels, sends),
            Err(GraphError::RoutingCycle)
        ));
    }

    #[test]
    fn pre_send_bypasses_source_fader_and_mute() {
        let mut source = channel("audio", ChannelKind::Audio, Some(3));
        source.gain_db = -90.0;
        source.muted = true;
        let channels = vec![
            source,
            channel("aux", ChannelKind::Aux, Some(3)),
            channel("master", ChannelKind::Master, None),
            channel("output", ChannelKind::Output, None),
        ];
        let sends = vec![SendSpec {
            id: "send".to_owned(),
            source: 0,
            target: RouteTarget::Bus(0),
            enabled: true,
            tap: SendTap::Pre,
            level_db: 0.0,
        }];
        let mut graph = MixerGraph::new(48_000, channels, sends).unwrap();
        let output = rendered(&mut graph, &[[1.0, 1.0]]);
        assert_eq!(output, [1.0, 1.0]);
    }

    #[test]
    fn post_send_follows_source_mute() {
        let mut source = channel("audio", ChannelKind::Audio, Some(3));
        source.muted = true;
        let channels = vec![
            source,
            channel("aux", ChannelKind::Aux, Some(3)),
            channel("master", ChannelKind::Master, None),
            channel("output", ChannelKind::Output, None),
        ];
        let sends = vec![SendSpec {
            id: "send".to_owned(),
            source: 0,
            target: RouteTarget::Bus(0),
            enabled: true,
            tap: SendTap::Post,
            level_db: 0.0,
        }];
        let mut graph = MixerGraph::new(48_000, channels, sends).unwrap();
        assert_eq!(rendered(&mut graph, &[[1.0, 1.0]]), [0.0, 0.0]);
    }

    #[test]
    fn stereo_aux_reads_two_adjacent_mono_bus_slots() {
        let mut left_source = channel("left", ChannelKind::Audio, Some(4));
        left_source.muted = true;
        let mut right_source = channel("right", ChannelKind::Audio, Some(4));
        right_source.muted = true;
        let mut aux = channel("aux", ChannelKind::Aux, Some(4));
        aux.input_bus = Some([0, 1]);
        let channels = vec![
            left_source,
            right_source,
            aux,
            channel("master", ChannelKind::Master, None),
            channel("output", ChannelKind::Output, None),
        ];
        let sends = vec![
            SendSpec {
                id: "left-send".to_owned(),
                source: 0,
                target: RouteTarget::Bus(0),
                enabled: true,
                tap: SendTap::Pre,
                level_db: 0.0,
            },
            SendSpec {
                id: "right-send".to_owned(),
                source: 1,
                target: RouteTarget::Bus(1),
                enabled: true,
                tap: SendTap::Pre,
                level_db: 0.0,
            },
        ];
        let mut graph = MixerGraph::new(48_000, channels, sends).unwrap();

        assert_eq!(rendered(&mut graph, &[[1.0, 0.0], [0.0, 2.0]]), [0.5, 1.0]);
    }

    #[test]
    fn main_outputs_can_target_buses_and_sends_can_target_outputs() {
        let mut bus_source = channel("bus-source", ChannelKind::Audio, None);
        bus_source.output = Some(RouteTarget::Bus(0));
        let mut output_send_source = channel("output-send-source", ChannelKind::Audio, None);
        output_send_source.output = Some(RouteTarget::Bus(2));
        let channels = vec![
            bus_source,
            output_send_source,
            channel("aux", ChannelKind::Aux, Some(4)),
            channel("master", ChannelKind::Master, None),
            channel("output", ChannelKind::Output, None),
        ];
        let sends = vec![SendSpec {
            id: "output-send".to_owned(),
            source: 1,
            target: RouteTarget::Output(4),
            enabled: true,
            tap: SendTap::PostPan,
            level_db: 0.0,
        }];
        let mut graph = MixerGraph::new(48_000, channels, sends).unwrap();

        assert_eq!(rendered(&mut graph, &[[1.0, 1.0], [0.5, 1.0]]), [1.5, 2.0]);
    }

    #[test]
    fn post_pan_send_follows_source_pan_after_the_fader() {
        let mut source = channel("audio", ChannelKind::Audio, Some(3));
        source.pan = 1.0;
        let channels = vec![
            source,
            channel("aux", ChannelKind::Aux, Some(3)),
            channel("master", ChannelKind::Master, None),
            channel("output", ChannelKind::Output, None),
        ];
        let sends = vec![SendSpec {
            id: "send".to_owned(),
            source: 0,
            target: RouteTarget::Bus(0),
            enabled: true,
            tap: SendTap::PostPan,
            level_db: 0.0,
        }];
        let mut graph = MixerGraph::new(48_000, channels, sends).unwrap();
        assert_eq!(rendered(&mut graph, &[[1.0, 1.0]]), [0.5, 1.5]);
    }

    #[test]
    fn solo_keeps_only_participating_route_edges_and_mute_wins() {
        let mut soloed = channel("soloed", ChannelKind::Audio, Some(4));
        soloed.soloed = true;
        let channels = vec![
            soloed,
            channel("other", ChannelKind::Audio, Some(4)),
            channel("aux", ChannelKind::Aux, Some(4)),
            channel("master", ChannelKind::Master, None),
            channel("output", ChannelKind::Output, None),
        ];
        let mut graph = MixerGraph::new(48_000, channels, vec![]).unwrap();
        assert_eq!(
            rendered(&mut graph, &[[0.25, 0.25], [0.75, 0.75]]),
            [0.25, 0.25]
        );

        let mut source = channel("source", ChannelKind::Audio, Some(3));
        source.muted = true;
        source.soloed = true;
        let channels = vec![
            source,
            channel("other", ChannelKind::Audio, Some(3)),
            channel("master", ChannelKind::Master, None),
            channel("output", ChannelKind::Output, None),
        ];
        let mut graph = MixerGraph::new(48_000, channels, vec![]).unwrap();
        assert_eq!(rendered(&mut graph, &[[1.0, 1.0], [1.0, 1.0]]), [0.0, 0.0]);
    }

    #[test]
    fn soloed_aux_receives_bus_inputs_without_leaking_direct_outputs() {
        let source = channel("source", ChannelKind::Audio, Some(3));
        let mut aux = channel("aux", ChannelKind::Aux, Some(3));
        aux.soloed = true;
        let channels = vec![
            source,
            aux,
            channel("master", ChannelKind::Master, None),
            channel("output", ChannelKind::Output, None),
        ];
        let sends = vec![SendSpec {
            id: "send".to_owned(),
            source: 0,
            target: RouteTarget::Bus(0),
            enabled: true,
            tap: SendTap::Post,
            level_db: 0.0,
        }];
        let mut graph = MixerGraph::new(48_000, channels, sends).unwrap();
        assert_eq!(rendered(&mut graph, &[[0.5, 0.5]]), [0.5, 0.5]);
    }

    #[test]
    fn parameter_changes_are_smoothed_and_meters_reset_after_snapshot() {
        let channels = vec![
            channel("audio", ChannelKind::Audio, Some(2)),
            channel("master", ChannelKind::Master, None),
            channel("output", ChannelKind::Output, None),
        ];
        let mut graph = MixerGraph::new(1_000, channels, vec![]).unwrap();
        graph.set_channel_gain(0, -90.0).unwrap();
        let first = rendered(&mut graph, &[[1.0, 0.5]]);
        assert!(first[0] > 0.0 && first[0] < 1.0);
        for _ in 0..200 {
            graph.process_frame(&[[1.0, 0.5]]);
        }
        assert!(rendered(&mut graph, &[[1.0, 0.5]])[0] < 1.0e-6);

        let mut peaks = vec![Default::default(); graph.channel_count()];
        graph.write_peaks(&mut peaks);
        assert_eq!(peaks[0].pre, [1.0, 0.5]);
        graph.write_peaks(&mut peaks);
        assert_eq!(peaks[0].pre, [0.0, 0.0]);
    }
}
