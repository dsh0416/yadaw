<script setup lang="ts">
import { useId } from "vue"

const props = withDefaults(
  defineProps<{
    id?: string
    label: string
    description?: string
    error?: string
    required?: boolean
    layout?: "stacked" | "inline"
  }>(),
  {
    id: undefined,
    description: undefined,
    error: undefined,
    required: false,
    layout: "stacked"
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
  <div
    class="ui-field"
    :class="`ui-field--${props.layout}`"
    :data-invalid="Boolean(props.error) || undefined"
  >
    <label class="ui-field__label" :for="controlId">
      {{ props.label }}
      <span v-if="props.required" class="ui-field__required" aria-hidden="true">*</span>
      <span v-if="props.required" class="ui-visually-hidden"> (required)</span>
    </label>
    <p v-if="props.description" :id="descriptionId" class="ui-field__description">
      {{ props.description }}
    </p>
    <div class="ui-field__control">
      <slot :control-id="controlId" :description-id="descriptionId" :error-id="errorId" />
    </div>
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
  font-weight: var(--ui-type-weight-semibold);
}

.ui-field__control {
  min-width: 0;
}

.ui-field--inline {
  grid-template-areas:
    "label control"
    "description description"
    "error error";
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  column-gap: var(--ui-space-3);
}

.ui-field--inline .ui-field__label {
  grid-area: label;
  color: var(--ui-color-text-muted);
  font: var(--ui-type-size-control) var(--ui-type-family-data);
  white-space: nowrap;
}

.ui-field--inline .ui-field__description,
.ui-field--inline .ui-field__error {
  grid-column: 1 / -1;
}

.ui-field--inline .ui-field__control {
  grid-area: control;
}

.ui-field__required,
.ui-field__error {
  color: var(--ui-color-danger);
}

.ui-field__description,
.ui-field__error {
  margin: 0;
  font-size: var(--ui-font-size-xs);
  line-height: var(--ui-type-leading-normal);
}

.ui-field__description {
  color: var(--ui-color-text-muted);
}

.ui-field--inline .ui-field__description {
  grid-area: description;
}

.ui-field--inline .ui-field__error {
  grid-area: error;
}
</style>
