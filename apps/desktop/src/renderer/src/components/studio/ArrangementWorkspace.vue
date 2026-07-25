<script setup lang="ts">
import { computed, nextTick, shallowRef, useTemplateRef, watch } from "vue"
import { storeToRefs } from "pinia"
import { useResizeObserver } from "@vueuse/core"
import { AudioLines } from "@lucide/vue"
import { useProjectStore } from "../../stores/project"
import { useTransportStore } from "../../stores/transport"
import { useArrangementViewStore } from "../../stores/arrangementView"
import { useMixerStore } from "../../stores/mixer"
import type { TimelineClip } from "../../stores/transport"
import { clipStartSecondsFromPointer, findNearestTrackId } from "../../utils/clipDrag"
import ArrangementTrack from "./ArrangementTrack.vue"
import ArrangementZoomControls from "./ArrangementZoomControls.vue"
import InlineTrackNameEditor from "../InlineTrackNameEditor.vue"
import TimelineRuler from "./TimelineRuler.vue"
import TrackHeightResizeHandle from "./TrackHeightResizeHandle.vue"

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
const { session } = storeToRefs(projectStore)
const {
  clips, playheadSeconds, selectedClipId, error,
  contentEndSeconds, timelineDurationSeconds
} = storeToRefs(transportStore)
const { pixelsPerSecond, trackHeight, amplitudeScale } = storeToRefs(viewStore)
const rail = useTemplateRef<HTMLElement>("rail")
const viewport = useTemplateRef<HTMLElement>("viewport")
const content = useTemplateRef<HTMLElement>("content")
const viewportWidth = shallowRef(1)
const scrollLeft = shallowRef(0)
const liveDurationSeconds = shallowRef(0)
const clipDrag = shallowRef<{
  clipId: string
  offsetSeconds: number
  trackId: string
  startSeconds: number
} | null>(null)
let timeZoomAnchor: { seconds: number; viewportX: number } | null = null

const tempo = computed(() => session.value?.configuration.tempo ?? 120)
const beatsPerBar = computed(() => session.value?.configuration.timeSignatureNumerator ?? 4)
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
    (liveClips.value[0]?.endSeconds ?? contentEndSeconds.value) + 2
  )
)
const contentWidth = computed(() =>
  Math.max(viewportWidth.value, visibleDuration.value * pixelsPerSecond.value)
)
const viewportStartSeconds = computed(() => scrollLeft.value / pixelsPerSecond.value)
const viewportEndSeconds = computed(() =>
  (scrollLeft.value + viewportWidth.value) / pixelsPerSecond.value
)
const dragPreview = computed<TimelineClip | null>(() => {
  const drag = clipDrag.value
  if (!drag) return null
  const clip = clips.value.find((candidate) => candidate.id === drag.clipId)
  if (!clip) return null
  return {
    ...clip,
    trackId: drag.trackId,
    startSeconds: drag.startSeconds,
    endSeconds: drag.startSeconds + clip.durationSeconds
  }
})
const trackRows = computed(() => mixerStore.audioTracks.map((track) => ({
  track,
  clips: clips.value.filter((clip) => clip.trackId === track.id),
  scale: viewStore.trackScale(track.id),
  height: viewStore.effectiveTrackHeight(track.id)
})))
const trackGridRows = computed(() => {
  const rows = trackRows.value.length > 0
    ? trackRows.value.map(({ height }) => `${height}px`).join(" ")
    : `${trackHeight.value}px`
  return `27px ${rows} minmax(64px, 1fr)`
})
const railStyle = computed(() => ({
  gridTemplateRows: trackGridRows.value
}))
const contentStyle = computed(() => ({
  width: `${contentWidth.value}px`,
  gridTemplateRows: trackGridRows.value
}))
const playheadStyle = computed(() => ({
  left: `${playheadSeconds.value * pixelsPerSecond.value}px`
}))

useResizeObserver(viewport, (entries) => {
  viewportWidth.value = Math.max(1, entries[0]?.contentRect.width ?? 1)
  if (viewport.value) syncRailScroll(viewport.value)
})
watch(() => props.recordingStartedAt, () => { liveDurationSeconds.value = 0 })
watch(pixelsPerSecond, (value, previous) => {
  const element = viewport.value
  if (!element || !previous) return
  const anchor = timeZoomAnchor ?? {
    seconds: (element.scrollLeft + element.clientWidth / 2) / previous,
    viewportX: element.clientWidth / 2
  }
  timeZoomAnchor = null
  void nextTick(() => {
    element.scrollLeft = Math.max(0, anchor.seconds * value - anchor.viewportX)
    scrollLeft.value = element.scrollLeft
  })
})

function handleScroll(): void {
  const element = viewport.value
  scrollLeft.value = element?.scrollLeft ?? 0
  if (element) syncRailScroll(element)
}
function syncRailScroll(element: HTMLElement): void {
  const railElement = rail.value
  if (!railElement) return
  railElement.style.paddingBottom = `${Math.max(0, element.offsetHeight - element.clientHeight)}px`
  railElement.scrollTop = element.scrollTop
}
function handleRailWheel(event: WheelEvent): void {
  const element = viewport.value
  if (!element) return
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
    handleWheel(event)
    return
  }
  element.scrollTop += event.deltaY
  element.scrollLeft += event.deltaX
  syncRailScroll(element)
  event.preventDefault()
}
function handleSeek(seconds: number): void {
  transportStore.clearSelection()
  transportStore.seek(seconds)
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
function handleClipDragStart(clipId: string, offsetSeconds: number): void {
  const clip = clips.value.find((candidate) => candidate.id === clipId)
  if (!clip) return
  clipDrag.value = {
    clipId,
    offsetSeconds,
    trackId: clip.trackId,
    startSeconds: clip.startSeconds
  }
}
function updateClipDrag(event: DragEvent): void {
  const drag = clipDrag.value
  const contentElement = content.value
  if (!drag || !contentElement) return

  const lanes = Array.from(
    contentElement.querySelectorAll<HTMLElement>("[data-track-id]")
  ).map((lane) => {
    const bounds = lane.getBoundingClientRect()
    return {
      trackId: lane.dataset.trackId!,
      top: bounds.top,
      bottom: bounds.bottom
    }
  })
  const trackId = findNearestTrackId(lanes, event.clientY)
  if (!trackId) return

  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move"
  const startSeconds = clipStartSecondsFromPointer(
    event.clientX,
    contentElement.getBoundingClientRect().left,
    pixelsPerSecond.value,
    drag.offsetSeconds
  )
  clipDrag.value = { ...drag, trackId, startSeconds }
}
function handleClipDrop(event: DragEvent): void {
  if (!clipDrag.value) return
  updateClipDrag(event)
  const drag = clipDrag.value
  if (!drag) return
  handleMoveClip(drag.clipId, drag.trackId, drag.startSeconds)
  clipDrag.value = null
}
function handleClipDragEnd(): void {
  clipDrag.value = null
}
function reorderTrack(index: number, direction: -1 | 1): void {
  const targetIndex = index + direction
  const source = mixerStore.audioTracks[index]
  const target = mixerStore.audioTracks[targetIndex]
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
function handleWheel(event: WheelEvent): void {
  if ((event.ctrlKey || event.metaKey) && event.altKey) {
    viewStore.zoomAmplitude(event.deltaY < 0 ? 1 : -1)
  }
  else if (event.ctrlKey || event.metaKey) {
    const element = viewport.value
    if (element) {
      const bounds = element.getBoundingClientRect()
      const viewportX = Math.max(0, Math.min(element.clientWidth, event.clientX - bounds.left))
      timeZoomAnchor = {
        seconds: (element.scrollLeft + viewportX) / pixelsPerSecond.value,
        viewportX
      }
    }
    viewStore.zoomTime(event.deltaY < 0 ? 1 : -1)
  }
  else if (event.altKey) viewStore.zoomTrack(event.deltaY < 0 ? 1 : -1)
  else if (event.shiftKey && viewport.value) viewport.value.scrollLeft += event.deltaY
  else return
  event.preventDefault()
}
</script>

<template>
  <section class="arrangement" aria-label="Arrangement timeline">
    <div class="arrangement-toolbar">
      <ArrangementZoomControls
        class="arrangement-zoom-controls"
        :pixels-per-second="pixelsPerSecond"
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
        <div
          v-for="({ track, scale }, index) in trackRows"
          :key="track.id"
          :class="['track-header', { selected: track.id === mixerStore.selectedChannelId }]"
          @click="mixerStore.selectedChannelId = track.id"
          @keydown="handleTrackKeydown($event, index)"
        >
          <span class="track-color" :style="{ background: track.color }" /><strong>{{ String(index + 1).padStart(2, "0") }}</strong>
          <div class="track-copy">
            <InlineTrackNameEditor
              class="track-name-editor"
              :name="track.name"
              :label="`${track.name}; double-click to rename; Alt+Arrow Up or Down to reorder`"
              @rename="mixerStore.updateChannel(track.id, { name: $event })"
            />
            <small>INPUT {{ track.inputChannels.join("–") }} · {{ track.inputFormat?.toUpperCase() }}</small>
          </div>
          <AudioLines :size="13" />
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
            :pixels-per-second="pixelsPerSecond"
            :tempo="tempo"
            :beats-per-bar="beatsPerBar"
            @seek="handleSeek"
          />
          <ArrangementTrack
            v-for="{ track, clips: trackClips, height } in trackRows"
            :key="track.id"
            :track-id="track.id"
            :track-color="track.color"
            :drag-preview="dragPreview?.trackId === track.id ? dragPreview : null"
            :dragging-clip-id="clipDrag?.clipId ?? null"
            :clips="trackClips"
            :content-width="contentWidth"
            :pixels-per-second="pixelsPerSecond"
            :track-height="height"
            :amplitude-scale="amplitudeScale"
            :display-mode="displayMode"
            :viewport-start-seconds="viewportStartSeconds"
            :viewport-end-seconds="viewportEndSeconds"
            :selected-clip-id="selectedClipId"
            :live-clip="liveClips.find((clip) => clip.trackId === track.id) ?? null"
            :tempo="tempo"
            :beats-per-bar="beatsPerBar"
            @seek="handleSeek"
            @select-clip="transportStore.selectClip"
            @waveform-frame-count="handleWaveformFrameCount"
            @clip-drag-start="handleClipDragStart"
            @clip-drag-end="handleClipDragEnd"
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
    <p v-if="recordingError || error" class="playback-error" role="alert">{{ recordingError || error }}</p>
  </section>
</template>

<style scoped>
.arrangement{position:relative;display:grid;grid-template-rows:43px minmax(0,1fr);min-width:0;min-height:0;overflow:hidden;background:var(--daw-workspace)}.arrangement-toolbar{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);align-items:center;gap:12px;padding:0 14px 0 15px;border-bottom:1px solid var(--line-soft);background:var(--surface-1)}.arrangement-zoom-controls{grid-column:3;justify-self:end}.timeline-grid{display:grid;grid-template-columns:178px minmax(0,1fr);min-height:0}.timeline-rail,.timeline-content{display:grid}.timeline-content{position:relative;min-height:100%}.timeline-rail{min-height:0;overflow:hidden;border-right:1px solid var(--line-soft);background:var(--daw-track-header)}.timeline-viewport{min-width:0;min-height:0;overflow:auto;background:var(--daw-lane)}.ruler-corner{display:flex;align-items:center;padding:0 12px;border-bottom:1px solid var(--line-strong);color:var(--text-faint);background:var(--daw-ruler);font:700 7px var(--font-utility);letter-spacing:.14em}.track-header{position:relative;display:grid;grid-template-columns:3px 25px minmax(0,1fr) auto;align-items:center;gap:8px;padding:12px 10px;border:0;border-bottom:1px solid var(--line-strong);color:var(--text-primary);background:var(--daw-track-header);text-align:left;cursor:pointer}.track-header:hover{background:var(--daw-track-header-hover)}.track-header.selected{background:var(--daw-track-header-selected);box-shadow:3px 0 0 var(--accent) inset}.track-header:focus-visible{outline:2px solid var(--focus);outline-offset:-2px}.track-color{align-self:stretch;border-radius:2px}.track-header>strong{color:var(--text-muted);font:9px var(--font-utility)}.track-copy b,.track-copy small{display:block}.track-copy{min-width:0}.track-copy b{overflow:hidden;font-size:10px;text-overflow:ellipsis;white-space:nowrap}.track-copy small{margin-top:4px;color:var(--text-faint);font:6px var(--font-utility)}.track-header>svg{color:var(--text-muted)}.track-spacer{background:var(--daw-ruler)}.timeline-playhead{position:absolute;z-index:8;top:27px;bottom:0;width:1px;background:var(--record);box-shadow:0 0 8px color-mix(in srgb,var(--record) 55%,transparent);pointer-events:none}.timeline-playhead span{position:absolute;top:0;left:-4px;width:9px;height:7px;background:var(--record);clip-path:polygon(0 0,100% 0,50% 100%)}.empty-lane{background:var(--daw-lane)}.playback-error{position:absolute;right:12px;bottom:12px;margin:0;padding:8px 10px;border:1px solid color-mix(in srgb,var(--record) 55%,var(--line-strong));border-radius:5px;color:var(--record);background:color-mix(in srgb,var(--record) 14%,var(--surface-1));font-size:8px}@media(max-width:1100px){.timeline-grid{grid-template-columns:152px minmax(0,1fr)}}
.track-name-editor{display:block;font-size:10px;font-weight:700}
</style>
