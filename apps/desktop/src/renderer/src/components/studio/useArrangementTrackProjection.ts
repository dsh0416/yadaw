import { computed, type ComputedRef } from "vue"
import type { MidiClipState, MixerChannelMeter } from "@heron/contracts"
import type { TimelineClip } from "../../stores/transport"
import type { ArrangementTimelineTrack, ArrangementTrackRow } from "./arrangementWorkspaceTypes"

interface ArrangementTrackProjectionOptions {
  tracks: () => readonly ArrangementTimelineTrack[]
  audioClips: () => readonly TimelineClip[]
  midiClips: () => readonly MidiClipState[]
  trackScale: (trackId: string) => number
  trackHeight: (trackId: string) => number
  meterFor: (channelId: string) => MixerChannelMeter | null | undefined
}

function emptyMeter(channelId: string): MixerChannelMeter {
  return {
    channelId,
    preFaderPeak: [0, 0],
    postFaderPeak: [0, 0],
    heldPeak: [0, 0],
    clipped: false
  }
}

export function useArrangementTrackProjection(options: ArrangementTrackProjectionOptions): {
  rows: ComputedRef<readonly ArrangementTrackRow[]>
} {
  const rows = computed<readonly ArrangementTrackRow[]>(() =>
    options.tracks().map((track) => ({
      track,
      audioClips: options.audioClips().filter((clip) => clip.trackId === track.trackId),
      midiClips: options.midiClips().filter((clip) => clip.trackId === track.trackId),
      scale: options.trackScale(track.trackId),
      height: options.trackHeight(track.trackId),
      meter: options.meterFor(track.id) ?? emptyMeter(track.id)
    }))
  )

  return { rows }
}
