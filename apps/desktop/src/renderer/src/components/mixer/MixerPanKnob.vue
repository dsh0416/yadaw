<script setup lang="ts">
import { computed, nextTick, shallowRef, useTemplateRef } from "vue"
import { useParameterGesture } from "../../composables/useParameterGesture"

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
const editInput = useTemplateRef<HTMLInputElement>("editInput")

function normalizedToPanUnits(value: number): number {
  const normalized = Math.max(-1, Math.min(1, value))
  return Math.round(normalized < 0 ? normalized * 64 : normalized * 63)
}

function panUnitsToNormalized(value: number): number {
  const units = Math.max(-64, Math.min(63, Math.round(value)))
  return units < 0 ? units / 64 : units / 63
}

const panUnits = computed(() => normalizedToPanUnits(props.value))
const panLabel = computed(() => {
  if (panUnits.value > 0) return `+${panUnits.value}`
  return String(panUnits.value)
})
const knobStyle = computed(() => {
  const value = Math.max(-1, Math.min(1, props.value))
  const position = 135 + value * 135
  const start = Math.min(135, position)
  const end = Math.max(135, position)

  return {
    "--pan-angle": `${value * 135}deg`,
    "--pan-progress": `conic-gradient(from 225deg, transparent 0deg ${start}deg, var(--mixer-pan) ${start}deg ${end}deg, transparent ${end}deg 270deg)`
  }
})

const gesture = useParameterGesture({
  currentValue: () => panUnits.value,
  preview: (value) => emit("preview", panUnitsToNormalized(value)),
  commit: (value) => emit("commit", panUnitsToNormalized(value))
})

async function beginEditing(): Promise<void> {
  editValue.value = String(panUnits.value)
  editing.value = true
  await nextTick()
  editInput.value?.focus()
  editInput.value?.select()
}

function commitEditing(): void {
  if (!editing.value) return
  const parsed = Number(editValue.value)
  if (Number.isFinite(parsed)) {
    emit("commit", panUnitsToNormalized(parsed))
  }
  editing.value = false
}

function cancelEditing(): void {
  editing.value = false
}

function onRangeKeydown(event: KeyboardEvent): void {
  if (event.key === "Enter" || event.key === "F2") {
    event.preventDefault()
    void beginEditing()
    return
  }
  gesture.keydown(event)
}
</script>

<template>
  <label class="pan-knob">
    <span class="pan-body">
      <span class="rotary-shell" :style="knobStyle">
        <span class="rotary-track" aria-hidden="true" />
        <span class="rotary-progress" aria-hidden="true" />
        <i aria-hidden="true" />
        <output v-if="!editing" class="pan-readout" aria-hidden="true">{{ panLabel }}</output>
        <input
          v-else
          ref="editInput"
          v-model="editValue"
          class="pan-editor"
          type="number"
          min="-64"
          max="63"
          step="1"
          :aria-label="`${channelName} pan value`"
          @blur="commitEditing"
          @keydown.enter.prevent="commitEditing"
          @keydown.esc.prevent="cancelEditing"
        >
      </span>
      <input
        class="rotary-input"
        type="range"
        min="-64"
        max="63"
        step="1"
        :value="panUnits"
        :aria-label="`${channelName} pan`"
        :aria-valuetext="panLabel"
        @pointerdown="gesture.begin"
        @input="gesture.preview"
        @change="gesture.commit"
        @keydown="onRangeKeydown"
        @dblclick.prevent="beginEditing"
      >
    </span>
  </label>
</template>

<style scoped>
.pan-knob {
  display: grid;
  place-items: center;
  min-width: 0;
}

.pan-body {
  position: relative;
  width: 47px;
  height: 47px;
}

.rotary-shell {
  position: absolute;
  top: 6px;
  left: 6px;
  display: block;
  width: 35px;
  height: 35px;
  border: 1px solid var(--line-strong);
  border-radius: 50%;
  background: linear-gradient(145deg,var(--daw-control-hover),var(--daw-control) 68%);
  box-shadow:
    0 1px 0 #ffffff1a inset,
    0 -2px 4px var(--shadow) inset,
    0 3px 7px var(--shadow);
}

.rotary-track {
  position: absolute;
  inset: -6px;
  border-radius: 50%;
  background: conic-gradient(from 225deg,var(--text-faint) 0deg 270deg,transparent 270deg);
  mask: radial-gradient(circle, transparent 67%, #000 69% 78%, transparent 80%);
}

.rotary-progress {
  position: absolute;
  inset: -6px;
  border-radius: 50%;
  background: var(--pan-progress);
  filter: drop-shadow(0 0 2px color-mix(in srgb,var(--mixer-pan) 60%,transparent));
  mask: radial-gradient(circle, transparent 66%, #000 68% 79%, transparent 81%);
}

.rotary-shell i {
  position: absolute;
  inset: 0;
  transform: rotate(var(--pan-angle));
  pointer-events: none;
}

.rotary-shell i::after {
  content: "";
  position: absolute;
  top: 3px;
  left: 50%;
  width: 2px;
  height: 8px;
  border-radius: 1px;
  background: var(--text-primary);
  box-shadow: 0 0 3px #fff7;
  transform: translateX(-50%);
}

.pan-readout,
.pan-editor {
  position: absolute;
  top: 50%;
  left: 50%;
  z-index: 1;
  width: 25px;
  transform: translate(-50%, -50%);
  color: var(--text-primary);
  font: 700 7px var(--font-utility);
  letter-spacing: -.03em;
  text-align: center;
}

.pan-editor {
  z-index: 4;
  height: 15px;
  padding: 0 1px;
  border: 1px solid var(--mixer-pan);
  border-radius: 2px;
  color: var(--text-primary);
  background: var(--daw-control);
  appearance: textfield;
}

.pan-editor::-webkit-inner-spin-button,
.pan-editor::-webkit-outer-spin-button {
  margin: 0;
  appearance: none;
}

.rotary-input {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 2;
  width: 47px;
  height: 47px;
  margin: 0;
  cursor: ew-resize;
  opacity: 0;
}

.pan-knob:focus-within .rotary-shell {
  border-color: var(--line-strong);
  box-shadow: 0 0 0 1px color-mix(in srgb,var(--focus) 50%,transparent),0 3px 7px var(--shadow);
}

.pan-editor:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}
</style>
