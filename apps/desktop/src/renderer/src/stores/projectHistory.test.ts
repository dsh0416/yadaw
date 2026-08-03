import { createPinia, setActivePinia } from "pinia"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ProjectCommand, ProjectCommandResult, ProjectGraphSnapshot } from "@yadaw/contracts"
import { applyToGraph, inverseFor } from "@yadaw/project-model"
import { useProjectGraphStore } from "./projectGraph"
import { useProjectHistoryStore } from "./projectHistory"

function graph(): ProjectGraphSnapshot {
  return {
    sampleRate: 48_000,
    tracks: [{ id: "track:audio", channelId: "audio", sortOrder: 0 }],
    channels: [
      {
        id: "audio",
        kind: "audio",
        systemRole: null,
        name: "Audio",
        color: "#8C83FF",
        sortOrder: 0,
        inputSource: "hardware",
        inputFormat: "stereo",
        gainDb: 0,
        pan: 0,
        muted: false,
        soloed: false,
        outputChannelId: "output",
        recordArmed: false,
        inputMonitoring: false,
        inputChannels: [1, 2],
        hardwareOutputChannels: []
      },
      {
        id: "output",
        kind: "output",
        systemRole: null,
        name: "Output",
        color: "#73D6A2",
        sortOrder: 0,
        inputSource: null,
        inputFormat: null,
        gainDb: 0,
        pan: 0,
        muted: false,
        soloed: false,
        outputChannelId: null,
        recordArmed: false,
        inputMonitoring: false,
        inputChannels: [],
        hardwareOutputChannels: [1, 2]
      }
    ],
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

const gainCommand: ProjectCommand = {
  type: "update-channel",
  channelId: "audio",
  patch: { gainDb: -6 }
}

beforeEach(() => {
  setActivePinia(createPinia())
  const graphStore = useProjectGraphStore()
  graphStore.hydrate(graph())
})

describe("useProjectHistoryStore", () => {
  it("records undo entries and clears redo history on new edits", () => {
    const history = useProjectHistoryStore()
    history.record({ forward: gainCommand, inverse: { ...gainCommand, patch: { gainDb: 0 } } })
    history.record({
      forward: { ...gainCommand, patch: { gainDb: -12 } },
      inverse: { ...gainCommand, patch: { gainDb: -6 } }
    })
    history.redoHistory = [{ forward: gainCommand, inverse: gainCommand }]

    history.record({
      forward: { ...gainCommand, patch: { gainDb: -3 } },
      inverse: { ...gainCommand, patch: { gainDb: -12 } }
    })

    expect(history.canUndo).toBe(true)
    expect(history.canRedo).toBe(false)
    expect(history.undoHistory).toHaveLength(3)
  })

  it("undoes and redoes through the project graph store", async () => {
    const graphStore = useProjectGraphStore()
    const history = useProjectHistoryStore()
    const execute = vi.spyOn(graphStore, "execute").mockImplementation(async (command) => {
      graphStore.graph = applyToGraph(graphStore.graph, command)
      return true
    })

    history.record({ forward: gainCommand, inverse: { ...gainCommand, patch: { gainDb: 0 } } })
    expect(graphStore.graph.channels[0]?.gainDb).toBe(0)

    await history.undo()
    expect(execute).toHaveBeenCalledWith({ ...gainCommand, patch: { gainDb: 0 } })
    expect(history.canUndo).toBe(false)
    expect(history.canRedo).toBe(true)

    await history.redo()
    expect(execute).toHaveBeenLastCalledWith(gainCommand)
    expect(history.canUndo).toBe(true)
    expect(history.canRedo).toBe(false)
  })

  it("does not move history when graph execution fails", async () => {
    const graphStore = useProjectGraphStore()
    const history = useProjectHistoryStore()
    vi.spyOn(graphStore, "execute").mockResolvedValue(false)
    history.record({ forward: gainCommand, inverse: { ...gainCommand, patch: { gainDb: 0 } } })

    await history.undo()

    expect(history.canUndo).toBe(true)
    expect(history.canRedo).toBe(false)
  })

  it("accepts external command results into history", () => {
    const graphStore = useProjectGraphStore()
    const history = useProjectHistoryStore()
    const acceptExternalResult = vi.spyOn(graphStore, "acceptExternalResult")
    const result: ProjectCommandResult = {
      graph: applyToGraph(graphStore.graph, gainCommand),
      inverse: { ...gainCommand, patch: { gainDb: 0 } }
    }

    history.acceptExternalResult(result)

    expect(acceptExternalResult).toHaveBeenCalledWith(result)
    expect(history.undoHistory).toHaveLength(1)
    expect(history.undoHistory[0]?.forward).toEqual(inverseFor(result.graph, result.inverse))
    expect(history.undoHistory[0]?.inverse).toEqual(result.inverse)
  })

  it("clears both stacks", () => {
    const history = useProjectHistoryStore()
    history.record({ forward: gainCommand, inverse: { ...gainCommand, patch: { gainDb: 0 } } })
    history.redoHistory = [{ forward: gainCommand, inverse: gainCommand }]

    history.clear()

    expect(history.canUndo).toBe(false)
    expect(history.canRedo).toBe(false)
  })
})
