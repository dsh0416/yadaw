<script setup lang="ts">
import { computed, shallowRef } from "vue"
import type { MixerChannelMeter } from "@yadaw/contracts"
import { useParameterGesture } from "../../composables/useParameterGesture"
import {
  dbToLevelPercent,
  FADER_MAX_DB,
  FADER_MIN_DB,
  METER_MAX_DB,
  METER_MIN_DB
} from "../../utils/mixerDbScale"

const props = defineProps<{
  channelName: string
  value: number
  meter: MixerChannelMeter
  disabled?: boolean
}>()

const emit = defineEmits<{
  preview: [value: number]
  commit: [value: number]
}>()

const tooltipVisible = shallowRef(false)
const valueLabel = computed(() =>
  props.value <= FADER_MIN_DB ? "−∞ dB" : `${props.value.toFixed(1)} dB`
)
const meterStyle = computed(() => {
  const amplitude = Math.max(0, ...props.meter.postFaderPeak)
  const db = amplitude > 0 ? 20 * Math.log10(amplitude) : Number.NEGATIVE_INFINITY
  return {
    "--meter-level": `${dbToLevelPercent(db, METER_MIN_DB, METER_MAX_DB)}%`
  }
})

const gesture = useParameterGesture({
  currentValue: () => props.value,
  preview: (value) => emit("preview", value),
  commit: (value) => emit("commit", value)
})

function beginGesture(): void {
  tooltipVisible.value = true
  gesture.begin()
}

function previewGesture(event: Event): void {
  tooltipVisible.value = true
  gesture.preview(event)
}

function commitGesture(event: Event): void {
  gesture.commit(event)
  tooltipVisible.value = false
}

function handleKeydown(event: KeyboardEvent): void {
  gesture.keydown(event)
  if (event.key === "Escape") tooltipVisible.value = false
}

function reset(): void {
  tooltipVisible.value = false
  gesture.reset(0)
}
</script>

<template>
  <label
    :class="['track-gain', { disabled }]"
    :style="meterStyle"
    :title="`${channelName} volume: ${valueLabel}`"
    @pointerdown.stop
    @click.stop
  >
    <span class="gain-meter" aria-hidden="true"><i /></span>
    <input
      type="range"
      :min="FADER_MIN_DB"
      :max="FADER_MAX_DB"
      step="0.1"
      :value="value"
      :disabled="disabled"
      :aria-label="`${channelName} quick volume`"
      :aria-valuetext="valueLabel"
      @pointerdown="beginGesture"
      @input="previewGesture"
      @change="commitGesture"
      @blur="tooltipVisible = false"
      @keydown="handleKeydown"
      @dblclick.stop.prevent="reset"
    />
    <output v-if="tooltipVisible" class="parameter-tooltip" aria-hidden="true">
      {{ valueLabel }}
    </output>
  </label>
</template>

<style scoped>
.track-gain {
  position: relative;
  display: block;
  min-width: 0;
  height: 15px;
}

.gain-meter {
  position: absolute;
  inset: 2px 0;
  overflow: hidden;
  border: 1px solid var(--line-strong);
  border-radius: 2px;
  background: linear-gradient(
    to right,
    var(--meter-green) 0 74%,
    var(--meter-yellow) 86%,
    var(--meter-red) 100%
  );
  box-shadow: 0 0 0 1px var(--ui-domain-color-0006) inset;
}

.gain-meter i {
  position: absolute;
  inset: 0 0 0 var(--meter-level);
  background: var(--daw-meter-well);
  opacity: 0.88;
  transition: left 55ms linear;
}

.track-gain input {
  position: absolute;
  z-index: var(--ui-z-local-raised);
  inset: 0;
  width: 100%;
  height: 15px;
  margin: 0;
  appearance: none;
  background: transparent;
  cursor: ew-resize;
}

.track-gain input::-webkit-slider-runnable-track {
  height: 15px;
  border: 0;
  background: transparent;
}

.track-gain input::-webkit-slider-thumb {
  width: 7px;
  height: 15px;
  border: 1px solid var(--text-muted);
  border-radius: 1px;
  appearance: none;
  background: linear-gradient(
    to right,
    var(--daw-control-hover) 0 calc(50% - 1px),
    var(--text-primary) calc(50% - 1px) calc(50% + 1px),
    var(--daw-control-hover) calc(50% + 1px) 100%
  );
  box-shadow: 0 1px 2px var(--ui-domain-color-000b);
}

.track-gain input::-moz-range-track {
  height: 15px;
  border: 0;
  background: transparent;
}

.track-gain input::-moz-range-progress {
  background: transparent;
}

.track-gain input::-moz-range-thumb {
  width: 7px;
  height: 15px;
  border: 1px solid var(--text-muted);
  border-radius: 1px;
  background: var(--daw-control-hover);
  box-shadow: 0 1px 2px var(--ui-domain-color-000b);
}

.track-gain input:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}

.track-gain input:disabled {
  cursor: not-allowed;
}

.track-gain.disabled {
  opacity: 0.45;
}

.parameter-tooltip {
  position: absolute;
  z-index: var(--ui-z-floating-control);
  top: calc(100% + 4px);
  left: 50%;
  min-width: 36px;
  padding: 3px 5px;
  border: 1px solid var(--line-strong);
  border-radius: 3px;
  color: var(--text-primary);
  background: var(--surface-3);
  box-shadow: 0 4px 10px var(--shadow);
  font: var(--ui-type-size-caption) var(--ui-type-family-data);
  text-align: center;
  transform: translateX(-50%);
  white-space: nowrap;
}

.parameter-tooltip::before {
  position: absolute;
  bottom: 100%;
  left: 50%;
  border: 3px solid transparent;
  border-bottom-color: var(--line-strong);
  content: "";
  transform: translateX(-50%);
}
</style>
