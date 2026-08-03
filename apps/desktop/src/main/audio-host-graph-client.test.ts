import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { graphDiff, readCrashMarker } from "./audio-host-graph-client"
import type { AudioHostGraph } from "./audio-host-wire"

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

function buildCrashMarker(revision: number, pluginIndex: number, stage: bigint): Buffer {
  const marker = Buffer.alloc(40)
  const magic = 0x5941444157565354n
  const salt = 0x43524153484d4152n
  const generation = BigInt(revision)
  const pluginIdx = BigInt(pluginIndex)
  const checksum = magic ^ generation ^ pluginIdx ^ stage ^ salt
  marker.writeBigUInt64LE(magic, 0)
  marker.writeBigUInt64LE(generation, 8)
  marker.writeBigUInt64LE(pluginIdx, 16)
  marker.writeBigUInt64LE(stage, 24)
  marker.writeBigUInt64LE(checksum, 32)
  return marker
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
})

describe("readCrashMarker", () => {
  it("returns the plugin instance id for a valid crash marker", () => {
    const directory = mkdtempSync(join(tmpdir(), "heron-crash-"))
    const path = join(directory, "crash.marker")
    const graph = emptyGraph({
      plugins: [
        {
          instance_id: "instrument-1",
          channel_id: "inst",
          role: "instrument",
          slot_order: 0,
          audio_mode: "stereo",
          enabled: true,
          aux_input_buses: [],
          latency_samples: 0,
          tail_samples: null
        },
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
    writeFileSync(path, buildCrashMarker(7, 0, 2n))

    expect(readCrashMarker(path, 7, graph)).toBe("fx-1")
  })

  it("ignores markers with the wrong revision, checksum, or stage", () => {
    const directory = mkdtempSync(join(tmpdir(), "heron-crash-"))
    const path = join(directory, "crash.marker")
    writeFileSync(path, buildCrashMarker(7, 0, 2n))

    expect(readCrashMarker(path, 8, emptyGraph())).toBeNull()
    expect(readCrashMarker(path, 7, emptyGraph())).toBeNull()

    writeFileSync(path, buildCrashMarker(7, 0, 0n))
    expect(readCrashMarker(path, 7, emptyGraph())).toBeNull()
  })

  it("returns null when the marker file is missing or truncated", () => {
    const directory = mkdtempSync(join(tmpdir(), "heron-crash-"))
    const path = join(directory, "missing.marker")

    expect(readCrashMarker(path, 1, emptyGraph())).toBeNull()

    writeFileSync(path, Buffer.alloc(8))
    expect(readCrashMarker(path, 1, emptyGraph())).toBeNull()
  })
})
