<script setup lang="ts">
import { computed, onMounted } from "vue"
import { storeToRefs } from "pinia"
import { useMidiInputStore } from "../../../stores/midiInput"

const midiInputStore = useMidiInputStore()
const { snapshot } = storeToRefs(midiInputStore)
onMounted(() => void midiInputStore.load())

const label = computed(() => {
  const sync = snapshot.value.sync
  const state = sync.state[0]?.toUpperCase() + sync.state.slice(1)
  const bpm = sync.effectiveBpm === null ? "" : ` · ${sync.effectiveBpm.toFixed(2)} BPM`
  return `${state}${bpm}`
})
</script>

<template>
  <div
    v-if="snapshot.sync.state !== 'internal'"
    class="midi-sync-status"
    :data-state="snapshot.sync.state"
    :title="snapshot.sync.sourcePortName ?? 'External MIDI Clock'"
    aria-live="polite"
  >
    <i />
    <span>{{ label }}</span>
  </div>
</template>

<style scoped>
.midi-sync-status {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 86px;
  padding: 0 7px;
  color: var(--text-secondary);
  font: var(--ui-type-size-micro) var(--ui-type-family-data);
  white-space: nowrap;
}
.midi-sync-status i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
}
.midi-sync-status[data-state="waiting"] i,
.midi-sync-status[data-state="locking"] i {
  animation: pulse 1s ease-in-out infinite;
}
.midi-sync-status[data-state="freewheel"] i,
.midi-sync-status[data-state="lost"] i {
  background: var(--mixer-record);
}
@keyframes pulse {
  50% {
    opacity: 0.35;
  }
}
@media (prefers-reduced-motion: reduce) {
  .midi-sync-status i {
    animation: none;
  }
}
</style>
