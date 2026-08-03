<script setup lang="ts">
import { computed } from "vue"

const props = withDefaults(
  defineProps<{
    variant?: "lockup" | "mark" | "wordmark"
    decorative?: boolean
  }>(),
  {
    variant: "lockup",
    decorative: false
  }
)

const classes = computed(() => ["heron-logo", `heron-logo--${props.variant}`])
</script>

<template>
  <span
    :class="classes"
    :role="props.decorative ? undefined : 'img'"
    :aria-label="props.decorative ? undefined : 'YADAW'"
    :aria-hidden="props.decorative ? 'true' : undefined"
    :data-variant="props.variant"
  >
    <svg
      v-if="props.variant !== 'wordmark'"
      class="heron-logo__mark"
      viewBox="0 0 32 32"
      aria-hidden="true"
    >
      <rect class="heron-logo__bar" x="2" y="11" width="4" height="10" rx="2" />
      <rect class="heron-logo__bar" x="8" y="6" width="4" height="20" rx="2" />
      <rect
        class="heron-logo__bar heron-logo__bar--center"
        x="14"
        y="1"
        width="4"
        height="30"
        rx="2"
      />
      <rect class="heron-logo__bar" x="20" y="6" width="4" height="20" rx="2" />
      <rect class="heron-logo__bar" x="26" y="11" width="4" height="10" rx="2" />
    </svg>
    <span v-if="props.variant !== 'mark'" class="heron-logo__wordmark" aria-hidden="true">
      YADAW
    </span>
  </span>
</template>

<style scoped>
.heron-logo {
  --heron-logo-wordmark-size: 1em;
  --heron-logo-lockup-wordmark-size: 0.68em;

  display: inline-flex;
  align-items: center;
  flex: none;
  gap: 0.46em;
  color: inherit;
  line-height: var(--ui-type-leading-none);
  white-space: nowrap;
}

.heron-logo__mark {
  display: block;
  width: 1em;
  height: 1em;
  flex: none;
  overflow: visible;
}

.heron-logo__bar {
  fill: currentColor;
}

.heron-logo__bar--center {
  fill: var(--heron-logo-highlight, currentColor);
}

.heron-logo__wordmark {
  display: var(--heron-logo-wordmark-display, inline);
  margin-right: -0.16em;
  font-family: var(--ui-type-family-data);
  font-size: var(--heron-logo-wordmark-size);
  font-weight: var(--ui-type-weight-bold);
  letter-spacing: var(--ui-type-tracking-widest);
}

.heron-logo--lockup .heron-logo__wordmark {
  font-size: var(--heron-logo-lockup-wordmark-size);
}
</style>
