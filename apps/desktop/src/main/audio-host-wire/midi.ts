export interface AudioHostMidiInputRoute {
  port_id: string | null
  port_name: string | null
  channel: number | null
}

export interface AudioHostMidiInputSnapshot {
  ports: Array<{ id: string; name: string; connected: boolean }>
  sync: {
    state: string
    source_port_id: string | null
    source_port_name: string | null
    effective_bpm: number | null
    jitter_microseconds: number
    last_clock_age_ms: number | null
    dropped_events: number
    ignored_system_messages: number
    error: string | null
  }
  control_events: Array<{
    generation: number
    timestamp_microseconds: number
    port_id: string
    port_name: string
    channel: number
    type: "note" | "control-change"
    number: number
    value: number
  }>
  recording_preview?: {
    position_tick: number
    takes: Array<{
      clip_id: string
      track_id: string
      notes: Array<{
        id: number
        start_tick: number
        end_tick: number
        channel: number
        key: number
        velocity: number
        active: boolean
      }>
    }>
  }
  captured_at: number
}
