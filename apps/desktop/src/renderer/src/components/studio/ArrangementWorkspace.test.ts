import { createPinia, setActivePinia } from "pinia"
import { flushPromises, mount } from "@vue/test-utils"
import { describe, expect, it, vi } from "vitest"
import type { MixerChannelState } from "@yadaw/contracts"
import type { ProjectAssetSummary as Asset } from "@yadaw/contracts"
import { useProjectStore } from "../../stores/project"
import { useMixerStore } from "../../stores/mixer"
import { useArrangementViewStore } from "../../stores/arrangementView"
import { usePianoRollStore } from "../../stores/pianoRoll"
import { useStudioWorkspaceStore } from "../../stores/studioWorkspace"
import ArrangementWorkspace from "./ArrangementWorkspace.vue"

const recordingAsset: Asset = {
  id: "recording-1",
  name: "First take.bwf",
  sampleRate: 48_000,
  channels: 2,
  bitDepth: "float32",
  frameCount: 48_000n
}

describe("ArrangementWorkspace", () => {
  it("renders project audio as a selectable timeline clip", async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const project = useProjectStore()
    project.applyLifecycleState({
      status: "open",
      session: {
        id: "project",
        path: "project.yadaw",
        configuration: {
          name: "Session",
          sampleRate: 48_000,
          timeSignatureNumerator: 4,
          timeSignatureDenominator: 4,
          waveformDisplayMode: "separate"
        },
        dirty: true,
        recoveredWorkingCopy: false
      },
      error: null
    })
    project.projectAssets = [recordingAsset]
    const mixer = useMixerStore()
    mixer.graph = {
      sampleRate: 48_000,
      channels: [
        {
          id: "audio-1",
          kind: "audio",
          systemRole: null,
          name: "Audio 1",
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
          id: "audio-2",
          kind: "audio",
          systemRole: null,
          name: "Audio 2",
          color: "#67D9E7",
          sortOrder: 1,
          inputSource: "hardware",
          inputFormat: "mono",
          gainDb: 0,
          pan: 0,
          muted: false,
          soloed: false,
          outputChannelId: "output",
          recordArmed: false,
          inputMonitoring: false,
          inputChannels: [1],
          hardwareOutputChannels: []
        },
        {
          id: "master",
          kind: "master",
          systemRole: null,
          name: "Master",
          color: "#67D9E7",
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
          hardwareOutputChannels: []
        },
        {
          id: "output",
          kind: "output",
          systemRole: null,
          name: "Output 1–2",
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
      clips: [
        {
          id: recordingAsset.id,
          assetId: recordingAsset.id,
          trackId: "audio-1",
          name: "First take",
          startFrame: 0,
          sourceOffsetFrames: 0,
          lengthFrames: 48_000,
          assetSampleRate: 48_000,
          assetChannels: 2
        }
      ],
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

    const wrapper = mount(ArrangementWorkspace, {
      props: {
        recordingId: null,
        recordingStartedAt: null,
        recordingStartFrame: null,
        recordingError: ""
      },
      global: { plugins: [pinia] }
    })

    expect(wrapper.find('button[aria-label="Toggle mixer dock"]').exists()).toBe(false)
    expect(wrapper.find(".tempo-readout").exists()).toBe(false)
    expect(wrapper.findAll(".track-lane")).toHaveLength(2)
    expect(wrapper.findAll('[data-testid="timeline-playhead"]')).toHaveLength(1)
    expect(wrapper.findAll(".beat-mark").length).toBeGreaterThan(0)
    expect(wrapper.findAll(".beat-line").length).toBeGreaterThan(0)
    expect(wrapper.findAll(".beat-guide").length).toBeGreaterThan(0)
    expect(wrapper.get('[aria-label="Tempo global track"]').text()).toContain("Tempo")
    expect(wrapper.get('[aria-label="Meter global track"]').text()).toContain("Meter")
    expect(wrapper.get('[aria-label="Key global track"]').text()).toContain("Key")
    const keySelect = wrapper.get<HTMLSelectElement>('[aria-label="Selected Key signature"]')
    expect(keySelect.findAll("optgroup").map((group) => group.attributes("label"))).toEqual([
      "Major keys",
      "Minor keys"
    ])
    expect(keySelect.findAll("option").map((option) => option.text())).toEqual([
      "C♯ Major",
      "F♯ Major",
      "B Major",
      "E Major",
      "A Major",
      "D Major",
      "G Major",
      "C Major",
      "F Major",
      "B♭ Major",
      "E♭ Major",
      "A♭ Major",
      "D♭ Major",
      "G♭ Major",
      "C♭ Major",
      "────────────────",
      "A♯ minor",
      "D♯ minor",
      "G♯ minor",
      "C♯ minor",
      "F♯ minor",
      "B minor",
      "E minor",
      "A minor",
      "D minor",
      "G minor",
      "C minor",
      "F minor",
      "B♭ minor",
      "E♭ minor",
      "A♭ minor"
    ])
    const executeKeyChange = vi.spyOn(mixer, "execute").mockResolvedValue(true)
    await keySelect.setValue("major:-7")
    expect(executeKeyChange).toHaveBeenCalledWith({
      type: "replace-key-signature-map",
      events: [{ tick: 0, fifths: -7, mode: "major" }]
    })
    expect(wrapper.findAll(".point-handle")).toHaveLength(1)
    expect(wrapper.findAll(".event-handle")).toHaveLength(2)
    const clip = wrapper.get('button[aria-label="Audio clip First take"]')
    expect(clip.attributes("aria-pressed")).toBe("false")
    expect(clip.attributes("style")).toContain("width: 100px")
    mixer.graph = {
      ...mixer.graph,
      tempoMap: {
        ...mixer.graph.tempoMap,
        tempoEvents: [{ tick: 0, beatsPerMinute: 180 }]
      }
    }
    await wrapper.vm.$nextTick()
    expect(clip.attributes("style")).toContain("width: 150px")
    await clip.trigger("click")
    expect(clip.attributes("aria-pressed")).toBe("true")
    expect(wrapper.text()).toContain("First take")
    expect(wrapper.text()).not.toContain("ARRANGEMENT")
    expect(wrapper.text()).not.toContain("2 TRACKS")
    expect(wrapper.text()).not.toContain("2 tracks · 1 clips")
    expect(wrapper.text()).not.toContain("INPUT 1–2")
    expect(wrapper.find('[role="status"]').exists()).toBe(false)
    expect(wrapper.findAll(".track-quick-controls")).toHaveLength(2)
    expect(wrapper.get(".waveform").attributes("style")).toContain("width: 1px")
    expect(wrapper.get('[aria-label="2 channels audio"]').findAll("path")).toHaveLength(2)
    expect(wrapper.text()).not.toContain("2 CH")

    const arrangementView = useArrangementViewStore()
    await wrapper.get('button[aria-label="Collapse Tempo track"]').trigger("click")
    expect(arrangementView.tempoLaneExpanded).toBe(false)
    expect(
      wrapper.get<HTMLElement>('[data-testid="timeline-rail"]').element.style.gridTemplateRows
    ).toContain("30px")
    await wrapper.get('button[aria-label="Expand Tempo track"]').trigger("click")
    await wrapper.get('button[aria-label="Collapse Meter track"]').trigger("click")
    expect(arrangementView.meterLaneExpanded).toBe(false)
    await wrapper.get('button[aria-label="Expand Meter track"]').trigger("click")
    await wrapper.get('button[aria-label="Collapse Key track"]').trigger("click")
    expect(arrangementView.keyLaneExpanded).toBe(false)
    await wrapper.get('button[aria-label="Expand Key track"]').trigger("click")
    const resizeHandles = wrapper.findAll('[role="separator"]')
    expect(resizeHandles).toHaveLength(2)
    expect(wrapper.findAll<HTMLElement>(".track-lane")[0]?.element.style.height).toBe("104px")
    expect(wrapper.findAll<HTMLElement>(".track-lane")[1]?.element.style.height).toBe("104px")

    await resizeHandles[0]?.trigger("keydown", { key: "ArrowDown" })
    expect(arrangementView.trackScale("audio-1")).toBe(1.25)
    expect(wrapper.findAll<HTMLElement>(".track-lane")[0]?.element.style.height).toBe("130px")
    expect(wrapper.findAll<HTMLElement>(".track-lane")[1]?.element.style.height).toBe("104px")

    arrangementView.zoomTrack(1)
    await wrapper.vm.$nextTick()
    expect(wrapper.findAll<HTMLElement>(".track-lane")[0]?.element.style.height).toBe("150px")
    expect(wrapper.findAll<HTMLElement>(".track-lane")[1]?.element.style.height).toBe("120px")
    expect(
      wrapper.get<HTMLElement>('[data-testid="timeline-rail"]').element.style.gridTemplateRows
    ).toContain("150px 120px")

    await resizeHandles[0]?.trigger("dblclick")
    expect(arrangementView.trackScale("audio-1")).toBe(1)
    expect(wrapper.findAll<HTMLElement>(".track-lane")[0]?.element.style.height).toBe("120px")

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
    project.applyLifecycleState({
      status: "open",
      session: {
        id: "project",
        path: "project.yadaw",
        configuration: {
          name: "Session",
          sampleRate: 48_000,
          timeSignatureNumerator: 4,
          timeSignatureDenominator: 4,
          waveformDisplayMode: "separate"
        },
        dirty: false,
        recoveredWorkingCopy: false
      },
      error: null
    })
    const mixer = useMixerStore()
    mixer.graph = {
      sampleRate: 48_000,
      channels: [
        {
          id: "audio-1",
          kind: "audio",
          systemRole: null,
          name: "Audio 1",
          color: "#8C83FF",
          sortOrder: 0,
          inputSource: "hardware",
          inputFormat: "stereo",
          gainDb: 0,
          pan: 0,
          muted: false,
          soloed: false,
          outputChannelId: "output",
          recordArmed: true,
          inputMonitoring: false,
          inputChannels: [1, 2],
          hardwareOutputChannels: []
        },
        {
          id: "master",
          kind: "master",
          systemRole: null,
          name: "Master",
          color: "#67D9E7",
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
          hardwareOutputChannels: []
        },
        {
          id: "output",
          kind: "output",
          systemRole: null,
          name: "Output 1–2",
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
      clips: [],
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

    const wrapper = mount(ArrangementWorkspace, {
      props: {
        recordingId: "recording-live",
        recordingStartedAt: Date.now() - 1_000,
        recordingStartFrame: 0,
        recordingError: ""
      },
      global: { plugins: [pinia] }
    })

    expect(
      wrapper.get('button[aria-label="Recording New recording"]').attributes("aria-label")
    ).toBe("Recording New recording")
    expect(wrapper.find('[role="status"]').exists()).toBe(false)
  })

  it("keeps the track rail aligned with vertical timeline scrolling", async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const mixer = useMixerStore()
    const channels: MixerChannelState[] = [
      ...Array.from({ length: 8 }, (_, index) => ({
        id: `audio-${index + 1}`,
        kind: "audio" as const,
        systemRole: null,
        name: `Audio ${index + 1}`,
        color: "#8C83FF",
        sortOrder: index,
        inputSource: "hardware" as const,
        inputFormat: "stereo" as const,
        gainDb: 0,
        pan: 0,
        muted: false,
        soloed: false,
        outputChannelId: "output",
        recordArmed: false,
        inputMonitoring: false,
        inputChannels: [1, 2],
        hardwareOutputChannels: []
      })),
      {
        id: "master",
        kind: "master",
        systemRole: null,
        name: "Master",
        color: "#67D9E7",
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
        hardwareOutputChannels: []
      },
      {
        id: "output",
        kind: "output",
        systemRole: null,
        name: "Output 1–2",
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
    ]
    mixer.graph = {
      sampleRate: 48_000,
      channels,
      clips: [],
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

  it("creates a snapped one-bar MIDI clip and opens it from an empty Instrument lane", async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const mixer = useMixerStore()
    mixer.graph = {
      sampleRate: 48_000,
      channels: [
        {
          id: "instrument-1",
          kind: "instrument",
          systemRole: null,
          name: "Instrument 1",
          color: "#73D6A2",
          sortOrder: 0,
          inputSource: null,
          inputFormat: null,
          gainDb: 0,
          pan: 0,
          muted: false,
          soloed: false,
          outputChannelId: "output",
          recordArmed: false,
          inputMonitoring: false,
          inputChannels: [],
          hardwareOutputChannels: []
        },
        {
          id: "master",
          kind: "master",
          systemRole: null,
          name: "Master",
          color: "#8C83FF",
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
          hardwareOutputChannels: []
        },
        {
          id: "output",
          kind: "output",
          systemRole: null,
          name: "Output",
          color: "#EF7C95",
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
      clips: [],
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
    const execute = vi.spyOn(mixer, "execute").mockResolvedValue(true)
    useArrangementViewStore().setTimeZoom(120)
    const randomUuid = vi
      .spyOn(crypto, "randomUUID")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000001")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000002")
    const wrapper = mount(ArrangementWorkspace, {
      props: {
        recordingId: null,
        recordingStartedAt: null,
        recordingStartFrame: null,
        recordingError: ""
      },
      global: { plugins: [pinia] }
    })
    const lane = wrapper.get<HTMLElement>(".midi-track")
    Object.defineProperty(lane.element, "getBoundingClientRect", {
      value: () => ({ left: 20 })
    })

    await lane.trigger("dblclick", { clientX: 145 })
    await flushPromises()

    expect(execute).toHaveBeenCalledWith({
      type: "batch",
      commands: [
        {
          type: "create-midi-source",
          source: {
            id: "00000000-0000-4000-8000-000000000001",
            name: "MIDI Clip 1",
            contentHash: "blank:00000000-0000-4000-8000-000000000001",
            rawBytes: new Uint8Array()
          }
        },
        {
          type: "create-midi-clip",
          clip: {
            id: "00000000-0000-4000-8000-000000000002",
            sourceId: "00000000-0000-4000-8000-000000000001",
            trackId: "instrument-1",
            name: "MIDI Clip 1",
            startTick: 960,
            lengthTicks: 3_840,
            sourceOffsetTicks: 0,
            notes: [],
            events: []
          }
        }
      ]
    })
    expect(usePianoRollStore().openClipIds).toEqual(["00000000-0000-4000-8000-000000000002"])
    expect(useStudioWorkspaceStore().activeLowerDock).toBe("piano-roll")

    randomUuid.mockRestore()
    wrapper.unmount()
  })
})
