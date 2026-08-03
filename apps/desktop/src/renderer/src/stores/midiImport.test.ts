import { createPinia, setActivePinia } from "pinia"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type {
  MidiImportCommitResult,
  MidiImportPreview,
  ProjectGraphSnapshot,
  ProjectWorkspaceSnapshot,
  RpcResult
} from "@heron/contracts"
import { useMidiImportStore } from "./midiImport"
import { useMixerStore } from "./mixer"
import { useProjectHistoryStore } from "./projectHistory"
import { useTransportStore } from "./transport"
import { useProjectStore } from "./project"

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

function workspace(graph: ProjectGraphSnapshot): ProjectWorkspaceSnapshot {
  return {
    project: {
      kind: "project-session",
      id: "project",
      epoch: "test-main",
      generation: 1
    },
    projectGraph: {
      kind: "project-graph",
      id: "project:graph",
      epoch: "test-main",
      generation: 1
    },
    revision: 2,
    session: {
      id: "project",
      path: "project.yadaw",
      configuration: {
        name: "MIDI import test",
        sampleRate: 48_000,
        timeSignatureNumerator: 4,
        timeSignatureDenominator: 4,
        waveformDisplayMode: "separate"
      },
      dirty: true,
      recoveredWorkingCopy: false
    },
    graph: structuredClone(graph),
    assets: []
  }
}

function success(graph: ProjectGraphSnapshot): RpcResult<MidiImportCommitResult> {
  return {
    ok: true,
    requestId: "midi-import-request",
    operationId: "midi-import-operation",
    resourceRevision: 2,
    warnings: [],
    value: {
      command: { graph: structuredClone(graph), inverse: { type: "batch", commands: [] } },
      workspace: workspace(graph)
    }
  }
}

describe("MIDI import tempo choice", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const mixer = useMixerStore()
    useProjectStore().applyWorkspace(workspace(mixer.graph))
    Object.assign(window.heron, { commitMidiImport: vi.fn() })
  })

  it("keeps the project Tempo Track by default and imports at the playhead", async () => {
    const mixer = useMixerStore()
    const transport = useTransportStore()
    transport.snapshot = {
      state: "stopped",
      positionFrames: 192_000,
      sampleRate: 48_000,
      loopEnabled: false,
      loopRange: null
    }
    const store = useMidiImportStore()
    store.preview = preview
    store.targets = { "0:0": { type: "new" } }
    vi.mocked(window.heron.commitMidiImport).mockResolvedValue(success(mixer.graph))

    await store.commit()

    expect(useProjectHistoryStore().canUndo).toBe(true)
    expect(window.heron.commitMidiImport).toHaveBeenCalledWith(
      expect.any(Object),
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
    vi.mocked(window.heron.commitMidiImport).mockResolvedValue(success(mixer.graph))

    await store.commit()

    expect(window.heron.commitMidiImport).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        importTempoMap: true,
        insertionTick: 0
      })
    )
  })
})
