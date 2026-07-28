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
