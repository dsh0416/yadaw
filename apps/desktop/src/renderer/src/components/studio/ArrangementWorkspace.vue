<script setup lang="ts">
import { computed, shallowRef } from "vue"
import { storeToRefs } from "pinia"
import { useIntervalFn } from "@vueuse/core"
import { AudioLines } from "@lucide/vue"
import { useProjectStore } from "../../stores/project"
import { useTransportStore } from "../../stores/transport"
import type { TimelineClip } from "../../stores/transport"
import ArrangementTrack from "./ArrangementTrack.vue"
import TimelineRuler from "./TimelineRuler.vue"

const props = defineProps<{
  recordingStartedAt: number | null
  recordingError: string
}>()

const projectStore = useProjectStore()
const transportStore = useTransportStore()
const { session } = storeToRefs(projectStore)
const {
  clips,
  playheadSeconds,
  selectedClipId,
  playing,
  loading,
  error,
  contentEndSeconds,
  timelineDurationSeconds
} = storeToRefs(transportStore)

const clock = shallowRef(Date.now())
useIntervalFn(() => {
  if (props.recordingStartedAt !== null) clock.value = Date.now()
}, 100)

const tempo = computed(() => session.value?.configuration.tempo ?? 120)
const beatsPerBar = computed(() => session.value?.configuration.timeSignatureNumerator ?? 4)
const recordingDuration = computed(() =>
  props.recordingStartedAt === null
    ? 0
    : Math.max(0.05, (clock.value - props.recordingStartedAt) / 1000)
)
const liveClip = computed<TimelineClip | null>(() =>
  props.recordingStartedAt === null
    ? null
    : {
        id: "recording-live",
        assetId: "recording-live",
        name: "New recording",
        startSeconds: contentEndSeconds.value,
        durationSeconds: recordingDuration.value,
        endSeconds: contentEndSeconds.value + recordingDuration.value,
        channels: 2,
        sampleRate: session.value?.configuration.sampleRate ?? 48_000
      }
)
const visibleDuration = computed(() =>
  Math.max(
    timelineDurationSeconds.value,
    (liveClip.value?.endSeconds ?? contentEndSeconds.value) + 2
  )
)
const selectedClip = computed(() =>
  clips.value.find((clip) => clip.id === selectedClipId.value) ?? null
)

function handleSeek(seconds: number): void {
  transportStore.clearSelection()
  transportStore.seek(seconds)
}
</script>

<template>
  <section class="arrangement" aria-label="Arrangement timeline">
    <div class="arrangement-toolbar">
      <div class="arrangement-title">
        <span>ARRANGEMENT</span>
        <strong>{{ selectedClip ? selectedClip.name : "Main timeline" }}</strong>
      </div>
      <div class="transport-state" role="status">
        <i :class="{ active: playing, loading, recording: recordingStartedAt !== null }" />
        <span v-if="recordingStartedAt !== null">Recording {{ recordingDuration.toFixed(1) }} s</span>
        <span v-else-if="loading">Preparing audio…</span>
        <span v-else-if="playing">Playing</span>
        <span v-else>{{ clips.length }} {{ clips.length === 1 ? "clip" : "clips" }}</span>
      </div>
    </div>

    <div class="timeline-grid">
      <div class="ruler-corner">TRACKS</div>
      <TimelineRuler
        :duration-seconds="visibleDuration"
        :tempo="tempo"
        :beats-per-bar="beatsPerBar"
        @seek="handleSeek"
      />

      <div class="track-header">
        <span class="track-color" />
        <strong>01</strong>
        <div class="track-copy">
          <b>Audio 01</b>
          <small>INPUT 1–2 · STEREO</small>
        </div>
        <AudioLines :size="13" aria-hidden="true" />
      </div>
      <ArrangementTrack
        :clips="clips"
        :timeline-duration-seconds="visibleDuration"
        :playhead-seconds="playheadSeconds"
        :selected-clip-id="selectedClipId"
        :live-clip="liveClip"
        :tempo="tempo"
        :beats-per-bar="beatsPerBar"
        @seek="handleSeek"
        @select-clip="transportStore.selectClip"
      />

      <div class="track-spacer">
        <span>01 TRACK</span>
      </div>
      <div class="empty-lane">
        <span v-if="clips.length === 0">Record audio to begin the arrangement.</span>
        <span v-else>Click the timeline to move the playhead. Press Space to play.</span>
      </div>
    </div>

    <p v-if="recordingError || error" class="playback-error" role="alert">{{ recordingError || error }}</p>
  </section>
</template>

<style scoped>
.arrangement{position:relative;display:grid;grid-template-rows:43px 1fr;min-width:0;min-height:0;overflow:hidden;background:#0a0e16}.arrangement-toolbar{display:flex;align-items:center;justify-content:space-between;padding:0 14px 0 15px;border-bottom:1px solid var(--line-soft);background:#111722}.arrangement-title span,.arrangement-title strong{display:block}.arrangement-title span{color:var(--accent);font:700 7px var(--font-utility);letter-spacing:.16em}.arrangement-title strong{max-width:340px;overflow:hidden;margin-top:3px;color:var(--text-secondary);font-size:10px;text-overflow:ellipsis;white-space:nowrap}.transport-state{display:flex;align-items:center;gap:7px;color:#657287;font:7px var(--font-utility);letter-spacing:.04em}.transport-state i{width:6px;height:6px;border-radius:50%;background:#465267}.transport-state i.active{background:var(--signal-cyan);box-shadow:0 0 7px var(--signal-cyan)}.transport-state i.loading{background:var(--warning);box-shadow:0 0 7px var(--warning)}.transport-state i.recording{background:var(--record);box-shadow:0 0 7px var(--record)}.timeline-grid{display:grid;grid-template:27px 101px minmax(64px,1fr)/178px minmax(0,1fr);min-height:0}.ruler-corner{display:flex;align-items:center;padding:0 12px;border-right:1px solid var(--line-soft);border-bottom:1px solid var(--line-strong);color:#536075;background:#101620;font:700 7px var(--font-utility);letter-spacing:.14em}.track-header{display:grid;grid-template-columns:3px 25px minmax(0,1fr) auto;align-items:center;gap:8px;padding:12px 10px;border-right:1px solid var(--line-soft);border-bottom:1px solid var(--line-strong);background:#151b27}.track-color{align-self:stretch;border-radius:2px;background:linear-gradient(var(--accent-soft),var(--signal-cyan));box-shadow:0 0 10px #8c83ff44}.track-header>strong{color:#68758a;font:9px var(--font-utility)}.track-copy b,.track-copy small{display:block}.track-copy b{color:var(--text-primary);font-size:10px}.track-copy small{margin-top:4px;color:var(--text-faint);font:6px var(--font-utility);letter-spacing:.04em}.track-header>svg{color:#68758a}.track-spacer{display:flex;align-items:flex-start;padding:13px 12px;border-right:1px solid var(--line-soft);color:#3e4a5d;background:#101620;font:6px var(--font-utility);letter-spacing:.12em}.empty-lane{display:grid;place-items:center;background-color:#090e16;background-image:linear-gradient(90deg,#171f2b 1px,transparent 1px);background-size:12.5% 100%;color:#435066;font-size:8px}.playback-error{position:absolute;right:12px;bottom:12px;max-width:360px;margin:0;padding:8px 10px;border:1px solid #71394a;border-radius:5px;color:#ffc3cb;background:#321722;font-size:8px;line-height:1.4}@media(max-width:1100px){.timeline-grid{grid-template-columns:152px minmax(0,1fr)}}
</style>
