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

const classes = computed(() => ["yadaw-logo", `yadaw-logo--${props.variant}`])
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
      class="yadaw-logo__mark"
      viewBox="0 0 32 32"
      aria-hidden="true"
    >
      <rect class="yadaw-logo__bar" x="2" y="11" width="4" height="10" rx="2" />
      <rect class="yadaw-logo__bar" x="8" y="6" width="4" height="20" rx="2" />
      <rect
        class="yadaw-logo__bar yadaw-logo__bar--center"
        x="14"
        y="1"
        width="4"
        height="30"
        rx="2"
      />
      <rect class="yadaw-logo__bar" x="20" y="6" width="4" height="20" rx="2" />
      <rect class="yadaw-logo__bar" x="26" y="11" width="4" height="10" rx="2" />
    </svg>
    <span v-if="props.variant !== 'mark'" class="yadaw-logo__wordmark" aria-hidden="true">
      YADAW
    </span>
  </span>
</template>

<style scoped>
.yadaw-logo {
  --yadaw-logo-wordmark-size: 1em;
  --yadaw-logo-lockup-wordmark-size: 0.68em;

  display: inline-flex;
  align-items: center;
  flex: none;
  gap: 0.46em;
  color: inherit;
  line-height: var(--ui-type-leading-none);
  white-space: nowrap;
}

.yadaw-logo__mark {
  display: block;
  width: 1em;
  height: 1em;
  flex: none;
  overflow: visible;
}

.yadaw-logo__bar {
  fill: currentColor;
}

.yadaw-logo__bar--center {
  fill: var(--yadaw-logo-highlight, currentColor);
}

.yadaw-logo__wordmark {
  display: var(--yadaw-logo-wordmark-display, inline);
  margin-right: -0.16em;
  font-family: var(--ui-type-family-data);
  font-size: var(--yadaw-logo-wordmark-size);
  font-weight: var(--ui-type-weight-bold);
  letter-spacing: var(--ui-type-tracking-widest);
}

.yadaw-logo--lockup .yadaw-logo__wordmark {
  font-size: var(--yadaw-logo-lockup-wordmark-size);
}
</style>
