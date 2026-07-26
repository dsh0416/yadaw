<script setup lang="ts">
import { useId } from "vue"

const props = withDefaults(
  defineProps<{
    id?: string
    label: string
    description?: string
    error?: string
    required?: boolean
  }>(),
  {
    id: undefined,
    description: undefined,
    error: undefined,
    required: false
  }
)

defineSlots<{
  default(props: {
    controlId: string
    descriptionId: string | undefined
    errorId: string | undefined
  }): unknown
}>()

const generatedId = useId()
const controlId = props.id ?? `ui-field-${generatedId}`
const descriptionId = props.description ? `${controlId}-description` : undefined
const errorId = props.error ? `${controlId}-error` : undefined
</script>

<template>
  <div class="ui-field" :data-invalid="Boolean(props.error) || undefined">
    <label class="ui-field__label" :for="controlId">
      {{ props.label }}
      <span v-if="props.required" class="ui-field__required" aria-hidden="true">*</span>
      <span v-if="props.required" class="ui-visually-hidden"> (required)</span>
    </label>
    <p v-if="props.description" :id="descriptionId" class="ui-field__description">
      {{ props.description }}
    </p>
    <slot :control-id="controlId" :description-id="descriptionId" :error-id="errorId" />
    <p v-if="props.error" :id="errorId" class="ui-field__error" role="alert">
      {{ props.error }}
    </p>
  </div>
</template>

<style scoped>
.ui-field {
  display: grid;
  gap: var(--ui-space-2);
  min-width: 0;
}

.ui-field__label {
  color: var(--ui-color-text);
  font-size: var(--ui-font-size-sm);
  font-weight: var(--ui-weight-semibold);
}

.ui-field__required,
.ui-field__error {
  color: var(--ui-color-danger);
}

.ui-field__description,
.ui-field__error {
  margin: 0;
  font-size: var(--ui-font-size-xs);
  line-height: var(--ui-line-normal);
}

.ui-field__description {
  color: var(--ui-color-text-muted);
}
</style>
