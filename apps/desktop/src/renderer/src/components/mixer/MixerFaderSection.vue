<script setup lang="ts">
import { computed, nextTick, shallowRef, useTemplateRef, watch } from "vue"
import type {
  MixerChannelMeter,
  MixerChannelPatch,
  MixerChannelState,
  MixerParameterPreview
} from "@heron/contracts"
import { UiVerticalFader } from "@heron/ui"
import { FADER_MAX_DB, FADER_MIN_DB, FADER_SCALE_MARKS } from "../../utils/mixerDbScale"
import MixerChannelControls from "./MixerChannelControls.vue"
import MixerChannelMeterDisplay from "./MixerChannelMeterDisplay.vue"
import type { MixerStripDisplayOptions } from "./mixer-strip-display-options"

const props = defineProps<{
  channel: MixerChannelState
  meter?: MixerChannelMeter
  displayOptions?: MixerStripDisplayOptions
}>()
const emit = defineEmits<{
  preview: [preview: MixerParameterPreview]
  updateChannel: [patch: MixerChannelPatch]
  resetMeterClips: []
  bounceOutput: []
}>()

const gainLabel = computed(() => formatGainLabel(props.channel.gainDb))
const gainReadoutLabel = computed(() =>
  props.channel.gainDb <= -90 ? "−∞" : props.channel.gainDb.toFixed(1)
)
const monitoringAvailable = computed(
  () =>
    (props.channel.kind === "instrument" && props.channel.systemRole === null) ||
    ((props.channel.kind === "audio" || props.channel.kind === "aux") &&
      (props.channel.inputSource === "hardware" ||
        (props.channel.inputSource === "application" && props.channel.applicationCapture != null)))
)
const monitoringActive = computed(() => monitoringAvailable.value && props.channel.inputMonitoring)
const gainInputValue = shallowRef(String(props.channel.gainDb))
const gainInputEditing = shallowRef(false)
const gainInput = useTemplateRef<HTMLInputElement>("gainInput")

function updateChannel(patch: MixerChannelPatch): void {
  // Keep the logical application identity in the same transaction as input
  // monitoring/record-arm changes. This repairs older renderer state that
  // selected the application source without persisting its target.
  if (props.channel.inputSource === "application" && props.channel.applicationCapture) {
    emit("updateChannel", { ...patch, applicationCapture: props.channel.applicationCapture })
    return
  }
  emit("updateChannel", patch)
}

watch(
  () => props.channel.gainDb,
  (value) => {
    if (!gainInputEditing.value) gainInputValue.value = String(value)
  }
)

function preview(parameter: "gainDb" | "pan", value: number): void {
  emit("preview", { target: "channel", id: props.channel.id, parameter, value })
}
function formatGainLabel(value: number): string {
  return value <= FADER_MIN_DB ? "−∞" : `${value.toFixed(1)} dB`
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
  emit("updateChannel", { gainDb: clampedValue })
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
      <UiVerticalFader
        class="fader"
        :value="channel.gainDb"
        :min="FADER_MIN_DB"
        :max="FADER_MAX_DB"
        :step="0.1"
        :default-value="0"
        :marks="FADER_SCALE_MARKS"
        :label="`${channel.name} volume`"
        :value-text="formatGainLabel"
        @preview="preview('gainDb', $event)"
        @commit="emit('updateChannel', { gainDb: $event })"
      />
      <MixerChannelMeterDisplay
        :channel-id="channel.id"
        :channel-name="channel.name"
        :meter="meter"
        :display-options="displayOptions"
        @reset-meter-clips="emit('resetMeterClips')"
      />
    </div>
    <MixerChannelControls
      :channel="channel"
      :monitoring-available="monitoringAvailable"
      :monitoring-active="monitoringActive"
      @update-channel="updateChannel"
      @bounce-output="emit('bounceOutput')"
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
  grid-template-columns: minmax(0, 1fr) 34px;
  grid-template-rows: 20px minmax(0, 1fr);
  column-gap: 2px;
  row-gap: 6px;
  min-height: 0;
  padding: 9px 7px 7px;
}
.fader {
  grid-column: 1;
  grid-row: 2;
  margin-block: 8px;
}
.parameter-value {
  grid-column: 1;
  grid-row: 1;
  justify-self: center;
  width: 34px;
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
.parameter-value:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}
</style>
