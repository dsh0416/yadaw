<script setup lang="ts">
import { computed } from "vue"
import { METER_SCALE_MARKS } from "../../utils/mixerDbScale"
import MixerDbScale from "./MixerDbScale.vue"

const props = defineProps<{
  levelPercent: number
  heldLevelPercent: number
  hasHeldPeak: boolean
  clipped: boolean
}>()

const meterStyle = computed(() => ({
  "--meter-level": `${props.levelPercent}%`,
  "--held-meter-level": `${props.heldLevelPercent}%`
}))
</script>

<template>
  <div class="meter-rack">
    <MixerDbScale class="meter-scale" :marks="METER_SCALE_MARKS" side="left" />
    <div
      class="meter"
      :class="{ clipped, 'has-held-peak': hasHeldPeak }"
      :style="meterStyle"
      aria-hidden="true"
    >
      <span /><span />
    </div>
  </div>
</template>

<style scoped>
.meter-rack {
  display: grid;
  grid-column: 2;
  grid-row: 2;
  grid-template-columns: 18px 18px;
  align-self: stretch;
  justify-self: center;
  gap: 2px;
  margin-block: 8px;
  min-height: 0;
}

.meter {
  position: relative;
  display: flex;
  align-self: stretch;
  width: 18px;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--line-strong);
  border-radius: 2px;
  background: var(--daw-meter-well);
}

.meter::after {
  content: "";
  position: absolute;
  z-index: var(--ui-z-local-raised);
  right: 2px;
  bottom: var(--held-meter-level);
  left: 2px;
  height: 1px;
  background: var(--meter-yellow);
  box-shadow: 0 0 2px color-mix(in srgb, var(--meter-yellow) 65%, transparent);
  opacity: 0;
}

.meter.has-held-peak::after {
  opacity: 0.9;
}

.meter span {
  position: relative;
  flex: 1;
  overflow: hidden;
  background: linear-gradient(
    to top,
    var(--meter-green) 0 68%,
    var(--meter-yellow) 79%,
    var(--meter-red) 100%
  );
  opacity: 0.26;
}

.meter span::after {
  content: "";
  position: absolute;
  inset: 0 0 var(--meter-level) 0;
  background: var(--daw-meter-well);
}

.meter.clipped {
  border-color: var(--mixer-record);
  box-shadow: 0 0 8px color-mix(in srgb, var(--mixer-record) 35%, transparent);
}
</style>
