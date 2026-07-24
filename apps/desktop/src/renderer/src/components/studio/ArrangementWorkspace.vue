<script setup lang="ts">
import { computed, nextTick, shallowRef, useTemplateRef, watch } from "vue"
import { storeToRefs } from "pinia"
import { useResizeObserver } from "@vueuse/core"
import { AudioLines } from "@lucide/vue"
import { useProjectStore } from "../../stores/project"
import { useTransportStore } from "../../stores/transport"
import { useArrangementViewStore } from "../../stores/arrangementView"
import type { TimelineClip } from "../../stores/transport"
import ArrangementTrack from "./ArrangementTrack.vue"
import ArrangementZoomControls from "./ArrangementZoomControls.vue"
import TimelineRuler from "./TimelineRuler.vue"

const props = defineProps<{
  recordingId: string | null
  recordingStartedAt: number | null
  recordingError: string
}>()
const projectStore = useProjectStore()
const transportStore = useTransportStore()
const viewStore = useArrangementViewStore()
const { session } = storeToRefs(projectStore)
const {
  clips, playheadSeconds, selectedClipId, playing, loading, error,
  contentEndSeconds, timelineDurationSeconds
} = storeToRefs(transportStore)
const { pixelsPerSecond, trackHeight, amplitudeScale } = storeToRefs(viewStore)
const viewport = useTemplateRef<HTMLElement>("viewport")
const viewportWidth = shallowRef(1)
const scrollLeft = shallowRef(0)
const liveDurationSeconds = shallowRef(0)
let timeZoomAnchor: { seconds: number; viewportX: number } | null = null

const tempo = computed(() => session.value?.configuration.tempo ?? 120)
const beatsPerBar = computed(() => session.value?.configuration.timeSignatureNumerator ?? 4)
const displayMode = computed(() => session.value?.configuration.waveformDisplayMode ?? "separate")
const recordingDuration = computed(() => {
  if (liveDurationSeconds.value > 0) return liveDurationSeconds.value
  return props.recordingStartedAt === null ? 0 : 0.05
})
const recordingStartSeconds = computed(() => clips.value
  .filter((clip) => clip.id !== props.recordingId)
  .reduce((latest, clip) => Math.max(latest, clip.endSeconds), 0)
)
const liveClip = computed<TimelineClip | null>(() =>
  props.recordingStartedAt === null || props.recordingId === null ? null : {
  id: props.recordingId,
  assetId: props.recordingId,
  name: "New recording",
  startSeconds: recordingStartSeconds.value,
  durationSeconds: recordingDuration.value,
  endSeconds: recordingStartSeconds.value + recordingDuration.value,
  channels: 2,
  sampleRate: session.value?.configuration.sampleRate ?? 48_000
})
const visibleDuration = computed(() =>
  Math.max(timelineDurationSeconds.value, (liveClip.value?.endSeconds ?? contentEndSeconds.value) + 2)
)
const contentWidth = computed(() =>
  Math.max(viewportWidth.value, visibleDuration.value * pixelsPerSecond.value)
)
const viewportStartSeconds = computed(() => scrollLeft.value / pixelsPerSecond.value)
const viewportEndSeconds = computed(() =>
  (scrollLeft.value + viewportWidth.value) / pixelsPerSecond.value
)
const selectedClip = computed(() => clips.value.find((clip) => clip.id === selectedClipId.value) ?? null)
const railStyle = computed(() => ({
  gridTemplateRows: `27px ${trackHeight.value}px minmax(64px, 1fr)`
}))
const contentStyle = computed(() => ({
  width: `${contentWidth.value}px`,
  gridTemplateRows: `27px ${trackHeight.value}px minmax(64px, 1fr)`
}))

useResizeObserver(viewport, (entries) => {
  viewportWidth.value = Math.max(1, entries[0]?.contentRect.width ?? 1)
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
  scrollLeft.value = viewport.value?.scrollLeft ?? 0
}
function handleSeek(seconds: number): void {
  transportStore.clearSelection()
  transportStore.seek(seconds)
}
function handleWaveformFrameCount(frameCount: number, sampleRate: number): void {
  if (sampleRate > 0) liveDurationSeconds.value = frameCount / sampleRate
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
      <div class="arrangement-title">
        <span>ARRANGEMENT</span>
        <strong>{{ selectedClip ? selectedClip.name : "Main timeline" }}</strong>
      </div>
      <ArrangementZoomControls
        :pixels-per-second="pixelsPerSecond"
        :track-height="trackHeight"
        :amplitude-scale="amplitudeScale"
        @zoom-time="viewStore.zoomTime"
        @zoom-track="viewStore.zoomTrack"
        @zoom-amplitude="viewStore.zoomAmplitude"
        @reset-time="viewStore.resetTime"
        @reset-track="viewStore.resetTrack"
        @reset-amplitude="viewStore.resetAmplitude"
      />
      <div class="transport-state" role="status">
        <i :class="{ active: playing, loading, recording: recordingStartedAt !== null }" />
        <span v-if="recordingStartedAt !== null">Recording {{ recordingDuration.toFixed(1) }} s</span>
        <span v-else-if="loading">Preparing audio…</span>
        <span v-else-if="playing">Playing</span>
        <span v-else>{{ clips.length }} {{ clips.length === 1 ? "clip" : "clips" }}</span>
      </div>
    </div>

    <div class="timeline-grid">
      <div class="timeline-rail" :style="railStyle">
        <div class="ruler-corner">TRACKS</div>
        <div class="track-header">
          <span class="track-color" /><strong>01</strong>
          <div class="track-copy"><b>Audio 01</b><small>INPUT 1–2 · MULTICHANNEL</small></div>
          <AudioLines :size="13" />
        </div>
        <div class="track-spacer"><span>01 TRACK</span></div>
      </div>
      <div ref="viewport" class="timeline-viewport" @scroll="handleScroll" @wheel="handleWheel">
        <div class="timeline-content" :style="contentStyle">
          <TimelineRuler
            :content-width="contentWidth"
            :pixels-per-second="pixelsPerSecond"
            :tempo="tempo"
            :beats-per-bar="beatsPerBar"
            @seek="handleSeek"
          />
          <ArrangementTrack
            :clips="clips"
            :content-width="contentWidth"
            :pixels-per-second="pixelsPerSecond"
            :track-height="trackHeight"
            :amplitude-scale="amplitudeScale"
            :display-mode="displayMode"
            :viewport-start-seconds="viewportStartSeconds"
            :viewport-end-seconds="viewportEndSeconds"
            :playhead-seconds="playheadSeconds"
            :selected-clip-id="selectedClipId"
            :live-clip="liveClip"
            :tempo="tempo"
            :beats-per-bar="beatsPerBar"
            @seek="handleSeek"
            @select-clip="transportStore.selectClip"
            @waveform-frame-count="handleWaveformFrameCount"
          />
          <div class="empty-lane">
            <span>{{ clips.length === 0 ? "Record audio to begin the arrangement." : "Click the timeline to move the playhead. Press Space to play." }}</span>
          </div>
        </div>
      </div>
    </div>
    <p v-if="recordingError || error" class="playback-error" role="alert">{{ recordingError || error }}</p>
  </section>
</template>

<style scoped>
.arrangement{position:relative;display:grid;grid-template-rows:43px minmax(0,1fr);min-width:0;min-height:0;overflow:hidden;background:#0a0e16}.arrangement-toolbar{display:grid;grid-template-columns:minmax(120px,1fr) auto minmax(100px,1fr);align-items:center;gap:12px;padding:0 14px 0 15px;border-bottom:1px solid var(--line-soft);background:#111722}.arrangement-title span,.arrangement-title strong{display:block}.arrangement-title span{color:var(--accent);font:700 7px var(--font-utility);letter-spacing:.16em}.arrangement-title strong{max-width:220px;overflow:hidden;margin-top:3px;color:var(--text-secondary);font-size:10px;text-overflow:ellipsis;white-space:nowrap}.transport-state{display:flex;justify-self:end;align-items:center;gap:7px;color:#657287;font:7px var(--font-utility)}.transport-state i{width:6px;height:6px;border-radius:50%;background:#465267}.transport-state i.active{background:var(--signal-cyan)}.transport-state i.loading{background:var(--warning)}.transport-state i.recording{background:var(--record);box-shadow:0 0 7px var(--record)}.timeline-grid{display:grid;grid-template-columns:178px minmax(0,1fr);min-height:0}.timeline-rail,.timeline-content{display:grid;min-height:100%}.timeline-rail{border-right:1px solid var(--line-soft)}.timeline-viewport{min-width:0;min-height:0;overflow-x:auto;overflow-y:hidden}.ruler-corner{display:flex;align-items:center;padding:0 12px;border-bottom:1px solid var(--line-strong);color:#536075;background:#101620;font:700 7px var(--font-utility);letter-spacing:.14em}.track-header{display:grid;grid-template-columns:3px 25px minmax(0,1fr) auto;align-items:center;gap:8px;padding:12px 10px;border-bottom:1px solid var(--line-strong);background:#151b27}.track-color{align-self:stretch;border-radius:2px;background:linear-gradient(var(--accent-soft),var(--signal-cyan))}.track-header>strong{color:#68758a;font:9px var(--font-utility)}.track-copy b,.track-copy small{display:block}.track-copy b{font-size:10px}.track-copy small{margin-top:4px;color:var(--text-faint);font:6px var(--font-utility)}.track-header>svg{color:#68758a}.track-spacer{padding:13px 12px;color:#3e4a5d;background:#101620;font:6px var(--font-utility)}.empty-lane{display:grid;place-items:center;background:#090e16;color:#435066;font-size:8px}.playback-error{position:absolute;right:12px;bottom:12px;margin:0;padding:8px 10px;border:1px solid #71394a;border-radius:5px;color:#ffc3cb;background:#321722;font-size:8px}@media(max-width:1100px){.timeline-grid{grid-template-columns:152px minmax(0,1fr)}.arrangement-toolbar{grid-template-columns:1fr auto}.arrangement-title{display:none}}
</style>
