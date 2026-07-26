<script setup lang="ts">
import { computed } from "vue"

const props = withDefaults(
  defineProps<{
    value?: number | null
    max?: number
    label: string
    valueText?: string
  }>(),
  {
    value: null,
    max: 100,
    valueText: undefined
  }
)

const normalizedValue = computed(() => {
  if (props.value === null || props.value === undefined) return null
  return Math.min(props.max, Math.max(0, props.value))
})

const percentage = computed(() =>
  normalizedValue.value === null ? 0 : (normalizedValue.value / props.max) * 100
)
</script>

<template>
  <div
    class="ui-progress"
    :class="{ 'ui-progress--indeterminate': normalizedValue === null }"
    role="progressbar"
    :aria-label="props.label"
    :aria-valuemin="normalizedValue === null ? undefined : 0"
    :aria-valuemax="normalizedValue === null ? undefined : props.max"
    :aria-valuenow="normalizedValue ?? undefined"
    :aria-valuetext="props.valueText"
  >
    <span class="ui-progress__bar" :style="{ width: `${percentage}%` }" />
  </div>
</template>

<style scoped>
.ui-progress {
  position: relative;
  width: 100%;
  height: 0.5rem;
  overflow: hidden;
  background: var(--ui-color-surface-active);
  border-radius: var(--ui-radius-pill);
}

.ui-progress__bar {
  display: block;
  height: 100%;
  background: var(--ui-color-action);
  border-radius: inherit;
  transition: width var(--ui-motion-normal) var(--ui-ease-standard);
}

.ui-progress--indeterminate .ui-progress__bar {
  width: 36% !important;
  animation: ui-progress-indeterminate 1.2s var(--ui-ease-standard) infinite;
}

@keyframes ui-progress-indeterminate {
  from {
    transform: translateX(-110%);
  }

  to {
    transform: translateX(310%);
  }
}
</style>
