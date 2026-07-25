import { createPinia, setActivePinia } from "pinia"
import { mount } from "@vue/test-utils"
import { describe, expect, it, vi } from "vitest"
import type { MixerChannelState } from "@yadaw/contracts"
import type { Asset } from "@yadaw/project-db/schema"
import { useProjectStore } from "../../stores/project"
import { useMixerStore } from "../../stores/mixer"
import ArrangementWorkspace from "./ArrangementWorkspace.vue"

const recordingAsset: Asset = {
  id: "recording-1",
  name: "First take.bwf",
  mimeType: "audio/x-bwf",
  contentHash: "hash",
  byteLength: 100n,
  sampleRate: 48_000,
  channels: 2,
  bitDepth: "float32",
  frameCount: 48_000n,
  bwfTimeReference: 0n,
  largeObjectOid: 1,
  createdAt: new Date()
}

describe("ArrangementWorkspace", () => {
  it("renders project audio as a selectable timeline clip", async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const project = useProjectStore()
    project.session = {
      id: "project",
      path: "project.yadaw",
      configuration: {
        name: "Session",
        sampleRate: 48_000,
        tempo: 120,
        timeSignatureNumerator: 4,
        timeSignatureDenominator: 4,
        waveformDisplayMode: "separate"
      },
      dirty: true,
      recoveredWorkingCopy: false
    }
    project.projectAssets = [recordingAsset]
    const mixer = useMixerStore()
    mixer.graph = {
      sampleRate: 48_000,
      channels: [
        {
          id: "audio-1", kind: "audio", name: "Audio 1", color: "#8C83FF",
          sortOrder: 0, inputFormat: "stereo", gainDb: 0, pan: 0, muted: false,
          soloed: false, outputChannelId: "output", recordArmed: false,
          inputChannels: [1, 2], hardwareOutputChannels: []
        },
        {
          id: "audio-2", kind: "audio", name: "Audio 2", color: "#67D9E7",
          sortOrder: 1, inputFormat: "mono", gainDb: 0, pan: 0, muted: false,
          soloed: false, outputChannelId: "output", recordArmed: false,
          inputChannels: [1], hardwareOutputChannels: []
        },
        {
          id: "master", kind: "master", name: "Master", color: "#67D9E7",
          sortOrder: 0, inputFormat: null, gainDb: 0, pan: 0, muted: false,
          soloed: false, outputChannelId: null, recordArmed: false, inputChannels: [],
          hardwareOutputChannels: []
        },
        {
          id: "output", kind: "output", name: "Output 1–2", color: "#73D6A2",
          sortOrder: 0, inputFormat: null, gainDb: 0, pan: 0, muted: false,
          soloed: false, outputChannelId: null, recordArmed: false, inputChannels: [],
          hardwareOutputChannels: [1, 2]
        }
      ],
      clips: [{
        id: recordingAsset.id,
        assetId: recordingAsset.id,
        trackId: "audio-1",
        name: "First take",
        startFrame: 0,
        sourceOffsetFrames: 0,
        lengthFrames: 48_000,
        assetSampleRate: 48_000,
        assetChannels: 2
      }],
      sends: []
    }

    const wrapper = mount(ArrangementWorkspace, {
      props: {
        recordingId: null,
        recordingStartedAt: null,
        recordingStartFrame: null,
        recordingError: ""
      },
      global: { plugins: [pinia] }
    })

    expect(wrapper.findAll(".track-lane")).toHaveLength(2)
    expect(wrapper.findAll('[data-testid="timeline-playhead"]')).toHaveLength(1)
    const clip = wrapper.get('button[aria-label="Audio clip First take"]')
    expect(clip.attributes("aria-pressed")).toBe("false")
    await clip.trigger("click")
    expect(clip.attributes("aria-pressed")).toBe("true")
    expect(wrapper.text()).toContain("First take")
    expect(wrapper.text()).toContain("1 clip")
    expect(wrapper.get(".waveform").attributes("style")).toContain("width: 1px")
    expect(wrapper.get('[aria-label="2 channels audio"]').findAll("path")).toHaveLength(2)
    expect(wrapper.text()).not.toContain("2 CH")

    const updateChannel = vi.spyOn(mixer, "updateChannel").mockResolvedValue(true)
    await wrapper
      .get('button[aria-label="Audio 1; double-click to rename; Alt+Arrow Up or Down to reorder"]')
      .trigger("dblclick")
    const nameEditor = wrapper.get('input[aria-label="Rename Audio 1"]')
    await nameEditor.setValue("  Rhythm Guitar  ")
    await nameEditor.trigger("blur")
    expect(updateChannel).toHaveBeenCalledWith("audio-1", { name: "Rhythm Guitar" })
  })

  it("shows a growing capture clip while recording", () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const project = useProjectStore()
    project.session = {
      id: "project",
      path: "project.yadaw",
      configuration: {
        name: "Session",
        sampleRate: 48_000,
        tempo: 120,
        timeSignatureNumerator: 4,
        timeSignatureDenominator: 4,
        waveformDisplayMode: "separate"
      },
      dirty: false,
      recoveredWorkingCopy: false
    }
    const mixer = useMixerStore()
    mixer.graph = {
      sampleRate: 48_000,
      channels: [
        {
          id: "audio-1", kind: "audio", name: "Audio 1", color: "#8C83FF",
          sortOrder: 0, inputFormat: "stereo", gainDb: 0, pan: 0, muted: false,
          soloed: false, outputChannelId: "output", recordArmed: true,
          inputChannels: [1, 2], hardwareOutputChannels: []
        },
        {
          id: "master", kind: "master", name: "Master", color: "#67D9E7",
          sortOrder: 0, inputFormat: null, gainDb: 0, pan: 0, muted: false,
          soloed: false, outputChannelId: null, recordArmed: false, inputChannels: [],
          hardwareOutputChannels: []
        },
        {
          id: "output", kind: "output", name: "Output 1–2", color: "#73D6A2",
          sortOrder: 0, inputFormat: null, gainDb: 0, pan: 0, muted: false,
          soloed: false, outputChannelId: null, recordArmed: false, inputChannels: [],
          hardwareOutputChannels: [1, 2]
        }
      ],
      clips: [],
      sends: []
    }

    const wrapper = mount(ArrangementWorkspace, {
      props: {
        recordingId: "recording-live",
        recordingStartedAt: Date.now() - 1_000,
        recordingStartFrame: 0,
        recordingError: ""
      },
      global: { plugins: [pinia] }
    })

    expect(wrapper.get('button[aria-label="Recording New recording"]').attributes("aria-label"))
      .toBe("Recording New recording")
    expect(wrapper.text()).toContain("Recording")
  })

  it("keeps the track rail aligned with vertical timeline scrolling", async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const mixer = useMixerStore()
    const channels: MixerChannelState[] = [
      ...Array.from({ length: 8 }, (_, index) => ({
        id: `audio-${index + 1}`,
        kind: "audio" as const,
        name: `Audio ${index + 1}`,
        color: "#8C83FF",
        sortOrder: index,
        inputFormat: "stereo" as const,
        gainDb: 0,
        pan: 0,
        muted: false,
        soloed: false,
        outputChannelId: "output",
        recordArmed: false,
        inputChannels: [1, 2],
        hardwareOutputChannels: []
      })),
      {
        id: "master",
        kind: "master",
        name: "Master",
        color: "#67D9E7",
        sortOrder: 0,
        inputFormat: null,
        gainDb: 0,
        pan: 0,
        muted: false,
        soloed: false,
        outputChannelId: null,
        recordArmed: false,
        inputChannels: [],
        hardwareOutputChannels: []
      },
      {
        id: "output",
        kind: "output",
        name: "Output 1–2",
        color: "#73D6A2",
        sortOrder: 0,
        inputFormat: null,
        gainDb: 0,
        pan: 0,
        muted: false,
        soloed: false,
        outputChannelId: null,
        recordArmed: false,
        inputChannels: [],
        hardwareOutputChannels: [1, 2]
      }
    ]
    mixer.graph = {
      sampleRate: 48_000,
      channels,
      clips: [],
      sends: []
    }

    const wrapper = mount(ArrangementWorkspace, {
      props: {
        recordingId: null,
        recordingStartedAt: null,
        recordingStartFrame: null,
        recordingError: ""
      },
      global: { plugins: [pinia] }
    })
    const viewport = wrapper.get<HTMLElement>('[data-testid="timeline-viewport"]')
    const rail = wrapper.get<HTMLElement>('[data-testid="timeline-rail"]')

    Object.defineProperties(viewport.element, {
      offsetHeight: { configurable: true, value: 400 },
      clientHeight: { configurable: true, value: 384 }
    })
    viewport.element.scrollTop = 240
    await viewport.trigger("scroll")
    expect(rail.element.scrollTop).toBe(240)
    expect(rail.element.style.paddingBottom).toBe("16px")

    await rail.trigger("wheel", { deltaY: 80 })
    expect(viewport.element.scrollTop).toBe(320)
    expect(rail.element.scrollTop).toBe(320)
  })
})
