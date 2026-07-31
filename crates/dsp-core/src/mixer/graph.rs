use super::*;

pub(super) fn db_to_gain(db: f32) -> f32 {
    if db <= -90.0 {
        0.0
    } else {
        10.0_f32.powf(db / 20.0)
    }
}

pub(super) fn valid_db(value: f32) -> bool {
    value.is_finite() && (-90.0..=12.0).contains(&value)
}

pub(super) fn valid_pan(value: f32) -> bool {
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

pub(super) fn add(target: &mut StereoFrame, source: StereoFrame) {
    target[0] += source[0];
    target[1] += source[1];
}

pub(super) fn scale(frame: StereoFrame, gain: f32) -> StereoFrame {
    [frame[0] * gain, frame[1] * gain]
}

pub(super) fn graph_edges(
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

pub(super) fn topological_order(edges: &[Vec<usize>]) -> Result<Vec<usize>, GraphError> {
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

pub(super) fn solo_audibility(
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
