<script setup lang="ts">
const props = withDefaults(
  defineProps<{
    title: string
    description?: string
  }>(),
  {
    description: undefined
  }
)
</script>

<template>
  <div class="ui-empty-state">
    <div v-if="$slots.icon" class="ui-empty-state__icon" aria-hidden="true">
      <slot name="icon" />
    </div>
    <div class="ui-empty-state__copy">
      <h2>{{ props.title }}</h2>
      <p v-if="props.description">{{ props.description }}</p>
    </div>
    <div v-if="$slots.actions" class="ui-empty-state__actions">
      <slot name="actions" />
    </div>
  </div>
</template>

<style scoped>
.ui-empty-state {
  display: grid;
  min-width: 0;
  place-items: center;
  gap: var(--ui-space-4);
  padding: var(--ui-space-8);
  text-align: center;
}

.ui-empty-state__icon {
  display: grid;
  width: 3rem;
  height: 3rem;
  place-items: center;
  color: var(--ui-color-text-muted);
  background: var(--ui-color-surface-raised);
  border: 1px solid var(--ui-color-border);
  border-radius: 50%;
}

.ui-empty-state__copy {
  display: grid;
  max-width: 34rem;
  gap: var(--ui-space-2);
}

.ui-empty-state h2,
.ui-empty-state p {
  margin: 0;
}

.ui-empty-state h2 {
  color: var(--ui-color-text);
  font-size: var(--ui-font-size-lg);
}

.ui-empty-state p {
  color: var(--ui-color-text-muted);
  font-size: var(--ui-font-size-sm);
  line-height: var(--ui-type-leading-normal);
}

.ui-empty-state__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: var(--ui-space-3);
}
</style>
