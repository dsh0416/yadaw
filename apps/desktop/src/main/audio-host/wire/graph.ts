import type { PluginAudioMode } from "@heron/contracts"
import type { BinaryPayloadWire } from "./binary"

export interface AudioHostGraph {
  sample_rate: number
  project_end_tick?: number
  latency_policy?:
    | { type: "normal" }
    | {
        type: "low-latency"
        target_output_channel_id: string
        plugin_budget_samples: number
      }
  channels: Array<{
    id: string
    name: string
    color: string
    kind: string
    system_role?: "metronome"
    gain_db: number
    pan: number
    muted: boolean
    soloed: boolean
    output_channel_id?: string
    output_bus?: number
    record_armed: boolean
    input_monitoring: boolean
    midi_input_port_id?: string
    midi_input_port_name?: string
    midi_input_channel?: number
    input_source?: "hardware" | "bus"
    input_channels: number[]
    hardware_output_channels: number[]
  }>
  sends: Array<{
    id: string
    source_channel_id: string
    target_channel_id?: string
    target_bus?: number
    enabled: boolean
    tap: string
    level_db: number
  }>
  clips: Array<{
    id: string
    channel_id: string
    start_frame: number
    source_offset_frames: number
    length_frames: number
    fade_in_frames: number
    fade_out_frames: number
    path: string
  }>
  plugins: Array<{
    instance_id: string
    channel_id: string
    role: string
    slot_order: number
    audio_mode: PluginAudioMode
    enabled: boolean
    aux_input_buses: Array<{
      input_bus_index: number
      name: string
      channels: number
      source_channel_id?: string
    }>
    latency_samples: number
    tail_samples: number | null
  }>
  midi_clips: Array<{
    id: string
    channel_id: string
    start_tick: number
    source_offset_ticks: number
    length_ticks: number
    notes: {
      storage: "inline"
      notes: Array<{
        start_tick: number
        duration_ticks: number
        channel: number
        key: number
        velocity: number
        release_velocity: number
      }>
    }
    events: {
      storage: "inline"
      events: Array<{
        tick: number
        channel: number | null
        kind: string
        data: BinaryPayloadWire
      }>
    }
  }>
  tempo_events: Array<{ tick: number; beats_per_minute: number }>
  time_signature_events: Array<{
    tick: number
    numerator: number
    denominator: number
  }>
}
