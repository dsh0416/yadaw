<script setup lang="ts">
import { NumberFieldInput, NumberFieldRoot } from "reka-ui"

import type { UiControlSize } from "../types"

defineOptions({ inheritAttrs: false })

const model = defineModel<number | null>({ default: null })
const props = withDefaults(
  defineProps<{
    id?: string
    name?: string
    size?: "compact" | UiControlSize
    min?: number
    max?: number
    step?: number
    placeholder?: string
    invalid?: boolean
    disabled?: boolean
    readonly?: boolean
    required?: boolean
  }>(),
  {
    id: undefined,
    name: undefined,
    size: "md",
    min: undefined,
    max: undefined,
    step: 1,
    placeholder: undefined,
    invalid: false,
    disabled: false,
    readonly: false,
    required: false
  }
)
</script>

<template>
  <NumberFieldRoot
    :id="props.id"
    v-model="model"
    class="ui-number-input"
    :class="`ui-number-input--${props.size}`"
    :name="props.name"
    :min="props.min"
    :max="props.max"
    :step="props.step"
    :disabled="props.disabled"
    :readonly="props.readonly"
    :required="props.required"
    disable-wheel-change
  >
    <NumberFieldInput
      v-bind="$attrs"
      class="ui-number-input__field"
      :placeholder="props.placeholder"
      :aria-invalid="props.invalid || undefined"
    />
  </NumberFieldRoot>
</template>

<style scoped>
.ui-number-input {
  display: inline-grid;
  min-width: 0;
}

.ui-number-input__field {
  width: 100%;
  min-width: 0;
  border: 1px solid var(--ui-color-border);
  border-radius: var(--ui-radius-md);
  color: var(--ui-color-text);
  background: var(--ui-color-canvas-subtle);
  font-variant-numeric: tabular-nums;
  transition:
    border-color var(--ui-motion-fast) var(--ui-ease-standard),
    background var(--ui-motion-fast) var(--ui-ease-standard);
}

.ui-number-input__field:hover:not(:disabled) {
  border-color: var(--ui-color-border-strong);
  background: var(--ui-color-control);
}

.ui-number-input__field:focus {
  border-color: var(--ui-color-focus);
}

.ui-number-input__field[aria-invalid="true"] {
  border-color: var(--ui-color-danger);
}

.ui-number-input[data-disabled] {
  opacity: var(--ui-opacity-disabled);
}

.ui-number-input__field:disabled {
  cursor: not-allowed;
}

.ui-number-input--compact .ui-number-input__field {
  min-height: var(--ui-control-compact);
  padding: 0 var(--ui-space-2);
  border-radius: var(--ui-radius-sm);
  font: var(--ui-type-size-control) var(--ui-type-family-data);
}

.ui-number-input--sm .ui-number-input__field {
  min-height: var(--ui-control-sm);
  padding: 0 var(--ui-space-2);
  font-size: var(--ui-font-size-xs);
}

.ui-number-input--md .ui-number-input__field {
  min-height: var(--ui-control-md);
  padding: 0 var(--ui-space-3);
  font-size: var(--ui-font-size-sm);
}

.ui-number-input--lg .ui-number-input__field {
  min-height: var(--ui-control-lg);
  padding: 0 var(--ui-space-4);
  font-size: var(--ui-font-size-md);
}
</style>
