import { createPinia, setActivePinia } from "pinia"
import { DOMWrapper, mount } from "@vue/test-utils"
import { describe, expect, it, vi } from "vitest"
import type { MixerChannelState } from "@heron/contracts"
import type { ProjectAssetSummary as Asset } from "@heron/contracts"
import { useProjectStore } from "../../stores/project"
import { useMixerStore } from "../../stores/mixer"
import { useArrangementViewStore } from "../../stores/arrangementView"
import ArrangementWorkspace from "./ArrangementWorkspace.vue"

const recordingAsset: Asset = {
  id: "recording-1",
  name: "First take.bwf",
  kind: "audio",
  contentHash: "recording-1-hash",
  sampleRate: 48_000,
  channels: 2,
  bitDepth: "float32",
  frameCount: 48_000n
}

describe("ArrangementWorkspace rendering", () => {
  it("renders project audio as a selectable timeline clip", async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const project = useProjectStore()
    project.applyLifecycleState({
      status: "open",
      session: {
        id: "project",
        path: "project.heron",
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
      tracks: [
        { id: "track:audio-1", channelId: "audio-1", sortOrder: 0 },
        { id: "track:audio-2", channelId: "audio-2", sortOrder: 1 }
      ],
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
      audioClips: [
        {
          id: recordingAsset.id,
          assetId: recordingAsset.id,
          trackId: "track:audio-1",
          name: "First take",
          startFrame: 0,
          sourceOffsetFrames: 0,
          sourceLengthFrames: Number.MAX_SAFE_INTEGER,
          fadeInFrames: 0,
          fadeOutFrames: 0,
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
    expect(wrapper.get('button[aria-label="Hide global tracks"]').attributes("aria-pressed")).toBe(
      "true"
    )
    expect(wrapper.findAll('[data-testid="timeline-playhead"]')).toHaveLength(1)
    expect(wrapper.findAll(".beat-mark").length).toBeGreaterThan(0)
    expect(wrapper.findAll(".beat-line").length).toBeGreaterThan(0)
    expect(wrapper.findAll(".beat-guide").length).toBeGreaterThan(0)
    expect(wrapper.get('[aria-label="Tempo global track"]').text()).toContain("Tempo")
    expect(wrapper.get('[aria-label="Meter global track"]').text()).toContain("Meter")
    expect(wrapper.get('[aria-label="Key global track"]').text()).toContain("Key")
    const keySelect = wrapper.get<HTMLButtonElement>('[aria-label="Selected Key signature"]')
    expect(keySelect.classes()).toContain("ui-cascading-select--workspace")
    expect(keySelect.text()).toBe("C Major")
    const executeKeyChange = vi.spyOn(mixer, "execute").mockResolvedValue(true)
    await keySelect.trigger("click")
    const keyGroups = document.body.querySelectorAll<HTMLElement>(
      ".ui-cascading-select__sub-trigger"
    )
    expect([...keyGroups].map((group) => group.textContent?.trim())).toEqual([
      "Major keys",
      "Minor keys"
    ])
    const majorKeys = new DOMWrapper(keyGroups[0])
    await majorKeys.trigger("focus")
    await majorKeys.trigger("keydown", { key: "ArrowRight" })
    const keyOptions = [
      ...document.body.querySelectorAll<HTMLElement>(".ui-cascading-select__item")
    ]
    expect(keyOptions.map((option) => option.textContent?.trim())).toEqual([
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
      "C♭ Major"
    ])
    await new DOMWrapper(keyOptions[14]).trigger("click")
    expect(executeKeyChange).toHaveBeenCalledWith({
      type: "replace-key-signature-map",
      events: [{ tick: 0, fifths: -7, mode: "major" }]
    })
    expect(wrapper.findAll(".point-handle")).toHaveLength(1)
    expect(wrapper.findAll(".event-handle")).toHaveLength(2)
    const clip = wrapper.get('[role="button"][aria-label="Audio clip First take"]')
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
    await wrapper.get('button[aria-label="Hide global tracks"]').trigger("click")
    expect(arrangementView.globalTracksExpanded).toBe(false)
    expect(wrapper.find('[aria-label="Tempo global track"]').exists()).toBe(false)
    expect(wrapper.find('[aria-label="Meter global track"]').exists()).toBe(false)
    expect(wrapper.find('[aria-label="Key global track"]').exists()).toBe(false)
    expect(wrapper.find('[aria-label^="Tempo global track editor"]').exists()).toBe(false)
    expect(wrapper.find('[aria-label^="Meter global track editor"]').exists()).toBe(false)
    expect(wrapper.find('[aria-label^="Key global track editor"]').exists()).toBe(false)
    expect(wrapper.find(".collapsed-rule").exists()).toBe(false)
    expect(
      wrapper.get<HTMLElement>('[data-testid="timeline-rail"]').element.style.gridTemplateRows
    ).not.toContain("112px 64px 64px")
    const globalTracksButton = wrapper.get('button[aria-label="Show global tracks"]')
    expect(globalTracksButton.attributes("aria-pressed")).toBe("false")
    await globalTracksButton.trigger("click")
    expect(arrangementView.globalTracksExpanded).toBe(true)
    expect(wrapper.find('[aria-label="Tempo global track"]').exists()).toBe(true)
    expect(wrapper.find('[aria-label="Meter global track"]').exists()).toBe(true)
    expect(wrapper.find('[aria-label="Key global track"]').exists()).toBe(true)
    const resizeHandles = wrapper.findAll('.track-height-resize-handle[role="separator"]')
    expect(resizeHandles).toHaveLength(2)
    expect(wrapper.findAll<HTMLElement>(".track-lane")[0]?.element.style.height).toBe("104px")
    expect(wrapper.findAll<HTMLElement>(".track-lane")[1]?.element.style.height).toBe("104px")

    await resizeHandles[0]?.trigger("keydown", { key: "ArrowDown" })
    expect(arrangementView.trackScale("track:audio-1")).toBe(1.25)
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
    expect(arrangementView.trackScale("track:audio-1")).toBe(1)
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

  it("uses the timeline viewport as the track rail's vertical scroll source", async () => {
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
      tracks: channels
        .filter((channel) => channel.kind === "audio" || channel.kind === "instrument")
        .map((channel) => ({
          id: `track:${channel.id}`,
          channelId: channel.id,
          sortOrder: channel.sortOrder
        })),
      channels,
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

    expect(viewport.element.contains(rail.element)).toBe(true)
    expect(rail.element.nextElementSibling).toBe(wrapper.get(".timeline-content").element)

    await rail.trigger("wheel", { shiftKey: true, deltaY: 80 })
    expect(viewport.element.scrollLeft).toBe(80)
  })
})
