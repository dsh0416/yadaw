use std::{error::Error, fmt};

use crate::tempo::{TempoMap, TempoMapError};

pub const MAX_PLUGIN_BLOCK_FRAMES: usize = 4_096;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProcessBlock {
    pub start_frame: u64,
    pub frame_count: usize,
}

pub fn plan_process_blocks(
    tempo_map: &TempoMap,
    start_frame: u64,
    frame_count: usize,
    sample_rate: u32,
) -> Result<Vec<ProcessBlock>, TempoMapError> {
    if sample_rate == 0 {
        return Err(TempoMapError::InvalidSampleRate);
    }
    let end_frame = start_frame.saturating_add(frame_count as u64);
    let mut boundaries = tempo_map
        .tempo_events()
        .iter()
        .skip(1)
        .map(|event| event.tick)
        .chain(
            tempo_map
                .time_signature_events()
                .iter()
                .skip(1)
                .map(|event| event.tick),
        )
        .filter_map(|tick| tempo_map.tick_to_frame(tick, sample_rate).ok())
        .filter(|frame| *frame > start_frame && *frame < end_frame)
        .collect::<Vec<_>>();
    boundaries.sort_unstable();
    boundaries.dedup();
    boundaries.push(end_frame);

    let mut result = Vec::new();
    let mut cursor = start_frame;
    for boundary in boundaries {
        while cursor < boundary {
            let frame_count =
                usize::try_from(boundary - cursor).unwrap_or(usize::MAX).min(MAX_PLUGIN_BLOCK_FRAMES);
            result.push(ProcessBlock {
                start_frame: cursor,
                frame_count,
            });
            cursor += frame_count as u64;
        }
    }
    Ok(result)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LatencyNode {
    pub id: String,
    pub intrinsic_latency: u32,
    pub inputs: Vec<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedNodeLatency {
    pub input_delays: Vec<u32>,
    pub total_latency: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LatencyPlanError {
    MissingInput,
    Cycle,
    Overflow,
}

impl fmt::Display for LatencyPlanError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::MissingInput => "latency graph references a missing input",
            Self::Cycle => "latency graph contains a cycle",
            Self::Overflow => "latency graph exceeds the supported sample delay",
        })
    }
}

impl Error for LatencyPlanError {}

pub fn plan_latency_compensation(
    nodes: &[LatencyNode],
) -> Result<Vec<PlannedNodeLatency>, LatencyPlanError> {
    let mut states = vec![0_u8; nodes.len()];
    let mut totals = vec![0_u32; nodes.len()];
    for index in 0..nodes.len() {
        visit_latency_node(index, nodes, &mut states, &mut totals)?;
    }

    nodes
        .iter()
        .map(|node| {
            let maximum_input = node
                .inputs
                .iter()
                .map(|index| totals[*index])
                .max()
                .unwrap_or(0);
            let input_delays = node
                .inputs
                .iter()
                .map(|index| maximum_input - totals[*index])
                .collect();
            Ok(PlannedNodeLatency {
                input_delays,
                total_latency: maximum_input
                    .checked_add(node.intrinsic_latency)
                    .ok_or(LatencyPlanError::Overflow)?,
            })
        })
        .collect()
}

fn visit_latency_node(
    index: usize,
    nodes: &[LatencyNode],
    states: &mut [u8],
    totals: &mut [u32],
) -> Result<u32, LatencyPlanError> {
    let Some(node) = nodes.get(index) else {
        return Err(LatencyPlanError::MissingInput);
    };
    match states[index] {
        1 => return Err(LatencyPlanError::Cycle),
        2 => return Ok(totals[index]),
        _ => {}
    }
    states[index] = 1;
    let mut maximum_input = 0;
    for input in &node.inputs {
        if *input >= nodes.len() {
            return Err(LatencyPlanError::MissingInput);
        }
        maximum_input = maximum_input.max(visit_latency_node(*input, nodes, states, totals)?);
    }
    let total = maximum_input
        .checked_add(node.intrinsic_latency)
        .ok_or(LatencyPlanError::Overflow)?;
    totals[index] = total;
    states[index] = 2;
    Ok(total)
}

#[derive(Debug, Clone)]
pub struct StereoDelayLine {
    frames: Vec<[f32; 2]>,
    cursor: usize,
}

impl StereoDelayLine {
    pub fn new(delay_frames: usize) -> Self {
        Self {
            frames: vec![[0.0; 2]; delay_frames],
            cursor: 0,
        }
    }

    pub fn delay_frames(&self) -> usize {
        self.frames.len()
    }

    pub fn process(&mut self, input: [f32; 2]) -> [f32; 2] {
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

    pub fn clear(&mut self) {
        self.frames.fill([0.0; 2]);
        self.cursor = 0;
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TailLength {
    None,
    Finite(u64),
    Infinite,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TailState {
    length: TailLength,
    remaining: u64,
    input_ended: bool,
}

impl TailState {
    pub fn new(length: TailLength) -> Self {
        Self {
            remaining: 0,
            length,
            input_ended: false,
        }
    }

    pub fn end_input(&mut self) {
        self.input_ended = true;
        self.remaining = match self.length {
            TailLength::Finite(samples) => samples,
            _ => 0,
        };
    }

    pub fn should_process(&self) -> bool {
        !self.input_ended
            || matches!(self.length, TailLength::Infinite)
            || self.remaining > 0
    }

    pub fn advance(&mut self, frame_count: usize) {
        if self.input_ended {
            self.remaining = self.remaining.saturating_sub(frame_count as u64);
        }
    }

    pub fn stop(&mut self) {
        self.input_ended = true;
        self.remaining = 0;
        self.length = TailLength::None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tempo::{TempoEvent, TimeSignatureEvent};

    #[test]
    fn process_blocks_split_at_map_markers_and_plugin_limit() {
        let map = TempoMap::new(
            vec![
                TempoEvent {
                    tick: 0,
                    beats_per_minute: 120.0,
                },
                TempoEvent {
                    tick: 960,
                    beats_per_minute: 90.0,
                },
            ],
            vec![
                TimeSignatureEvent {
                    tick: 0,
                    numerator: 4,
                    denominator: 4,
                },
                TimeSignatureEvent {
                    tick: 1_920,
                    numerator: 3,
                    denominator: 4,
                },
            ],
        )
        .unwrap();
        let blocks = plan_process_blocks(&map, 22_000, 40_000, 48_000).unwrap();
        assert_eq!(
            blocks,
            vec![
                ProcessBlock {
                    start_frame: 22_000,
                    frame_count: 2_000,
                },
                ProcessBlock {
                    start_frame: 24_000,
                    frame_count: 4_096,
                },
                ProcessBlock {
                    start_frame: 28_096,
                    frame_count: 4_096,
                },
                ProcessBlock {
                    start_frame: 32_192,
                    frame_count: 4_096,
                },
                ProcessBlock {
                    start_frame: 36_288,
                    frame_count: 4_096,
                },
                ProcessBlock {
                    start_frame: 40_384,
                    frame_count: 4_096,
                },
                ProcessBlock {
                    start_frame: 44_480,
                    frame_count: 4_096,
                },
                ProcessBlock {
                    start_frame: 48_576,
                    frame_count: 4_096,
                },
                ProcessBlock {
                    start_frame: 52_672,
                    frame_count: 3_328,
                },
                ProcessBlock {
                    start_frame: 56_000,
                    frame_count: 4_096,
                },
                ProcessBlock {
                    start_frame: 60_096,
                    frame_count: 1_904,
                },
            ]
        );
    }

    #[test]
    fn delays_shorter_paths_at_each_merge() {
        let plan = plan_latency_compensation(&[
            LatencyNode {
                id: "dry".into(),
                intrinsic_latency: 0,
                inputs: vec![],
            },
            LatencyNode {
                id: "effect".into(),
                intrinsic_latency: 128,
                inputs: vec![],
            },
            LatencyNode {
                id: "bus".into(),
                intrinsic_latency: 32,
                inputs: vec![0, 1],
            },
            LatencyNode {
                id: "output".into(),
                intrinsic_latency: 0,
                inputs: vec![2],
            },
        ])
        .unwrap();
        assert_eq!(plan[2].input_delays, vec![128, 0]);
        assert_eq!(plan[2].total_latency, 160);
        assert_eq!(plan[3].total_latency, 160);
    }

    #[test]
    fn rejects_latency_cycles_and_missing_inputs() {
        assert_eq!(
            plan_latency_compensation(&[
                LatencyNode {
                    id: "a".into(),
                    intrinsic_latency: 0,
                    inputs: vec![1],
                },
                LatencyNode {
                    id: "b".into(),
                    intrinsic_latency: 0,
                    inputs: vec![0],
                },
            ]),
            Err(LatencyPlanError::Cycle)
        );
        assert_eq!(
            plan_latency_compensation(&[LatencyNode {
                id: "a".into(),
                intrinsic_latency: 0,
                inputs: vec![1],
            }]),
            Err(LatencyPlanError::MissingInput)
        );
    }

    #[test]
    fn bypass_delay_preserves_plugin_latency_without_allocating() {
        let mut delay = StereoDelayLine::new(2);
        assert_eq!(delay.process([1.0, -1.0]), [0.0, 0.0]);
        assert_eq!(delay.process([2.0, -2.0]), [0.0, 0.0]);
        assert_eq!(delay.process([3.0, -3.0]), [1.0, -1.0]);
        assert_eq!(delay.delay_frames(), 2);
    }

    #[test]
    fn finite_and_infinite_tails_have_explicit_stop_rules() {
        let mut finite = TailState::new(TailLength::Finite(512));
        finite.end_input();
        finite.advance(256);
        assert!(finite.should_process());
        finite.advance(256);
        assert!(!finite.should_process());

        let mut infinite = TailState::new(TailLength::Infinite);
        infinite.end_input();
        infinite.advance(100_000);
        assert!(infinite.should_process());
        infinite.stop();
        assert!(!infinite.should_process());
    }
}
