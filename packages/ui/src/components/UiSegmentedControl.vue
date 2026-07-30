<script setup lang="ts">
import { ToggleGroupItem, ToggleGroupRoot } from "reka-ui"

import type { UiControlSize, UiSegmentedOption } from "../types"

const model = defineModel<string>({ required: true })
const props = withDefaults(
  defineProps<{
    label: string
    options: readonly UiSegmentedOption[]
    size?: "compact" | UiControlSize
    disabled?: boolean
  }>(),
  {
    size: "sm",
    disabled: false
  }
)
</script>

<template>
  <ToggleGroupRoot
    v-model="model"
    class="ui-segmented"
    :class="`ui-segmented--${props.size}`"
    type="single"
    orientation="horizontal"
    :disabled="props.disabled"
    :aria-label="props.label"
  >
    <ToggleGroupItem
      v-for="option in props.options"
      :key="option.value"
      class="ui-segmented__item"
      :value="option.value"
      :disabled="option.disabled"
      :aria-label="option.ariaLabel"
    >
      {{ option.label }}
    </ToggleGroupItem>
  </ToggleGroupRoot>
</template>

<style scoped>
.ui-segmented {
  display: inline-flex;
  min-width: 0;
  align-items: stretch;
  padding: 1px;
  border: 1px solid var(--ui-color-border);
  border-radius: var(--ui-radius-md);
  background: var(--ui-color-control-pressed);
}

.ui-segmented__item {
  min-width: 0;
  border: 0;
  border-radius: calc(var(--ui-radius-md) - 2px);
  color: var(--ui-color-text-muted);
  background: transparent;
  font-weight: var(--ui-type-weight-medium);
  line-height: var(--ui-type-leading-tight);
  white-space: nowrap;
  cursor: pointer;
}

.ui-segmented__item:hover:not(:disabled) {
  color: var(--ui-color-text);
  background: var(--ui-color-control-hover);
}

.ui-segmented__item[data-state="on"] {
  color: var(--ui-color-text);
  background: var(--ui-color-selection);
  box-shadow: var(--ui-shadow-highlight-inset);
}

.ui-segmented__item:disabled {
  cursor: not-allowed;
  opacity: var(--ui-opacity-disabled);
}

.ui-segmented--compact .ui-segmented__item {
  min-height: calc(var(--ui-control-compact) - 2px);
  padding: 0 var(--ui-space-2);
  font-size: var(--ui-type-size-control);
}

.ui-segmented--sm .ui-segmented__item {
  min-height: calc(var(--ui-control-sm) - 2px);
  padding: 0 var(--ui-space-3);
  font-size: var(--ui-font-size-xs);
}

.ui-segmented--md .ui-segmented__item {
  min-height: calc(var(--ui-control-md) - 2px);
  padding: 0 var(--ui-space-4);
  font-size: var(--ui-font-size-sm);
}

.ui-segmented--lg .ui-segmented__item {
  min-height: calc(var(--ui-control-lg) - 2px);
  padding: 0 var(--ui-space-5);
  font-size: var(--ui-font-size-md);
}
</style>
