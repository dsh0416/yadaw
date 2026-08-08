<script setup lang="ts">
import { computed, shallowRef } from "vue"

import type { UiScaleMark, UiScaleSide } from "../types"
import UiDbScale from "./UiDbScale.vue"

const props = withDefaults(
  defineProps<{
    value: number
    min: number
    max: number
    step: number
    defaultValue: number
    label: string
    valueText?: (value: number) => string
    marks?: readonly UiScaleMark[]
    scaleSide?: UiScaleSide
    accent?: string
    disabled?: boolean
  }>(),
  {
    valueText: undefined,
    marks: () => [],
    scaleSide: "left",
    accent: "var(--ui-color-action)",
    disabled: false
  }
)

const emit = defineEmits<{
  preview: [value: number]
  commit: [value: number]
}>()

const gestureValue = shallowRef(props.value)
const gestureActive = shallowRef(false)
const tooltipVisible = shallowRef(false)

let startValue: number | null = null
let cancelled = false

const precision = computed(() => String(props.step).split(".")[1]?.length ?? 0)
const displayedValue = computed(() => (gestureActive.value ? gestureValue.value : props.value))
const displayText = computed(
  () => props.valueText?.(displayedValue.value) ?? displayedValue.value.toFixed(precision.value)
)
const controlStyle = computed(() => {
  const range = props.max - props.min
  const ratio = range > 0 ? (displayedValue.value - props.min) / range : 0
  return {
    "--vertical-fader-accent": props.accent,
    "--vertical-fader-level": `${Math.max(0, Math.min(1, ratio)) * 100}%`
  }
})

function snapValue(value: number): number {
  const clamped = Math.max(props.min, Math.min(props.max, value))
  const steps = Math.round((clamped - props.min) / props.step)
  return Number((props.min + steps * props.step).toFixed(precision.value))
}

function begin(): void {
  startValue ??= props.value
  gestureValue.value = props.value
  gestureActive.value = true
  cancelled = false
}

function beginPointerGesture(event: PointerEvent): void {
  if (props.disabled || event.button !== 0) {
    event.preventDefault()
    return
  }
  const input = event.currentTarget as HTMLInputElement
  const bounds = input.getBoundingClientRect()
  const range = props.max - props.min
  const ratio =
    range > 0 ? (Math.max(props.min, Math.min(props.max, props.value)) - props.min) / range : 0
  const thumbInset = Math.min(7, bounds.height / 2)
  const thumbTravel = Math.max(0, bounds.height - thumbInset * 2)
  const thumbCenterY = bounds.top + thumbInset + (1 - ratio) * thumbTravel
  if (Math.abs(event.clientY - thumbCenterY) > 13) {
    event.preventDefault()
    return
  }
  begin()
  tooltipVisible.value = true
}

function previewValue(event: Event): void {
  if (!gestureActive.value) begin()
  const value = snapValue(Number((event.currentTarget as HTMLInputElement).value))
  gestureValue.value = value
  tooltipVisible.value = true
  emit("preview", value)
}

function commitValue(event: Event): void {
  const input = event.currentTarget as HTMLInputElement
  if (cancelled) {
    input.value = String(startValue ?? props.value)
    finish()
    return
  }
  emit("commit", snapValue(Number(input.value)))
  finish()
}

function cancelGesture(event: Event): void {
  if (startValue === null) return
  const input = event.currentTarget as HTMLInputElement
  cancelled = true
  gestureValue.value = startValue
  input.value = String(startValue)
  emit("preview", startValue)
  tooltipVisible.value = false
}

function cancelPointerGesture(event: PointerEvent): void {
  if (startValue === null) return
  const input = event.currentTarget as HTMLInputElement
  const restoredValue = startValue
  input.value = String(restoredValue)
  emit("preview", restoredValue)
  finish()
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key !== "Escape" || startValue === null) return
  event.preventDefault()
  event.stopPropagation()
  cancelGesture(event)
}

function resetToDefault(): void {
  if (props.disabled) return
  finish()
  emit("commit", snapValue(props.defaultValue))
}

function finish(): void {
  startValue = null
  cancelled = false
  gestureActive.value = false
  tooltipVisible.value = false
}
</script>

<template>
  <label
    :class="['ui-vertical-fader', `scale-${scaleSide}`, { 'is-disabled': disabled }]"
    :style="controlStyle"
  >
    <UiDbScale v-if="marks.length > 0" class="ui-vertical-fader__scale" :marks :side="scaleSide" />
    <input
      class="ui-vertical-fader__input"
      type="range"
      :min
      :max
      :step
      :value="displayedValue"
      :disabled
      :aria-label="label"
      :aria-valuetext="displayText"
      @pointerdown="beginPointerGesture"
      @pointercancel="cancelPointerGesture"
      @input="previewValue"
      @change="commitValue"
      @blur="tooltipVisible = false"
      @keydown="handleKeydown"
      @dblclick.prevent="resetToDefault"
    />
    <output v-if="tooltipVisible" class="ui-vertical-fader__tooltip" aria-hidden="true">
      {{ displayText }}
    </output>
  </label>
</template>

<style scoped>
.ui-vertical-fader {
  --vertical-fader-track-center: calc(50% + 0.46875rem);
  position: relative;
  display: grid;
  grid-template-columns: 0.9375rem minmax(0, 1fr);
  gap: 0;
  min-height: 0;
}

.ui-vertical-fader.scale-right {
  --vertical-fader-track-center: calc(50% - 0.46875rem);
  grid-template-columns: minmax(0, 1fr) 0.9375rem;
}

.ui-vertical-fader.scale-right .ui-vertical-fader__scale {
  grid-column: 2;
  grid-row: 1;
}

.ui-vertical-fader::after {
  position: absolute;
  z-index: var(--ui-z-local-base);
  top: 0;
  bottom: 0;
  left: var(--vertical-fader-track-center);
  width: 4px;
  border: 1px solid var(--ui-color-border-strong);
  background: linear-gradient(
    to top,
    var(--vertical-fader-accent) 0 var(--vertical-fader-level),
    var(--ui-color-control-pressed) var(--vertical-fader-level) 100%
  );
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--ui-color-text) 38%, transparent) inset;
  content: "";
  transform: translateX(-50%);
}

.ui-vertical-fader__input {
  position: relative;
  z-index: var(--ui-z-local-content);
  width: 100%;
  height: calc(100% + 1rem);
  margin: -0.5rem 0;
  appearance: none;
  background: transparent;
  writing-mode: vertical-lr;
  direction: rtl;
  cursor: ns-resize;
}

.ui-vertical-fader__input::-webkit-slider-runnable-track {
  width: 4px;
  height: 100%;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}

.ui-vertical-fader__input::-webkit-slider-thumb {
  width: 1.75rem;
  height: 0.8125rem;
  margin-left: -0.8125rem;
  border: 1px solid var(--ui-color-text-subtle);
  border-radius: 1px;
  appearance: none;
  background: linear-gradient(
    to bottom,
    var(--ui-color-control-hover) 0 calc(50% - 1px),
    var(--ui-color-text) calc(50% - 1px) calc(50% + 1px),
    var(--ui-color-control-hover) calc(50% + 1px) 100%
  );
  box-shadow:
    var(--ui-shadow-sm),
    0 0 0 1px var(--ui-color-surface);
  cursor: ns-resize;
}

.ui-vertical-fader__input::-moz-range-track {
  width: 4px;
  height: 100%;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}

.ui-vertical-fader__input::-moz-range-progress {
  width: 4px;
  background: transparent;
}

.ui-vertical-fader__input::-moz-range-thumb {
  width: 1.75rem;
  height: 0.8125rem;
  border: 1px solid var(--ui-color-text-subtle);
  border-radius: 1px;
  background: linear-gradient(
    to bottom,
    var(--ui-color-control-hover) 0 calc(50% - 1px),
    var(--ui-color-text) calc(50% - 1px) calc(50% + 1px),
    var(--ui-color-control-hover) calc(50% + 1px) 100%
  );
  box-shadow:
    var(--ui-shadow-sm),
    0 0 0 1px var(--ui-color-surface);
  cursor: ns-resize;
}

.ui-vertical-fader__input:focus {
  outline: none;
}

.ui-vertical-fader__input:focus-visible::-webkit-slider-thumb,
.ui-vertical-fader__input:focus-visible::-moz-range-thumb {
  border-color: var(--ui-color-focus);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ui-color-focus) 50%, transparent);
}

.ui-vertical-fader__tooltip {
  position: absolute;
  z-index: var(--ui-z-local-controls);
  bottom: -0.3125rem;
  left: var(--vertical-fader-track-center);
  min-width: 2.375rem;
  padding: 0.1875rem 0.3125rem;
  border: 1px solid var(--ui-color-border-strong);
  border-radius: var(--ui-radius-sm);
  color: var(--ui-color-text);
  background: var(--ui-color-surface-raised);
  box-shadow: var(--ui-shadow-md);
  font: var(--ui-type-size-caption) var(--ui-type-family-data);
  text-align: center;
  transform: translate(-50%, 100%);
  white-space: nowrap;
}

.ui-vertical-fader__tooltip::before {
  position: absolute;
  bottom: 100%;
  left: 50%;
  border: 3px solid transparent;
  border-bottom-color: var(--ui-color-border-strong);
  content: "";
  transform: translateX(-50%);
}

.ui-vertical-fader.is-disabled {
  cursor: not-allowed;
  opacity: var(--ui-opacity-disabled);
}
</style>
