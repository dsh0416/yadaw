<script setup lang="ts">
import { computed, shallowRef } from "vue"
import { storeToRefs } from "pinia"
import type {
  ApplicationSettings,
  MeterPeakHold,
  MeterReturnRate,
  MixerChannelMeter
} from "@heron/contracts"
import { UiLevelMeter } from "@heron/ui"
import { usePeakMeterDisplay } from "../../composables/usePeakMeterDisplay"
import { useApplicationSettingsStore } from "../../stores/applicationSettings"
import { useMixerRuntimeStore } from "../../stores/mixerRuntime"
import { METER_SCALE_MARKS } from "../../utils/mixerDbScale"
import type { MixerStripDisplayOptions } from "./mixer-strip-display-options"

const props = defineProps<{
  channelId: string
  channelName: string
  meter?: MixerChannelMeter
  displayOptions?: MixerStripDisplayOptions
}>()
const emit = defineEmits<{
  resetMeterClips: []
}>()

// Tests and static previews can provide a meter directly. Production instances subscribe here so
// a 30 Hz runtime update invalidates only this small display rather than the full channel strip.
const runtimeStore = useMixerRuntimeStore()
const settingsStore = props.displayOptions ? null : useApplicationSettingsStore()
const settings = settingsStore
  ? storeToRefs(settingsStore).settings
  : shallowRef<ApplicationSettings | null>(null)
const meter = computed(() => props.meter ?? runtimeStore.meterFor(props.channelId))
const peakHold = computed<MeterPeakHold>(
  () => props.displayOptions?.meterPeakHold ?? settings.value?.meterPeakHold ?? "800ms"
)
const returnRate = computed<MeterReturnRate>(
  () => props.displayOptions?.meterReturnRate ?? settings.value?.meterReturnRate ?? "iec-type-i"
)
const meterDisplay = usePeakMeterDisplay({ meter, peakHold, returnRate })
const maximumPeakLabel = computed(() =>
  Number.isFinite(meterDisplay.latchedPeakDb.value)
    ? meterDisplay.latchedPeakDb.value.toFixed(1)
    : "−∞"
)
const maximumPeakState = computed(() => ({
  active: Number.isFinite(meterDisplay.latchedPeakDb.value),
  hot: meterDisplay.latchedPeakDb.value >= -6,
  clipped: meterDisplay.clipped.value
}))

function resetMaximumPeak(): void {
  meterDisplay.resetPeakAndClip()
  emit("resetMeterClips")
}
</script>

<template>
  <div class="meter-display">
    <button
      type="button"
      :class="['maximum-peak-value', maximumPeakState]"
      :aria-label="`${channelName} latched maximum post-fader level in decibels`"
      :title="`Maximum post-fader peak: ${maximumPeakLabel} dB · Click to reset peak and clipping`"
      @pointerdown.stop
      @click.stop="resetMaximumPeak"
    >
      {{ maximumPeakLabel }}
    </button>
    <UiLevelMeter
      class="meter-rack"
      :level-percent="meterDisplay.meterLevelPercent.value"
      :held-level-percent="meterDisplay.heldMeterLevelPercent.value"
      :has-held-peak="Number.isFinite(meterDisplay.heldPeakDb.value)"
      :clipped="meterDisplay.clipped.value"
      :marks="METER_SCALE_MARKS"
      :label="`${channelName} post-fader level`"
    />
  </div>
</template>

<style scoped>
.meter-display {
  display: contents;
}
.meter-rack {
  grid-column: 2;
  grid-row: 2;
  margin-block: 8px;
}
.maximum-peak-value {
  display: grid;
  grid-column: 2;
  grid-row: 1;
  place-items: center;
  width: 34px;
  height: 20px;
  overflow: hidden;
  border: 1px solid var(--line-strong);
  border-radius: 2px;
  color: var(--text-faint);
  background: var(--daw-meter-well);
  font: var(--ui-type-size-control) var(--ui-type-family-data);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  cursor: pointer;
}
.maximum-peak-value.active {
  color: var(--mixer-pan);
}
.maximum-peak-value.hot {
  color: var(--mixer-solo);
}
.maximum-peak-value.clipped {
  border-color: var(--mixer-record);
  color: var(--record);
  background: color-mix(in srgb, var(--record) 14%, var(--daw-meter-well));
}
.maximum-peak-value:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}
</style>
