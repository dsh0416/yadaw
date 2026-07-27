<script setup lang="ts">
import UiProgress from "./UiProgress.vue"
import UiSpinner from "./UiSpinner.vue"

const props = withDefaults(
  defineProps<{
    title: string
    description?: string
    value?: number | null
    max?: number
  }>(),
  {
    description: undefined,
    value: undefined,
    max: 100
  }
)
</script>

<template>
  <div class="ui-loading-state" role="status" aria-live="polite">
    <UiSpinner v-if="props.value === undefined" size="lg" :label="props.title" />
    <div class="ui-loading-state__copy">
      <strong>{{ props.title }}</strong>
      <p v-if="props.description">{{ props.description }}</p>
    </div>
    <UiProgress
      v-if="props.value !== undefined"
      :value="props.value"
      :max="props.max"
      :label="props.title"
    />
  </div>
</template>

<style scoped>
.ui-loading-state {
  display: grid;
  min-width: 0;
  place-items: center;
  gap: var(--ui-space-4);
  padding: var(--ui-space-8);
  color: var(--ui-color-text);
  text-align: center;
}

.ui-loading-state__copy {
  display: grid;
  gap: var(--ui-space-2);
}

.ui-loading-state__copy strong {
  font-size: var(--ui-font-size-lg);
}

.ui-loading-state__copy p {
  max-width: 34rem;
  margin: 0;
  color: var(--ui-color-text-muted);
  font-size: var(--ui-font-size-sm);
  line-height: var(--ui-type-leading-normal);
}
</style>
