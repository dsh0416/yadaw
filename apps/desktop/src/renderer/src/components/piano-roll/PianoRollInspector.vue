<script setup lang="ts">
import { usePianoRollEditor } from "./usePianoRollEditor"

const { selectedItems, applyInspector, commonValue } = usePianoRollEditor()

const FIELD_LABELS: Record<string, string> = {
  key: "Pitch",
  start: "Start tick",
  duration: "Duration",
  channel: "Channel",
  velocity: "Velocity",
  releaseVelocity: "Release"
}
</script>

<template>
  <aside class="inspector" aria-label="Selected note properties">
    <span class="selection-summary">
      {{ selectedItems.length }} note{{ selectedItems.length === 1 ? "" : "s" }}
    </span>
    <label
      v-for="field in ['key', 'start', 'duration', 'channel', 'velocity', 'releaseVelocity']"
      :key="field"
    >
      <span>{{ FIELD_LABELS[field] }}</span>
      <input
        type="number"
        :min="field === 'duration' || field === 'velocity' || field === 'channel' ? 1 : 0"
        :max="
          field === 'key' || field === 'velocity' || field === 'releaseVelocity'
            ? 127
            : field === 'channel'
              ? 16
              : undefined
        "
        :value="commonValue(field)"
        placeholder="—"
        :disabled="selectedItems.length === 0"
        @change="applyInspector(field, ($event.target as HTMLInputElement).value)"
      />
    </label>
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

.inspector label {
  display: grid;
  flex: none;
  grid-template-columns: minmax(0, 1fr) 64px;
  align-items: center;
  gap: 4px;
  color: var(--text-muted);
  font: var(--ui-type-size-caption) var(--ui-type-family-data);
  white-space: nowrap;
}

.inspector input {
  width: 64px;
  min-height: var(--ui-target-min);
  padding: 0 5px;
  border: 1px solid var(--line-soft);
  border-radius: var(--ui-radius-sm);
  color: var(--text-primary);
  background: var(--surface-sunken);
  font: inherit;
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

.resolution {
  margin-top: auto;
  padding-top: var(--ui-space-2);
}
</style>
