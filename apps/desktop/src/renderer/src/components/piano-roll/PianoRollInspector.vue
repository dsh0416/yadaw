<script setup lang="ts">
import { UiButton, UiField, UiNumberInput } from "@yadaw/ui"
import { usePianoRollEditor } from "./usePianoRollEditor"

const { pianoRollStore, selectedItems, applyInspector, commonValue, quantizeSelected } =
  usePianoRollEditor()

const INSPECTOR_FIELDS = [
  { key: "key", label: "Pitch", min: 0, max: 127 },
  { key: "start", label: "Start tick", min: 0, max: undefined },
  { key: "duration", label: "Duration", min: 1, max: undefined },
  { key: "channel", label: "Channel", min: 1, max: 16 },
  { key: "velocity", label: "Velocity", min: 1, max: 127 },
  { key: "releaseVelocity", label: "Release", min: 0, max: 127 }
] as const

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
  <aside class="inspector" aria-label="Selected note properties">
    <span class="selection-summary">
      {{ selectedItems.length }} note{{ selectedItems.length === 1 ? "" : "s" }}
    </span>
    <UiField
      v-for="field in INSPECTOR_FIELDS"
      :key="field.key"
      :label="field.label"
      layout="inline"
    >
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
      aria-label="Quantize selected note starts to the snap grid"
      :disabled="selectedItems.length === 0 || pianoRollStore.snap === 'off'"
      @click="quantizeSelected"
    >
      Quantize
    </UiButton>
    <UiButton
      size="sm"
      :variant="pianoRollStore.showVelocityLane ? 'primary' : 'ghost'"
      class="velocity-toggle"
      aria-label="Toggle velocity lane"
      :aria-pressed="pianoRollStore.showVelocityLane"
      @click="pianoRollStore.showVelocityLane = !pianoRollStore.showVelocityLane"
    >
      Velocity lane
    </UiButton>
    <span class="resolution">Resolution 1/3840 note · integer ticks</span>
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
