<script setup lang="ts">
import type { UiActionVariant, UiControlSize } from "../types"
import UiButton from "./UiButton.vue"
import UiTooltip from "./UiTooltip.vue"

const props = withDefaults(
  defineProps<{
    label: string
    tooltip?: string
    variant?: UiActionVariant
    size?: UiControlSize
    loading?: boolean
    disabled?: boolean
    pressed?: boolean
  }>(),
  {
    tooltip: undefined,
    variant: "ghost",
    size: "md",
    loading: false,
    disabled: false,
    pressed: undefined
  }
)
</script>

<template>
  <UiTooltip :text="props.tooltip ?? props.label">
    <UiButton
      class="ui-icon-button"
      :variant="props.variant"
      :size="props.size"
      :loading="props.loading"
      :disabled="props.disabled"
      :aria-label="props.label"
      :aria-pressed="props.pressed"
    >
      <slot />
    </UiButton>
  </UiTooltip>
</template>

<style scoped>
.ui-icon-button {
  width: var(--ui-control-md);
  min-width: var(--ui-control-md);
  padding: 0;
}

.ui-icon-button.ui-button--sm {
  width: var(--ui-control-sm);
  min-width: var(--ui-control-sm);
}

.ui-icon-button.ui-button--lg {
  width: var(--ui-control-lg);
  min-width: var(--ui-control-lg);
}
</style>
