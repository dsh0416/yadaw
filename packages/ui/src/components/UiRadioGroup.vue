<script setup lang="ts">
import { useId } from "vue"

import type { UiRadioOption } from "../types"

const model = defineModel<string>({ required: true })
const props = withDefaults(
  defineProps<{
    label: string
    options: readonly UiRadioOption[]
    disabled?: boolean
    orientation?: "horizontal" | "vertical"
    name?: string
  }>(),
  {
    disabled: false,
    orientation: "vertical",
    name: undefined
  }
)

const generatedId = useId()
const groupName = props.name ?? `ui-radio-${generatedId}`
</script>

<template>
  <fieldset
    class="ui-radio-group"
    :class="`ui-radio-group--${props.orientation}`"
    :disabled="props.disabled"
  >
    <legend class="ui-radio-group__legend">{{ props.label }}</legend>
    <label
      v-for="option in props.options"
      :key="option.value"
      class="ui-radio-group__option"
      :class="{ 'ui-radio-group__option--disabled': option.disabled }"
    >
      <input
        v-model="model"
        type="radio"
        :name="groupName"
        :value="option.value"
        :disabled="option.disabled"
      />
      <span>
        <span class="ui-radio-group__label">{{ option.label }}</span>
        <span v-if="option.description" class="ui-radio-group__description">
          {{ option.description }}
        </span>
      </span>
    </label>
  </fieldset>
</template>

<style scoped>
.ui-radio-group {
  display: flex;
  min-width: 0;
  padding: 0;
  margin: 0;
  border: 0;
  gap: var(--ui-space-3);
}

.ui-radio-group--vertical {
  flex-direction: column;
}

.ui-radio-group--horizontal {
  flex-flow: row wrap;
}

.ui-radio-group__legend {
  padding: 0;
  margin-bottom: var(--ui-space-2);
  color: var(--ui-color-text);
  font-size: var(--ui-font-size-sm);
  font-weight: var(--ui-type-weight-semibold);
}

.ui-radio-group__option {
  display: inline-flex;
  align-items: flex-start;
  gap: var(--ui-space-2);
  color: var(--ui-color-text);
  cursor: pointer;
}

.ui-radio-group__option--disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.ui-radio-group__option input {
  width: 1.25rem;
  height: 1.25rem;
  flex: none;
  margin: 0.125rem 0 0;
  accent-color: var(--ui-color-action);
}

.ui-radio-group__label,
.ui-radio-group__description {
  display: block;
  line-height: var(--ui-type-leading-normal);
}

.ui-radio-group__label {
  font-size: var(--ui-font-size-sm);
  font-weight: var(--ui-type-weight-medium);
}

.ui-radio-group__description {
  color: var(--ui-color-text-muted);
  font-size: var(--ui-font-size-xs);
}
</style>
