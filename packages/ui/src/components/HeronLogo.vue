<script setup lang="ts">
import { computed } from "vue"
import logoUrl from "../assets/heron-logo.png"

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
    :aria-label="props.decorative ? undefined : 'Heron'"
    :aria-hidden="props.decorative ? 'true' : undefined"
    :data-variant="props.variant"
  >
    <img
      v-if="props.variant !== 'wordmark'"
      class="heron-logo__mark"
      :src="logoUrl"
      alt=""
      draggable="false"
    />
    <span v-if="props.variant !== 'mark'" class="heron-logo__wordmark" aria-hidden="true">
      Heron
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
  object-fit: contain;
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
