import { createTestingPinia } from "@pinia/testing"
import { setActivePinia } from "pinia"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useMixerStore } from "./mixer"
import { EMPTY_PROJECT_GRAPH, useProjectGraphStore } from "./projectGraph"
import { useRecordingStore } from "./recording"
import { useStudioWorkflowStore } from "./studioWorkflow"
import { useTransportStore } from "./transport"

beforeEach(() => {
  setActivePinia(
    createTestingPinia({
      createSpy: vi.fn,
      stubActions: (_action, store) => store.$id !== "studio-workflow"
    })
  )
})

describe("stopRecording", () => {
  function activeSession(overrides: Record<string, unknown> = {}) {
    return {
      id: "take-1",
      startedAt: 1,
      swapPath: "/swap/take",
      startFrame: 0,
      trackIds: ["audio"],
      ...overrides
    }
  }

  it("reloads the mixer after MIDI takes are committed in main", async () => {
    const mixerStore = useMixerStore()
    const recordingStore = useRecordingStore()
    const workflowStore = useStudioWorkflowStore()
    const { useProjectStore } = await import("./project")
    const projectStore = useProjectStore()
    recordingStore.resource = {
      recording: { kind: "recording", id: "take-1", epoch: "1", generation: 1 },
      revision: 1,
      session: activeSession({
        startTick: 960,
        trackIds: ["track:keys"],
        midiTrackIds: ["track:keys"]
      }),
      project: { kind: "project", id: "p", epoch: "1", generation: 1 },
      projectGraph: { kind: "project-graph", id: "g", epoch: "1", generation: 1 },
      audioEngine: { kind: "audio-engine", id: "a", epoch: "1", generation: 1 }
    } as never
    vi.mocked(recordingStore.stop).mockResolvedValue({
      id: "take-1",
      state: "committed",
      audioPath: "/swap/take.midi-only",
      sidecarPath: "/swap/take.recording.json",
      projectPath: "/tmp/project.yadaw",
      sampleRate: 48_000,
      channels: 0,
      startedAt: 1,
      startFrame: 0,
      startTick: 960,
      dropoutFrames: 0,
      assetExists: true,
      recordedTracks: [],
      midiTakes: [
        {
          trackId: "track:keys",
          sourceId: "source-1",
          clipId: "clip-1",
          journalPath: "/swap/take.midijournal",
          eventCount: 2,
          droppedEvents: 0
        }
      ]
    })
    vi.mocked(projectStore.refreshAssets).mockResolvedValue(undefined)
    vi.mocked(projectStore.markDirty).mockImplementation(() => undefined)
    vi.mocked(recordingStore.refreshPending).mockResolvedValue([] as never)
    vi.mocked(mixerStore.reload).mockResolvedValue(undefined)
    vi.mocked(mixerStore.execute).mockResolvedValue(undefined as never)

    await expect(workflowStore.stopRecording()).resolves.toMatchObject({ id: "take-1" })
    expect(mixerStore.reload).toHaveBeenCalledOnce()
    expect(mixerStore.execute).not.toHaveBeenCalled()
    expect(projectStore.markDirty).toHaveBeenCalledOnce()
    expect(recordingStore.refreshPending).toHaveBeenCalledOnce()
  })

  it("creates audio clips without reloading for audio-only takes", async () => {
    const mixerStore = useMixerStore()
    const recordingStore = useRecordingStore()
    const workflowStore = useStudioWorkflowStore()
    const { useProjectStore } = await import("./project")
    const projectStore = useProjectStore()
    mixerStore.graph = {
      ...structuredClone(EMPTY_PROJECT_GRAPH),
      sampleRate: 48_000,
      tracks: [{ id: "track:audio", channelId: "audio", sortOrder: 0 }]
    }
    recordingStore.resource = {
      recording: { kind: "recording", id: "take-1", epoch: "1", generation: 1 },
      revision: 1,
      session: activeSession({ startFrame: 480, trackIds: ["audio"] }),
      project: { kind: "project", id: "p", epoch: "1", generation: 1 },
      projectGraph: { kind: "project-graph", id: "g", epoch: "1", generation: 1 },
      audioEngine: { kind: "audio-engine", id: "a", epoch: "1", generation: 1 }
    } as never
    vi.mocked(recordingStore.stop).mockResolvedValue({
      id: "take-1",
      state: "committed",
      audioPath: "/swap/take.ready.bwf",
      sidecarPath: "/swap/take.recording.json",
      projectPath: "/tmp/project.yadaw",
      sampleRate: 48_000,
      channels: 2,
      startedAt: 1,
      startFrame: 480,
      dropoutFrames: 0,
      assetExists: true,
      recordedTracks: [
        {
          assetId: "asset-1",
          trackId: "audio",
          name: "Recording Audio",
          sampleRate: 48_000,
          channels: 2,
          frameCount: 4_800
        }
      ],
      midiTakes: []
    })
    vi.mocked(projectStore.refreshAssets).mockResolvedValue(undefined)
    vi.mocked(projectStore.markDirty).mockImplementation(() => undefined)
    vi.mocked(recordingStore.refreshPending).mockResolvedValue([] as never)
    vi.mocked(mixerStore.reload).mockResolvedValue(undefined)
    vi.mocked(mixerStore.execute).mockResolvedValue(undefined as never)

    await workflowStore.stopRecording()
    expect(mixerStore.execute).toHaveBeenCalledOnce()
    expect(mixerStore.reload).not.toHaveBeenCalled()
  })
})

describe("startRecording", () => {
  it("keeps a muted metronome muted during count-in", async () => {
    const graphStore = useProjectGraphStore()
    graphStore.graph = {
      ...structuredClone(EMPTY_PROJECT_GRAPH),
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
          outputChannelId: null,
          recordArmed: true,
          inputMonitoring: false,
          inputChannels: [1, 2],
          hardwareOutputChannels: []
        },
        {
          id: "metronome",
          kind: "instrument",
          systemRole: "metronome",
          name: "Metronome",
          color: "#AD8CFF",
          sortOrder: 0,
          inputSource: null,
          inputFormat: null,
          gainDb: 0,
          pan: 0,
          muted: true,
          soloed: false,
          outputChannelId: null,
          recordArmed: false,
          inputMonitoring: false,
          inputChannels: [],
          hardwareOutputChannels: []
        }
      ]
    }
    const mixerStore = useMixerStore()
    const recordingStore = useRecordingStore()
    const transportStore = useTransportStore()
    const workflowStore = useStudioWorkflowStore()
    transportStore.countInEnabled = true
    vi.mocked(recordingStore.start).mockResolvedValue({
      id: "take-1",
      startedAt: 1_000,
      swapPath: "/swap/take-1.bwf",
      startFrame: 0,
      trackIds: ["audio"]
    })

    await expect(workflowStore.startRecording()).resolves.toBe(true)

    expect(recordingStore.start).toHaveBeenCalledWith(true)
    expect(mixerStore.toggleMetronome).not.toHaveBeenCalled()
    expect(mixerStore.metronome?.muted).toBe(true)
  })
})

describe("closeProject", () => {
  it("clears the session loop in native before resetting renderer state", async () => {
    const { useProjectStore } = await import("./project")
    const projectStore = useProjectStore()
    const transportStore = useTransportStore()
    const workflowStore = useStudioWorkflowStore()
    vi.mocked(projectStore.prepareClose).mockResolvedValue("discard")
    vi.mocked(projectStore.close).mockResolvedValue(true)
    vi.mocked(transportStore.setLoop).mockResolvedValue(undefined)
    vi.mocked(transportStore.stop).mockResolvedValue(undefined)

    await expect(workflowStore.closeProject()).resolves.toBe(true)

    expect(transportStore.setLoop).toHaveBeenCalledWith(false, null)
    expect(transportStore.setLoop).toHaveBeenCalledBefore(vi.mocked(transportStore.stop))
    expect(transportStore.reset).toHaveBeenCalledOnce()
  })
})
