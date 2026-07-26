<script setup lang="ts">
import { useAttrs } from "vue"

import type { UiActionVariant, UiControlSize } from "../types"
import UiSpinner from "./UiSpinner.vue"

defineOptions({ inheritAttrs: false })

const props = withDefaults(
  defineProps<{
    variant?: UiActionVariant
    size?: UiControlSize
    loading?: boolean
    disabled?: boolean
    type?: "button" | "submit" | "reset"
    loadingLabel?: string
  }>(),
  {
    variant: "secondary",
    size: "md",
    loading: false,
    disabled: false,
    type: "button",
    loadingLabel: "Loading"
  }
)

const attrs = useAttrs()
</script>

<template>
  <button
    v-bind="attrs"
    class="ui-button"
    :class="[`ui-button--${props.variant}`, `ui-button--${props.size}`]"
    :type="props.type"
    :disabled="props.disabled || props.loading"
    :aria-disabled="props.disabled || props.loading || undefined"
    :aria-busy="props.loading || undefined"
  >
    <UiSpinner v-if="props.loading" size="sm" :label="props.loadingLabel" />
    <span class="ui-button__content"><slot /></span>
  </button>
</template>

<style scoped>
.ui-button {
  display: inline-flex;
  min-width: 0;
  min-height: var(--ui-target-min);
  align-items: center;
  justify-content: center;
  gap: var(--ui-space-2);
  border: 1px solid transparent;
  border-radius: var(--ui-radius-md);
  font-weight: var(--ui-weight-semibold);
  line-height: var(--ui-line-tight);
  text-align: center;
  overflow-wrap: anywhere;
  cursor: pointer;
  transition:
    color var(--ui-motion-fast) var(--ui-ease-standard),
    background var(--ui-motion-fast) var(--ui-ease-standard),
    border-color var(--ui-motion-fast) var(--ui-ease-standard);
}

.ui-button--sm {
  min-height: var(--ui-control-sm);
  padding: 0 var(--ui-space-3);
  font-size: var(--ui-font-size-xs);
}

.ui-button--md {
  min-height: var(--ui-control-md);
  padding: 0 var(--ui-space-4);
  font-size: var(--ui-font-size-sm);
}

.ui-button--lg {
  min-height: var(--ui-control-lg);
  padding: 0 var(--ui-space-5);
  font-size: var(--ui-font-size-md);
}

.ui-button--primary {
  color: var(--ui-color-action-text);
  background: var(--ui-color-action);
}

.ui-button--primary:hover:not(:disabled) {
  background: var(--ui-color-action-hover);
}

.ui-button--primary:active:not(:disabled) {
  background: var(--ui-color-action-pressed);
}

.ui-button--secondary {
  color: var(--ui-color-text);
  background: var(--ui-color-surface-raised);
  border-color: var(--ui-color-border);
}

.ui-button--secondary:hover:not(:disabled),
.ui-button--ghost:hover:not(:disabled) {
  background: var(--ui-color-surface-hover);
  border-color: var(--ui-color-border-strong);
}

.ui-button--ghost {
  color: var(--ui-color-text-muted);
  background: transparent;
}

.ui-button--danger {
  color: var(--ui-color-danger-text);
  background: var(--ui-color-danger);
}

.ui-button--danger:hover:not(:disabled) {
  background: var(--ui-color-danger-hover);
}

.ui-button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.ui-button__content {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: inherit;
}
</style>
