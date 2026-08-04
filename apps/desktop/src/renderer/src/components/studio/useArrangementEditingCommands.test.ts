import { describe, expect, it, vi } from "vitest"
import type { ProjectGraphSnapshot } from "@heron/contracts"
import { useArrangementEditingCommands } from "./useArrangementEditingCommands"

function graph(): ProjectGraphSnapshot {
  return {
    sampleRate: 48_000,
    tracks: [],
    channels: [],
    audioClips: [],
    sends: [],
    plugins: [],
    midiClips: [],
    keySignatureEvents: [{ tick: 0, fifths: 0, mode: "major" }],
    tempoMap: {
      ticksPerQuarter: 960,
      tempoEvents: [{ tick: 0, beatsPerMinute: 120 }],
      timeSignatureEvents: [{ tick: 0, numerator: 4, denominator: 4 }]
    }
  }
}

function ports(execute = vi.fn().mockResolvedValue(true)) {
  return {
    graph,
    tracks: () => [],
    playheadFrame: () => 24_000,
    playheadTick: () => 960,
    snap: () => "1/16" as const,
    selectedAudioClipId: () => "audio-1",
    selectedMidiClipIds: () => [],
    execute,
    clearAudioSelection: vi.fn(),
    selectAudioClip: vi.fn(),
    clearMidiSelection: vi.fn(),
    selectMidiClip: vi.fn(),
    openMidiClipSet: vi.fn(),
    openPianoRoll: vi.fn(),
    midiClipName: (index: number) => `MIDI ${index}`,
    createId: vi.fn().mockReturnValueOnce("source-1").mockReturnValueOnce("clip-1")
  }
}

describe("useArrangementEditingCommands", () => {
  it("rejects track reorder boundaries without submitting a command", async () => {
    const options = ports()
    const commands = useArrangementEditingCommands(options)

    await expect(commands.reorderTrack(0, -1)).resolves.toBe(false)
    expect(options.execute).not.toHaveBeenCalled()
  })

  it("treats an empty MIDI selection and missing clip as a no-op", async () => {
    const options = ports()
    const commands = useArrangementEditingCommands(options)

    await expect(commands.splitMidiClip("missing")).resolves.toBe(false)
    expect(options.execute).not.toHaveBeenCalled()
  })

  it("does not mutate selection or open the editor when a command fails", async () => {
    const options = ports(vi.fn().mockResolvedValue(false))
    const commands = useArrangementEditingCommands(options)

    await expect(commands.removeAudioClip("audio-1")).resolves.toBe(false)
    await expect(commands.createMidiClip("track-1", 1_000)).resolves.toBe(false)
    expect(options.clearAudioSelection).not.toHaveBeenCalled()
    expect(options.clearMidiSelection).not.toHaveBeenCalled()
    expect(options.selectMidiClip).not.toHaveBeenCalled()
    expect(options.openMidiClipSet).not.toHaveBeenCalled()
    expect(options.openPianoRoll).not.toHaveBeenCalled()
  })
})
