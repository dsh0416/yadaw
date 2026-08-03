<script setup lang="ts">
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import { UiButton, UiField, UiNumberInput } from "@heron/ui"
import { usePianoRollEditor } from "./usePianoRollEditor"

const { pianoRollStore, selectedItems, applyInspector, commonValue, quantizeSelected } =
  usePianoRollEditor()
const { t } = useI18n()

const inspectorFields = computed(() => [
  { key: "key", label: t("pianoRoll.inspector.pitch"), min: 0, max: 127 },
  { key: "start", label: t("pianoRoll.inspector.startTick"), min: 0, max: undefined },
  { key: "duration", label: t("pianoRoll.inspector.duration"), min: 1, max: undefined },
  { key: "channel", label: t("pianoRoll.inspector.channel"), min: 1, max: 16 },
  { key: "velocity", label: t("pianoRoll.inspector.velocity"), min: 1, max: 127 },
  { key: "releaseVelocity", label: t("pianoRoll.inspector.release"), min: 0, max: 127 }
])

function numericValue(field: string): number | null {
  const value = commonValue(field)
  return value === "" ? null : Number(value)
}

function commitInspectorValue(field: string, value: number | null | undefined): void {
  if (value === null || value === undefined) return
  applyInspector(field, String(value))
}
</script>

<template>
  <aside class="inspector" :aria-label="t('pianoRoll.inspector.ariaLabel')">
    <span class="selection-summary">
      {{
        t("pianoRoll.inspector.noteCount", { count: selectedItems.length }, selectedItems.length)
      }}
    </span>
    <UiField v-for="field in inspectorFields" :key="field.key" :label="field.label" layout="inline">
      <template #default="{ controlId }">
        <UiNumberInput
          :id="controlId"
          class="inspector-input"
          size="compact"
          :min="field.min"
          :max="field.max"
          :model-value="numericValue(field.key)"
          placeholder="—"
          :disabled="selectedItems.length === 0"
          @update:model-value="commitInspectorValue(field.key, $event)"
        />
      </template>
    </UiField>
    <UiButton
      size="sm"
      variant="ghost"
      class="quantize"
      :aria-label="t('pianoRoll.inspector.quantizeAria')"
      :disabled="selectedItems.length === 0 || pianoRollStore.snap === 'off'"
      @click="quantizeSelected"
    >
      {{ t("pianoRoll.inspector.quantize") }}
    </UiButton>
    <UiButton
      size="sm"
      :variant="pianoRollStore.showVelocityLane ? 'primary' : 'ghost'"
      class="velocity-toggle"
      :aria-label="t('pianoRoll.inspector.velocityLaneAria')"
      :aria-pressed="pianoRollStore.showVelocityLane"
      @click="pianoRollStore.showVelocityLane = !pianoRollStore.showVelocityLane"
    >
      {{ t("pianoRoll.inspector.velocityLane") }}
    </UiButton>
    <span class="resolution">{{ t("pianoRoll.inspector.resolution") }}</span>
  </aside>
</template>

<style scoped>
.inspector {
  position: relative;
  z-index: var(--ui-z-local-header);
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  gap: var(--ui-space-2);
  padding: var(--ui-space-2) var(--ui-space-3);
  border-right: 1px solid var(--line-soft);
  background: var(--surface-1);
  overflow-y: auto;
}

.inspector-input {
  width: 4rem;
}

.selection-summary,
.resolution {
  color: var(--text-muted);
  font: var(--ui-type-size-caption) var(--ui-type-family-data);
}

.selection-summary {
  flex: none;
  white-space: nowrap;
}

.quantize,
.velocity-toggle {
  flex: none;
}

.resolution {
  margin-top: auto;
  padding-top: var(--ui-space-2);
}
</style>
