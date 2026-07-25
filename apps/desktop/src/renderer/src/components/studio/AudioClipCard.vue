<script setup lang="ts">
import { computed, watch } from "vue"
import type { WaveformDisplayMode } from "@yadaw/contracts"
import type { TimelineClip } from "../../stores/transport"
import { useClipWaveform } from "../../composables/useClipWaveform"
import ChannelFormatIcon from "./ChannelFormatIcon.vue"
import WaveformCanvas from "./WaveformCanvas.vue"

const props = defineProps<{
  clip: TimelineClip
  pixelsPerSecond: number
  viewportStartSeconds: number
  viewportEndSeconds: number
  amplitudeScale: number
  displayMode: WaveformDisplayMode
  selected: boolean
  recording?: boolean
}>()

const emit = defineEmits<{
  select: [id: string]
  waveformFrameCount: [frameCount: number, sampleRate: number]
}>()

const clipStyle = computed(() => ({
  left: `${props.clip.startSeconds * props.pixelsPerSecond}px`,
  width: `max(${props.clip.durationSeconds * props.pixelsPerSecond}px, 12px)`
}))
const visibleStartSeconds = computed(() =>
  Math.max(props.clip.startSeconds, props.viewportStartSeconds)
)
const visibleEndSeconds = computed(() =>
  Math.min(props.clip.endSeconds, props.viewportEndSeconds)
)
const visibleWidth = computed(() =>
  Math.max(1, (visibleEndSeconds.value - visibleStartSeconds.value) * props.pixelsPerSecond)
)
const waveformStyle = computed(() => ({
  left: `${(visibleStartSeconds.value - props.clip.startSeconds) * props.pixelsPerSecond}px`,
  width: `${visibleWidth.value}px`
}))
const startFrame = computed(() =>
  Math.max(0, Math.floor((visibleStartSeconds.value - props.clip.startSeconds) * props.clip.sampleRate))
)
const endFrame = computed(() =>
  props.recording
    ? Number.MAX_SAFE_INTEGER
    : Math.max(
        startFrame.value,
        Math.ceil((visibleEndSeconds.value - props.clip.startSeconds) * props.clip.sampleRate)
      )
)
const { data: waveformData, loading: waveformLoading } = useClipWaveform({
  id: () => props.clip.assetId,
  recording: () => Boolean(props.recording),
  startFrame,
  endFrame,
  pixelWidth: visibleWidth
})

watch(() => waveformData.value?.frameCount, (frameCount) => {
  if (props.recording && frameCount !== undefined && waveformData.value) {
    emit("waveformFrameCount", frameCount, waveformData.value.sampleRate)
  }
})

function startDrag(event: DragEvent): void {
  if (props.recording || !event.dataTransfer) {
    event.preventDefault()
    return
  }
  const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect()
  event.dataTransfer.effectAllowed = "move"
  event.dataTransfer.setData("application/x-yadaw-clip", JSON.stringify({
    id: props.clip.id,
    offsetSeconds: Math.max(0, (event.clientX - bounds.left) / props.pixelsPerSecond)
  }))
}
</script>

<template>
  <button
    :class="['audio-clip', { selected, recording }]"
    :style="clipStyle"
    :aria-label="`${recording ? 'Recording' : 'Audio clip'} ${clip.name}`"
    :aria-pressed="selected"
    :draggable="!recording"
    @pointerdown.stop
    @click.stop="emit('select', clip.id)"
    @dragstart.stop="startDrag"
  >
    <span class="clip-heading" :title="clip.name">
      <b class="clip-name">{{ clip.name }}</b>
      <span v-if="recording" class="capture-dot" aria-label="Recording" />
      <ChannelFormatIcon :channels="clip.channels" />
    </span>
    <span v-if="visibleEndSeconds > visibleStartSeconds" class="waveform" :style="waveformStyle">
      <WaveformCanvas
        :window="waveformData"
        :display-mode="displayMode"
        :amplitude-scale="amplitudeScale"
        :loading="waveformLoading"
        :recording="recording"
      />
    </span>
  </button>
</template>

<style scoped>
.audio-clip{position:absolute;z-index:2;top:9px;bottom:9px;display:block;min-width:12px;overflow:hidden;padding:0;border:1px solid #716be0;border-radius:4px;color:#f0efff;background:linear-gradient(180deg,#4b47a8ed,#283373ed);box-shadow:0 1px 0 #ffffff24 inset,0 7px 18px #02040a55;cursor:pointer;text-align:left}.audio-clip:hover{border-color:#a7a1ff;filter:brightness(1.08)}.audio-clip:focus-visible{outline:2px solid #d2ceff;outline-offset:-3px}.audio-clip.selected{z-index:3;border-color:#e4e2ff;box-shadow:0 0 0 2px #a49cff99 inset,0 0 20px #8179ff66}.audio-clip.recording{border-color:#ff6d7d;background:linear-gradient(180deg,#a23850ed,#59283fed);box-shadow:0 0 18px #ff65774d}.clip-heading{position:absolute;z-index:3;top:0;right:0;left:0;display:flex;align-items:center;gap:5px;height:23px;padding:4px 6px 5px;color:#f7f7ff;background:linear-gradient(180deg,#29285dcf 0%,#29285d8f 72%,transparent 100%);pointer-events:none;white-space:nowrap}.recording .clip-heading{background:linear-gradient(180deg,#602239d9 0%,#60223991 72%,transparent 100%)}.clip-name{min-width:0;flex:1;overflow:hidden;font-size:9px;font-weight:650;line-height:13px;text-overflow:ellipsis;text-shadow:0 1px 2px #050815a8}.channel-format{color:#d9d7ff;filter:drop-shadow(0 1px 1px #080a16)}.recording .channel-format{color:#ffe0e4}.capture-dot{flex:none;width:6px;height:6px;border:1px solid #ffe5e9;border-radius:50%;background:#ff5b70;box-shadow:0 0 5px #ff5b70}.waveform{position:absolute;z-index:1;top:22px;right:0;bottom:3px;overflow:hidden;opacity:.94}
</style>
