<script setup lang="ts">
import { computed } from "vue"

const props = defineProps<{ channels: number }>()

const visibleChannels = computed(() => Math.min(4, Math.max(1, Math.round(props.channels))))
const lanePositions = computed(() => {
  const count = visibleChannels.value
  const spacing = count === 1 ? 0 : Math.min(4, 9 / (count - 1))
  return Array.from(
    { length: count },
    (_, index) => 7 + (index - (count - 1) / 2) * spacing
  )
})
const accessibleLabel = computed(() =>
  `${props.channels} ${props.channels === 1 ? "channel" : "channels"} audio`
)

function waveformPath(center: number): string {
  return [
    `M 1 ${center}`,
    `H 3`,
    `L 4 ${center - 1.4}`,
    `L 5 ${center + 1.4}`,
    `L 6 ${center - 0.9}`,
    `L 7 ${center + 0.9}`,
    `L 8 ${center}`,
    `H 15`
  ].join(" ")
}
</script>

<template>
  <span class="channel-format" role="img" :aria-label="accessibleLabel">
    <svg viewBox="0 0 16 14" aria-hidden="true">
      <path
        v-for="(position, index) in lanePositions"
        :key="index"
        :d="waveformPath(position)"
      />
    </svg>
  </span>
</template>

<style scoped>
.channel-format{display:grid;flex:none;place-items:center;width:18px;height:15px;color:currentColor}
.channel-format svg{display:block;width:16px;height:14px;overflow:visible}
.channel-format path{fill:none;stroke:currentColor;stroke-width:1.15;stroke-linecap:round;stroke-linejoin:round;vector-effect:non-scaling-stroke}
</style>
