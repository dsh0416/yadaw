<script setup lang="ts">
import type { UiNoticeTone } from "../types"

const props = withDefaults(
  defineProps<{
    title?: string
    tone?: UiNoticeTone
    live?: "off" | "polite" | "assertive"
  }>(),
  {
    title: undefined,
    tone: "neutral",
    live: "off"
  }
)
</script>

<template>
  <div
    class="ui-status-notice"
    :data-tone="props.tone"
    :role="props.live === 'assertive' ? 'alert' : props.live === 'polite' ? 'status' : undefined"
    :aria-live="props.live === 'off' ? undefined : props.live"
  >
    <span class="ui-status-notice__marker" aria-hidden="true" />
    <div class="ui-status-notice__copy">
      <strong v-if="props.title" class="ui-status-notice__title">{{ props.title }}</strong>
      <div class="ui-status-notice__content"><slot /></div>
    </div>
  </div>
</template>

<style scoped>
.ui-status-notice {
  display: flex;
  min-width: 0;
  align-items: flex-start;
  gap: var(--ui-space-3);
  padding: var(--ui-space-3) var(--ui-space-4);
  color: var(--ui-color-text);
  background: var(--ui-color-surface-raised);
  border: 1px solid var(--ui-color-border);
  border-radius: var(--ui-radius-md);
}

.ui-status-notice__marker {
  width: 0.625rem;
  height: 0.625rem;
  flex: none;
  margin-top: 0.35rem;
  background: var(--ui-color-text-muted);
  border-radius: 50%;
}

.ui-status-notice[data-tone="info"] .ui-status-notice__marker {
  background: var(--ui-color-info);
}

.ui-status-notice[data-tone="success"] .ui-status-notice__marker {
  background: var(--ui-color-success);
}

.ui-status-notice[data-tone="warning"] .ui-status-notice__marker {
  background: var(--ui-color-warning);
}

.ui-status-notice[data-tone="danger"] .ui-status-notice__marker {
  background: var(--ui-color-danger);
}

.ui-status-notice__copy {
  display: grid;
  min-width: 0;
  gap: var(--ui-space-1);
  font-size: var(--ui-font-size-sm);
  line-height: var(--ui-type-leading-normal);
}

.ui-status-notice__title {
  font-weight: var(--ui-type-weight-semibold);
}

.ui-status-notice__content {
  color: var(--ui-color-text-muted);
}
</style>
