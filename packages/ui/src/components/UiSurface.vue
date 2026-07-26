<script setup lang="ts">
const props = withDefaults(
  defineProps<{
    as?: "div" | "section" | "article" | "aside"
    level?: "base" | "raised" | "canvas"
    padding?: "none" | "sm" | "md" | "lg"
  }>(),
  {
    as: "section",
    level: "base",
    padding: "md"
  }
)
</script>

<template>
  <component
    :is="props.as"
    class="ui-surface"
    :class="[`ui-surface--${props.level}`, `ui-surface--padding-${props.padding}`]"
  >
    <slot />
  </component>
</template>

<style scoped>
.ui-surface {
  min-width: 0;
  color: var(--ui-color-text);
  border: 1px solid var(--ui-color-border);
  border-radius: var(--ui-radius-lg);
}

.ui-surface--base {
  background: var(--ui-color-surface);
}

.ui-surface--raised {
  background: var(--ui-color-surface-raised);
  box-shadow: var(--ui-shadow-sm);
}

.ui-surface--canvas {
  background: var(--ui-color-canvas-subtle);
}

.ui-surface--padding-none {
  padding: 0;
}

.ui-surface--padding-sm {
  padding: var(--ui-space-3);
}

.ui-surface--padding-md {
  padding: var(--ui-space-5);
}

.ui-surface--padding-lg {
  padding: var(--ui-space-8);
}
</style>
