<script setup lang="ts">
const props = withDefaults(
  defineProps<{
    title: string
    description?: string
    level?: 1 | 2 | 3 | 4
  }>(),
  {
    description: undefined,
    level: 2
  }
)
</script>

<template>
  <header class="ui-section-heading">
    <div class="ui-section-heading__copy">
      <component :is="`h${props.level}`" class="ui-section-heading__title">
        {{ props.title }}
      </component>
      <p v-if="props.description" class="ui-section-heading__description">
        {{ props.description }}
      </p>
    </div>
    <div v-if="$slots.actions" class="ui-section-heading__actions">
      <slot name="actions" />
    </div>
  </header>
</template>

<style scoped>
.ui-section-heading {
  display: flex;
  min-width: 0;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--ui-space-4);
}

.ui-section-heading__copy {
  display: grid;
  min-width: 0;
  gap: var(--ui-space-2);
}

.ui-section-heading__title,
.ui-section-heading__description {
  margin: 0;
}

.ui-section-heading__title {
  color: var(--ui-color-text);
  font-size: var(--ui-font-size-lg);
  font-weight: var(--ui-weight-semibold);
  line-height: var(--ui-line-tight);
}

.ui-section-heading__description {
  max-width: 48rem;
  color: var(--ui-color-text-muted);
  font-size: var(--ui-font-size-sm);
  line-height: var(--ui-line-normal);
}

.ui-section-heading__actions {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  gap: var(--ui-space-2);
}

@media (max-width: 30rem) {
  .ui-section-heading {
    flex-direction: column;
  }

  .ui-section-heading__actions {
    width: 100%;
  }
}
</style>
