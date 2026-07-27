<script setup lang="ts">
import { useId } from "vue"

const model = defineModel<boolean>({ default: false })
const props = withDefaults(
  defineProps<{
    label: string
    description?: string
    disabled?: boolean
    id?: string
  }>(),
  {
    description: undefined,
    disabled: false,
    id: undefined
  }
)

const generatedId = useId()
const controlId = props.id ?? `ui-checkbox-${generatedId}`
</script>

<template>
  <label class="ui-checkbox" :class="{ 'ui-checkbox--disabled': props.disabled }">
    <input
      :id="controlId"
      v-model="model"
      class="ui-checkbox__control"
      type="checkbox"
      :disabled="props.disabled"
    />
    <span class="ui-checkbox__copy">
      <span class="ui-checkbox__label">{{ props.label }}</span>
      <span v-if="props.description" class="ui-checkbox__description">
        {{ props.description }}
      </span>
    </span>
  </label>
</template>

<style scoped>
.ui-checkbox {
  display: inline-flex;
  min-width: 0;
  align-items: flex-start;
  gap: var(--ui-space-3);
  color: var(--ui-color-text);
  cursor: pointer;
}

.ui-checkbox--disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.ui-checkbox__control {
  width: 1.25rem;
  height: 1.25rem;
  flex: none;
  margin: 0.125rem 0 0;
  accent-color: var(--ui-color-action);
}

.ui-checkbox__copy {
  display: grid;
  gap: var(--ui-space-1);
  line-height: var(--ui-type-leading-normal);
}

.ui-checkbox__label {
  font-size: var(--ui-font-size-sm);
  font-weight: var(--ui-type-weight-medium);
}

.ui-checkbox__description {
  color: var(--ui-color-text-muted);
  font-size: var(--ui-font-size-xs);
}
</style>
