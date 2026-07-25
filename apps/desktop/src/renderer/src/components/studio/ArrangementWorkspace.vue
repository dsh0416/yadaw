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
import ArrangementTrack from "./ArrangementTrack.vue"
import ArrangementZoomControls from "./ArrangementZoomControls.vue"
import InlineTrackNameEditor from "../InlineTrackNameEditor.vue"
import TimelineRuler from "./TimelineRuler.vue"

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
        channels: track.channelFormat === "mono" ? 1 : 2,
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
const selectedClip = computed(() => clips.value.find((clip) => clip.id === selectedClipId.value) ?? null)
const trackRows = computed(() => mixerStore.audioTracks.map((track) => ({
  track,
  clips: clips.value.filter((clip) => clip.trackId === track.id)
})))
const trackGridRows = computed(() =>
  `27px repeat(${Math.max(1, trackRows.value.length)}, ${trackHeight.value}px) minmax(64px, 1fr)`
)
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
      <div class="arrangement-title">
        <span>ARRANGEMENT</span>
        <strong>{{ selectedClip ? selectedClip.name : mixerStore.selectedChannel?.name ?? "Main timeline" }}</strong>
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
        <span v-else>{{ mixerStore.audioTracks.length }} tracks · {{ clips.length }} clips</span>
      </div>
    </div>

    <div class="timeline-grid">
      <div class="timeline-rail" :style="railStyle">
        <div class="ruler-corner">TRACKS</div>
        <div
          v-for="({ track }, index) in trackRows"
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
            <small>INPUT {{ track.inputChannels.join("–") }} · {{ track.channelFormat.toUpperCase() }}</small>
          </div>
          <AudioLines :size="13" />
        </div>
        <div class="track-spacer"><span>{{ mixerStore.audioTracks.length }} TRACKS</span></div>
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
            v-for="{ track, clips: trackClips } in trackRows"
            :key="track.id"
            :track-id="track.id"
            :track-color="track.color"
            :clips="trackClips"
            :content-width="contentWidth"
            :pixels-per-second="pixelsPerSecond"
            :track-height="trackHeight"
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
            @move-clip="handleMoveClip"
          />
          <div
            class="timeline-playhead"
            data-testid="timeline-playhead"
            :style="playheadStyle"
            aria-hidden="true"
          >
            <span />
          </div>
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
.arrangement{position:relative;display:grid;grid-template-rows:43px minmax(0,1fr);min-width:0;min-height:0;overflow:hidden;background:var(--daw-workspace)}.arrangement-toolbar{display:grid;grid-template-columns:minmax(120px,1fr) auto minmax(100px,1fr);align-items:center;gap:12px;padding:0 14px 0 15px;border-bottom:1px solid var(--line-soft);background:var(--surface-1)}.arrangement-title span,.arrangement-title strong{display:block}.arrangement-title span{color:var(--accent);font:700 7px var(--font-utility);letter-spacing:.16em}.arrangement-title strong{max-width:220px;overflow:hidden;margin-top:3px;color:var(--text-secondary);font-size:10px;text-overflow:ellipsis;white-space:nowrap}.transport-state{display:flex;justify-self:end;align-items:center;gap:7px;color:var(--text-muted);font:7px var(--font-utility)}.transport-state i{width:6px;height:6px;border-radius:50%;background:var(--text-faint)}.transport-state i.active{background:var(--signal-cyan)}.transport-state i.loading{background:var(--warning)}.transport-state i.recording{background:var(--record);box-shadow:0 0 7px var(--record)}.timeline-grid{display:grid;grid-template-columns:178px minmax(0,1fr);min-height:0}.timeline-rail,.timeline-content{display:grid;min-height:100%}.timeline-content{position:relative}.timeline-rail{border-right:1px solid var(--line-soft);background:var(--daw-track-header)}.timeline-viewport{min-width:0;min-height:0;overflow:auto;background:var(--daw-lane)}.ruler-corner{display:flex;align-items:center;padding:0 12px;border-bottom:1px solid var(--line-strong);color:var(--text-faint);background:var(--daw-ruler);font:700 7px var(--font-utility);letter-spacing:.14em}.track-header{display:grid;grid-template-columns:3px 25px minmax(0,1fr) auto;align-items:center;gap:8px;padding:12px 10px;border:0;border-bottom:1px solid var(--line-strong);color:var(--text-primary);background:var(--daw-track-header);text-align:left;cursor:pointer}.track-header:hover{background:var(--daw-track-header-hover)}.track-header.selected{background:var(--daw-track-header-selected);box-shadow:3px 0 0 var(--accent) inset}.track-header:focus-visible{outline:2px solid var(--focus);outline-offset:-2px}.track-color{align-self:stretch;border-radius:2px}.track-header>strong{color:var(--text-muted);font:9px var(--font-utility)}.track-copy b,.track-copy small{display:block}.track-copy{min-width:0}.track-copy b{overflow:hidden;font-size:10px;text-overflow:ellipsis;white-space:nowrap}.track-copy small{margin-top:4px;color:var(--text-faint);font:6px var(--font-utility)}.track-header>svg{color:var(--text-muted)}.track-spacer{padding:13px 12px;color:var(--text-faint);background:var(--daw-ruler);font:6px var(--font-utility)}.timeline-playhead{position:absolute;z-index:8;top:27px;bottom:0;width:1px;background:var(--record);box-shadow:0 0 8px color-mix(in srgb,var(--record) 55%,transparent);pointer-events:none}.timeline-playhead span{position:absolute;top:0;left:-4px;width:9px;height:7px;background:var(--record);clip-path:polygon(0 0,100% 0,50% 100%)}.empty-lane{display:grid;place-items:center;background:var(--daw-lane);color:var(--text-faint);font-size:8px}.playback-error{position:absolute;right:12px;bottom:12px;margin:0;padding:8px 10px;border:1px solid color-mix(in srgb,var(--record) 55%,var(--line-strong));border-radius:5px;color:var(--record);background:color-mix(in srgb,var(--record) 14%,var(--surface-1));font-size:8px}@media(max-width:1100px){.timeline-grid{grid-template-columns:152px minmax(0,1fr)}.arrangement-toolbar{grid-template-columns:1fr auto}.arrangement-title{display:none}}
.track-name-editor{display:block;font-size:10px;font-weight:700}
</style>
