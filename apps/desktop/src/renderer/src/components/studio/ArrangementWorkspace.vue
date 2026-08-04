<script setup lang="ts">
import { computed, shallowRef, watch } from "vue"
import { useI18n } from "vue-i18n"
import { storeToRefs } from "pinia"
import { UiSelect } from "@heron/ui"
import { useProjectStore } from "../../stores/project"
import { useTransportStore } from "../../stores/transport"
import { useArrangementViewStore } from "../../stores/arrangementView"
import { useMixerStore } from "../../stores/mixer"
import { useMidiInputStore } from "../../stores/midiInput"
import { usePianoRollStore } from "../../stores/pianoRoll"
import { useStudioWorkspaceStore } from "../../stores/studioWorkspace"
import ArrangementTimelineTrack from "./ArrangementTimelineTrack.vue"
import ArrangementTrackRail from "./ArrangementTrackRail.vue"
import ArrangementZoomControls from "./ArrangementZoomControls.vue"
import GlobalTracksToggle from "./GlobalTracksToggle.vue"
import KeySignatureDropdown from "./KeySignatureDropdown.vue"
import TimelineRuler from "./TimelineRuler.vue"
import { secondsToTick } from "../../utils/tempoMap"
import GlobalLaneHeader from "./global-lanes/GlobalLaneHeader.vue"
import GlobalEventLaneHeader from "./global-lanes/GlobalEventLaneHeader.vue"
import KeyTrackLane from "./global-lanes/KeyTrackLane.vue"
import MeterTrackLane from "./global-lanes/MeterTrackLane.vue"
import TempoTrackLane from "./global-lanes/TempoTrackLane.vue"
import { secondsToTimelineX } from "../../utils/timelineCoordinates"
import { useArrangementViewport } from "./useArrangementViewport"
import { useArrangementClipDrag } from "./useArrangementClipDrag"
import { useGlobalLaneSelection } from "./useGlobalLaneSelection"
import { useMidiClipDrag } from "./useMidiClipDrag"
import { useArrangementRecordingProjection } from "./useArrangementRecordingProjection"
import { useArrangementTrackProjection } from "./useArrangementTrackProjection"
import { useArrangementEditingCommands } from "./useArrangementEditingCommands"

const props = defineProps<{
  recordingId: string | null
  recordingStartedAt: number | null
  recordingStartFrame: number | null
  recordingStartTick?: number | null
  recordingAudioTrackIds?: string[]
  recordingMidiTrackIds?: string[]
  recordingError: string
}>()
const { t } = useI18n()
const projectStore = useProjectStore()
const transportStore = useTransportStore()
const viewStore = useArrangementViewStore()
const mixerStore = useMixerStore()
const midiInputStore = useMidiInputStore()
const pianoRollStore = usePianoRollStore()
const workspaceStore = useStudioWorkspaceStore()
const { snap: pianoRollSnap } = storeToRefs(pianoRollStore)
const { session } = storeToRefs(projectStore)
const {
  clips,
  playheadSeconds,
  selectedClipId,
  error,
  loopEnabled,
  loopRange,
  contentEndSeconds,
  timelineDurationSeconds
} = storeToRefs(transportStore)
const { pixelsPerQuarter, trackHeight, amplitudeScale, globalTracksExpanded } =
  storeToRefs(viewStore)
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
const TEMPO_LANE_HEIGHT = 112
const GLOBAL_EVENT_LANE_HEIGHT = 64
const displayMode = computed(() => session.value?.configuration.waveformDisplayMode ?? "separate")
const {
  liveClips,
  hasRecordingStartTick,
  recordingStartTick: recordingStartTickValue,
  recordingPositionTick,
  recordingMidiTrackIds: recordingMidiTrackIdSet,
  liveMidiPreview,
  visibleDuration
} = useArrangementRecordingProjection({
  recordingId: () => props.recordingId,
  recordingStartedAt: () => props.recordingStartedAt,
  recordingStartFrame: () => props.recordingStartFrame,
  recordingStartTick: () => props.recordingStartTick,
  recordingAudioTrackIds: () => props.recordingAudioTrackIds,
  recordingMidiTrackIds: () => props.recordingMidiTrackIds,
  liveDurationSeconds,
  sampleRate: () => session.value?.configuration.sampleRate ?? 48_000,
  playheadSeconds,
  contentEndSeconds,
  timelineDurationSeconds,
  selectedChannelId: () => mixerStore.selectedChannelId,
  audioTracks: () => mixerStore.audioTracks,
  instrumentTracks: () => mixerStore.instrumentTracks,
  graph: () => mixerStore.graph,
  midiRecordingPreview: () => midiInputStore.snapshot.recordingPreview ?? null,
  recordingName: () => t("studio.arrangement.newRecording")
})
const playheadTick = computed(() => secondsToTick(mixerStore.graph.tempoMap, playheadSeconds.value))
const playheadFrame = computed(() =>
  Math.round(playheadSeconds.value * mixerStore.graph.sampleRate)
)
const { rows: trackRows } = useArrangementTrackProjection({
  tracks: () => mixerStore.timelineTracks,
  audioClips: () => clips.value,
  midiClips: () => mixerStore.graph.midiClips,
  trackScale: viewStore.trackScale,
  trackHeight: viewStore.effectiveTrackHeight,
  meterFor: mixerStore.meterFor
})
const {
  moveAudioClip,
  removeAudioClip,
  trimAudioClip,
  splitAudioClip,
  updateAudioFade,
  resetAudioFades,
  reorderTrack,
  removeMidiClip,
  trimMidiClip,
  splitMidiClip,
  moveMidiClip,
  selectAudioClip,
  selectMidiClip,
  openMidiClip,
  createMidiClip
} = useArrangementEditingCommands({
  graph: () => mixerStore.graph,
  tracks: () => mixerStore.timelineTracks,
  playheadFrame: () => playheadFrame.value,
  playheadTick: () => playheadTick.value,
  snap: () => pianoRollStore.snap,
  selectedAudioClipId: () => transportStore.selectedClipId,
  selectedMidiClipIds: () => pianoRollStore.arrangementClipIds,
  execute: mixerStore.execute,
  clearAudioSelection: transportStore.clearSelection,
  selectAudioClip: transportStore.selectClip,
  clearMidiSelection: pianoRollStore.clearArrangementSelection,
  selectMidiClip: pianoRollStore.selectArrangementClip,
  openMidiClipSet: pianoRollStore.openClipSet,
  openPianoRoll: workspaceStore.openPianoRollDock,
  midiClipName: (index) => t("studio.arrangement.midiClipName", { index })
})
const { contentWidth, viewportStartSeconds, viewportEndSeconds, handleScroll, handleWheel } =
  useArrangementViewport({
    tempoMap: () => mixerStore.graph.tempoMap,
    pixelsPerQuarter,
    visibleDuration,
    zoomTime: viewStore.zoomTime,
    zoomTrack: viewStore.zoomTrack,
    zoomAmplitude: viewStore.zoomAmplitude
  })
const {
  content,
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
  moveClip: (clipId, trackId, startSeconds) => {
    void moveAudioClip(clipId, trackId, startSeconds)
  }
})
const midiClipList = computed(() => mixerStore.graph.midiClips)
const {
  midiClipDrag,
  midiDragPreview,
  handleMidiClipDragStart,
  updateMidiClipDrag,
  handleMidiClipDrop,
  handleMidiClipDragEnd
} = useMidiClipDrag({
  clips: midiClipList,
  content,
  tempoMap: () => mixerStore.graph.tempoMap,
  pixelsPerQuarter,
  snap: pianoRollSnap,
  moveClip: (clipId, trackId, startTick) => {
    void moveMidiClip(clipId, trackId, startTick)
  }
})
const trackGridRows = computed(() => {
  const rows = ["43px"]
  if (globalTracksExpanded.value) {
    rows.push(
      `${TEMPO_LANE_HEIGHT}px`,
      `${GLOBAL_EVENT_LANE_HEIGHT}px`,
      `${GLOBAL_EVENT_LANE_HEIGHT}px`
    )
  }
  rows.push(
    ...(trackRows.value.length > 0
      ? trackRows.value.map(({ height }) => `${height}px`)
      : [`${trackHeight.value}px`]),
    "minmax(64px, 1fr)"
  )
  return rows.join(" ")
})
const railStyle = computed(() => ({
  gridTemplateRows: trackGridRows.value
}))
const scrollContentStyle = computed(() => ({
  gridTemplateColumns: `var(--arrangement-rail-width) ${contentWidth.value}px`
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
function updateCycleRange(range: { startTick: number; endTick: number }): void {
  void transportStore.setLoop(true, range)
}
function updateProjectEnd(endTick: number): void {
  void mixerStore.execute({ type: "update-project-end", endTick })
}
function handleWaveformFrameCount(frameCount: number, sampleRate: number): void {
  if (sampleRate > 0) liveDurationSeconds.value = frameCount / sampleRate
}
function updateArrangementDrag(event: DragEvent): void {
  updateClipDrag(event)
  updateMidiClipDrag(event)
}

function handleArrangementDrop(event: DragEvent): void {
  handleClipDrop(event)
  handleMidiClipDrop(event)
}
</script>

<template>
  <section class="arrangement" :aria-label="t('studio.arrangement.ariaLabel')">
    <div class="arrangement-toolbar">
      <GlobalTracksToggle :expanded="globalTracksExpanded" @toggle="viewStore.toggleGlobalTracks" />
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
        ref="viewport"
        class="timeline-viewport"
        data-testid="timeline-viewport"
        @scroll="handleScroll"
        @wheel="handleWheel"
      >
        <div class="timeline-scroll-content" :style="scrollContentStyle">
          <div ref="rail" class="timeline-rail" data-testid="timeline-rail" :style="railStyle">
            <div class="ruler-corner">{{ t("studio.arrangement.tracks") }}</div>
            <template v-if="globalTracksExpanded">
              <GlobalLaneHeader
                :label="t('studio.arrangement.tempo')"
                :eyebrow="t('studio.arrangement.globalTrack')"
                :value="selectedTempo.beatsPerMinute"
                unit="BPM"
                :minimum="20"
                :maximum="300"
                color="var(--ui-domain-color-65a8ff)"
                @update-value="updateSelectedTempo"
              />
              <GlobalEventLaneHeader
                :label="t('studio.arrangement.meter')"
                :eyebrow="t('studio.arrangement.globalTrack')"
                color="var(--ui-domain-color-f2a65a)"
              >
                <template #controls>
                  <input
                    :value="selectedMeter.numerator"
                    type="number"
                    min="1"
                    max="32"
                    :aria-label="t('studio.arrangement.meterNumeratorAria')"
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
                    :aria-label="t('studio.arrangement.meterDenominatorAria')"
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
                :label="t('studio.arrangement.key')"
                :eyebrow="t('studio.arrangement.globalTrack')"
                color="var(--ui-domain-color-b894ff)"
              >
                <template #controls>
                  <KeySignatureDropdown
                    :model-value="selectedKeyValue"
                    size="compact"
                    appearance="workspace"
                    :aria-label="t('studio.arrangement.keySignatureAria')"
                    @update:model-value="updateSelectedKey"
                  />
                </template>
              </GlobalEventLaneHeader>
            </template>
            <ArrangementTrackRail
              :rows="trackRows"
              :selected-channel-id="mixerStore.selectedChannelId"
              :track-height="trackHeight"
              @select="mixerStore.selectedChannelId = $event"
              @reorder="reorderTrack"
              @rename="(channelId, name) => mixerStore.updateChannel(channelId, { name })"
              @preview="mixerStore.preview"
              @update-channel="mixerStore.updateChannel"
              @set-scale="viewStore.setTrackScale"
              @reset-scale="viewStore.resetTrackScale"
            />
          </div>
          <div
            ref="content"
            class="timeline-content"
            :style="contentStyle"
            @dragover="updateArrangementDrag"
            @drop="handleArrangementDrop"
          >
            <TimelineRuler
              :content-width="contentWidth"
              :pixels-per-quarter="pixelsPerQuarter"
              :tempo-map="mixerStore.graph.tempoMap"
              :loop-enabled="loopEnabled"
              :loop-range="loopRange"
              :project-end-tick="mixerStore.graph.projectEndTick"
              :cycle-disabled="transportStore.snapshot.clockSource === 'external'"
              @seek="handleSeek"
              @update-loop-range="updateCycleRange"
              @update-project-end="updateProjectEnd"
            />
            <template v-if="globalTracksExpanded">
              <TempoTrackLane
                :tempo-map="mixerStore.graph.tempoMap"
                :selected-tick="selectedTempoTick"
                :content-width="contentWidth"
                :pixels-per-quarter="pixelsPerQuarter"
                :height="TEMPO_LANE_HEIGHT"
                @replace="replaceTempoMap"
                @select="selectedTempoTick = $event"
              />
              <MeterTrackLane
                :tempo-map="mixerStore.graph.tempoMap"
                :selected-tick="selectedMeterTick"
                :content-width="contentWidth"
                :pixels-per-quarter="pixelsPerQuarter"
                :height="GLOBAL_EVENT_LANE_HEIGHT"
                @replace="replaceTempoMap"
                @select="selectedMeterTick = $event"
              />
              <KeyTrackLane
                :events="mixerStore.graph.keySignatureEvents"
                :tempo-map="mixerStore.graph.tempoMap"
                :selected-tick="selectedKeyTick"
                :content-width="contentWidth"
                :pixels-per-quarter="pixelsPerQuarter"
                :height="GLOBAL_EVENT_LANE_HEIGHT"
                @replace="replaceKeySignatureMap"
                @select="selectedKeyTick = $event"
              />
            </template>
            <ArrangementTimelineTrack
              v-for="row in trackRows"
              :key="row.track.id"
              :row="row"
              :tempo-map="mixerStore.graph.tempoMap"
              :content-width="contentWidth"
              :pixels-per-quarter="pixelsPerQuarter"
              :amplitude-scale="amplitudeScale"
              :display-mode="displayMode"
              :viewport-start-seconds="viewportStartSeconds"
              :viewport-end-seconds="viewportEndSeconds"
              :selected-audio-clip-id="selectedClipId"
              :selected-midi-clip-ids="pianoRollStore.arrangementClipIds"
              :keyboard-insertion-tick="playheadTick"
              :playhead-tick="playheadTick"
              :playhead-frame="playheadFrame"
              :snap="pianoRollSnap"
              :audio-drag-preview="dragPreview?.trackId === row.track.trackId ? dragPreview : null"
              :dragging-audio-clip-id="clipDrag?.clipId ?? null"
              :midi-drag-preview="
                midiDragPreview?.trackId === row.track.trackId ? midiDragPreview : null
              "
              :dragging-midi-clip-id="midiClipDrag?.clipId ?? null"
              :live-audio-clip="
                liveClips.find((clip) => clip.trackId === row.track.trackId) ?? null
              "
              :recording-midi="
                recordingId !== null &&
                hasRecordingStartTick &&
                recordingMidiTrackIdSet.has(row.track.trackId)
              "
              :recording-start-tick="recordingStartTickValue"
              :recording-position-tick="recordingPositionTick"
              :live-midi-take="
                liveMidiPreview?.takes.find((take) => take.trackId === row.track.trackId) ?? null
              "
              @seek="handleSeek"
              @select-audio-clip="selectAudioClip"
              @waveform-frame-count="handleWaveformFrameCount"
              @audio-clip-drag-start="handleClipDragStart"
              @audio-clip-drag-end="handleClipDragEnd"
              @remove-audio-clip="removeAudioClip"
              @split-audio-clip="splitAudioClip"
              @trim-audio-clip="trimAudioClip"
              @fade-audio-clip="updateAudioFade"
              @reset-audio-fades="resetAudioFades"
              @remove-midi-clip="removeMidiClip"
              @select-midi-clip="selectMidiClip"
              @open-midi-clip="openMidiClip"
              @create-midi-clip="createMidiClip"
              @split-midi-clip="splitMidiClip"
              @trim-midi-clip="trimMidiClip"
              @midi-clip-drag-start="handleMidiClipDragStart"
              @midi-clip-drag-end="handleMidiClipDragEnd"
            />
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
  --arrangement-rail-width: 220px;

  min-width: 0;
  min-height: 0;
}
.timeline-scroll-content {
  display: grid;
  width: max-content;
  min-width: 100%;
  min-height: 100%;
  isolation: isolate;
}
.timeline-rail,
.timeline-content {
  display: grid;
}
.timeline-content {
  position: relative;
  z-index: var(--ui-z-local-base);
  min-height: 100%;
}
.timeline-rail {
  position: sticky;
  z-index: var(--ui-z-local-sticky);
  left: 0;
  min-height: 0;
  border-right: 1px solid var(--line-soft);
  background: var(--daw-track-header);
}
.timeline-viewport {
  width: 100%;
  height: 100%;
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
    --arrangement-rail-width: 204px;
  }
}
</style>
