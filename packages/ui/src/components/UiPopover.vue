<script setup lang="ts">
import { PopoverArrow, PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from "reka-ui"

const open = defineModel<boolean>({ default: false })
const props = withDefaults(
  defineProps<{
    align?: "start" | "center" | "end"
    side?: "top" | "right" | "bottom" | "left"
    sideOffset?: number
    collisionPadding?: number
    modal?: boolean
  }>(),
  {
    align: "center",
    side: "bottom",
    sideOffset: 8,
    collisionPadding: 8,
    modal: false
  }
)
</script>

<template>
  <PopoverRoot v-model:open="open" :modal="props.modal">
    <PopoverTrigger as-child>
      <slot name="trigger" />
    </PopoverTrigger>
    <PopoverPortal>
      <PopoverContent
        class="ui-popover"
        :align="props.align"
        :side="props.side"
        :side-offset="props.sideOffset"
        :collision-padding="props.collisionPadding"
      >
        <slot />
        <PopoverArrow class="ui-popover__arrow" />
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>

<style>
.ui-popover {
  z-index: var(--ui-z-popover);
  max-width: min(28rem, calc(100vw - 1rem));
  max-height: min(36rem, calc(100dvh - 1rem));
  overflow: auto;
  padding: var(--ui-space-3);
  color: var(--ui-color-text);
  background: var(--ui-color-surface-raised);
  border: 1px solid var(--ui-color-border);
  border-radius: var(--ui-radius-md);
  box-shadow: var(--ui-shadow-md);
}

.ui-popover__arrow {
  fill: var(--ui-color-surface-raised);
}
</style>
