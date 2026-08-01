<script setup lang="ts">
import { computed } from "vue"
import { useI18n } from "vue-i18n"
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
import StudioMidiSyncStatus from "./StudioMidiSyncStatus.vue"

const props = defineProps<{
  engineRunning: boolean
  recording: boolean
  recordingBusy: boolean
  playing: boolean
  playLoading: boolean
  canPlay: boolean
  cycleEnabled: boolean
  externalClock: boolean
}>()
const emit = defineEmits<{
  goToStart: []
  togglePlayback: []
  toggleRecording: []
  toggleCycle: []
}>()

const { t } = useI18n()
const playLabel = computed(() =>
  props.playing ? t("studio.transport.pause") : t("studio.transport.play")
)
const playTooltip = computed(() =>
  props.playing ? t("studio.transport.pauseTooltip") : t("studio.transport.playTooltip")
)
const cycleTooltip = computed(() =>
  props.externalClock
    ? t("studio.transport.cycleExternalClockTooltip")
    : props.recording
      ? t("studio.transport.cycleRecordingTooltip")
      : t("studio.transport.cycleTooltip")
)
</script>

<template>
  <div class="transport-controls" :aria-label="t('studio.transport.ariaLabel')">
    <StudioControlButton :label="t('studio.transport.rewind')" unavailable compact-hidden>
      <Rewind :size="15" fill="currentColor" />
    </StudioControlButton>
    <StudioControlButton :label="t('studio.transport.fastForward')" unavailable compact-hidden>
      <FastForward :size="15" fill="currentColor" />
    </StudioControlButton>
    <StudioControlButton
      :label="t('studio.transport.goToBeginning')"
      :tooltip="t('studio.transport.goToBeginningTooltip')"
      @activate="emit('goToStart')"
    >
      <SkipBack :size="15" fill="currentColor" />
    </StudioControlButton>
    <StudioControlButton
      :label="playLabel"
      :tooltip="playTooltip"
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
      :label="t('studio.transport.record')"
      :tooltip="t('studio.transport.recordTooltip')"
      :pressed="recording"
      :disabled="(!engineRunning && !recording) || recordingBusy"
      tone="record"
      @activate="emit('toggleRecording')"
    >
      <Circle :size="13" fill="currentColor" />
    </StudioControlButton>
    <StudioControlButton
      :label="t('studio.transport.captureRecording')"
      unavailable
      compact-hidden
      tone="record"
    >
      <CircleDashed :size="16" />
    </StudioControlButton>
    <StudioControlButton
      :label="t('studio.transport.cycle')"
      :tooltip="cycleTooltip"
      :pressed="cycleEnabled"
      :disabled="externalClock"
      compact-hidden
      tone="accent"
      @activate="emit('toggleCycle')"
    >
      <Repeat2 :size="15" />
    </StudioControlButton>
    <StudioMidiSyncStatus />
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
