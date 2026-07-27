<script setup lang="ts">
import type { MixerDbScaleMark } from "../../utils/mixerDbScale"

defineProps<{
  marks: readonly MixerDbScaleMark[]
  side: "left" | "right"
}>()
</script>

<template>
  <div :class="['db-scale', side]" aria-hidden="true">
    <span
      v-for="mark in marks"
      :key="mark.value"
      :class="['db-scale-mark', { emphasis: mark.emphasis }]"
      :style="{ top: `${mark.position}%` }"
    >
      <i />
      <small>{{ mark.label }}</small>
    </span>
  </div>
</template>

<style scoped>
.db-scale {
  position: relative;
  width: 18px;
  min-height: 0;
  color: var(--text-faint);
  font-family: var(--ui-type-family-display);
  font-size: var(--ui-type-size-micro);
  font-stretch: condensed;
  font-weight: var(--ui-type-weight-regular);
  font-variant-numeric: tabular-nums;
  letter-spacing: var(--ui-type-tracking-wide);
  pointer-events: none;
  user-select: none;
}

.db-scale-mark {
  position: absolute;
  right: 0;
  left: 0;
  height: 1px;
}

.db-scale-mark i {
  position: absolute;
  top: 0;
  width: 5px;
  border-top: 1px solid color-mix(in srgb, var(--text-faint) 70%, transparent);
}

.db-scale-mark small {
  position: absolute;
  top: 0;
  color: inherit;
  font: inherit;
  line-height: var(--ui-type-leading-none);
  transform: translateY(-50%);
  white-space: nowrap;
}

.db-scale-mark.emphasis {
  color: var(--text-secondary);
  font-weight: var(--ui-type-weight-medium);
}

.db-scale-mark.emphasis i {
  width: 7px;
  border-color: color-mix(in srgb, var(--text-secondary) 85%, transparent);
}

.db-scale.left .db-scale-mark i {
  right: 0;
}

.db-scale.left .db-scale-mark small {
  right: 7px;
  text-align: right;
}

.db-scale.right .db-scale-mark i {
  left: 0;
}

.db-scale.right .db-scale-mark small {
  left: 7px;
  text-align: left;
}
</style>
