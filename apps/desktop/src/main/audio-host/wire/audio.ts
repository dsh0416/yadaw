export interface AudioHostDevice {
  id: string
  name: string
  is_default: boolean
  default_sample_rate: number | null
  min_buffer_size: number | null
  max_buffer_size: number | null
  channel_count: number | null
}

export interface AudioHostApplicationCaptureLogicalTarget {
  platform: string
  bundle_identifier: string | null
  executable_path: string
  executable_name: string
  include_process_tree: boolean
}

export interface AudioHostApplicationCaptureTarget {
  runtime_id: string
  process_id: number
  display_name: string
  executable_path: string
  logical_target: AudioHostApplicationCaptureLogicalTarget
  channel_count: number
  status: string
}

export interface AudioHostApplicationCaptureSnapshot {
  runtime_id: string
  process_id: number | null
  display_name: string
  executable_path: string
  logical_target: AudioHostApplicationCaptureLogicalTarget
  channel_count: number
  status: string
  dropout_frames: number
  overflow_frames: number
  underflow_frames: number
}

export interface AudioHostRuntime {
  state: string
  requested_buffer_size: number | null
  sample_rate: number | null
  input_sample_rate: number | null
  output_sample_rate: number | null
  input_buffer_size: number | null
  output_buffer_size: number | null
  ring_buffer_capacity_frames: number | null
  ring_buffer_fill_frames: number | null
  input_latency_ms: number | null
  output_latency_ms: number | null
  ring_buffer_latency_ms: number | null
  engine_latency_ms: number | null
  estimated_round_trip_latency_ms: number | null
  xruns: number
  clock_sync: string
  buffer_fallback: boolean
}

export interface AudioHostRoundTripLatencyMeasurement {
  status: string
  input_channel: number | null
  output_channel: number | null
  measured_round_trip_latency_ms: number | null
  failure: string | null
}

export interface AudioHostMeter {
  channel_id: string
  pre_left: number
  pre_right: number
  post_left: number
  post_right: number
  held_left: number
  held_right: number
  clipped: boolean
}

export interface AudioHostBenchmarkReport {
  duration_ms: number
  overall_realtime_factor: number
  worst_p99_deadline_utilization_percent: number
  scenarios: Array<{
    id: string
    label: string
    description: string
    sample_rate: number
    block_size: number
    tracks: number
    buses: number
    sends: number
    plugins: number
    elapsed_ms: number
    audio_duration_ms: number
    average_block_ms: number
    p95_block_ms: number
    p99_block_ms: number
    max_block_ms: number
    buffer_budget_ms: number
    p99_deadline_utilization_percent: number
    deadline_misses: number
    measured_blocks: number
    realtime_factor: number
  }>
}

export interface AudioHostTransport {
  state: string
  position_frames: number
  position_ticks: number
  sample_rate: number
  effective_bpm: number | null
  clock_source: string
  waiting_for: string | null
  loop_enabled: boolean
  loop_start_tick: number | null
  loop_end_tick: number | null
}
