use std::{collections::VecDeque, error::Error, fmt};

pub type StereoFrame = [f32; 2];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChannelKind {
    Audio,
    Bus,
    Master,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChannelFormat {
    Mono,
    Stereo,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SendTap {
    Pre,
    Post,
}

#[derive(Debug, Clone)]
pub struct ChannelSpec {
    pub id: String,
    pub kind: ChannelKind,
    pub format: ChannelFormat,
    pub gain_db: f32,
    pub pan: f32,
    pub muted: bool,
    pub soloed: bool,
    pub output: Option<usize>,
}

#[derive(Debug, Clone)]
pub struct SendSpec {
    pub id: String,
    pub source: usize,
    pub target: usize,
    pub enabled: bool,
    pub tap: SendTap,
    pub level_db: f32,
    pub pan: f32,
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
}

#[derive(Debug, Clone)]
struct SendRuntime {
    gain: SmoothedValue,
    pan: SmoothedValue,
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

fn apply_pan(frame: StereoFrame, format: ChannelFormat, pan: f32) -> StereoFrame {
    match format {
        ChannelFormat::Mono => pan_mono((frame[0] + frame[1]) * 0.5, pan),
        ChannelFormat::Stereo => balance_stereo(frame, pan),
    }
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
            (ChannelKind::Master, None) => {}
            (ChannelKind::Master, Some(_)) | (_, None) => return Err(GraphError::InvalidOutput),
            (_, Some(output)) if output >= channels.len() || output == index => {
                return Err(GraphError::InvalidOutput);
            }
            (_, Some(output)) => edges[index].push(output),
        }
    }
    for send in sends {
        if send.source >= channels.len()
            || send.target >= channels.len()
            || send.source == send.target
            || channels[send.target].kind == ChannelKind::Audio
        {
            return Err(GraphError::InvalidSend);
        }
        edges[send.source].push(send.target);
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
        .filter_map(|(index, channel)| channel.soloed.then_some(index))
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
    let output_audible = channels
        .iter()
        .enumerate()
        .map(|(source, channel)| {
            channel
                .output
                .is_none_or(|target| edge_is_audible(source, target))
        })
        .collect();
    let send_audible = sends
        .iter()
        .map(|send| edge_is_audible(send.source, send.target))
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
            || sends
                .iter()
                .any(|send| !valid_db(send.level_db) || !valid_pan(send.pan))
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
        let edges = graph_edges(&channels, &sends)?;
        let order = topological_order(&edges)?;
        let (audible, output_audible, send_audible) = solo_audibility(&channels, &edges, &sends);
        let channel_runtime = channels
            .iter()
            .map(|channel| ChannelRuntime {
                gain: SmoothedValue::new(db_to_gain(channel.gain_db), sample_rate),
                pan: SmoothedValue::new(channel.pan, sample_rate),
            })
            .collect();
        let send_runtime = sends
            .iter()
            .map(|send| SendRuntime {
                gain: SmoothedValue::new(db_to_gain(send.level_db), sample_rate),
                pan: SmoothedValue::new(send.pan, sample_rate),
            })
            .collect();
        let mut sends_by_source = vec![Vec::new(); channels.len()];
        for (index, send) in sends.iter().enumerate() {
            sends_by_source[send.source].push(index);
        }
        Ok(Self {
            accumulation: vec![[0.0, 0.0]; channels.len()],
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

    pub fn set_send_pan(&mut self, index: usize, pan: f32) -> Result<(), GraphError> {
        if index >= self.sends.len() || !valid_pan(pan) {
            return Err(GraphError::InvalidParameter);
        }
        self.sends[index].pan = pan;
        self.send_runtime[index].pan.set_target(pan);
        Ok(())
    }

    pub fn process_frame(&mut self, audio_inputs: &[StereoFrame]) -> StereoFrame {
        self.accumulation.fill([0.0, 0.0]);
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

        for &index in &self.order {
            let channel = &self.channels[index];
            let pre = self.accumulation[index];
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

            for &send_index in &self.sends_by_source[index] {
                let send = &self.sends[send_index];
                if !send.enabled || !self.send_audible[send_index] {
                    continue;
                }
                let tap = match send.tap {
                    SendTap::Pre => pre,
                    SendTap::Post => post_fader,
                };
                let sent = scale(
                    apply_pan(
                        tap,
                        channel.format,
                        self.send_runtime[send_index].pan.next(),
                    ),
                    self.send_runtime[send_index].gain.next(),
                );
                add(&mut self.accumulation[send.target], sent);
            }

            let post = apply_pan(
                post_fader,
                channel.format,
                self.channel_runtime[index].pan.next(),
            );
            self.peaks[index].post = [
                self.peaks[index].post[0].max(post[0].abs()),
                self.peaks[index].post[1].max(post[1].abs()),
            ];
            if let Some(output) = channel.output.filter(|_| self.output_audible[index]) {
                add(&mut self.accumulation[output], post);
            }
        }
        self.accumulation[self.master]
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
        ChannelFormat, ChannelKind, ChannelSpec, GraphError, MixerGraph, SendSpec, SendTap,
        balance_stereo, pan_mono,
    };

    fn channel(
        id: &str,
        kind: ChannelKind,
        format: ChannelFormat,
        output: Option<usize>,
    ) -> ChannelSpec {
        ChannelSpec {
            id: id.to_owned(),
            kind,
            format,
            gain_db: 0.0,
            pan: 0.0,
            muted: false,
            soloed: false,
            output,
        }
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
    fn rejects_output_and_send_cycles() {
        let channels = vec![
            channel("bus-a", ChannelKind::Bus, ChannelFormat::Stereo, Some(1)),
            channel("bus-b", ChannelKind::Bus, ChannelFormat::Stereo, Some(0)),
            channel("master", ChannelKind::Master, ChannelFormat::Stereo, None),
        ];
        assert!(matches!(
            MixerGraph::new(48_000, channels, vec![]),
            Err(GraphError::RoutingCycle)
        ));
    }

    #[test]
    fn pre_send_bypasses_source_fader_and_mute() {
        let mut source = channel("audio", ChannelKind::Audio, ChannelFormat::Stereo, Some(2));
        source.gain_db = -90.0;
        source.muted = true;
        let channels = vec![
            source,
            channel("bus", ChannelKind::Bus, ChannelFormat::Stereo, Some(2)),
            channel("master", ChannelKind::Master, ChannelFormat::Stereo, None),
        ];
        let sends = vec![SendSpec {
            id: "send".to_owned(),
            source: 0,
            target: 1,
            enabled: true,
            tap: SendTap::Pre,
            level_db: 0.0,
            pan: 0.0,
        }];
        let mut graph = MixerGraph::new(48_000, channels, sends).unwrap();
        let output = graph.process_frame(&[[1.0, 1.0]]);
        assert_eq!(output, [1.0, 1.0]);
    }

    #[test]
    fn post_send_follows_source_mute() {
        let mut source = channel("audio", ChannelKind::Audio, ChannelFormat::Stereo, Some(2));
        source.muted = true;
        let channels = vec![
            source,
            channel("bus", ChannelKind::Bus, ChannelFormat::Stereo, Some(2)),
            channel("master", ChannelKind::Master, ChannelFormat::Stereo, None),
        ];
        let sends = vec![SendSpec {
            id: "send".to_owned(),
            source: 0,
            target: 1,
            enabled: true,
            tap: SendTap::Post,
            level_db: 0.0,
            pan: 0.0,
        }];
        let mut graph = MixerGraph::new(48_000, channels, sends).unwrap();
        assert_eq!(graph.process_frame(&[[1.0, 1.0]]), [0.0, 0.0]);
    }

    #[test]
    fn send_pan_is_independent_from_the_source_pan() {
        let mut source = channel("audio", ChannelKind::Audio, ChannelFormat::Stereo, Some(2));
        source.muted = true;
        source.pan = -1.0;
        let channels = vec![
            source,
            channel("bus", ChannelKind::Bus, ChannelFormat::Stereo, Some(2)),
            channel("master", ChannelKind::Master, ChannelFormat::Stereo, None),
        ];
        let sends = vec![SendSpec {
            id: "send".to_owned(),
            source: 0,
            target: 1,
            enabled: true,
            tap: SendTap::Pre,
            level_db: 0.0,
            pan: 1.0,
        }];
        let mut graph = MixerGraph::new(48_000, channels, sends).unwrap();
        assert_eq!(graph.process_frame(&[[1.0, 1.0]]), [0.0, 1.0]);
    }

    #[test]
    fn solo_keeps_only_participating_route_edges_and_mute_wins() {
        let mut soloed = channel("soloed", ChannelKind::Audio, ChannelFormat::Stereo, Some(3));
        soloed.soloed = true;
        let channels = vec![
            soloed,
            channel("other", ChannelKind::Audio, ChannelFormat::Stereo, Some(3)),
            channel("bus", ChannelKind::Bus, ChannelFormat::Stereo, Some(3)),
            channel("master", ChannelKind::Master, ChannelFormat::Stereo, None),
        ];
        let mut graph = MixerGraph::new(48_000, channels, vec![]).unwrap();
        assert_eq!(
            graph.process_frame(&[[0.25, 0.25], [0.75, 0.75]]),
            [0.25, 0.25]
        );

        let mut source = channel("source", ChannelKind::Audio, ChannelFormat::Stereo, Some(2));
        source.muted = true;
        source.soloed = true;
        let channels = vec![
            source,
            channel("other", ChannelKind::Audio, ChannelFormat::Stereo, Some(2)),
            channel("master", ChannelKind::Master, ChannelFormat::Stereo, None),
        ];
        let mut graph = MixerGraph::new(48_000, channels, vec![]).unwrap();
        assert_eq!(graph.process_frame(&[[1.0, 1.0], [1.0, 1.0]]), [0.0, 0.0]);
    }

    #[test]
    fn soloed_bus_receives_inputs_without_leaking_their_direct_outputs() {
        let source = channel("source", ChannelKind::Audio, ChannelFormat::Stereo, Some(2));
        let mut bus = channel("bus", ChannelKind::Bus, ChannelFormat::Stereo, Some(2));
        bus.soloed = true;
        let channels = vec![
            source,
            bus,
            channel("master", ChannelKind::Master, ChannelFormat::Stereo, None),
        ];
        let sends = vec![SendSpec {
            id: "send".to_owned(),
            source: 0,
            target: 1,
            enabled: true,
            tap: SendTap::Post,
            level_db: 0.0,
            pan: 0.0,
        }];
        let mut graph = MixerGraph::new(48_000, channels, sends).unwrap();
        assert_eq!(graph.process_frame(&[[0.5, 0.5]]), [0.5, 0.5]);
    }

    #[test]
    fn parameter_changes_are_smoothed_and_meters_reset_after_snapshot() {
        let channels = vec![
            channel("audio", ChannelKind::Audio, ChannelFormat::Stereo, Some(1)),
            channel("master", ChannelKind::Master, ChannelFormat::Stereo, None),
        ];
        let mut graph = MixerGraph::new(1_000, channels, vec![]).unwrap();
        graph.set_channel_gain(0, -90.0).unwrap();
        let first = graph.process_frame(&[[1.0, 0.5]]);
        assert!(first[0] > 0.0 && first[0] < 1.0);
        for _ in 0..200 {
            graph.process_frame(&[[1.0, 0.5]]);
        }
        assert!(graph.process_frame(&[[1.0, 0.5]])[0] < 1.0e-6);

        let mut peaks = vec![Default::default(); graph.channel_count()];
        graph.write_peaks(&mut peaks);
        assert_eq!(peaks[0].pre, [1.0, 0.5]);
        graph.write_peaks(&mut peaks);
        assert_eq!(peaks[0].pre, [0.0, 0.0]);
    }
}
