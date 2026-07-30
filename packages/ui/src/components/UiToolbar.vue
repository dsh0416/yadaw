<script setup lang="ts">
const props = withDefaults(
  defineProps<{
    label: string
    as?: "div" | "header"
    density?: "compact" | "standard"
  }>(),
  {
    as: "div",
    density: "standard"
  }
)
</script>

<template>
  <component
    :is="props.as"
    class="ui-toolbar"
    :class="`ui-toolbar--${props.density}`"
    role="toolbar"
    :aria-label="props.label"
  >
    <div v-if="$slots.start" class="ui-toolbar__section ui-toolbar__section--start">
      <slot name="start" />
    </div>
    <div class="ui-toolbar__content">
      <slot />
    </div>
    <div v-if="$slots.end" class="ui-toolbar__section ui-toolbar__section--end">
      <slot name="end" />
    </div>
  </component>
</template>

<style scoped>
.ui-toolbar {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: var(--ui-space-2);
  border-bottom: 1px solid var(--ui-color-border);
  color: var(--ui-color-text);
  background: var(--ui-color-surface);
}

.ui-toolbar--compact {
  min-height: var(--ui-control-md);
  padding: var(--ui-space-1) var(--ui-space-3);
}

.ui-toolbar--standard {
  min-height: var(--ui-control-lg);
  padding: var(--ui-space-2) var(--ui-space-4);
}

.ui-toolbar__content,
.ui-toolbar__section {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: var(--ui-space-2);
}

.ui-toolbar__content {
  flex: 1 1 0;
  overflow-x: auto;
  scrollbar-width: thin;
}

.ui-toolbar__section {
  flex: none;
}

.ui-toolbar__section--start {
  flex: 0 1 auto;
  overflow-x: auto;
  scrollbar-width: thin;
}

.ui-toolbar__section--end {
  margin-inline-start: auto;
}
</style>
