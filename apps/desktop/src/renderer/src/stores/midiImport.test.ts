import { createPinia, setActivePinia } from "pinia"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { MidiImportPreview, ProjectCommandResult } from "@yadaw/contracts"
import { useMidiImportStore } from "./midiImport"
import { useMixerStore } from "./mixer"
import { useTransportStore } from "./transport"

const preview: MidiImportPreview = {
  token: "midi-token",
  path: "song.mid",
  format: 1,
  sourceTiming: "PPQ 480",
  tracks: [
    {
      sourceTrack: 0,
      sequence: 0,
      name: "Piano",
      noteCount: 4,
      eventCount: 8,
      lengthTicks: 3_840,
      tempoMap: {
        ticksPerQuarter: 960,
        tempoEvents: [{ tick: 0, beatsPerMinute: 132 }],
        timeSignatureEvents: [{ tick: 0, numerator: 4, denominator: 4 }]
      },
      warnings: []
    }
  ],
  tempoMap: {
    ticksPerQuarter: 960,
    tempoEvents: [{ tick: 0, beatsPerMinute: 132 }],
    timeSignatureEvents: [{ tick: 0, numerator: 4, denominator: 4 }]
  },
  warnings: []
}

describe("MIDI import tempo choice", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    Object.assign(window.yadaw, { commitMidiImport: vi.fn() })
  })

  it("keeps the project Tempo Track by default and imports at the playhead", async () => {
    const mixer = useMixerStore()
    const transport = useTransportStore()
    transport.snapshot = {
      state: "stopped",
      positionFrames: 192_000,
      sampleRate: 48_000
    }
    const store = useMidiImportStore()
    store.preview = preview
    store.targets = { "0:0": { type: "new" } }
    vi.mocked(window.yadaw.commitMidiImport).mockResolvedValue({
      graph: mixer.graph,
      inverse: { type: "batch", commands: [] }
    } satisfies ProjectCommandResult)

    await store.commit()

    expect(window.yadaw.commitMidiImport).toHaveBeenCalledWith(
      expect.objectContaining({
        importTempoMap: false,
        insertionTick: 7_680
      })
    )
  })

  it("imports the MIDI tempo map from tick zero when selected", async () => {
    const mixer = useMixerStore()
    const store = useMidiImportStore()
    store.preview = preview
    store.targets = { "0:0": { type: "new" } }
    store.tempoMode = "midi"
    vi.mocked(window.yadaw.commitMidiImport).mockResolvedValue({
      graph: mixer.graph,
      inverse: { type: "batch", commands: [] }
    } satisfies ProjectCommandResult)

    await store.commit()

    expect(window.yadaw.commitMidiImport).toHaveBeenCalledWith(
      expect.objectContaining({
        importTempoMap: true,
        insertionTick: 0
      })
    )
  })
})
