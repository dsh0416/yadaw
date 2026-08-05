import { describe, expect, it, vi } from "vitest"
import { AudioHostRecordingClient } from "./audio-host-recording-client"
import type { ControlResponse } from "./wire"

describe("AudioHostRecordingClient MIDI recording", () => {
  it("starts audio recording with the graph capture format", async () => {
    const request = vi.fn(async () => ({ result: { type: "accepted" } }) as ControlResponse)
    const client = new AudioHostRecordingClient(request)
    await client.startRecording({
      path: "/swap/take.bwf",
      assetId: "asset-1",
      originator: "Heron",
      originationDate: "2026-08-05",
      originationTime: "12:00:00",
      timeReference: 0,
      sampleRate: 48_000,
      channels: 4
    })
    expect(request).toHaveBeenCalledWith({
      type: "start-recording",
      config: expect.objectContaining({ sample_rate: 48_000, channels: 4 })
    })
  })

  it("starts MIDI recording with snake_case wire fields", async () => {
    const request = vi.fn(async () => ({ result: { type: "accepted" } }) as ControlResponse)
    const client = new AudioHostRecordingClient(request)
    await client.startMidiRecording({
      takes: [
        {
          path: "/swap/take.midijournal",
          sourceId: "source-1",
          clipId: "clip-1",
          trackId: "track-1",
          portId: "port-a",
          channel: 3
        }
      ]
    })
    expect(request).toHaveBeenCalledWith({
      type: "start-midi-recording",
      config: {
        takes: [
          {
            path: "/swap/take.midijournal",
            source_id: "source-1",
            clip_id: "clip-1",
            track_id: "track-1",
            port_id: "port-a",
            channel: 3
          }
        ]
      }
    })
  })

  it("maps MIDI recording stop results to camelCase", async () => {
    const request = vi.fn(async () => ({
      result: {
        type: "midi-recording-stopped",
        midi_recording: {
          takes: [
            {
              path: "/swap/take.midijournal",
              source_id: "source-1",
              clip_id: "clip-1",
              track_id: "track-1",
              event_count: 4,
              dropped_events: 1
            }
          ]
        }
      }
    }))
    const client = new AudioHostRecordingClient(request as never)
    await expect(client.stopMidiRecording()).resolves.toEqual({
      takes: [
        {
          path: "/swap/take.midijournal",
          sourceId: "source-1",
          clipId: "clip-1",
          trackId: "track-1",
          eventCount: 4,
          droppedEvents: 1
        }
      ]
    })
  })

  it("rejects an invalid MIDI recording stop result", async () => {
    const request = vi.fn(async () => ({ result: { type: "accepted" } }))
    const client = new AudioHostRecordingClient(request as never)
    await expect(client.stopMidiRecording()).rejects.toThrow(
      "audio host returned an invalid MIDI recording result"
    )
  })
})
