<script setup lang="ts">
import { computed, nextTick, shallowRef, useTemplateRef, watch } from "vue"
import { storeToRefs } from "pinia"
import type {
  ApplicationSettings,
  MeterPeakHold,
  MeterReturnRate,
  MixerChannelMeter,
  MixerChannelPatch,
  MixerChannelState,
  MixerParameterPreview
} from "@yadaw/contracts"
import { usePeakMeterDisplay } from "../../composables/usePeakMeterDisplay"
import { useParameterGesture } from "../../composables/useParameterGesture"
import { useApplicationSettingsStore } from "../../stores/applicationSettings"
import {
  dbToLevelPercent,
  FADER_MAX_DB,
  FADER_MIN_DB,
  FADER_SCALE_MARKS
} from "../../utils/mixerDbScale"
import MixerChannelControls from "./MixerChannelControls.vue"
import MixerDbScale from "./MixerDbScale.vue"
import MixerLevelMeter from "./MixerLevelMeter.vue"
import type { MixerStripDisplayOptions } from "./mixer-strip-display-options"

const props = defineProps<{
  channel: MixerChannelState
  meter: MixerChannelMeter
  displayOptions?: MixerStripDisplayOptions
}>()
const emit = defineEmits<{
  preview: [preview: MixerParameterPreview]
  updateChannel: [patch: MixerChannelPatch]
  resetMeterClips: []
}>()

const settingsStore = props.displayOptions ? null : useApplicationSettingsStore()
const settings = settingsStore
  ? storeToRefs(settingsStore).settings
  : shallowRef<ApplicationSettings | null>(null)
const meter = computed(() => props.meter)
const peakHold = computed<MeterPeakHold>(
  () => props.displayOptions?.meterPeakHold ?? settings.value?.meterPeakHold ?? "800ms"
)
const returnRate = computed<MeterReturnRate>(
  () => props.displayOptions?.meterReturnRate ?? settings.value?.meterReturnRate ?? "iec-type-i"
)
const softwareMonitoringEnabled = computed(
  () =>
    props.displayOptions?.softwareMonitoringEnabled ??
    settings.value?.softwareMonitoringEnabled ??
    false
)
const meterDisplay = usePeakMeterDisplay({ meter, peakHold, returnRate })
const gainLabel = computed(() =>
  props.channel.gainDb <= -90 ? "−∞" : `${props.channel.gainDb.toFixed(1)} dB`
)
const gainReadoutLabel = computed(() =>
  props.channel.gainDb <= -90 ? "−∞" : props.channel.gainDb.toFixed(1)
)
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
const monitoringAvailable = computed(
  () =>
    (props.channel.kind === "instrument" && props.channel.systemRole === null) ||
    (softwareMonitoringEnabled.value &&
      props.channel.kind === "audio" &&
      props.channel.inputSource === "hardware")
)
const monitoringActive = computed(() => monitoringAvailable.value && props.channel.inputMonitoring)
const faderStyle = computed(() => ({
  "--fader-level": `${dbToLevelPercent(props.channel.gainDb, FADER_MIN_DB, FADER_MAX_DB)}%`
}))
const gainInputValue = shallowRef(String(props.channel.gainDb))
const gainInputEditing = shallowRef(false)
const faderTooltipVisible = shallowRef(false)
const gainInput = useTemplateRef<HTMLInputElement>("gainInput")

watch(
  () => props.channel.gainDb,
  (value) => {
    if (!gainInputEditing.value) gainInputValue.value = String(value)
  }
)

function preview(parameter: "gainDb" | "pan", value: number): void {
  emit("preview", { target: "channel", id: props.channel.id, parameter, value })
}
function resetMaximumPeak(): void {
  meterDisplay.resetPeakAndClip()
  emit("resetMeterClips")
}
async function beginGainInputEdit(): Promise<void> {
  gainInputEditing.value = true
  gainInputValue.value = String(props.channel.gainDb)
  await nextTick()
  gainInput.value?.focus()
  gainInput.value?.select()
}
function updateGainInputValue(event: Event): void {
  gainInputEditing.value = true
  gainInputValue.value = (event.currentTarget as HTMLInputElement).value
}
function finishGainInputEdit(): void {
  if (!gainInputEditing.value) return
  gainInputEditing.value = false
  gainInputValue.value = String(props.channel.gainDb)
}
function commitGainInputValue(event: Event): void {
  const input = event.currentTarget as HTMLInputElement
  const value = Number(input.value)
  if (input.value.trim() === "" || !Number.isFinite(value)) {
    finishGainInputEdit()
    input.value = gainInputValue.value
    return
  }
  const clampedValue = Math.max(FADER_MIN_DB, Math.min(FADER_MAX_DB, value))
  gainInputValue.value = String(clampedValue)
  preview("gainDb", clampedValue)
  gainInputEditing.value = false
  gainGesture.reset(clampedValue)
}
function cancelGainInputEdit(event: KeyboardEvent): void {
  if (event.key !== "Escape") return
  event.preventDefault()
  event.stopPropagation()
  const input = event.currentTarget as HTMLInputElement
  gainInputValue.value = String(props.channel.gainDb)
  gainInputEditing.value = false
  input.value = gainInputValue.value
  input.blur()
}
function submitGainInput(event: KeyboardEvent): void {
  if (event.key !== "Enter") return
  event.preventDefault()
  ;(event.currentTarget as HTMLInputElement).blur()
}

const gainGesture = useParameterGesture({
  currentValue: () => props.channel.gainDb,
  preview: (value) => preview("gainDb", value),
  commit: (value) => emit("updateChannel", { gainDb: value })
})
function beginFaderGesture(event: PointerEvent): void {
  if (event.button !== 0) {
    event.preventDefault()
    return
  }
  const input = event.currentTarget as HTMLInputElement
  const bounds = input.getBoundingClientRect()
  const min = Number(input.min)
  const max = Number(input.max)
  const value = Math.max(min, Math.min(max, props.channel.gainDb))
  const ratio = (value - min) / (max - min)
  const thumbInset = Math.min(8, bounds.height / 2)
  const thumbTravel = Math.max(0, bounds.height - thumbInset * 2)
  const thumbCenterY = bounds.top + thumbInset + (1 - ratio) * thumbTravel
  if (Math.abs(event.clientY - thumbCenterY) > 13) {
    event.preventDefault()
    return
  }
  gainGesture.begin()
  faderTooltipVisible.value = true
}
function previewFaderGesture(event: Event): void {
  faderTooltipVisible.value = true
  gainGesture.preview(event)
}
function commitFaderGesture(event: Event): void {
  gainGesture.commit(event)
  faderTooltipVisible.value = false
}
function handleFaderKeydown(event: KeyboardEvent): void {
  gainGesture.keydown(event)
  if (event.key === "Escape") faderTooltipVisible.value = false
}
</script>

<template>
  <section class="volume-section" data-section="volume">
    <div class="strip-core">
      <button
        v-if="!gainInputEditing"
        type="button"
        class="parameter-value parameter-value-button"
        :aria-label="`${channel.name} volume value in decibels`"
        :title="`Fader: ${gainLabel} · Double-click to edit`"
        @pointerdown.stop
        @dblclick.stop.prevent="beginGainInputEdit"
      >
        {{ gainReadoutLabel }}
      </button>
      <input
        v-else
        ref="gainInput"
        class="parameter-value"
        type="number"
        :min="FADER_MIN_DB"
        :max="FADER_MAX_DB"
        step="0.1"
        :value="gainInputValue"
        :aria-label="`${channel.name} volume value in decibels`"
        :title="`Fader: ${gainLabel}`"
        @input="updateGainInputValue"
        @change="commitGainInputValue"
        @blur="finishGainInputEdit"
        @keydown="cancelGainInputEdit"
        @keydown.enter="submitGainInput"
      />
      <button
        type="button"
        :class="['maximum-peak-value', maximumPeakState]"
        :aria-label="`${channel.name} latched maximum post-fader level in decibels`"
        :title="`Maximum post-fader peak: ${maximumPeakLabel} dB · Click to reset peak and clipping`"
        @pointerdown.stop
        @click.stop="resetMaximumPeak"
      >
        {{ maximumPeakLabel }}
      </button>
      <label class="fader" :style="faderStyle">
        <MixerDbScale class="fader-scale" :marks="FADER_SCALE_MARKS" side="left" />
        <input
          class="fader-control"
          type="range"
          :min="FADER_MIN_DB"
          :max="FADER_MAX_DB"
          step="0.1"
          :value="channel.gainDb"
          :aria-label="`${channel.name} volume`"
          @pointerdown="beginFaderGesture"
          @input="previewFaderGesture"
          @change="commitFaderGesture"
          @blur="faderTooltipVisible = false"
          @keydown="handleFaderKeydown"
          @dblclick.prevent="gainGesture.reset(0)"
        />
        <output v-if="faderTooltipVisible" class="fader-tooltip" aria-hidden="true">
          {{ gainLabel }}
        </output>
      </label>
      <MixerLevelMeter
        :level-percent="meterDisplay.meterLevelPercent.value"
        :held-level-percent="meterDisplay.heldMeterLevelPercent.value"
        :has-held-peak="Number.isFinite(meterDisplay.heldPeakDb.value)"
        :clipped="meterDisplay.clipped.value"
      />
    </div>
    <MixerChannelControls
      :channel="channel"
      :monitoring-available="monitoringAvailable"
      :monitoring-active="monitoringActive"
      @update-channel="emit('updateChannel', $event)"
    />
  </section>
</template>

<style scoped>
.volume-section {
  display: grid;
  grid-template-rows: 221px 61px;
  min-height: 0;
  border-bottom: 1px solid var(--ui-domain-color-444);
  background: var(--ui-domain-color-555);
}
.strip-core {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 39px;
  grid-template-rows: 20px minmax(0, 1fr);
  column-gap: 4px;
  row-gap: 6px;
  min-height: 0;
  padding: 9px 10px 7px;
}
.fader {
  --fader-level: 0%;
  position: relative;
  display: grid;
  grid-column: 1;
  grid-row: 2;
  grid-template-columns: 18px minmax(0, 1fr);
  gap: 1px;
  margin-block: 8px;
  min-height: 0;
}
.fader::after {
  position: absolute;
  z-index: var(--ui-z-local-base);
  top: 0;
  bottom: 0;
  left: calc(50% + 9.5px);
  width: 4px;
  border: 1px solid var(--line-strong);
  background: linear-gradient(
    to top,
    var(--accent) 0 var(--fader-level),
    var(--daw-meter-well) var(--fader-level) 100%
  );
  box-shadow: 0 0 0 1px var(--ui-domain-color-0006) inset;
  content: "";
  transform: translateX(-50%);
}
.fader-control {
  position: relative;
  z-index: var(--ui-z-local-content);
  width: 100%;
  height: calc(100% + 16px);
  margin: -8px 0;
  appearance: none;
  background: transparent;
  writing-mode: vertical-lr;
  direction: rtl;
  cursor: ns-resize;
}
.fader-control::-webkit-slider-runnable-track {
  width: 4px;
  height: 100%;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}
.fader-control::-webkit-slider-thumb {
  width: 28px;
  height: 13px;
  margin-left: -13px;
  border: 1px solid var(--text-muted);
  border-radius: 1px;
  appearance: none;
  background: linear-gradient(
    to bottom,
    var(--daw-control-hover) 0 calc(50% - 1px),
    var(--text-primary) calc(50% - 1px) calc(50% + 1px),
    var(--daw-control-hover) calc(50% + 1px) 100%
  );
  box-shadow:
    0 1px 3px var(--ui-domain-color-0009),
    0 0 0 1px var(--surface-1);
  cursor: ns-resize;
}
.fader-control::-moz-range-track {
  width: 4px;
  height: 100%;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}
.fader-control::-moz-range-progress {
  width: 4px;
  background: transparent;
}
.fader-control::-moz-range-thumb {
  width: 28px;
  height: 13px;
  border: 1px solid var(--text-muted);
  border-radius: 1px;
  background: linear-gradient(
    to bottom,
    var(--daw-control-hover) 0 calc(50% - 1px),
    var(--text-primary) calc(50% - 1px) calc(50% + 1px),
    var(--daw-control-hover) calc(50% + 1px) 100%
  );
  box-shadow:
    0 1px 3px var(--ui-domain-color-0009),
    0 0 0 1px var(--surface-1);
  cursor: ns-resize;
}
.fader-control:focus {
  outline: none;
}
.fader-control:focus-visible::-webkit-slider-thumb,
.fader-control:focus-visible::-moz-range-thumb {
  border-color: var(--focus);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--focus) 50%, transparent);
}
.fader-tooltip {
  position: absolute;
  z-index: var(--ui-z-local-controls);
  bottom: -5px;
  left: calc(50% + 9.5px);
  min-width: 38px;
  padding: 3px 5px;
  border: 1px solid var(--line-strong);
  border-radius: 3px;
  color: var(--text-primary);
  background: var(--surface-3);
  box-shadow: 0 4px 10px var(--shadow);
  font: var(--ui-type-size-caption) var(--ui-type-family-data);
  text-align: center;
  transform: translate(-50%, 100%);
  white-space: nowrap;
}
.fader-tooltip::before {
  position: absolute;
  bottom: 100%;
  left: 50%;
  border: 3px solid transparent;
  border-bottom-color: var(--line-strong);
  content: "";
  transform: translateX(-50%);
}
.parameter-value {
  grid-column: 1;
  grid-row: 1;
  justify-self: center;
  width: 38px;
  height: 20px;
  margin: 0;
  padding: 0 2px;
  border: 1px solid var(--line-strong);
  border-radius: 2px;
  color: var(--text-primary);
  background: var(--daw-control);
  font: var(--ui-type-size-control) var(--ui-type-family-data);
  text-align: center;
  writing-mode: horizontal-tb;
  direction: ltr;
  appearance: textfield;
}
.parameter-value-button {
  cursor: text;
}
.parameter-value::-webkit-inner-spin-button,
.parameter-value::-webkit-outer-spin-button {
  margin: 0;
  appearance: none;
}
.maximum-peak-value {
  display: grid;
  grid-column: 2;
  grid-row: 1;
  place-items: center;
  width: 39px;
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
.maximum-peak-value:focus-visible,
.parameter-value:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}
</style>
