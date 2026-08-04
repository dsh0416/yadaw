import type { AudioHostIpcClient } from "@heron/audio-host-client"
import { describe, expect, it, vi } from "vitest"
import { AudioHostMidiInputClient } from "./audio-host-midi-input-client"
import type { ControlResponse } from "./wire"

function midiResponse(): ControlResponse {
  return {
    request_id: 1,
    result: {
      type: "midi-input-snapshot",
      midi_input: {
        ports: [{ id: "port-1", name: "Keyboard", connected: true }],
        sync: {
          state: "following",
          source_port_id: "port-1",
          source_port_name: "Keyboard",
          effective_bpm: 121,
          jitter_microseconds: 25,
          last_clock_age_ms: 2,
          dropped_events: 1,
          ignored_system_messages: 3,
          error: null
        },
        control_events: [
          {
            generation: 4,
            timestamp_microseconds: 5,
            port_id: "control-1",
            port_name: "Control",
            channel: 1,
            type: "control-change",
            number: 7,
            value: 100
          }
        ],
        captured_at: 9
      }
    }
  }
}

describe("AudioHostMidiInputClient", () => {
  it("configures unique control ports and decodes the wire snapshot", async () => {
    const request = vi.fn(async () => midiResponse())
    const client = new AudioHostMidiInputClient(request, vi.fn())

    const snapshot = await client.configure(
      {
        enabled: true,
        sourcePortId: "port-1",
        sourcePortName: "Keyboard",
        inputOffsetsMs: { "port-1": -2 }
      },
      {
        keyboard: {},
        midi: {
          "transport.toggle-playback": {
            portId: "control-1",
            portName: "Control",
            type: "control-change",
            channel: 1,
            number: 7
          },
          "transport.toggle-loop": {
            portId: "control-1",
            portName: "Control",
            type: "note",
            channel: 1,
            number: 8
          }
        }
      }
    )

    expect(request).toHaveBeenCalledWith({
      type: "configure-midi-input",
      preferences: {
        enabled: true,
        source_port_id: "port-1",
        source_port_name: "Keyboard",
        input_offsets_ms: { "port-1": -2 },
        control_port_ids: ["control-1"],
        capture_all_controls: false
      }
    })
    expect(snapshot).toMatchObject({
      ports: [{ id: "port-1", name: "Keyboard", connected: true }],
      sync: { state: "following", sourcePortId: "port-1", effectiveBpm: 121 },
      controlEvents: [{ portId: "control-1", number: 7, value: 100 }],
      capturedAt: 9
    })
  })

  it("restores configured preferences and the current learning state on a new helper", async () => {
    const request = vi.fn(async () => midiResponse())
    const requestImmediately = vi.fn(async () => midiResponse())
    const client = new AudioHostMidiInputClient(request, requestImmediately)
    await client.configure({
      enabled: true,
      sourcePortId: "port-1",
      sourcePortName: "Keyboard",
      inputOffsetsMs: {}
    })
    await client.setControlLearning(true)
    const helper = {} as AudioHostIpcClient

    await client.restore(helper)

    expect(requestImmediately).toHaveBeenCalledWith(
      {
        type: "configure-midi-input",
        preferences: {
          enabled: true,
          source_port_id: "port-1",
          source_port_name: "Keyboard",
          input_offsets_ms: {},
          control_port_ids: [],
          capture_all_controls: true
        }
      },
      helper
    )
  })

  it("does not configure a replacement helper before preferences exist", async () => {
    const requestImmediately = vi.fn(async () => midiResponse())
    const client = new AudioHostMidiInputClient(vi.fn(), requestImmediately)

    await client.restore({} as AudioHostIpcClient)

    expect(requestImmediately).not.toHaveBeenCalled()
  })
})
