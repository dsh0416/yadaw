<script setup lang="ts">
import { computed } from "vue"
import type { CSSProperties } from "vue"

const props = withDefaults(
  defineProps<{
    label: string
    selected?: boolean
    disabled?: boolean
    signalColor?: string
  }>(),
  {
    selected: false,
    disabled: false,
    signalColor: undefined
  }
)
const emit = defineEmits<{
  select: []
}>()

const signalStyle = computed<CSSProperties | undefined>(() =>
  props.signalColor ? { "--choice-signal": props.signalColor } : undefined
)
</script>

<template>
  <button
    type="button"
    class="ui-choice-chip"
    :class="{ 'ui-choice-chip--selected': props.selected }"
    :style="signalStyle"
    :aria-pressed="props.selected"
    :disabled="props.disabled"
    @click="emit('select')"
  >
    <span class="ui-choice-chip__label">{{ props.label }}</span>
  </button>
</template>

<style scoped>
.ui-choice-chip {
  --choice-signal: var(--ui-color-action);

  display: inline-flex;
  min-width: 0;
  min-height: var(--ui-control-compact);
  align-items: center;
  padding: 0 var(--ui-space-2);
  border: 1px solid var(--ui-color-border);
  border-inline-start-width: var(--ui-signal-rail-width);
  border-inline-start-color: var(--choice-signal);
  border-radius: var(--ui-radius-sm);
  color: var(--ui-color-text-muted);
  background: var(--ui-color-control-pressed);
  font: var(--ui-type-weight-medium) var(--ui-type-size-control) var(--ui-type-family-interface);
  white-space: nowrap;
  cursor: pointer;
  transition:
    color var(--ui-motion-fast) var(--ui-ease-standard),
    background var(--ui-motion-fast) var(--ui-ease-standard),
    border-color var(--ui-motion-fast) var(--ui-ease-standard);
}

.ui-choice-chip:hover:not(:disabled) {
  color: var(--ui-color-text);
  background: var(--ui-color-control-hover);
}

.ui-choice-chip--selected {
  border-color: var(--choice-signal);
  color: var(--ui-color-text);
  background: var(--ui-color-selection);
}

.ui-choice-chip--selected:hover:not(:disabled) {
  background: var(--ui-color-selection-hover);
}

.ui-choice-chip:disabled {
  cursor: not-allowed;
  opacity: var(--ui-opacity-disabled);
}

.ui-choice-chip__label {
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
