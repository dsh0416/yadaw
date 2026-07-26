<script setup lang="ts">
import { computed, nextTick, shallowRef, useTemplateRef } from "vue"
import { useParameterGesture } from "../../composables/useParameterGesture"
import { useRotaryParameterGesture } from "../../composables/useRotaryParameterGesture"
import {
  normalizedToPanUnits,
  panLabelFromNormalized,
  panUnitsToNormalized
} from "../../utils/mixerPan"

const props = defineProps<{
  channelName: string
  value: number
}>()

const emit = defineEmits<{
  preview: [value: number]
  commit: [value: number]
}>()

const editing = shallowRef(false)
const editValue = shallowRef("")
const tooltipVisible = shallowRef(false)
const editInput = useTemplateRef<HTMLInputElement>("editInput")
const panUnits = computed(() => normalizedToPanUnits(props.value))

const gesture = useParameterGesture({
  currentValue: () => panUnits.value,
  preview: (value) => emit("preview", panUnitsToNormalized(value)),
  commit: (value) => emit("commit", panUnitsToNormalized(value))
})

const rotaryGesture = useRotaryParameterGesture({
  currentValue: () => panUnits.value,
  minimum: -64,
  maximum: 63,
  pixelsPerStep: 2,
  preview: (value) => emit("preview", panUnitsToNormalized(value)),
  commit: (value) => emit("commit", panUnitsToNormalized(value))
})
const { dragging, dragValue } = rotaryGesture
const displayedPan = computed(() =>
  dragging.value ? panUnitsToNormalized(dragValue.value) : props.value
)
const panLabel = computed(() => panLabelFromNormalized(displayedPan.value))
const knobStyle = computed(() => ({
  "--pan-angle": `${Math.max(-1, Math.min(1, displayedPan.value)) * 135}deg`
}))

function previewKeyboardGesture(event: Event): void {
  tooltipVisible.value = true
  gesture.preview(event)
}

function commitKeyboardGesture(event: Event): void {
  gesture.commit(event)
  tooltipVisible.value = false
}

function handleKeydown(event: KeyboardEvent): void {
  gesture.keydown(event)
  if (event.key === "Escape") tooltipVisible.value = false
}

async function beginEditing(): Promise<void> {
  tooltipVisible.value = false
  editValue.value = String(panUnits.value)
  editing.value = true
  await nextTick()
  editInput.value?.focus()
  editInput.value?.select()
}

function commitEditing(): void {
  if (!editing.value) return
  const parsed = Number(editValue.value)
  if (Number.isFinite(parsed)) emit("commit", panUnitsToNormalized(parsed))
  editing.value = false
}

function cancelEditing(): void {
  editing.value = false
}
</script>

<template>
  <label
    class="track-pan"
    :style="knobStyle"
    :title="`${channelName} pan: ${panLabel}`"
    @pointerdown.stop
    @click.stop
  >
    <span class="pan-knob" aria-hidden="true"><i /></span>
    <input
      class="pan-range"
      type="range"
      min="-64"
      max="63"
      step="1"
      :value="panUnits"
      :aria-label="`${channelName} quick pan`"
      :aria-valuetext="panLabel"
      @pointerdown="rotaryGesture.begin"
      @pointermove="rotaryGesture.move"
      @pointerup="rotaryGesture.end"
      @pointercancel="rotaryGesture.cancel"
      @input="previewKeyboardGesture"
      @change="commitKeyboardGesture"
      @blur="tooltipVisible = false"
      @keydown="handleKeydown"
      @dblclick.stop.prevent="beginEditing"
    />
    <input
      v-if="editing"
      ref="editInput"
      v-model="editValue"
      class="pan-editor"
      type="number"
      min="-64"
      max="63"
      step="1"
      :aria-label="`${channelName} quick pan value`"
      @blur="commitEditing"
      @keydown.enter.prevent="commitEditing"
      @keydown.esc.prevent="cancelEditing"
    />
    <output
      v-if="(dragging || tooltipVisible) && !editing"
      class="parameter-tooltip"
      aria-hidden="true"
    >
      {{ panLabel }}
    </output>
  </label>
</template>

<style scoped>
.track-pan {
  position: relative;
  display: block;
  width: 23px;
  height: 23px;
}

.pan-knob {
  position: absolute;
  inset: 1px;
  border: 1px solid var(--line-strong);
  border-radius: 50%;
  background: linear-gradient(145deg, var(--daw-control-hover), var(--daw-control));
  box-shadow:
    0 1px 0 #ffffff14 inset,
    0 1px 2px #0009;
}

.pan-knob i {
  position: absolute;
  inset: 0;
  transform: rotate(var(--pan-angle));
}

.pan-knob i::after {
  position: absolute;
  top: 2px;
  left: 50%;
  width: 1px;
  height: 5px;
  background: var(--mixer-pan);
  box-shadow: 0 0 2px color-mix(in srgb, var(--mixer-pan) 65%, transparent);
  content: "";
  transform: translateX(-50%);
}

.pan-range {
  position: absolute;
  z-index: 2;
  inset: 0;
  width: 23px;
  height: 23px;
  margin: 0;
  cursor: ns-resize;
  opacity: 0;
  touch-action: none;
}

.pan-editor {
  position: absolute;
  z-index: 30;
  top: -1px;
  right: -1px;
  width: 31px;
  height: 23px;
  padding: 0 2px;
  border: 1px solid var(--mixer-pan);
  border-radius: 2px;
  outline: none;
  color: var(--text-primary);
  background: var(--daw-control);
  font: 7px var(--font-utility);
  text-align: center;
  appearance: textfield;
}

.pan-editor::-webkit-inner-spin-button,
.pan-editor::-webkit-outer-spin-button {
  margin: 0;
  appearance: none;
}

.parameter-tooltip {
  position: absolute;
  z-index: 20;
  top: calc(100% + 4px);
  left: 50%;
  min-width: 24px;
  padding: 3px 5px;
  border: 1px solid var(--line-strong);
  border-radius: 3px;
  color: var(--text-primary);
  background: var(--surface-3);
  box-shadow: 0 4px 10px var(--shadow);
  font: 7px var(--font-utility);
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

.track-pan:focus-within .pan-knob {
  border-color: var(--focus);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--focus) 45%, transparent);
}

.pan-editor:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}
</style>
