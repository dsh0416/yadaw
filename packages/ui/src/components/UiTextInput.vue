<script setup lang="ts">
import { useAttrs } from "vue"

import type { UiControlSize } from "../types"

defineOptions({ inheritAttrs: false })

const model = defineModel<string>({ default: "" })
const props = withDefaults(
  defineProps<{
    size?: UiControlSize
    invalid?: boolean
  }>(),
  {
    size: "md",
    invalid: false
  }
)
const attrs = useAttrs()
</script>

<template>
  <input
    v-bind="attrs"
    v-model="model"
    class="ui-input"
    :class="`ui-input--${props.size}`"
    :aria-invalid="props.invalid || undefined"
  />
</template>

<style scoped>
.ui-input {
  width: 100%;
  min-width: 0;
  color: var(--ui-color-text);
  background: var(--ui-color-canvas-subtle);
  border: 1px solid var(--ui-color-border);
  border-radius: var(--ui-radius-md);
  transition:
    border-color var(--ui-motion-fast) var(--ui-ease-standard),
    background var(--ui-motion-fast) var(--ui-ease-standard);
}

.ui-input:hover:not(:disabled) {
  border-color: var(--ui-color-border-strong);
}

.ui-input:focus {
  border-color: var(--ui-color-focus);
}

.ui-input:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.ui-input[aria-invalid="true"] {
  border-color: var(--ui-color-danger);
}

.ui-input--sm {
  min-height: var(--ui-control-sm);
  padding: 0 var(--ui-space-2);
  font-size: var(--ui-font-size-xs);
}

.ui-input--md {
  min-height: var(--ui-control-md);
  padding: 0 var(--ui-space-3);
  font-size: var(--ui-font-size-sm);
}

.ui-input--lg {
  min-height: var(--ui-control-lg);
  padding: 0 var(--ui-space-4);
  font-size: var(--ui-font-size-md);
}
</style>
