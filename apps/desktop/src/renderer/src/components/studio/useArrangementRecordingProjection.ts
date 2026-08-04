import { computed, readonly, toValue, type ComputedRef, type MaybeRefOrGetter } from "vue"
import type {
  MidiRecordingPreview,
  MixerChannelState,
  ProjectGraphSnapshot
} from "@heron/contracts"
import type { TimelineClip } from "../../stores/transport"
import { secondsToTick, tickToSeconds } from "../../utils/tempoMap"

export interface ArrangementRecordingProjectionInput {
  recordingId: MaybeRefOrGetter<string | null>
  recordingStartedAt: MaybeRefOrGetter<number | null>
  recordingStartFrame: MaybeRefOrGetter<number | null>
  recordingStartTick: MaybeRefOrGetter<number | null | undefined>
  recordingAudioTrackIds: MaybeRefOrGetter<string[] | undefined>
  recordingMidiTrackIds: MaybeRefOrGetter<string[] | undefined>
  liveDurationSeconds: MaybeRefOrGetter<number>
  sampleRate: MaybeRefOrGetter<number>
  playheadSeconds: MaybeRefOrGetter<number>
  contentEndSeconds: MaybeRefOrGetter<number>
  timelineDurationSeconds: MaybeRefOrGetter<number>
  selectedChannelId: MaybeRefOrGetter<string | null>
  audioTracks: MaybeRefOrGetter<MixerChannelState[]>
  instrumentTracks: MaybeRefOrGetter<MixerChannelState[]>
  graph: MaybeRefOrGetter<ProjectGraphSnapshot>
  midiRecordingPreview: MaybeRefOrGetter<MidiRecordingPreview | null>
  recordingName: MaybeRefOrGetter<string>
}

export interface ArrangementRecordingProjection {
  recordingStartSeconds: ComputedRef<number>
  recordingDuration: ComputedRef<number>
  liveClips: ComputedRef<TimelineClip[]>
  hasRecordingStartTick: ComputedRef<boolean>
  recordingStartTick: ComputedRef<number>
  recordingPositionTick: ComputedRef<number>
  recordingMidiTrackIds: ComputedRef<ReadonlySet<string>>
  liveMidiPreview: ComputedRef<MidiRecordingPreview | null>
  visibleDuration: ComputedRef<number>
}

export function useArrangementRecordingProjection(
  input: ArrangementRecordingProjectionInput
): ArrangementRecordingProjection {
  const recordingStartSeconds = computed(() => {
    const startFrame = toValue(input.recordingStartFrame)
    return startFrame === null
      ? toValue(input.playheadSeconds)
      : startFrame / toValue(input.sampleRate)
  })
  const recordingDuration = computed(() => {
    if (toValue(input.recordingStartedAt) === null) return 0
    return Math.max(
      0.05,
      toValue(input.liveDurationSeconds),
      toValue(input.playheadSeconds) - recordingStartSeconds.value
    )
  })
  const recordingTracks = computed(() => {
    const requestedTrackIds = new Set(toValue(input.recordingAudioTrackIds) ?? [])
    const audioTracks = toValue(input.audioTracks)
    if (requestedTrackIds.size > 0) {
      return audioTracks.filter((channel) => requestedTrackIds.has(channel.id))
    }
    const armed = audioTracks.filter((track) => track.recordArmed)
    if (armed.length > 0) return armed
    const selectedChannelId = toValue(input.selectedChannelId)
    return audioTracks.filter((track) => track.id === selectedChannelId).slice(0, 1)
  })
  const liveClips = computed<TimelineClip[]>(() => {
    const recordingId = toValue(input.recordingId)
    if (toValue(input.recordingStartedAt) === null || recordingId === null) return []
    const graph = toValue(input.graph)
    const sampleRate = toValue(input.sampleRate)
    const durationSeconds = recordingDuration.value
    const lengthFrames = Math.max(1, Math.round(durationSeconds * sampleRate))
    return recordingTracks.value.flatMap((channel) => {
      const track = graph.tracks.find((candidate) => candidate.channelId === channel.id)
      return track
        ? [
            {
              id: `${recordingId}-${track.id}`,
              assetId: recordingId,
              trackId: track.id,
              name: toValue(input.recordingName),
              startSeconds: recordingStartSeconds.value,
              durationSeconds,
              endSeconds: recordingStartSeconds.value + durationSeconds,
              channels: channel.inputFormat === "mono" ? 1 : 2,
              sampleRate,
              projectSampleRate: sampleRate,
              startFrame: toValue(input.recordingStartFrame) ?? 0,
              sourceOffsetFrames: 0,
              lengthFrames,
              sourceLengthFrames: lengthFrames,
              fadeInFrames: 0,
              fadeOutFrames: 0
            }
          ]
        : []
    })
  })
  const hasRecordingStartTick = computed(() => {
    const startTick = toValue(input.recordingStartTick)
    return typeof startTick === "number" && Number.isFinite(startTick)
  })
  const recordingStartTick = computed(() => {
    const startTick = toValue(input.recordingStartTick)
    return hasRecordingStartTick.value ? Math.max(0, Math.floor(startTick as number)) : 0
  })
  const liveMidiPreview = computed(() =>
    toValue(input.recordingId) === null || !hasRecordingStartTick.value
      ? null
      : toValue(input.midiRecordingPreview)
  )
  const recordingPositionTick = computed(() =>
    Math.max(
      recordingStartTick.value,
      secondsToTick(toValue(input.graph).tempoMap, toValue(input.playheadSeconds)),
      liveMidiPreview.value?.positionTick ?? 0
    )
  )
  const recordingMidiTrackIds = computed<ReadonlySet<string>>(() => {
    const requestedTrackIds = toValue(input.recordingMidiTrackIds) ?? []
    if (requestedTrackIds.length > 0) return readonly(new Set(requestedTrackIds))
    const graph = toValue(input.graph)
    return readonly(
      new Set(
        toValue(input.instrumentTracks)
          .filter((channel) => channel.recordArmed)
          .flatMap((channel) => {
            const track = graph.tracks.find((candidate) => candidate.channelId === channel.id)
            return track ? [track.id] : []
          })
      )
    )
  })
  const liveRecordingEndSeconds = computed(() =>
    toValue(input.recordingId) === null
      ? toValue(input.contentEndSeconds)
      : Math.max(
          recordingStartSeconds.value + recordingDuration.value,
          tickToSeconds(toValue(input.graph).tempoMap, recordingPositionTick.value)
        )
  )
  const visibleDuration = computed(() => {
    const graph = toValue(input.graph)
    return Math.max(
      toValue(input.timelineDurationSeconds),
      ...graph.midiClips.map((clip) =>
        tickToSeconds(graph.tempoMap, clip.startTick + clip.lengthTicks)
      ),
      liveRecordingEndSeconds.value + 2
    )
  })

  return {
    recordingStartSeconds,
    recordingDuration,
    liveClips,
    hasRecordingStartTick,
    recordingStartTick,
    recordingPositionTick,
    recordingMidiTrackIds,
    liveMidiPreview,
    visibleDuration
  }
}
