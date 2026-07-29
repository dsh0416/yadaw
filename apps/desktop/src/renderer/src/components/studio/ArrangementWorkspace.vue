<script setup lang="ts">
import { computed, shallowRef, watch } from "vue"
import { storeToRefs } from "pinia"
import { UiSelect } from "@yadaw/ui"
import { useProjectStore } from "../../stores/project"
import { useTransportStore } from "../../stores/transport"
import { useArrangementViewStore } from "../../stores/arrangementView"
import { useMixerStore } from "../../stores/mixer"
import { usePianoRollStore } from "../../stores/pianoRoll"
import { useStudioWorkspaceStore } from "../../stores/studioWorkspace"
import type { MidiClipState, MidiSourceState, ProjectCommand } from "@yadaw/contracts"
import type { TimelineClip } from "../../stores/transport"
import ArrangementTrack from "./ArrangementTrack.vue"
import ArrangementZoomControls from "./ArrangementZoomControls.vue"
import InlineTrackNameEditor from "../InlineTrackNameEditor.vue"
import TimelineRuler from "./TimelineRuler.vue"
import TrackQuickControls from "./TrackQuickControls.vue"
import TrackHeightResizeHandle from "./TrackHeightResizeHandle.vue"
import MidiArrangementTrack from "./MidiArrangementTrack.vue"
import { barLengthTicksAtTick, secondsToTick, tickToSeconds } from "../../utils/tempoMap"
import { MAJOR_KEY_SIGNATURE_CHOICES, MINOR_KEY_SIGNATURE_CHOICES } from "../../utils/keySignatures"
import GlobalLaneHeader from "./global-lanes/GlobalLaneHeader.vue"
import GlobalEventLaneHeader from "./global-lanes/GlobalEventLaneHeader.vue"
import KeyTrackLane from "./global-lanes/KeyTrackLane.vue"
import MeterTrackLane from "./global-lanes/MeterTrackLane.vue"
import TempoTrackLane from "./global-lanes/TempoTrackLane.vue"
import { secondsToTimelineX } from "../../utils/timelineCoordinates"
import { useArrangementViewport } from "./useArrangementViewport"
import { useArrangementClipDrag } from "./useArrangementClipDrag"
import { useGlobalLaneSelection } from "./useGlobalLaneSelection"
import { snapTicks } from "../../utils/pianoRoll"

const props = defineProps<{
  recordingId: string | null
  recordingStartedAt: number | null
  recordingStartFrame: number | null
  recordingError: string
}>()
const projectStore = useProjectStore()
const transportStore = useTransportStore()
const viewStore = useArrangementViewStore()
const mixerStore = useMixerStore()
const pianoRollStore = usePianoRollStore()
const workspaceStore = useStudioWorkspaceStore()
const { session } = storeToRefs(projectStore)
const {
  clips,
  playheadSeconds,
  selectedClipId,
  error,
  contentEndSeconds,
  timelineDurationSeconds
} = storeToRefs(transportStore)
const {
  pixelsPerQuarter,
  trackHeight,
  amplitudeScale,
  tempoLaneExpanded,
  tempoLaneHeight,
  meterLaneExpanded,
  meterLaneHeight,
  keyLaneExpanded,
  keyLaneHeight
} = storeToRefs(viewStore)
const liveDurationSeconds = shallowRef(0)
const {
  selectedTempoTick,
  selectedMeterTick,
  selectedKeyTick,
  selectedTempo,
  selectedMeter,
  selectedKeyValue,
  replaceTempoMap,
  updateSelectedTempo,
  updateSelectedMeter,
  replaceKeySignatureMap,
  updateSelectedKey
} = useGlobalLaneSelection({
  graph: () => mixerStore.graph,
  execute: (command) => mixerStore.execute(command)
})
const meterDenominators = [1, 2, 4, 8, 16, 32] as const
const keySignatureGroups = [
  {
    label: "Major keys",
    options: MAJOR_KEY_SIGNATURE_CHOICES
  },
  {
    label: "Minor keys",
    options: MINOR_KEY_SIGNATURE_CHOICES,
    separatorBefore: true
  }
] as const
const displayMode = computed(() => session.value?.configuration.waveformDisplayMode ?? "separate")
const recordingDuration = computed(() => {
  if (liveDurationSeconds.value > 0) return liveDurationSeconds.value
  return props.recordingStartedAt === null ? 0 : 0.05
})
const recordingStartSeconds = computed(() =>
  props.recordingStartFrame === null
    ? playheadSeconds.value
    : props.recordingStartFrame / (session.value?.configuration.sampleRate ?? 48_000)
)
const recordingTracks = computed(() => {
  const armed = mixerStore.audioTracks.filter((track) => track.recordArmed)
  if (armed.length > 0) return armed
  return mixerStore.audioTracks
    .filter((track) => track.id === mixerStore.selectedChannelId)
    .slice(0, 1)
})
const liveClips = computed<TimelineClip[]>(() =>
  props.recordingStartedAt === null || props.recordingId === null
    ? []
    : recordingTracks.value.map((track) => ({
        id: `${props.recordingId}-${track.id}`,
        assetId: props.recordingId!,
        trackId: track.id,
        name: "New recording",
        startSeconds: recordingStartSeconds.value,
        durationSeconds: recordingDuration.value,
        endSeconds: recordingStartSeconds.value + recordingDuration.value,
        channels: track.inputFormat === "mono" ? 1 : 2,
        sampleRate: session.value?.configuration.sampleRate ?? 48_000
      }))
)
const visibleDuration = computed(() =>
  Math.max(
    timelineDurationSeconds.value,
    ...mixerStore.graph.midiClips.map((clip) =>
      tickToSeconds(mixerStore.graph.tempoMap, clip.startTick + clip.lengthTicks)
    ),
    (liveClips.value[0]?.endSeconds ?? contentEndSeconds.value) + 2
  )
)
const {
  contentWidth,
  viewportStartSeconds,
  viewportEndSeconds,
  handleScroll,
  handleWheel,
  handleRailWheel
} = useArrangementViewport({
  tempoMap: () => mixerStore.graph.tempoMap,
  pixelsPerQuarter,
  visibleDuration,
  zoomTime: viewStore.zoomTime,
  zoomTrack: viewStore.zoomTrack,
  zoomAmplitude: viewStore.zoomAmplitude
})
const {
  clipDrag,
  dragPreview,
  handleClipDragStart,
  updateClipDrag,
  handleClipDrop,
  handleClipDragEnd
} = useArrangementClipDrag({
  clips,
  tempoMap: () => mixerStore.graph.tempoMap,
  pixelsPerQuarter,
  moveClip: handleMoveClip
})
const trackRows = computed(() =>
  mixerStore.timelineTracks.map((track) => ({
    track,
    clips: clips.value.filter((clip) => clip.trackId === track.id),
    midiClips: mixerStore.graph.midiClips.filter((clip) => clip.trackId === track.id),
    scale: viewStore.trackScale(track.id),
    height: viewStore.effectiveTrackHeight(track.id)
  }))
)
const trackGridRows = computed(() => {
  const rows =
    trackRows.value.length > 0
      ? trackRows.value.map(({ height }) => `${height}px`).join(" ")
      : `${trackHeight.value}px`
  return `43px ${tempoLaneHeight.value}px ${meterLaneHeight.value}px ${keyLaneHeight.value}px ${rows} minmax(64px, 1fr)`
})
const railStyle = computed(() => ({
  gridTemplateRows: trackGridRows.value
}))
const contentStyle = computed(() => ({
  width: `${contentWidth.value}px`,
  gridTemplateRows: trackGridRows.value
}))
const playheadStyle = computed(() => ({
  left: `${secondsToTimelineX(
    mixerStore.graph.tempoMap,
    playheadSeconds.value,
    pixelsPerQuarter.value
  )}px`
}))

watch(
  () => props.recordingStartedAt,
  () => {
    liveDurationSeconds.value = 0
  }
)
function handleSeek(seconds: number): void {
  transportStore.clearSelection()
  pianoRollStore.clearArrangementSelection()
  transportStore.seek(seconds)
}
function selectAudioClip(clipId: string): void {
  pianoRollStore.clearArrangementSelection()
  transportStore.selectClip(clipId)
}
function handleWaveformFrameCount(frameCount: number, sampleRate: number): void {
  if (sampleRate > 0) liveDurationSeconds.value = frameCount / sampleRate
}
function handleMoveClip(clipId: string, trackId: string, startSeconds: number): void {
  void mixerStore.execute({
    type: "move-clip",
    clipId,
    trackId,
    startFrame: Math.round(startSeconds * mixerStore.graph.sampleRate)
  })
}
function reorderTrack(index: number, direction: -1 | 1): void {
  const targetIndex = index + direction
  const source = mixerStore.timelineTracks[index]
  const target = mixerStore.timelineTracks[targetIndex]
  if (!source || !target) return
  void mixerStore.execute({
    type: "batch",
    commands: [
      { type: "update-channel", channelId: source.id, patch: { sortOrder: target.sortOrder } },
      { type: "update-channel", channelId: target.id, patch: { sortOrder: source.sortOrder } }
    ]
  })
}
function handleTrackKeydown(event: KeyboardEvent, index: number): void {
  if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return
  event.preventDefault()
  reorderTrack(index, event.key === "ArrowUp" ? -1 : 1)
}

function removeMidiClip(clipId: string): void {
  void mixerStore.execute({ type: "delete-midi-clip", clipId }).then(() => {
    pianoRollStore.clearArrangementSelection()
  })
}

function moveMidiClip(clipId: string, trackId: string, startTick: number): void {
  void mixerStore.execute({ type: "move-midi-clip", clipId, trackId, startTick })
}

function selectMidiClip(clipId: string, additive: boolean): void {
  transportStore.clearSelection()
  pianoRollStore.selectArrangementClip(clipId, additive)
}

function openMidiClip(clipId: string, selectedClipIds: string[]): void {
  pianoRollStore.openClipSet(selectedClipIds, clipId)
  workspaceStore.openPianoRollDock()
}

function createMidiClip(trackId: string, requestedStartTick: number): void {
  const sourceId = crypto.randomUUID()
  const clipId = crypto.randomUUID()
  const startTick = snapTicks(requestedStartTick, pianoRollStore.snap)
  const name = `MIDI Clip ${mixerStore.graph.midiClips.length + 1}`
  const source: MidiSourceState = {
    id: sourceId,
    name,
    contentHash: `blank:${sourceId}`,
    rawBytes: new Uint8Array()
  }
  const clip: MidiClipState = {
    id: clipId,
    sourceId,
    trackId,
    name,
    startTick,
    lengthTicks: barLengthTicksAtTick(mixerStore.graph.tempoMap, startTick),
    sourceOffsetTicks: 0,
    notes: [],
    events: []
  }
  const command: ProjectCommand = {
    type: "batch",
    commands: [
      { type: "create-midi-source", source },
      { type: "create-midi-clip", clip }
    ]
  }
  void mixerStore.execute(command).then((created) => {
    if (!created) return
    transportStore.clearSelection()
    pianoRollStore.selectArrangementClip(clipId)
    pianoRollStore.openClipSet([clipId], clipId)
    workspaceStore.openPianoRollDock()
  })
}
</script>

<template>
  <section class="arrangement" aria-label="Arrangement timeline">
    <div class="arrangement-toolbar">
      <ArrangementZoomControls
        class="arrangement-zoom-controls"
        :pixels-per-quarter="pixelsPerQuarter"
        :track-height="trackHeight"
        :amplitude-scale="amplitudeScale"
        @set-time="viewStore.setTimeZoom"
        @set-track="viewStore.setTrackHeight"
        @set-amplitude="viewStore.setAmplitudeScale"
        @reset-time="viewStore.resetTime"
        @reset-track="viewStore.resetTrack"
        @reset-amplitude="viewStore.resetAmplitude"
      />
    </div>

    <div class="timeline-grid">
      <div
        ref="rail"
        class="timeline-rail"
        data-testid="timeline-rail"
        :style="railStyle"
        @wheel="handleRailWheel"
      >
        <div class="ruler-corner">TRACKS</div>
        <GlobalLaneHeader
          label="Tempo"
          eyebrow="GLOBAL TRACK"
          :value="selectedTempo.beatsPerMinute"
          unit="BPM"
          :minimum="20"
          :maximum="300"
          :expanded="tempoLaneExpanded"
          color="var(--ui-domain-color-65a8ff)"
          @toggle="viewStore.toggleTempoLane"
          @update-value="updateSelectedTempo"
        />
        <GlobalEventLaneHeader
          label="Meter"
          eyebrow="GLOBAL TRACK"
          :expanded="meterLaneExpanded"
          color="var(--ui-domain-color-f2a65a)"
          @toggle="viewStore.toggleMeterLane"
        >
          <template #controls>
            <input
              :value="selectedMeter.numerator"
              type="number"
              min="1"
              max="32"
              aria-label="Selected Meter numerator"
              @change="
                updateSelectedMeter({
                  numerator: Math.min(
                    32,
                    Math.max(1, Number(($event.target as HTMLInputElement).value))
                  )
                })
              "
            />
            <span aria-hidden="true">/</span>
            <UiSelect
              :model-value="String(selectedMeter.denominator)"
              size="compact"
              aria-label="Selected Meter denominator"
              @update:model-value="
                updateSelectedMeter({
                  denominator: Number($event)
                })
              "
            >
              <option
                v-for="denominator in meterDenominators"
                :key="denominator"
                :value="String(denominator)"
              >
                {{ denominator }}
              </option>
            </UiSelect>
          </template>
        </GlobalEventLaneHeader>
        <GlobalEventLaneHeader
          label="Key"
          eyebrow="GLOBAL TRACK"
          :expanded="keyLaneExpanded"
          color="var(--ui-domain-color-b894ff)"
          @toggle="viewStore.toggleKeyLane"
        >
          <template #controls>
            <UiSelect
              :model-value="selectedKeyValue"
              :groups="keySignatureGroups"
              size="compact"
              aria-label="Selected Key signature"
              @update:model-value="updateSelectedKey"
            />
          </template>
        </GlobalEventLaneHeader>
        <div
          v-for="({ track, scale }, index) in trackRows"
          :key="track.id"
          :class="['track-header', { selected: track.id === mixerStore.selectedChannelId }]"
          @click="mixerStore.selectedChannelId = track.id"
          @keydown="handleTrackKeydown($event, index)"
        >
          <span class="track-color" :style="{ background: track.color }" /><strong>{{
            String(index + 1).padStart(2, "0")
          }}</strong>
          <div class="track-copy">
            <InlineTrackNameEditor
              class="track-name-editor"
              :name="track.name"
              :label="`${track.name}; double-click to rename; Alt+Arrow Up or Down to reorder`"
              @rename="mixerStore.updateChannel(track.id, { name: $event })"
            />
          </div>
          <TrackQuickControls
            class="track-quick-controls"
            :channel="track"
            :meter="mixerStore.meterFor(track.id)"
            @preview="mixerStore.preview"
            @update-channel="mixerStore.updateChannel"
          />
          <TrackHeightResizeHandle
            :base-height="trackHeight"
            :scale="scale"
            :track-name="track.name"
            @set-scale="viewStore.setTrackScale(track.id, $event)"
            @reset="viewStore.resetTrackScale(track.id)"
          />
        </div>
        <div class="track-spacer" aria-hidden="true" />
      </div>
      <div
        ref="viewport"
        class="timeline-viewport"
        data-testid="timeline-viewport"
        @scroll="handleScroll"
        @wheel="handleWheel"
      >
        <div
          ref="content"
          class="timeline-content"
          :style="contentStyle"
          @dragover="updateClipDrag"
          @drop="handleClipDrop"
        >
          <TimelineRuler
            :content-width="contentWidth"
            :pixels-per-quarter="pixelsPerQuarter"
            :tempo-map="mixerStore.graph.tempoMap"
            @seek="handleSeek"
          />
          <TempoTrackLane
            :tempo-map="mixerStore.graph.tempoMap"
            :selected-tick="selectedTempoTick"
            :content-width="contentWidth"
            :pixels-per-quarter="pixelsPerQuarter"
            :height="tempoLaneHeight"
            :expanded="tempoLaneExpanded"
            @replace="replaceTempoMap"
            @select="selectedTempoTick = $event"
          />
          <MeterTrackLane
            :tempo-map="mixerStore.graph.tempoMap"
            :selected-tick="selectedMeterTick"
            :content-width="contentWidth"
            :pixels-per-quarter="pixelsPerQuarter"
            :height="meterLaneHeight"
            :expanded="meterLaneExpanded"
            @replace="replaceTempoMap"
            @select="selectedMeterTick = $event"
          />
          <KeyTrackLane
            :events="mixerStore.graph.keySignatureEvents"
            :tempo-map="mixerStore.graph.tempoMap"
            :selected-tick="selectedKeyTick"
            :content-width="contentWidth"
            :pixels-per-quarter="pixelsPerQuarter"
            :height="keyLaneHeight"
            :expanded="keyLaneExpanded"
            @replace="replaceKeySignatureMap"
            @select="selectedKeyTick = $event"
          />
          <template
            v-for="{ track, clips: trackClips, midiClips, height } in trackRows"
            :key="track.id"
          >
            <ArrangementTrack
              v-if="track.kind === 'audio'"
              :track-id="track.id"
              :track-color="track.color"
              :drag-preview="dragPreview?.trackId === track.id ? dragPreview : null"
              :dragging-clip-id="clipDrag?.clipId ?? null"
              :clips="trackClips"
              :tempo-map="mixerStore.graph.tempoMap"
              :content-width="contentWidth"
              :pixels-per-quarter="pixelsPerQuarter"
              :track-height="height"
              :amplitude-scale="amplitudeScale"
              :display-mode="displayMode"
              :viewport-start-seconds="viewportStartSeconds"
              :viewport-end-seconds="viewportEndSeconds"
              :selected-clip-id="selectedClipId"
              :live-clip="liveClips.find((clip) => clip.trackId === track.id) ?? null"
              @seek="handleSeek"
              @select-clip="selectAudioClip"
              @waveform-frame-count="handleWaveformFrameCount"
              @clip-drag-start="handleClipDragStart"
              @clip-drag-end="handleClipDragEnd"
            />
            <MidiArrangementTrack
              v-else
              :track-id="track.id"
              :track-color="track.color"
              :clips="midiClips"
              :tempo-map="mixerStore.graph.tempoMap"
              :content-width="contentWidth"
              :pixels-per-quarter="pixelsPerQuarter"
              :track-height="height"
              :selected-clip-ids="pianoRollStore.arrangementClipIds"
              :keyboard-insertion-tick="secondsToTick(mixerStore.graph.tempoMap, playheadSeconds)"
              @move="moveMidiClip"
              @remove="removeMidiClip"
              @select="selectMidiClip"
              @open="openMidiClip"
              @create="createMidiClip"
            />
          </template>
          <div
            class="timeline-playhead"
            data-testid="timeline-playhead"
            :style="playheadStyle"
            aria-hidden="true"
          >
            <span />
          </div>
          <div class="empty-lane" aria-hidden="true" />
        </div>
      </div>
    </div>
    <p v-if="recordingError || error" class="playback-error" role="alert">
      {{ recordingError || error }}
    </p>
  </section>
</template>

<style scoped>
.arrangement {
  position: relative;
  display: grid;
  grid-template-rows: 43px minmax(0, 1fr);
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--daw-workspace);
}
.arrangement-toolbar {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding: 0 14px 0 15px;
  border-bottom: 1px solid var(--line-soft);
  background: var(--surface-1);
}
.arrangement-zoom-controls {
  margin-left: auto;
}
.timeline-grid {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
  min-height: 0;
}
.timeline-rail,
.timeline-content {
  display: grid;
}
.timeline-content {
  position: relative;
  min-height: 100%;
}
.timeline-rail {
  min-height: 0;
  overflow: hidden;
  border-right: 1px solid var(--line-soft);
  background: var(--daw-track-header);
}
.timeline-viewport {
  min-width: 0;
  min-height: 0;
  overflow: auto;
  background: var(--daw-lane);
}
.ruler-corner {
  display: flex;
  align-items: center;
  padding: 0 12px;
  border-bottom: 1px solid var(--line-strong);
  color: var(--text-faint);
  background: var(--daw-ruler);
  font: var(--ui-type-weight-bold) var(--ui-type-size-caption) var(--ui-type-family-data);
  letter-spacing: var(--ui-type-tracking-wider);
}
.track-header {
  position: relative;
  display: grid;
  grid-template-columns: 3px 20px minmax(0, 1fr);
  grid-template-rows: minmax(9px, auto) 23px;
  align-content: center;
  align-items: center;
  column-gap: 6px;
  row-gap: 1px;
  padding: 1px 8px;
  border: 0;
  border-bottom: 1px solid var(--line-strong);
  color: var(--text-primary);
  background: var(--daw-track-header);
  text-align: left;
  cursor: pointer;
}
.track-header:hover,
.track-header:focus-within {
  z-index: var(--ui-z-local-selection);
}
.track-header:hover {
  background: var(--daw-track-header-hover);
}
.track-header.selected {
  background: var(--daw-track-header-selected);
  box-shadow: 3px 0 0 var(--accent) inset;
}
.track-header:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: -2px;
}
.track-color {
  grid-row: 1/3;
  align-self: stretch;
  border-radius: 2px;
}
.track-header > strong {
  grid-column: 2;
  grid-row: 1;
  color: var(--text-muted);
  font: var(--ui-type-size-control) var(--ui-type-family-data);
}
.track-copy {
  grid-column: 3;
  grid-row: 1;
  min-width: 0;
}
.track-copy b {
  display: block;
  overflow: hidden;
  font-size: var(--ui-type-size-body-compact);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.track-quick-controls {
  grid-column: 2/4;
  grid-row: 2;
}
.track-spacer {
  background: var(--daw-ruler);
}
.timeline-playhead {
  position: absolute;
  z-index: var(--ui-z-local-controls);
  top: 43px;
  bottom: 0;
  width: 1px;
  background: var(--record);
  box-shadow: 0 0 8px color-mix(in srgb, var(--record) 55%, transparent);
  pointer-events: none;
}
.timeline-playhead span {
  position: absolute;
  top: 0;
  left: -4px;
  width: 9px;
  height: 7px;
  background: var(--record);
  clip-path: polygon(0 0, 100% 0, 50% 100%);
}
.empty-lane {
  background: var(--daw-lane);
}
.playback-error {
  position: absolute;
  right: 12px;
  bottom: 12px;
  margin: 0;
  padding: 8px 10px;
  border: 1px solid color-mix(in srgb, var(--record) 55%, var(--line-strong));
  border-radius: 5px;
  color: var(--record);
  background: color-mix(in srgb, var(--record) 14%, var(--surface-1));
  font-size: var(--ui-type-size-control);
}
@media (max-width: 1100px) {
  .timeline-grid {
    grid-template-columns: 204px minmax(0, 1fr);
  }
}
.track-name-editor {
  display: block;
  font-size: var(--ui-type-size-body-compact);
  font-weight: var(--ui-type-weight-bold);
}
</style>
