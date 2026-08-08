<script setup lang="ts">
import { computed } from "vue"

import type { UiScaleMark, UiScaleSide } from "../types"
import UiDbScale from "./UiDbScale.vue"

const props = withDefaults(
  defineProps<{
    levelPercent: number
    heldLevelPercent: number
    hasHeldPeak: boolean
    clipped: boolean
    marks?: readonly UiScaleMark[]
    scaleSide?: UiScaleSide
    channels?: number
    label?: string
  }>(),
  {
    marks: () => [],
    scaleSide: "left",
    channels: 2,
    label: undefined
  }
)

const meterStyle = computed(() => ({
  "--level-meter-level": `${Math.max(0, Math.min(100, props.levelPercent))}%`,
  "--level-meter-held-level": `${Math.max(0, Math.min(100, props.heldLevelPercent))}%`
}))
</script>

<template>
  <div :class="['ui-level-meter', `scale-${scaleSide}`]">
    <UiDbScale v-if="marks.length > 0" class="ui-level-meter__scale" :marks :side="scaleSide" />
    <div
      class="ui-level-meter__well"
      :class="{ clipped, 'has-held-peak': hasHeldPeak }"
      :style="meterStyle"
      role="meter"
      aria-valuemin="0"
      aria-valuemax="100"
      :aria-valuenow="Math.round(Math.max(0, Math.min(100, levelPercent)))"
      :aria-label="label"
    >
      <span v-for="channel in channels" :key="channel" />
    </div>
  </div>
</template>

<style scoped>
.ui-level-meter {
  display: grid;
  grid-template-columns: 0.9375rem 1rem;
  align-self: stretch;
  justify-self: center;
  gap: 1px;
  min-height: 0;
}

.ui-level-meter.scale-right {
  grid-template-columns: 1rem 0.9375rem;
}

.ui-level-meter.scale-right .ui-level-meter__scale {
  grid-column: 2;
  grid-row: 1;
}

.ui-level-meter__well {
  position: relative;
  display: flex;
  align-self: stretch;
  width: 1rem;
  gap: 1px;
  padding: 2px;
  border: 1px solid var(--ui-color-border-strong);
  border-radius: var(--ui-radius-sm);
  background: var(--ui-color-control-pressed);
}

.ui-level-meter__well::after {
  position: absolute;
  z-index: var(--ui-z-local-raised);
  right: 2px;
  bottom: var(--level-meter-held-level);
  left: 2px;
  height: 1px;
  background: var(--ui-signal-meter-warning);
  box-shadow: 0 0 2px color-mix(in srgb, var(--ui-signal-meter-warning) 65%, transparent);
  content: "";
  opacity: 0;
}

.ui-level-meter__well.has-held-peak::after {
  opacity: 0.9;
}

.ui-level-meter__well span {
  position: relative;
  flex: 1;
  overflow: hidden;
  background: linear-gradient(
    to top,
    var(--ui-signal-meter-safe) 0 68%,
    var(--ui-signal-meter-warning) 79%,
    var(--ui-signal-meter-clip) 100%
  );
  opacity: 0.26;
}

.ui-level-meter__well span::after {
  position: absolute;
  inset: 0 0 var(--level-meter-level) 0;
  background: var(--ui-color-control-pressed);
  content: "";
}

.ui-level-meter__well.clipped {
  border-color: var(--ui-signal-meter-clip);
  box-shadow: 0 0 8px color-mix(in srgb, var(--ui-signal-meter-clip) 35%, transparent);
}
</style>
