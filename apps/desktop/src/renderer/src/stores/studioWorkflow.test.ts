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
