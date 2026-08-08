<script setup lang="ts">
import { computed, nextTick, shallowRef, useTemplateRef, watch } from "vue"

import type { UiRotaryControlRingWeight, UiRotaryControlSize } from "../types"

const props = withDefaults(
  defineProps<{
    value: number
    min: number
    max: number
    step: number
    defaultValue: number
    label: string
    valueLabel?: string
    valueText?: (value: number) => string
    bipolarCenter?: number
    dragRangePixels?: number
    accent?: string
    size?: UiRotaryControlSize
    ringWeight?: UiRotaryControlRingWeight
    disabled?: boolean
  }>(),
  {
    valueLabel: undefined,
    valueText: undefined,
    bipolarCenter: undefined,
    dragRangePixels: 240,
    accent: "var(--ui-color-action)",
    size: "standard",
    ringWeight: "standard",
    disabled: false
  }
)

const emit = defineEmits<{
  preview: [value: number]
  commit: [value: number]
}>()

const editing = shallowRef(false)
const editValue = shallowRef("")
const dragging = shallowRef(false)
const keyboardActive = shallowRef(false)
const dragValue = shallowRef(props.value)
const tooltipVisible = shallowRef(false)
const editInput = useTemplateRef<HTMLInputElement>("editInput")

let pointerId: number | null = null
let pointerStartY = 0
let gestureStartValue: number | null = null
let keyboardCancelled = false

const precision = computed(() => {
  const decimal = String(props.step).split(".")[1]
  return decimal?.length ?? 0
})
const displayedValue = computed(() =>
  dragging.value || keyboardActive.value ? dragValue.value : props.value
)
const displayText = computed(() => formatValue(displayedValue.value))
const controlStyle = computed(() => {
  const range = props.max - props.min
  const ratio = range > 0 ? (displayedValue.value - props.min) / range : 0
  const clampedRatio = Math.max(0, Math.min(1, ratio))
  const centerRatio =
    props.bipolarCenter === undefined || range <= 0
      ? 0
      : Math.max(0, Math.min(1, (props.bipolarCenter - props.min) / range))
  const position = clampedRatio * 270
  const center = centerRatio * 270

  return {
    "--rotary-control-accent": props.accent,
    "--rotary-control-angle": `${-135 + clampedRatio * 270}deg`,
    "--rotary-control-progress": `conic-gradient(from 225deg, transparent 0deg ${Math.min(center, position)}deg, var(--rotary-control-accent) ${Math.min(center, position)}deg ${Math.max(center, position)}deg, transparent ${Math.max(center, position)}deg 270deg)`
  }
})

watch(
  () => props.value,
  (value) => {
    if (!dragging.value && !keyboardActive.value) dragValue.value = value
  }
)

function formatValue(value: number): string {
  return props.valueText?.(value) ?? value.toFixed(precision.value)
}

function snapValue(value: number): number {
  const clamped = Math.max(props.min, Math.min(props.max, value))
  const steps = Math.round((clamped - props.min) / props.step)
  return Number((props.min + steps * props.step).toFixed(precision.value))
}

function beginPointerGesture(event: PointerEvent): void {
  if (props.disabled || event.button !== 0) return
  event.preventDefault()
  const target = event.currentTarget as HTMLElement
  target.focus()
  pointerId = event.pointerId
  pointerStartY = event.clientY
  gestureStartValue = props.value
  dragValue.value = props.value
  dragging.value = true
  keyboardActive.value = false
  tooltipVisible.value = true
  target.setPointerCapture?.(event.pointerId)
}

function movePointerGesture(event: PointerEvent): void {
  if (!dragging.value || event.pointerId !== pointerId || gestureStartValue === null) return
  event.preventDefault()
  const range = props.max - props.min
  const dragDistance = Math.max(1, props.dragRangePixels) * (event.shiftKey ? 5 : 1)
  const valueDelta = ((pointerStartY - event.clientY) / dragDistance) * range
  const value = snapValue(gestureStartValue + valueDelta)
  if (value === dragValue.value) return
  dragValue.value = value
  emit("preview", value)
}

function endPointerGesture(event: PointerEvent): void {
  if (!dragging.value || event.pointerId !== pointerId) return
  event.preventDefault()
  ;(event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId)
  pointerId = null
  dragging.value = false
  tooltipVisible.value = false
  gestureStartValue = null
  emit("commit", dragValue.value)
}

function cancelPointerGesture(event: PointerEvent): void {
  if (!dragging.value || event.pointerId !== pointerId) return
  ;(event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId)
  pointerId = null
  dragging.value = false
  tooltipVisible.value = false
  if (gestureStartValue !== null) {
    dragValue.value = gestureStartValue
    emit("preview", gestureStartValue)
  }
  gestureStartValue = null
}

function previewKeyboardGesture(event: Event): void {
  gestureStartValue ??= props.value
  keyboardCancelled = false
  dragValue.value = snapValue(Number((event.currentTarget as HTMLInputElement).value))
  keyboardActive.value = true
  tooltipVisible.value = true
  emit("preview", dragValue.value)
}

function commitKeyboardGesture(event: Event): void {
  const input = event.currentTarget as HTMLInputElement
  if (keyboardCancelled) {
    input.value = String(gestureStartValue ?? props.value)
    dragValue.value = gestureStartValue ?? props.value
    keyboardCancelled = false
    gestureStartValue = null
    keyboardActive.value = false
    tooltipVisible.value = false
    return
  }
  emit("commit", dragValue.value)
  gestureStartValue = null
  keyboardActive.value = false
  tooltipVisible.value = false
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === "Enter" || event.key === "F2") {
    event.preventDefault()
    void beginEditing()
    return
  }
  if (event.key !== "Escape" || gestureStartValue === null) return
  event.preventDefault()
  event.stopPropagation()
  keyboardCancelled = true
  const startValue = gestureStartValue
  dragValue.value = startValue
  ;(event.currentTarget as HTMLInputElement).value = String(startValue)
  emit("preview", startValue)
  keyboardActive.value = false
  tooltipVisible.value = false
}

function resetToDefault(): void {
  if (props.disabled) return
  gestureStartValue = null
  keyboardCancelled = false
  keyboardActive.value = false
  emit("commit", snapValue(props.defaultValue))
}

async function beginEditing(): Promise<void> {
  if (props.disabled) return
  tooltipVisible.value = false
  editValue.value = String(props.value)
  editing.value = true
  await nextTick()
  editInput.value?.focus()
  editInput.value?.select()
}

function commitEditing(): void {
  if (!editing.value) return
  const rawValue = String(editValue.value)
  const parsed = Number(rawValue)
  if (rawValue.trim() !== "" && Number.isFinite(parsed)) {
    emit("commit", snapValue(parsed))
  }
  editing.value = false
}

function cancelEditing(): void {
  editing.value = false
}
</script>

<template>
  <span
    :class="[
      'ui-rotary-control',
      `ui-rotary-control--${props.size}`,
      `ui-rotary-control--ring-${props.ringWeight}`,
      { 'is-disabled': props.disabled }
    ]"
    :style="controlStyle"
  >
    <span class="ui-rotary-control__shell" aria-hidden="true">
      <span class="ui-rotary-control__track" />
      <span class="ui-rotary-control__progress" />
      <i class="ui-rotary-control__marker" />
    </span>
    <input
      class="ui-rotary-control__input"
      type="range"
      :min="props.min"
      :max="props.max"
      :step="props.step"
      :value="displayedValue"
      :disabled="props.disabled"
      :aria-label="props.label"
      :aria-valuetext="displayText"
      @pointerdown="beginPointerGesture"
      @pointermove="movePointerGesture"
      @pointerup="endPointerGesture"
      @pointercancel="cancelPointerGesture"
      @input="previewKeyboardGesture"
      @change="commitKeyboardGesture"
      @blur="tooltipVisible = false"
      @keydown="handleKeydown"
      @dblclick.prevent.stop="resetToDefault"
    />
    <input
      v-if="editing"
      ref="editInput"
      v-model="editValue"
      class="ui-rotary-control__editor"
      type="number"
      :min="props.min"
      :max="props.max"
      :step="props.step"
      :aria-label="props.valueLabel ?? props.label"
      @blur="commitEditing"
      @keydown.enter.prevent="commitEditing"
      @keydown.esc.prevent="cancelEditing"
    />
    <output v-if="tooltipVisible && !editing" class="ui-rotary-control__tooltip" aria-hidden="true">
      {{ displayText }}
    </output>
  </span>
</template>

<style scoped>
.ui-rotary-control {
  --rotary-control-target-size: 3.3125rem;
  --rotary-control-knob-size: 2.4375rem;
  --rotary-control-ring-inset: -0.375rem;
  --rotary-control-marker-width: 0.125rem;
  --rotary-control-marker-height: 0.5rem;
  --rotary-control-ring-inner: 66%;
  --rotary-control-ring-start: 68%;
  --rotary-control-ring-end: 79%;
  --rotary-control-ring-outer: 81%;
  position: relative;
  display: inline-grid;
  width: var(--rotary-control-target-size);
  height: var(--rotary-control-target-size);
  place-items: center;
  flex: 0 0 auto;
}

.ui-rotary-control--ring-emphasized {
  --rotary-control-ring-inner: 56%;
  --rotary-control-ring-start: 60%;
  --rotary-control-ring-end: 84%;
  --rotary-control-ring-outer: 88%;
}

.ui-rotary-control--compact {
  --rotary-control-target-size: var(--ui-target-min);
  --rotary-control-knob-size: 0.9375rem;
  --rotary-control-ring-inset: -0.1875rem;
  --rotary-control-marker-width: 0.0625rem;
  --rotary-control-marker-height: 0.25rem;
}

.ui-rotary-control__shell {
  position: absolute;
  width: var(--rotary-control-knob-size);
  height: var(--rotary-control-knob-size);
  border: 1px solid var(--ui-color-border-strong);
  border-radius: var(--ui-radius-pill);
  background: linear-gradient(145deg, var(--ui-color-control-hover), var(--ui-color-control) 68%);
  box-shadow: var(--ui-shadow-highlight-inset), var(--ui-shadow-sm);
}

.ui-rotary-control__track,
.ui-rotary-control__progress {
  position: absolute;
  inset: var(--rotary-control-ring-inset);
  border-radius: var(--ui-radius-pill);
}

.ui-rotary-control__track {
  background: conic-gradient(
    from 225deg,
    var(--ui-color-text-subtle) 0deg 270deg,
    transparent 270deg
  );
  mask: radial-gradient(circle, transparent 66%, var(--ui-color-text) 68% 79%, transparent 81%);
  opacity: 0.58;
}

.ui-rotary-control__progress {
  background: var(--rotary-control-progress);
  mask: radial-gradient(
    circle,
    transparent var(--rotary-control-ring-inner),
    var(--ui-color-text) var(--rotary-control-ring-start) var(--rotary-control-ring-end),
    transparent var(--rotary-control-ring-outer)
  );
  filter: drop-shadow(
    0 0 0.125rem color-mix(in srgb, var(--rotary-control-accent) 60%, transparent)
  );
}

.ui-rotary-control__marker {
  position: absolute;
  inset: 0;
  transform: rotate(var(--rotary-control-angle));
}

.ui-rotary-control__marker::after {
  position: absolute;
  top: 0.1875rem;
  left: 50%;
  width: var(--rotary-control-marker-width);
  height: var(--rotary-control-marker-height);
  border-radius: var(--ui-radius-pill);
  background: var(--ui-color-text);
  content: "";
  transform: translateX(-50%);
}

.ui-rotary-control__input {
  position: absolute;
  z-index: var(--ui-z-local-raised);
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  cursor: ns-resize;
  opacity: 0;
  touch-action: none;
}

.ui-rotary-control__editor {
  position: absolute;
  z-index: var(--ui-z-local-handle);
  width: calc(var(--rotary-control-knob-size) - 0.375rem);
  min-width: 1.375rem;
  height: 1.125rem;
  padding: 0 0.0625rem;
  border: 1px solid var(--rotary-control-accent);
  border-radius: var(--ui-radius-sm);
  color: var(--ui-color-text);
  background: var(--ui-color-control);
  font: var(--ui-type-weight-bold) var(--ui-type-size-caption) var(--ui-type-family-data);
  text-align: center;
  appearance: textfield;
}

.ui-rotary-control__editor::-webkit-inner-spin-button,
.ui-rotary-control__editor::-webkit-outer-spin-button {
  margin: 0;
  appearance: none;
}

.ui-rotary-control__tooltip {
  position: absolute;
  z-index: var(--ui-z-local-controls);
  top: calc(100% + var(--ui-space-1));
  left: 50%;
  min-width: 1.75rem;
  padding: 0.1875rem 0.3125rem;
  border: 1px solid var(--ui-color-border-strong);
  border-radius: var(--ui-radius-sm);
  color: var(--ui-color-text);
  background: var(--ui-color-surface-raised);
  box-shadow: var(--ui-shadow-sm);
  font: var(--ui-type-size-caption) var(--ui-type-family-data);
  text-align: center;
  transform: translateX(-50%);
  white-space: nowrap;
}

.ui-rotary-control:focus-within .ui-rotary-control__shell {
  border-color: var(--ui-color-focus);
  box-shadow: var(--ui-focus-ring);
}

.ui-rotary-control.is-disabled {
  opacity: var(--ui-opacity-disabled);
}

.ui-rotary-control.is-disabled .ui-rotary-control__input {
  cursor: not-allowed;
}

@media (prefers-reduced-motion: reduce) {
  .ui-rotary-control__shell {
    transition: none;
  }
}
</style>
