import { describe, expect, it } from "vitest"

import type { MidiRuntimeResourceSnapshot } from "./midi"
import type { PluginParameterCommand } from "./plugins"

function wireRoundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

describe("plugin and MIDI resource routing contracts", () => {
  it("keeps helper epoch, plugin generation, and sequence explicit on parameter commands", () => {
    const command: PluginParameterCommand = {
      plugin: {
        kind: "plugin-instance",
        id: "plugin-1",
        epoch: "18446744073709551615",
        generation: 7
      },
      helperEpoch: "18446744073709551614",
      pluginGeneration: 7,
      sequence: "9007199254740993",
      parameterId: 42,
      normalized: 0.75,
      gesture: "perform"
    }

    const decoded = wireRoundTrip(command)

    expect(decoded).toEqual(command)
    expect(typeof decoded.helperEpoch).toBe("string")
    expect(typeof decoded.sequence).toBe("string")
    expect(decoded.pluginGeneration).toBe(decoded.plugin.generation)
  })

  it("binds a MIDI runtime projection to its AudioHostRef generation", () => {
    const snapshot: MidiRuntimeResourceSnapshot = {
      runtime: {
        kind: "midi-runtime",
        id: "midi-runtime",
        epoch: "helper-epoch",
        generation: 3
      },
      host: {
        kind: "audio-host",
        id: "audio-host",
        epoch: "helper-epoch",
        generation: 3
      },
      revision: 11,
      snapshot: {
        ports: [{ id: "controller", name: "Controller", connected: true }],
        sync: {
          state: "internal",
          sourcePortId: null,
          sourcePortName: null,
          effectiveBpm: null,
          jitterMicroseconds: null,
          lastClockAgeMs: null,
          droppedEvents: 0,
          ignoredSystemMessages: 0,
          error: null
        },
        controlEvents: [],
        capturedAt: 1
      }
    }

    const decoded = wireRoundTrip(snapshot)

    expect(decoded).toEqual(snapshot)
    expect(decoded.runtime.epoch).toBe(decoded.host.epoch)
  })
})
