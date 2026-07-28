<script setup lang="ts">
import { shallowRef } from "vue"
import type { CompiledAudioGraphSnapshot } from "@yadaw/contracts"
import type { CompiledEffectGraphStatus } from "../../stores/compiledEffectGraph"
import CompiledEffectGraphChart from "./CompiledEffectGraphChart.vue"

defineProps<{
  status: CompiledEffectGraphStatus
  snapshot: CompiledAudioGraphSnapshot | null
  errorMessage: string
}>()

const emit = defineEmits<{ retry: [] }>()
const resetToken = shallowRef(0)
</script>

<template>
  <section class="compiled-effect-graph-panel">
    <header class="graph-toolbar">
      <div>
        <span>NATIVE COMPILE</span>
        <strong v-if="snapshot">
          revision {{ snapshot.graphRevision }} · build {{ snapshot.buildGeneration }} ·
          {{ snapshot.sampleRate.toLocaleString() }} Hz
        </strong>
        <strong v-else>Waiting for a published graph</strong>
      </div>
      <button type="button" :disabled="!snapshot" @click="resetToken += 1">Reset view</button>
    </header>

    <CompiledEffectGraphChart
      v-if="status === 'ready' && snapshot"
      :snapshot="snapshot"
      :reset-token="resetToken"
    />
    <div v-else class="graph-state" role="status">
      <template v-if="status === 'loading'">
        <b>Reading the published audio graph…</b>
        <span>The graph appears after the helper swaps it at an audio block boundary.</span>
      </template>
      <template v-else-if="status === 'empty'">
        <b>No published graph</b>
        <span>Open a project and start the audio engine to publish its compiled effect chain.</span>
      </template>
      <template v-else-if="status === 'error'">
        <b>Audio helper unavailable</b>
        <span>{{ errorMessage }}</span>
        <button type="button" @click="emit('retry')">Retry</button>
      </template>
    </div>
  </section>
</template>

<style scoped>
.compiled-effect-graph-panel {
  min-height: 560px;
  overflow: hidden;
  border: 1px solid var(--line-strong);
  border-radius: 7px;
  background: var(--surface-1);
}

.graph-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 48px;
  padding: 0 12px;
  border-bottom: 1px solid var(--line-strong);
  background: var(--surface-2);
}

.graph-toolbar div {
  display: grid;
  gap: 3px;
}

.graph-toolbar span {
  color: var(--mixer-input);
  font: var(--ui-type-weight-bold) var(--ui-type-size-caption) var(--ui-type-family-data);
  letter-spacing: var(--ui-type-tracking-wider);
}

.graph-toolbar strong {
  color: var(--text-secondary);
  font: var(--ui-type-size-caption) var(--ui-type-family-data);
}

.graph-toolbar button,
.graph-state button {
  padding: 6px 10px;
  border: 1px solid var(--line-strong);
  border-radius: 4px;
  color: var(--text-secondary);
  background: var(--daw-control);
  cursor: pointer;
}

.graph-toolbar button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.graph-state {
  display: grid;
  place-content: center;
  justify-items: center;
  min-height: 510px;
  gap: 8px;
  padding: 30px;
  color: var(--text-muted);
  text-align: center;
}

.graph-state b {
  color: var(--text-primary);
}
</style>
