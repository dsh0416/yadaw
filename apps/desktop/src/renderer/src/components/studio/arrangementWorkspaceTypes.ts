import type { MidiClipState, MixerChannelState } from "@heron/contracts"
import type { TimelineClip } from "../../stores/transport"

export type ArrangementTimelineTrack = MixerChannelState & {
  trackId: string
  sortOrder: number
}

export interface ArrangementTrackRow {
  track: ArrangementTimelineTrack
  audioClips: TimelineClip[]
  midiClips: MidiClipState[]
  scale: number
  height: number
}
