<script setup lang="ts">
import type { UiScaleMark, UiScaleSide } from "../types"

defineProps<{
  marks: readonly UiScaleMark[]
  side: UiScaleSide
}>()
</script>

<template>
  <div :class="['ui-db-scale', side]" aria-hidden="true">
    <span
      v-for="mark in marks"
      :key="mark.value"
      :class="['ui-db-scale__mark', { emphasis: mark.emphasis }]"
      :style="{ top: `${mark.position}%` }"
    >
      <i />
      <small>{{ mark.label }}</small>
    </span>
  </div>
</template>

<style scoped>
.ui-db-scale {
  position: relative;
  width: 0.9375rem;
  min-height: 0;
  color: var(--ui-color-text-subtle);
  font-family: var(--ui-type-family-display);
  font-size: var(--ui-type-size-micro);
  font-stretch: condensed;
  font-weight: var(--ui-type-weight-regular);
  font-variant-numeric: tabular-nums;
  letter-spacing: var(--ui-type-tracking-wide);
  pointer-events: none;
  user-select: none;
}

.ui-db-scale__mark {
  position: absolute;
  right: 0;
  left: 0;
  height: 1px;
}

.ui-db-scale__mark i {
  position: absolute;
  top: 0;
  width: 0.25rem;
  border-top: 1px solid color-mix(in srgb, var(--ui-color-text-subtle) 70%, transparent);
}

.ui-db-scale__mark small {
  position: absolute;
  top: 0;
  color: inherit;
  font: inherit;
  line-height: var(--ui-type-leading-none);
  transform: translateY(-50%);
  white-space: nowrap;
}

.ui-db-scale__mark.emphasis {
  color: var(--ui-color-text-muted);
  font-weight: var(--ui-type-weight-medium);
}

.ui-db-scale__mark.emphasis i {
  width: 0.375rem;
  border-color: color-mix(in srgb, var(--ui-color-text-muted) 85%, transparent);
}

.ui-db-scale.left .ui-db-scale__mark i {
  right: 0;
}

.ui-db-scale.left .ui-db-scale__mark small {
  right: 0.375rem;
  text-align: right;
}

.ui-db-scale.right .ui-db-scale__mark i {
  left: 0;
}

.ui-db-scale.right .ui-db-scale__mark small {
  left: 0.375rem;
  text-align: left;
}
</style>
