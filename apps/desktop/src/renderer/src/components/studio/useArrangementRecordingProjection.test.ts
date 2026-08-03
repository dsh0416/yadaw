import { isReadonly, ref } from "vue"
import { describe, expect, it } from "vitest"
import type { MixerChannelState, ProjectGraphSnapshot } from "@heron/contracts"
import { useArrangementRecordingProjection } from "./useArrangementRecordingProjection"

const audioTrack: MixerChannelState = {
  id: "audio-1",
  kind: "audio",
  systemRole: null,
  name: "Audio 1",
  color: "#8c83ff",
  sortOrder: 0,
  inputSource: "hardware",
  inputFormat: "mono",
  gainDb: 0,
  pan: 0,
  muted: false,
  soloed: false,
  outputChannelId: null,
  recordArmed: true,
  inputMonitoring: false,
  inputChannels: [1],
  hardwareOutputChannels: []
}

const instrumentTrack: MixerChannelState = {
  ...audioTrack,
  id: "instrument-1",
  kind: "instrument",
  name: "Instrument 1",
  inputSource: null,
  inputFormat: null,
  inputChannels: []
}

const graph = ref<ProjectGraphSnapshot>({
  sampleRate: 48_000,
  tracks: [
    { id: "track:audio-1", channelId: audioTrack.id, sortOrder: 0 },
    { id: "track:instrument-1", channelId: instrumentTrack.id, sortOrder: 1 }
  ],
  channels: [audioTrack, instrumentTrack],
  audioClips: [],
  sends: [],
  plugins: [],
  midiClips: [],
  tempoMap: {
    ticksPerQuarter: 960,
    tempoEvents: [{ tick: 0, beatsPerMinute: 120 }],
    timeSignatureEvents: [{ tick: 0, numerator: 4, denominator: 4 }]
  },
  keySignatureEvents: [{ tick: 0, fifths: 0, mode: "major" }]
})

describe("useArrangementRecordingProjection", () => {
  it("derives readonly live audio and MIDI recording geometry", () => {
    const playheadSeconds = ref(0.5)
    const projection = useArrangementRecordingProjection({
      recordingId: ref("recording-1"),
      recordingStartedAt: ref(1),
      recordingStartFrame: ref(0),
      recordingStartTick: ref(960),
      recordingAudioTrackIds: ref(undefined),
      recordingMidiTrackIds: ref(undefined),
      liveDurationSeconds: ref(0.25),
      sampleRate: ref(48_000),
      playheadSeconds,
      contentEndSeconds: ref(1),
      timelineDurationSeconds: ref(2),
      selectedChannelId: ref(audioTrack.id),
      audioTracks: ref([audioTrack]),
      instrumentTracks: ref([instrumentTrack]),
      graph,
      midiRecordingPreview: ref({
        positionTick: 1_440,
        takes: [{ clipId: "midi-take", trackId: "track:instrument-1", notes: [] }]
      }),
      recordingName: ref("New recording")
    })

    expect(isReadonly(projection.liveClips)).toBe(true)
    expect(isReadonly(projection.recordingMidiTrackIds)).toBe(true)
    expect(projection.liveClips.value).toEqual([
      expect.objectContaining({
        id: "recording-1-track:audio-1",
        trackId: "track:audio-1",
        durationSeconds: 0.5,
        channels: 1,
        lengthFrames: 24_000
      })
    ])
    expect(projection.recordingStartTick.value).toBe(960)
    expect(projection.recordingPositionTick.value).toBe(1_440)
    expect(projection.recordingMidiTrackIds.value.has("track:instrument-1")).toBe(true)
    expect(projection.liveMidiPreview.value?.takes).toHaveLength(1)
    expect(projection.visibleDuration.value).toBe(2.75)

    playheadSeconds.value = 1
    expect(projection.liveClips.value[0]?.durationSeconds).toBe(1)
    expect(projection.recordingPositionTick.value).toBe(1_920)
  })

  it("uses explicit track ids and hides previews outside an active recording", () => {
    const projection = useArrangementRecordingProjection({
      recordingId: ref(null),
      recordingStartedAt: ref(null),
      recordingStartFrame: ref(null),
      recordingStartTick: ref(Number.NaN),
      recordingAudioTrackIds: ref([audioTrack.id]),
      recordingMidiTrackIds: ref(["track:explicit"]),
      liveDurationSeconds: ref(0),
      sampleRate: ref(48_000),
      playheadSeconds: ref(2),
      contentEndSeconds: ref(6),
      timelineDurationSeconds: ref(8),
      selectedChannelId: ref(null),
      audioTracks: ref([audioTrack]),
      instrumentTracks: ref([instrumentTrack]),
      graph,
      midiRecordingPreview: ref({ positionTick: 2_000, takes: [] }),
      recordingName: ref("New recording")
    })

    expect(projection.liveClips.value).toEqual([])
    expect(projection.hasRecordingStartTick.value).toBe(false)
    expect(projection.liveMidiPreview.value).toBeNull()
    expect([...projection.recordingMidiTrackIds.value]).toEqual(["track:explicit"])
    expect(projection.visibleDuration.value).toBe(8)
  })
})
