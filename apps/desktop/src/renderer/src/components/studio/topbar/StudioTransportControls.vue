<script setup lang="ts">
import {
  Circle,
  CircleDashed,
  FastForward,
  LoaderCircle,
  Pause,
  Play,
  Repeat2,
  Rewind,
  SkipBack
} from "@lucide/vue"
import StudioControlButton from "./StudioControlButton.vue"

defineProps<{
  engineRunning: boolean
  recording: boolean
  recordingBusy: boolean
  playing: boolean
  playLoading: boolean
  canPlay: boolean
}>()
const emit = defineEmits<{
  goToStart: []
  togglePlayback: []
  toggleRecording: []
}>()
</script>

<template>
  <div class="transport-controls" aria-label="Transport controls">
    <StudioControlButton label="Rewind" unavailable compact-hidden>
      <Rewind :size="15" fill="currentColor" />
    </StudioControlButton>
    <StudioControlButton label="Fast-forward" unavailable compact-hidden>
      <FastForward :size="15" fill="currentColor" />
    </StudioControlButton>
    <StudioControlButton
      label="Go to beginning"
      tooltip="Go to beginning · Home"
      @activate="emit('goToStart')"
    >
      <SkipBack :size="15" fill="currentColor" />
    </StudioControlButton>
    <StudioControlButton
      :label="playing ? 'Pause' : 'Play'"
      :tooltip="`${playing ? 'Pause' : 'Play'} · Space`"
      :pressed="playing"
      :disabled="!canPlay && !playing && !playLoading"
      tone="play"
      @activate="emit('togglePlayback')"
    >
      <LoaderCircle v-if="playLoading" :size="15" class="spin" />
      <Pause v-else-if="playing" :size="15" fill="currentColor" />
      <Play v-else :size="15" fill="currentColor" />
    </StudioControlButton>
    <StudioControlButton
      label="Record"
      tooltip="Record · R"
      :pressed="recording"
      :disabled="(!engineRunning && !recording) || recordingBusy"
      tone="record"
      @activate="emit('toggleRecording')"
    >
      <Circle :size="13" fill="currentColor" />
    </StudioControlButton>
    <StudioControlButton label="Capture Recording" unavailable compact-hidden tone="record">
      <CircleDashed :size="16" />
    </StudioControlButton>
    <StudioControlButton label="Cycle" unavailable compact-hidden>
      <Repeat2 :size="15" />
    </StudioControlButton>
  </div>
</template>

<style scoped>
.transport-controls {
  display: flex;
  align-items: center;
  gap: 2px;
}
.spin {
  animation: spin 800ms linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(1turn);
  }
}
@media (prefers-reduced-motion: reduce) {
  .spin {
    animation: none;
  }
}
</style>
