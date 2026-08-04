import { describe, expect, it } from "vitest"
import { graphDiff } from "./audio-host-graph-client"
import type { AudioHostGraph } from "./wire"

function emptyGraph(overrides: Partial<AudioHostGraph> = {}): AudioHostGraph {
  return {
    sample_rate: 48_000,
    channels: [],
    sends: [],
    clips: [],
    plugins: [],
    midi_clips: [],
    tempo_events: [{ tick: 0, beats_per_minute: 120 }],
    time_signature_events: [{ tick: 0, numerator: 4, denominator: 4 }],
    ...overrides
  }
}

describe("graphDiff", () => {
  it("returns no operations when graphs are identical", () => {
    const graph = emptyGraph({
      channels: [
        {
          id: "audio-1",
          name: "Audio 1",
          color: "#58c6c2",
          kind: "audio",
          gain_db: 0,
          pan: 0,
          muted: false,
          soloed: false,
          record_armed: false,
          input_monitoring: false,
          input_channels: [1, 2],
          hardware_output_channels: []
        }
      ]
    })

    expect(graphDiff(graph, structuredClone(graph))).toEqual([])
  })

  it("emits upsert and remove operations for changed collections", () => {
    const previous = emptyGraph({
      channels: [
        {
          id: "audio-1",
          name: "Audio 1",
          color: "#58c6c2",
          kind: "audio",
          gain_db: 0,
          pan: 0,
          muted: false,
          soloed: false,
          record_armed: false,
          input_monitoring: false,
          input_channels: [1, 2],
          hardware_output_channels: []
        }
      ],
      plugins: [
        {
          instance_id: "fx-1",
          channel_id: "audio-1",
          role: "insert",
          slot_order: 0,
          audio_mode: "stereo",
          enabled: true,
          aux_input_buses: [],
          latency_samples: 0,
          tail_samples: null
        }
      ]
    })
    const next = emptyGraph({
      channels: [
        {
          id: "audio-1",
          name: "Audio 1",
          color: "#58c6c2",
          kind: "audio",
          gain_db: -3,
          pan: 0,
          muted: false,
          soloed: false,
          record_armed: false,
          input_monitoring: false,
          input_channels: [1, 2],
          hardware_output_channels: []
        }
      ],
      plugins: []
    })

    expect(graphDiff(previous, next)).toEqual([
      {
        type: "upsert-channel",
        value: next.channels[0]
      },
      { type: "remove-plugin", id: "fx-1" }
    ])
  })

  it("replaces the tempo map when timing metadata changes", () => {
    const previous = emptyGraph()
    const next = emptyGraph({
      tempo_events: [{ tick: 0, beats_per_minute: 140 }]
    })

    expect(graphDiff(previous, next)).toEqual([
      {
        type: "replace-tempo-map",
        tempo_events: next.tempo_events,
        time_signature_events: next.time_signature_events
      }
    ])
  })

  it("patches the soft project end independently of timeline content", () => {
    const previous = emptyGraph({ project_end_tick: 61_440 })
    const next = emptyGraph({ project_end_tick: 15_360 })

    expect(graphDiff(previous, next)).toEqual([
      { type: "set-project-end", project_end_tick: 15_360 }
    ])
  })
})
