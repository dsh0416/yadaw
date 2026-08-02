<script setup lang="ts">
import { computed, nextTick, shallowRef, useTemplateRef } from "vue"
import { useI18n } from "vue-i18n"
import type {
  KeySignatureEventState,
  KeySignatureMode,
  TempoMapSnapshot,
  TimeSignatureEventState
} from "@yadaw/contracts"
import {
  musicalPositionAtTick,
  secondsToTick,
  tempoAtTick,
  timeSignatureAtTick
} from "../../../utils/tempoMap"
import {
  MAJOR_KEY_SIGNATURE_CHOICES,
  MINOR_KEY_SIGNATURE_CHOICES,
  keySignatureAtTick,
  keySignatureLabel,
  keySignatureValue,
  parseKeySignatureValue
} from "../../../utils/keySignatures"

const props = defineProps<{
  playheadSeconds: number
  tempoMap: TempoMapSnapshot
  keySignatureEvents: KeySignatureEventState[]
}>()
const emit = defineEmits<{
  updateTempo: [beatsPerMinute: number]
  updateMeter: [signature: Pick<TimeSignatureEventState, "numerator" | "denominator">]
  updateKey: [signature: { fifths: number; mode: KeySignatureMode }]
}>()

const { t } = useI18n()
const MINIMUM_TEMPO = 20
const MAXIMUM_TEMPO = 300
const METER_DENOMINATORS = [1, 2, 4, 8, 16, 32]
const editingTempo = shallowRef(false)
const tempoDraft = shallowRef("")
const editingMeter = shallowRef(false)
const meterDraft = shallowRef("")
const editingKey = shallowRef(false)
const keyDraft = shallowRef("")
const tempoInput = useTemplateRef<HTMLInputElement>("tempoInput")
const meterInput = useTemplateRef<HTMLInputElement>("meterInput")
const keyInput = useTemplateRef<HTMLSelectElement>("keyInput")
const playheadTick = computed(() => secondsToTick(props.tempoMap, props.playheadSeconds))
const musicalPosition = computed(() => musicalPositionAtTick(props.tempoMap, playheadTick.value))
const currentTempo = computed(() => tempoAtTick(props.tempoMap, playheadTick.value))
const currentSignature = computed(() => timeSignatureAtTick(props.tempoMap, playheadTick.value))
const currentKey = computed(() => keySignatureAtTick(props.keySignatureEvents, playheadTick.value))
const currentKeyLabel = computed(() =>
  keySignatureLabel(currentKey.value.fifths, currentKey.value.mode)
)

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

function beginMeterEdit(): void {
  if (editingMeter.value) return
  meterDraft.value = `${currentSignature.value.numerator}/${currentSignature.value.denominator}`
  editingMeter.value = true
  void nextTick(() => meterInput.value?.select())
}

function cancelMeterEdit(): void {
  editingMeter.value = false
}

function commitMeterEdit(): void {
  if (!editingMeter.value) return
  const match = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(meterDraft.value)
  editingMeter.value = false
  if (!match) return
  const numerator = Number(match[1])
  const denominator = Number(match[2])
  if (numerator < 1 || numerator > 32 || !METER_DENOMINATORS.includes(denominator)) return
  if (
    numerator !== currentSignature.value.numerator ||
    denominator !== currentSignature.value.denominator
  ) {
    emit("updateMeter", { numerator, denominator })
  }
}

function beginKeyEdit(): void {
  if (editingKey.value) return
  keyDraft.value = keySignatureValue(currentKey.value.fifths, currentKey.value.mode)
  editingKey.value = true
  void nextTick(() => keyInput.value?.focus())
}

function cancelKeyEdit(): void {
  editingKey.value = false
}

function commitKeyEdit(): void {
  if (!editingKey.value) return
  const choice = parseKeySignatureValue(keyDraft.value)
  editingKey.value = false
  if (!choice) return
  if (choice.fifths !== currentKey.value.fifths || choice.mode !== currentKey.value.mode) {
    emit("updateKey", choice)
  }
}
</script>

<template>
  <section class="musical-display" :aria-label="t('studio.musical.ariaLabel')">
    <div class="position-cell bar-cell">
      <strong>{{ String(musicalPosition.bar).padStart(3, "0") }}</strong>
      <span>{{ t("studio.musical.bar") }}</span>
    </div>
    <div class="position-cell beat-cell">
      <strong>{{ musicalPosition.beat }}</strong>
      <span>{{ t("studio.musical.beat") }}</span>
    </div>
    <div class="lcd-cell tempo-cell">
      <input
        v-if="editingTempo"
        ref="tempoInput"
        v-model="tempoDraft"
        class="tempo-input"
        :aria-label="t('studio.musical.editTempoAria')"
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
        :aria-label="t('studio.musical.tempoButtonAria', { value: currentTempo.toFixed(2) })"
        :title="t('studio.musical.tempoEditTitle')"
        @dblclick="beginTempoEdit"
        @keydown.enter.prevent="beginTempoEdit"
      >
        {{ currentTempo.toFixed(2) }}
      </button>
      <span>{{ t("studio.musical.tempo") }}</span>
    </div>
    <div class="lcd-cell signature-cell">
      <input
        v-if="editingMeter"
        ref="meterInput"
        v-model="meterDraft"
        class="meter-input"
        :aria-label="t('studio.musical.editMeterAria')"
        inputmode="numeric"
        @blur="commitMeterEdit"
        @keydown.enter.prevent="commitMeterEdit"
        @keydown.escape.prevent="cancelMeterEdit"
      />
      <button
        v-else
        type="button"
        class="meter-value"
        :aria-label="
          t('studio.musical.meterButtonAria', {
            value: `${currentSignature.numerator}/${currentSignature.denominator}`
          })
        "
        :title="t('studio.musical.meterEditTitle')"
        @dblclick="beginMeterEdit"
        @keydown.enter.prevent="beginMeterEdit"
      >
        {{ currentSignature.numerator }}/{{ currentSignature.denominator }}
      </button>
      <span>{{ t("studio.musical.meter") }}</span>
    </div>
    <div class="lcd-cell key-cell">
      <select
        v-if="editingKey"
        ref="keyInput"
        v-model="keyDraft"
        class="key-input"
        :aria-label="t('studio.musical.editKeyAria')"
        @change="commitKeyEdit"
        @blur="commitKeyEdit"
        @keydown.enter.prevent="commitKeyEdit"
        @keydown.escape.prevent="cancelKeyEdit"
      >
        <optgroup :label="t('studio.arrangement.majorKeys')">
          <option
            v-for="choice in MAJOR_KEY_SIGNATURE_CHOICES"
            :key="choice.value"
            :value="choice.value"
          >
            {{ choice.label }}
          </option>
        </optgroup>
        <optgroup :label="t('studio.arrangement.minorKeys')">
          <option
            v-for="choice in MINOR_KEY_SIGNATURE_CHOICES"
            :key="choice.value"
            :value="choice.value"
          >
            {{ choice.label }}
          </option>
        </optgroup>
      </select>
      <button
        v-else
        type="button"
        class="key-value"
        :aria-label="t('studio.musical.keyButtonAria', { value: currentKeyLabel })"
        :title="t('studio.musical.keyEditTitle')"
        @dblclick="beginKeyEdit"
        @keydown.enter.prevent="beginKeyEdit"
      >
        {{ currentKeyLabel }}
      </button>
      <span>{{ t("studio.musical.key") }}</span>
    </div>
  </section>
</template>

<style scoped>
.musical-display {
  display: grid;
  grid-template-columns: 74px 42px 65px 52px 72px;
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
.tempo-input,
.meter-value,
.meter-input,
.key-value {
  height: 22px;
  color: var(--text-primary);
  font: var(--ui-type-weight-medium) var(--ui-type-size-feature-title) / var(--ui-type-leading-none)
    var(--ui-type-family-data);
  letter-spacing: var(--ui-type-tracking-tight);
  text-shadow: 0 0 12px color-mix(in srgb, var(--signal-cyan) 23%, transparent);
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
.meter-value,
.key-value {
  width: 100%;
  min-width: 0;
  padding: 0 2px;
  border: 0;
  background: transparent;
  cursor: text;
  overflow: hidden;
  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.key-value {
  font-size: var(--ui-type-size-control);
}
.tempo-value:hover,
.meter-value:hover,
.key-value:hover {
  color: var(--signal-cyan);
}
.tempo-value:focus-visible,
.meter-value:focus-visible,
.key-value:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: -2px;
}
.tempo-input,
.meter-input,
.key-input {
  width: 56px;
  padding: 0 2px;
  border: 1px solid var(--focus);
  border-radius: 3px;
  background: var(--surface-1);
  outline: none;
  text-align: center;
}
.meter-input {
  width: 46px;
}
.key-cell {
  overflow: hidden;
}
.key-input {
  width: 68px;
  padding-inline: 1px;
  font-size: var(--ui-type-size-micro);
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
