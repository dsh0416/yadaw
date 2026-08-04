import { createPinia, setActivePinia } from "pinia"
import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"
import { useProjectStore } from "../../stores/project"
import { useMixerStore } from "../../stores/mixer"
import { useTransportStore } from "../../stores/transport"
import ArrangementWorkspace from "./ArrangementWorkspace.vue"

describe("ArrangementWorkspace recording", () => {
  it("shows a growing capture clip while recording", () => {
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
        dirty: false,
        recoveredWorkingCopy: false
      },
      error: null
    })
    const mixer = useMixerStore()
    mixer.graph = {
      sampleRate: 48_000,
      tracks: [{ id: "track:audio-1", channelId: "audio-1", sortOrder: 0 }],
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

    const transport = useTransportStore()
    transport.snapshot = {
      state: "recording",
      positionFrames: 48_000,
      positionTicks: 1_920,
      sampleRate: 48_000,
      loopEnabled: false,
      loopRange: null
    }

    const wrapper = mount(ArrangementWorkspace, {
      props: {
        recordingId: "recording-live",
        recordingStartedAt: Date.now() - 1_000,
        recordingStartFrame: 0,
        recordingAudioTrackIds: ["audio-1"],
        recordingError: ""
      },
      global: { plugins: [pinia] }
    })

    expect(
      wrapper.get('[role="button"][aria-label="Recording New recording"]').attributes("aria-label")
    ).toBe("Recording New recording")
    expect(
      wrapper.get<HTMLElement>('[role="button"][aria-label="Recording New recording"]').element
        .style.width
    ).toBe("100px")
    expect(wrapper.find('[role="status"]').exists()).toBe(false)
  })
})
