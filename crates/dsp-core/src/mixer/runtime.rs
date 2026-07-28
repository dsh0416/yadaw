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
