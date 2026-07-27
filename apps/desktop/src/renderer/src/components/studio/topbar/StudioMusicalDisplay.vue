<script setup lang="ts">
import { computed, nextTick, shallowRef, useTemplateRef } from "vue"
import { UiTooltip } from "@yadaw/ui"
import type { TempoMapSnapshot } from "@yadaw/contracts"
import {
  musicalPositionAtTick,
  secondsToTick,
  tempoAtTick,
  timeSignatureAtTick
} from "../../../utils/tempoMap"

const props = defineProps<{
  playheadSeconds: number
  tempoMap: TempoMapSnapshot
}>()
const emit = defineEmits<{
  updateTempo: [beatsPerMinute: number]
}>()

const MINIMUM_TEMPO = 20
const MAXIMUM_TEMPO = 300
const editingTempo = shallowRef(false)
const tempoDraft = shallowRef("")
const tempoInput = useTemplateRef<HTMLInputElement>("tempoInput")
const playheadTick = computed(() => secondsToTick(props.tempoMap, props.playheadSeconds))
const musicalPosition = computed(() => musicalPositionAtTick(props.tempoMap, playheadTick.value))
const currentTempo = computed(() => tempoAtTick(props.tempoMap, playheadTick.value))
const currentSignature = computed(() => timeSignatureAtTick(props.tempoMap, playheadTick.value))

function beginTempoEdit(): void {
  if (editingTempo.value) return
  tempoDraft.value = currentTempo.value.toFixed(2)
  editingTempo.value = true
  void nextTick(() => tempoInput.value?.select())
}

function cancelTempoEdit(): void {
  editingTempo.value = false
}

function commitTempoEdit(): void {
  if (!editingTempo.value) return
  const parsed = Number(tempoDraft.value)
  editingTempo.value = false
  if (!Number.isFinite(parsed)) return
  const normalized =
    Math.round(Math.min(MAXIMUM_TEMPO, Math.max(MINIMUM_TEMPO, parsed)) * 100) / 100
  if (normalized !== currentTempo.value) emit("updateTempo", normalized)
}
</script>

<template>
  <section class="musical-display" aria-label="Project musical display">
    <div class="position-cell bar-cell">
      <strong>{{ String(musicalPosition.bar).padStart(3, "0") }}</strong>
      <span>BAR</span>
    </div>
    <div class="position-cell beat-cell">
      <strong>{{ musicalPosition.beat }}</strong>
      <span>BEAT</span>
    </div>
    <div class="lcd-cell tempo-cell">
      <input
        v-if="editingTempo"
        ref="tempoInput"
        v-model="tempoDraft"
        class="tempo-input"
        aria-label="Edit current tempo"
        type="number"
        :min="MINIMUM_TEMPO"
        :max="MAXIMUM_TEMPO"
        step="0.01"
        @blur="commitTempoEdit"
        @keydown.enter.prevent="commitTempoEdit"
        @keydown.escape.prevent="cancelTempoEdit"
      />
      <button
        v-else
        type="button"
        class="tempo-value"
        :aria-label="`Tempo ${currentTempo.toFixed(2)} BPM; double-click to edit`"
        title="Double-click to edit the current Tempo Track event"
        @dblclick="beginTempoEdit"
        @keydown.enter.prevent="beginTempoEdit"
      >
        {{ currentTempo.toFixed(2) }}
      </button>
      <span>TEMPO</span>
    </div>
    <div class="lcd-cell signature-cell">
      <strong>{{ currentSignature.numerator }}/{{ currentSignature.denominator }}</strong>
      <span>METER</span>
    </div>
    <UiTooltip text="Project key · Coming soon" side="bottom">
      <button
        type="button"
        class="lcd-cell key-cell"
        aria-label="Project key"
        aria-disabled="true"
        data-placeholder
        @click.prevent
      >
        <strong>—</strong>
        <span>KEY</span>
      </button>
    </UiTooltip>
  </section>
</template>

<style scoped>
.musical-display {
  display: grid;
  grid-template-columns: 74px 42px 65px 52px 54px;
  align-self: stretch;
  min-width: 0;
  height: 44px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  color: var(--text-secondary);
  background: var(--surface-sunken);
  box-shadow:
    0 1px 0 var(--ui-domain-color-ffffff08) inset,
    0 7px 18px var(--shadow);
  overflow: hidden;
  -webkit-app-region: no-drag;
}
.position-cell,
.lcd-cell {
  display: grid;
  min-width: 0;
  align-content: center;
  justify-items: center;
  border-left: 1px solid var(--line-soft);
}
.bar-cell {
  border-left: 0;
}
.position-cell strong,
.lcd-cell strong,
.tempo-value,
.tempo-input {
  height: 22px;
  color: var(--text-primary);
  font: var(--ui-type-weight-medium) var(--ui-type-size-feature-title) /
    var(--ui-type-leading-compact) var(--ui-type-family-data);
  letter-spacing: var(--ui-type-tracking-tight);
  text-shadow: 0 0 12px color-mix(in srgb, var(--signal-cyan) 23%, transparent);
}
.bar-cell strong {
  font-size: var(--ui-font-size-2xl);
  font-weight: var(--ui-type-weight-regular);
  letter-spacing: var(--ui-type-tracking-tighter);
}
.beat-cell strong {
  font-size: var(--ui-type-size-feature-title);
}
.position-cell span,
.lcd-cell span {
  color: var(--text-faint);
  font: var(--ui-type-weight-semibold) var(--ui-type-size-micro) var(--ui-type-family-data);
  letter-spacing: var(--ui-type-tracking-wider);
}
.tempo-value {
  width: 100%;
  padding: 0 4px;
  border: 0;
  background: transparent;
  cursor: text;
  text-align: center;
}
.tempo-value:hover {
  color: var(--signal-cyan);
}
.tempo-value:focus-visible,
.key-cell:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: -2px;
}
.tempo-input {
  width: 56px;
  padding: 0 2px;
  border: 1px solid var(--focus);
  border-radius: 3px;
  background: var(--surface-1);
  outline: none;
  text-align: center;
}
.key-cell {
  width: 100%;
  padding: 0;
  border-top: 0;
  border-right: 0;
  border-bottom: 0;
  background: transparent;
  opacity: 0.48;
  cursor: help;
}
@media (max-width: 1279px) {
  .musical-display {
    grid-template-columns: 68px 38px 62px 48px;
  }
  .key-cell {
    display: none;
  }
}
</style>
