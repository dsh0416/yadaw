import type { ProjectGraphSnapshot } from "@heron/contracts"
import type { AudioHostGraph } from "../audio-host"

export type RuntimeLatencyPolicy =
  | { type: "normal" }
  | {
      type: "low-latency"
      targetOutputChannelId: string
      pluginBudgetSamples: number
    }

export interface RuntimeGraphOptions {
  softwareMonitoringEnabled: boolean
  latencyPolicy: RuntimeLatencyPolicy
}

export class AudioGraphCompiler {
  compile(
    graph: ProjectGraphSnapshot,
    assetPaths: ReadonlyMap<string, string>,
    options: RuntimeGraphOptions | boolean
  ): AudioHostGraph {
    const runtimeOptions: RuntimeGraphOptions =
      typeof options === "boolean"
        ? { softwareMonitoringEnabled: options, latencyPolicy: { type: "normal" } }
        : options
    const channelIdForTrack = (trackId: string): string => {
      const track = graph.tracks.find((candidate) => candidate.id === trackId)
      if (!track) throw new Error(`Project track '${trackId}' was not found`)
      return track.channelId
    }
    return {
      sample_rate: graph.sampleRate,
      latency_policy:
        runtimeOptions.latencyPolicy.type === "normal"
          ? { type: "normal" }
          : {
              type: "low-latency",
              target_output_channel_id: runtimeOptions.latencyPolicy.targetOutputChannelId,
              plugin_budget_samples: runtimeOptions.latencyPolicy.pluginBudgetSamples
            },
      channels: graph.channels.map((channel) => ({
        id: channel.id,
        name: channel.name,
        color: channel.color,
        kind: channel.kind,
        system_role: channel.systemRole ?? undefined,
        gain_db: channel.gainDb,
        pan: channel.pan,
        muted: channel.muted,
        soloed: channel.soloed,
        record_armed: channel.recordArmed,
        input_monitoring:
          channel.kind === "instrument" && channel.systemRole === null
            ? channel.inputMonitoring
            : runtimeOptions.softwareMonitoringEnabled &&
              channel.kind === "audio" &&
              channel.inputMonitoring &&
              channel.inputSource === "hardware",
        midi_input_port_id: channel.midiInput?.portId ?? undefined,
        midi_input_port_name: channel.midiInput?.portName ?? undefined,
        midi_input_channel: channel.midiInput?.channel ?? undefined,
        input_source: channel.inputSource ?? undefined,
        input_channels: channel.inputChannels,
        hardware_output_channels: channel.hardwareOutputChannels,
        output_channel_id: channel.outputChannelId ?? undefined,
        output_bus: channel.outputBus ?? undefined
      })),
      sends: graph.sends.map((send) => ({
        id: send.id,
        source_channel_id: send.sourceChannelId,
        target_channel_id: send.targetChannelId ?? undefined,
        target_bus: send.targetBus ?? undefined,
        enabled: send.enabled,
        tap: send.tap,
        level_db: send.levelDb
      })),
      clips: graph.audioClips.map((clip) => ({
        id: clip.id,
        channel_id: channelIdForTrack(clip.trackId),
        start_frame: clip.startFrame,
        source_offset_frames: clip.sourceOffsetFrames,
        length_frames: clip.lengthFrames,
        fade_in_frames: clip.fadeInFrames,
        fade_out_frames: clip.fadeOutFrames,
        path: assetPaths.get(clip.assetId)!
      })),
      plugins: graph.plugins.map((plugin) => ({
        instance_id: plugin.id,
        channel_id: plugin.channelId,
        role: plugin.role,
        slot_order: plugin.slotOrder,
        audio_mode: plugin.audioMode,
        enabled: plugin.enabled,
        aux_input_buses: plugin.descriptor.buses
          .filter(
            (bus) =>
              bus.direction === "input" &&
              bus.kind === "aux" &&
              (bus.channels === 1 || bus.channels === 2)
          )
          .map((bus) => ({
            input_bus_index: bus.index,
            name: bus.name,
            channels: bus.channels,
            source_channel_id: plugin.sidechainInputs.find(
              (route) => route.inputBusIndex === bus.index
            )?.sourceChannelId
          })),
        latency_samples: 0,
        tail_samples: 0
      })),
      midi_clips: graph.midiClips.map((clip) => ({
        id: clip.id,
        channel_id: channelIdForTrack(clip.trackId),
        start_tick: clip.startTick,
        source_offset_ticks: clip.sourceOffsetTicks,
        length_ticks: clip.lengthTicks,
        notes: {
          storage: "inline",
          notes: clip.notes.map((note) => ({
            start_tick: note.startTick,
            duration_ticks: note.durationTicks,
            channel: note.channel,
            key: note.key,
            velocity: note.velocity,
            release_velocity: note.releaseVelocity
          }))
        },
        events: {
          storage: "inline",
          events: clip.events.map((event) => ({
            tick: event.tick,
            channel: event.channel,
            kind: event.kind,
            data: { storage: "inline", bytes: event.data }
          }))
        }
      })),
      tempo_events: graph.tempoMap.tempoEvents.map((event) => ({
        tick: event.tick,
        beats_per_minute: event.beatsPerMinute
      })),
      time_signature_events: graph.tempoMap.timeSignatureEvents.map((event) => ({
        tick: event.tick,
        numerator: event.numerator,
        denominator: event.denominator
      }))
    }
  }
}
