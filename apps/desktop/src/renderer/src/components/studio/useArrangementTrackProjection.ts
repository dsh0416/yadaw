import { computed, type ComputedRef } from "vue"
import type { MidiClipState } from "@heron/contracts"
import type { TimelineClip } from "../../stores/transport"
import type { ArrangementTimelineTrack, ArrangementTrackRow } from "./arrangementWorkspaceTypes"

interface ArrangementTrackProjectionOptions {
  tracks: () => readonly ArrangementTimelineTrack[]
  audioClips: () => readonly TimelineClip[]
  midiClips: () => readonly MidiClipState[]
  trackScale: (trackId: string) => number
  trackHeight: (trackId: string) => number
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
      height: options.trackHeight(track.trackId)
    }))
  )

  return { rows }
}
