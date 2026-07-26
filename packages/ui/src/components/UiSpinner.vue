<script setup lang="ts">
withDefaults(
  defineProps<{
    label?: string
    size?: "sm" | "md" | "lg"
  }>(),
  {
    label: "Loading",
    size: "md"
  }
)
</script>

<template>
  <span class="ui-spinner" :class="`ui-spinner--${size}`" role="status">
    <span class="ui-spinner__ring" aria-hidden="true" />
    <span class="ui-visually-hidden">{{ label }}</span>
  </span>
</template>

<style scoped>
.ui-spinner {
  display: inline-grid;
  flex: none;
  place-items: center;
  color: currentColor;
}

.ui-spinner--sm {
  width: 0.875rem;
  height: 0.875rem;
}

.ui-spinner--md {
  width: 1.125rem;
  height: 1.125rem;
}

.ui-spinner--lg {
  width: 1.5rem;
  height: 1.5rem;
}

.ui-spinner__ring {
  width: 100%;
  height: 100%;
  border: 2px solid color-mix(in srgb, currentColor 28%, transparent);
  border-top-color: currentColor;
  border-radius: 50%;
  animation: ui-spinner-rotate 720ms linear infinite;
}

@keyframes ui-spinner-rotate {
  to {
    transform: rotate(360deg);
  }
}
</style>
