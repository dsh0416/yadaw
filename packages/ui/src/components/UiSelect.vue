<script setup lang="ts">
import type { UiControlSize, UiSelectOption } from "../types"

const model = defineModel<string>({ required: true })
const props = withDefaults(
  defineProps<{
    options: readonly UiSelectOption[]
    placeholder?: string
    size?: UiControlSize
    invalid?: boolean
  }>(),
  {
    placeholder: undefined,
    size: "md",
    invalid: false
  }
)
</script>

<template>
  <select
    v-model="model"
    class="ui-select"
    :class="`ui-select--${props.size}`"
    :aria-invalid="props.invalid || undefined"
  >
    <option v-if="props.placeholder" value="" disabled>{{ props.placeholder }}</option>
    <option
      v-for="option in props.options"
      :key="option.value"
      :value="option.value"
      :disabled="option.disabled"
    >
      {{ option.label }}
    </option>
  </select>
</template>

<style scoped>
.ui-select {
  width: 100%;
  min-width: 0;
  color: var(--ui-color-text);
  background: var(--ui-color-canvas-subtle);
  border: 1px solid var(--ui-color-border);
  border-radius: var(--ui-radius-md);
}

.ui-select:hover:not(:disabled) {
  border-color: var(--ui-color-border-strong);
}

.ui-select:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.ui-select[aria-invalid="true"] {
  border-color: var(--ui-color-danger);
}

.ui-select--sm {
  min-height: var(--ui-control-sm);
  padding: 0 var(--ui-space-2);
  font-size: var(--ui-font-size-xs);
}

.ui-select--md {
  min-height: var(--ui-control-md);
  padding: 0 var(--ui-space-3);
  font-size: var(--ui-font-size-sm);
}

.ui-select--lg {
  min-height: var(--ui-control-lg);
  padding: 0 var(--ui-space-4);
  font-size: var(--ui-font-size-md);
}
</style>
