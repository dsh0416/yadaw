import { shallowMount } from "@vue/test-utils"
import { describe, expect, it, vi } from "vitest"
import type { MixerChannelMeter, MixerChannelState, TempoMapSnapshot } from "@heron/contracts"
import ArrangementTrack from "./ArrangementTrack.vue"
import ArrangementTimelineTrack from "./ArrangementTimelineTrack.vue"
import ArrangementTimelineTrackSource from "./ArrangementTimelineTrack.vue?raw"
import ArrangementTrackRail from "./ArrangementTrackRail.vue"
import ArrangementTrackRailSource from "./ArrangementTrackRail.vue?raw"
import InlineTrackNameEditor from "../InlineTrackNameEditor.vue"
import MidiArrangementTrack from "./MidiArrangementTrack.vue"
import TrackQuickControls from "./TrackQuickControls.vue"
import type { ArrangementTrackRow } from "./arrangementWorkspaceTypes"

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key })
}))

const channel: MixerChannelState = {
  id: "audio-1",
  kind: "audio",
  systemRole: null,
  name: "Audio 1",
  color: "#8c83ff",
  sortOrder: 0,
  inputSource: "hardware",
  inputFormat: "stereo",
  gainDb: 0,
  pan: 0,
  muted: false,
  soloed: false,
  outputChannelId: null,
  recordArmed: false,
  inputMonitoring: false,
  inputChannels: [1, 2],
  hardwareOutputChannels: []
}

const meter: MixerChannelMeter = {
  channelId: channel.id,
  preFaderPeak: [0, 0],
  postFaderPeak: [0, 0],
  heldPeak: [0, 0],
  clipped: false
}

function row(kind: "audio" | "instrument" = "audio"): ArrangementTrackRow {
  return {
    track: {
      ...channel,
      id: kind === "audio" ? channel.id : "instrument-1",
      kind,
      inputSource: kind === "audio" ? "hardware" : null,
      inputFormat: kind === "audio" ? "stereo" : null,
      inputChannels: kind === "audio" ? [1, 2] : [],
      trackId: `track:${kind}`,
      sortOrder: 0
    },
    audioClips: [],
    midiClips: [],
    scale: 1,
    height: 88,
    meter: { ...meter, channelId: kind === "audio" ? channel.id : "instrument-1" }
  }
}

const tempoMap: TempoMapSnapshot = {
  ticksPerQuarter: 960,
  tempoEvents: [{ tick: 0, beatsPerMinute: 120 }],
  timeSignatureEvents: [{ tick: 0, numerator: 4, denominator: 4 }]
}

function timelineProps(trackRow = row()) {
  return {
    row: trackRow,
    tempoMap,
    contentWidth: 1_200,
    pixelsPerQuarter: 120,
    amplitudeScale: 1,
    displayMode: "separate" as const,
    viewportStartSeconds: 0,
    viewportEndSeconds: 8,
    selectedAudioClipId: null,
    selectedMidiClipIds: [],
    keyboardInsertionTick: 960,
    playheadTick: 960,
    playheadFrame: 24_000,
    snap: "1/16" as const,
    audioDragPreview: null,
    draggingAudioClipId: null,
    midiDragPreview: null,
    draggingMidiClipId: null,
    liveAudioClip: null,
    recordingMidi: false,
    recordingStartTick: 0,
    recordingPositionTick: 960,
    liveMidiTake: null
  }
}

describe("ArrangementWorkspace presentational children", () => {
  it("keeps the track rail props-down/events-up", async () => {
    const wrapper = shallowMount(ArrangementTrackRail, {
      props: {
        rows: [row()],
        selectedChannelId: channel.id,
        trackHeight: 88
      }
    })

    await wrapper.get(".track-header").trigger("click")
    await wrapper.get(".track-header").trigger("keydown", { altKey: true, key: "ArrowDown" })
    wrapper.getComponent(InlineTrackNameEditor).vm.$emit("rename", "Lead")
    wrapper.getComponent(TrackQuickControls).vm.$emit("updateChannel", channel.id, { muted: true })

    expect(wrapper.emitted("select")).toEqual([[channel.id]])
    expect(wrapper.emitted("reorder")).toEqual([[0, 1]])
    expect(wrapper.emitted("rename")).toEqual([[channel.id, "Lead"]])
    expect(wrapper.emitted("updateChannel")).toEqual([[channel.id, { muted: true }]])
  })

  it("relays typed audio and MIDI lane contracts", () => {
    const audio = shallowMount(ArrangementTimelineTrack, { props: timelineProps() })
    audio.getComponent(ArrangementTrack).vm.$emit("trim", "clip-1", "start", 120)
    audio.getComponent(ArrangementTrack).vm.$emit("clipDragStart", "clip-1", 24)
    expect(audio.emitted("trimAudioClip")).toEqual([["clip-1", "start", 120]])
    expect(audio.emitted("audioClipDragStart")).toEqual([["clip-1", 24]])

    const instrument = shallowMount(ArrangementTimelineTrack, {
      props: {
        ...timelineProps(row("instrument")),
        recordingMidi: true,
        liveMidiTake: { clipId: "take-1", trackId: "track:instrument", notes: [] }
      }
    })
    const midiLane = instrument.getComponent(MidiArrangementTrack)
    expect(midiLane.props("recording")).toBe(true)
    expect(midiLane.props("liveTake")).toEqual({
      clipId: "take-1",
      trackId: "track:instrument",
      notes: []
    })
    midiLane.vm.$emit("select", "midi-1", true)
    midiLane.vm.$emit("create", "track:instrument", 1_920)
    expect(instrument.emitted("selectMidiClip")).toEqual([["midi-1", true]])
    expect(instrument.emitted("createMidiClip")).toEqual([["track:instrument", 1_920]])
  })

  it("does not hide preload or store access inside presentational children", () => {
    for (const source of [ArrangementTrackRailSource, ArrangementTimelineTrackSource]) {
      expect(source).not.toContain("window.heron")
      expect(source).not.toContain("useMixerStore")
      expect(source).not.toContain("useArrangementViewStore")
    }
  })
})
