<script setup lang="ts">
import type {
  MidiClipState,
  MidiRecordingPreviewTake,
  TempoMapSnapshot,
  WaveformDisplayMode
} from "@heron/contracts"
import type { TimelineClip } from "../../stores/transport"
import type { AudioFadeEdge, ClipTrimEdge } from "../../utils/clipEditing"
import type { PianoRollSnap } from "../../utils/pianoRoll"
import ArrangementTrack from "./ArrangementTrack.vue"
import MidiArrangementTrack from "./MidiArrangementTrack.vue"
import type { ArrangementTrackRow } from "./arrangementWorkspaceTypes"

defineProps<{
  row: ArrangementTrackRow
  tempoMap: TempoMapSnapshot
  contentWidth: number
  pixelsPerQuarter: number
  amplitudeScale: number
  displayMode: WaveformDisplayMode
  viewportStartSeconds: number
  viewportEndSeconds: number
  selectedAudioClipId: string | null
  selectedMidiClipIds: string[]
  keyboardInsertionTick: number
  playheadTick: number
  playheadFrame: number
  snap: PianoRollSnap
  audioDragPreview: TimelineClip | null
  draggingAudioClipId: string | null
  midiDragPreview: MidiClipState | null
  draggingMidiClipId: string | null
  liveAudioClip: TimelineClip | null
  recordingMidi: boolean
  recordingStartTick: number
  recordingPositionTick: number
  liveMidiTake: MidiRecordingPreviewTake | null
}>()

const emit = defineEmits<{
  seek: [seconds: number]
  selectAudioClip: [clipId: string]
  waveformFrameCount: [frameCount: number, sampleRate: number]
  audioClipDragStart: [clipId: string, offsetPixels: number]
  audioClipDragEnd: []
  removeAudioClip: [clipId: string]
  splitAudioClip: [clipId: string]
  trimAudioClip: [clipId: string, edge: ClipTrimEdge, frame: number]
  fadeAudioClip: [clipId: string, edge: AudioFadeEdge, frames: number]
  resetAudioFades: [clipId: string]
  removeMidiClip: [clipId: string]
  selectMidiClip: [clipId: string, additive: boolean]
  openMidiClip: [clipId: string, selectedClipIds: string[]]
  createMidiClip: [trackId: string, startTick: number]
  splitMidiClip: [clipId: string]
  trimMidiClip: [clipId: string, edge: ClipTrimEdge, tick: number]
  midiClipDragStart: [clipId: string, offsetPixels: number]
  midiClipDragEnd: []
}>()

function relayWaveformFrameCount(frameCount: number, sampleRate: number): void {
  emit("waveformFrameCount", frameCount, sampleRate)
}
function relayAudioClipDragStart(clipId: string, offsetPixels: number): void {
  emit("audioClipDragStart", clipId, offsetPixels)
}
function relayAudioTrim(clipId: string, edge: ClipTrimEdge, frame: number): void {
  emit("trimAudioClip", clipId, edge, frame)
}
function relayAudioFade(clipId: string, edge: AudioFadeEdge, frames: number): void {
  emit("fadeAudioClip", clipId, edge, frames)
}
function relayMidiSelect(clipId: string, additive: boolean): void {
  emit("selectMidiClip", clipId, additive)
}
function relayMidiOpen(clipId: string, selectedClipIds: string[]): void {
  emit("openMidiClip", clipId, selectedClipIds)
}
function relayMidiCreate(trackId: string, startTick: number): void {
  emit("createMidiClip", trackId, startTick)
}
function relayMidiTrim(clipId: string, edge: ClipTrimEdge, tick: number): void {
  emit("trimMidiClip", clipId, edge, tick)
}
function relayMidiClipDragStart(clipId: string, offsetPixels: number): void {
  emit("midiClipDragStart", clipId, offsetPixels)
}
</script>

<template>
  <ArrangementTrack
    v-if="row.track.kind === 'audio'"
    :track-id="row.track.trackId"
    :track-color="row.track.color"
    :drag-preview="audioDragPreview"
    :dragging-clip-id="draggingAudioClipId"
    :clips="row.audioClips"
    :tempo-map="tempoMap"
    :content-width="contentWidth"
    :pixels-per-quarter="pixelsPerQuarter"
    :track-height="row.height"
    :amplitude-scale="amplitudeScale"
    :display-mode="displayMode"
    :viewport-start-seconds="viewportStartSeconds"
    :viewport-end-seconds="viewportEndSeconds"
    :selected-clip-id="selectedAudioClipId"
    :live-clip="liveAudioClip"
    :playhead-frame="playheadFrame"
    @seek="emit('seek', $event)"
    @select-clip="emit('selectAudioClip', $event)"
    @waveform-frame-count="relayWaveformFrameCount"
    @clip-drag-start="relayAudioClipDragStart"
    @clip-drag-end="emit('audioClipDragEnd')"
    @remove="emit('removeAudioClip', $event)"
    @split="emit('splitAudioClip', $event)"
    @trim="relayAudioTrim"
    @fade="relayAudioFade"
    @reset-fades="emit('resetAudioFades', $event)"
  />
  <MidiArrangementTrack
    v-else
    :track-id="row.track.trackId"
    :track-color="row.track.color"
    :clips="row.midiClips"
    :tempo-map="tempoMap"
    :content-width="contentWidth"
    :pixels-per-quarter="pixelsPerQuarter"
    :track-height="row.height"
    :selected-clip-ids="selectedMidiClipIds"
    :keyboard-insertion-tick="keyboardInsertionTick"
    :playhead-tick="playheadTick"
    :snap="snap"
    :drag-preview="midiDragPreview"
    :dragging-clip-id="draggingMidiClipId"
    :recording="recordingMidi"
    :recording-start-tick="recordingStartTick"
    :recording-position-tick="recordingPositionTick"
    :live-take="liveMidiTake"
    @remove="emit('removeMidiClip', $event)"
    @select="relayMidiSelect"
    @open="relayMidiOpen"
    @create="relayMidiCreate"
    @split="emit('splitMidiClip', $event)"
    @trim="relayMidiTrim"
    @clip-drag-start="relayMidiClipDragStart"
    @clip-drag-end="emit('midiClipDragEnd')"
  />
</template>
