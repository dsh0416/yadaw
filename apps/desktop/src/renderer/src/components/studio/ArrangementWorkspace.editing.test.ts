import { createPinia, setActivePinia } from "pinia"
import { flushPromises, mount } from "@vue/test-utils"
import { describe, expect, it, vi } from "vitest"
import { useProjectStore } from "../../stores/project"
import { useMixerStore } from "../../stores/mixer"
import { useArrangementViewStore } from "../../stores/arrangementView"
import { usePianoRollStore } from "../../stores/pianoRoll"
import { useStudioWorkspaceStore } from "../../stores/studioWorkspace"
import { useTransportStore } from "../../stores/transport"
import ArrangementWorkspace from "./ArrangementWorkspace.vue"
import AudioClipCard from "./AudioClipCard.vue"
import MidiClipCard from "./MidiClipCard.vue"
import TimelineRuler from "./TimelineRuler.vue"

describe("ArrangementWorkspace editing", () => {
  it("creates a snapped one-bar MIDI clip and opens it from an empty Instrument lane", async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const mixer = useMixerStore()
    mixer.graph = {
      sampleRate: 48_000,
      tracks: [{ id: "track:instrument-1", channelId: "instrument-1", sortOrder: 0 }],
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
            trackId: "track:instrument-1",
            name: "MIDI Clip 1",
            startTick: 960,
            lengthTicks: 3_840,
            sourceOffsetTicks: 0,
            sourceLengthTicks: 3_840,
            notes: [],
            events: []
          }
        }
      ]
    })
    expect(usePianoRollStore().openClipIds).toEqual(["00000000-0000-4000-8000-000000000002"])
    expect(useStudioWorkspaceStore().activeLowerDock).toBe("piano-roll")

    await wrapper.setProps({
      recordingId: "midi-recording-live",
      recordingMidiTrackIds: ["track:instrument-1"]
    })
    expect(wrapper.find('[data-testid="midi-recording-preview"]').exists()).toBe(false)
    await wrapper.setProps({ recordingStartTick: 960 })
    expect(wrapper.find('[data-testid="midi-recording-preview"]').exists()).toBe(true)

    randomUuid.mockRestore()
    wrapper.unmount()
  })

  it("commits audio and MIDI clip edits plus cycle range updates through the mixer/transport", async () => {
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
    const mixer = useMixerStore()
    mixer.graph = {
      sampleRate: 48_000,
      tracks: [
        { id: "track:audio-1", channelId: "audio-1", sortOrder: 0 },
        { id: "track:instrument-1", channelId: "instrument-1", sortOrder: 1 }
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
          id: "instrument-1",
          kind: "instrument",
          systemRole: null,
          name: "Keys",
          color: "#73D6A2",
          sortOrder: 1,
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
      audioClips: [
        {
          id: "audio-1",
          assetId: "asset-1",
          trackId: "track:audio-1",
          name: "Take",
          startFrame: 0,
          sourceOffsetFrames: 0,
          sourceLengthFrames: 96_000,
          fadeInFrames: 12_000,
          fadeOutFrames: 12_000,
          lengthFrames: 48_000,
          assetSampleRate: 48_000,
          assetChannels: 2
        }
      ],
      sends: [],
      plugins: [],
      midiClips: [
        {
          id: "midi-1",
          sourceId: "source-1",
          trackId: "track:instrument-1",
          name: "Verse",
          startTick: 0,
          sourceOffsetTicks: 0,
          lengthTicks: 3_840,
          sourceLengthTicks: 3_840,
          notes: [],
          events: []
        }
      ],
      keySignatureEvents: [{ tick: 0, fifths: 0, mode: "major" }],
      tempoMap: {
        ticksPerQuarter: 960,
        tempoEvents: [{ tick: 0, beatsPerMinute: 120 }],
        timeSignatureEvents: [{ tick: 0, numerator: 4, denominator: 4 }]
      }
    }
    const execute = vi.spyOn(mixer, "execute").mockResolvedValue(true)
    const setLoop = vi.spyOn(useTransportStore(), "setLoop").mockResolvedValue()
    useTransportStore().snapshot = {
      state: "stopped",
      positionFrames: 24_000,
      sampleRate: 48_000,
      loopEnabled: false,
      loopRange: null
    }
    usePianoRollStore().selectArrangementClip("midi-1")
    const wrapper = mount(ArrangementWorkspace, {
      props: {
        recordingId: null,
        recordingStartedAt: null,
        recordingStartFrame: null,
        recordingError: ""
      },
      global: { plugins: [pinia] }
    })

    await wrapper.getComponent(TimelineRuler).vm.$emit("updateLoopRange", {
      startTick: 960,
      endTick: 4_800
    })
    await wrapper.getComponent(AudioClipCard).vm.$emit("trim", "audio-1", "end", 36_000)
    await wrapper.getComponent(AudioClipCard).vm.$emit("fade", "audio-1", "in", 6_000)
    await wrapper.getComponent(AudioClipCard).vm.$emit("resetFades", "audio-1")
    await wrapper.getComponent(AudioClipCard).vm.$emit("split", "audio-1")
    await wrapper.getComponent(MidiClipCard).vm.$emit("trim", "midi-1", "end", 1_920)
    await wrapper.getComponent(MidiClipCard).vm.$emit("split", "midi-1")
    await flushPromises()

    expect(setLoop).toHaveBeenCalledWith(true, { startTick: 960, endTick: 4_800 })
    expect(execute).toHaveBeenCalledWith({
      type: "update-audio-clip",
      clipId: "audio-1",
      patch: expect.objectContaining({ lengthFrames: 36_000 })
    })
    expect(execute).toHaveBeenCalledWith({
      type: "update-audio-clip",
      clipId: "audio-1",
      patch: { fadeInFrames: 6_000 }
    })
    expect(execute).toHaveBeenCalledWith({
      type: "update-audio-clip",
      clipId: "audio-1",
      patch: { fadeInFrames: 0, fadeOutFrames: 0 }
    })
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "batch",
        commands: expect.arrayContaining([
          expect.objectContaining({
            type: "update-audio-clip",
            clipId: "audio-1"
          })
        ])
      })
    )
    expect(execute).toHaveBeenCalledWith({
      type: "update-midi-clip-range",
      clipId: "midi-1",
      patch: { startTick: 0, sourceOffsetTicks: 0, lengthTicks: 1_920 }
    })
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "batch",
        commands: expect.arrayContaining([
          expect.objectContaining({
            type: "update-midi-clip-range",
            clipId: "midi-1"
          })
        ])
      })
    )
    wrapper.unmount()
  })
})
