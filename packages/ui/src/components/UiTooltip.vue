<script setup lang="ts">
import { TooltipArrow, TooltipContent, TooltipPortal, TooltipRoot, TooltipTrigger } from "reka-ui"

const props = withDefaults(
  defineProps<{
    text: string
    shortcut?: string
    side?: "top" | "right" | "bottom" | "left"
    disabled?: boolean
  }>(),
  {
    shortcut: undefined,
    side: "top",
    disabled: false
  }
)
</script>

<template>
  <TooltipRoot :disabled="props.disabled">
    <TooltipTrigger as-child>
      <slot />
    </TooltipTrigger>
    <TooltipPortal>
      <TooltipContent class="ui-tooltip" :side="props.side" :side-offset="6">
        <span>{{ props.text }}</span>
        <kbd v-if="props.shortcut">{{ props.shortcut }}</kbd>
        <TooltipArrow class="ui-tooltip__arrow" />
      </TooltipContent>
    </TooltipPortal>
  </TooltipRoot>
</template>

<style>
.ui-tooltip {
  z-index: var(--ui-z-tooltip);
  display: inline-flex;
  max-width: min(22rem, calc(100vw - 2rem));
  align-items: center;
  gap: var(--ui-space-2);
  padding: var(--ui-space-2) var(--ui-space-3);
  color: var(--ui-color-text);
  background: var(--ui-color-surface-raised);
  border: 1px solid var(--ui-color-border);
  border-radius: var(--ui-radius-sm);
  box-shadow: var(--ui-shadow-md);
  font-size: var(--ui-font-size-xs);
  line-height: var(--ui-line-normal);
}

.ui-tooltip kbd {
  color: var(--ui-color-text-muted);
  font: inherit;
}

.ui-tooltip__arrow {
  fill: var(--ui-color-surface-raised);
}
</style>
