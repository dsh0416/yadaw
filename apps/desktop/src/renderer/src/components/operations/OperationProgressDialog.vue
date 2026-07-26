<script setup lang="ts">
import { computed } from "vue"
import type { OperationSnapshot } from "@yadaw/contracts"
import { UiButton, UiProgress, UiStatusNotice } from "@yadaw/ui"

const props = defineProps<{ operation: OperationSnapshot }>()
const emit = defineEmits<{ cancel: [] }>()

const phaseLabels: Record<OperationSnapshot["phase"], string> = {
  "closing-recording": "Closing recording",
  "repairing-header": "Repairing BWF header",
  hashing: "Hashing audio",
  resampling: "Resampling audio",
  quantizing: "Quantizing audio",
  "writing-large-object": "Writing project asset",
  "committing-database": "Committing database",
  "saving-archive": "Saving project archive",
  "loading-project-archive": "Reading project archive",
  "loading-project-database": "Loading project database",
  "restoring-project-state": "Restoring project state",
  "loading-mixer": "Loading mixer",
  "preparing-waveforms": "Preparing waveforms",
  "cleaning-up": "Cleaning swap files"
}

const progress = computed(() => {
  if (props.operation.state === "completed") return 100
  if (!props.operation.totalUnits || props.operation.completedUnits === null) return null
  return Math.min(100, (props.operation.completedUnits / props.operation.totalUnits) * 100)
})

const progressLabel = computed(() =>
  progress.value === null ? null : `${Math.round(progress.value)}%`
)

const statusLabel = computed(() => {
  if (props.operation.state === "completed") return "Completed"
  if (props.operation.state === "failed") return "Failed"
  return phaseLabels[props.operation.phase]
})
</script>

<template>
  <section class="operation-dialog">
    <span class="operation-kicker">OPERATION IN PROGRESS</span>
    <div class="operation-status">
      <p>{{ statusLabel }}</p>
      <span v-if="progressLabel">{{ progressLabel }}</span>
    </div>
    <UiProgress :value="progress" :label="statusLabel" :value-text="progressLabel ?? undefined" />
    <UiStatusNotice
      v-if="operation.message"
      :tone="operation.state === 'failed' ? 'danger' : 'info'"
      :live="operation.state === 'failed' ? 'assertive' : 'polite'"
    >
      {{ operation.message }}
    </UiStatusNotice>
    <UiStatusNotice v-if="operation.dropoutFrames > 0" tone="warning" live="polite">
      {{ operation.dropoutFrames }} captured frames were dropped.
    </UiStatusNotice>
    <div v-if="operation.state === 'running' && operation.cancellable" class="operation-actions">
      <UiButton @click="emit('cancel')">Cancel</UiButton>
    </div>
  </section>
</template>

<style scoped>
.operation-dialog {
  display: grid;
  gap: var(--ui-space-4);
}
.operation-kicker {
  color: var(--accent);
  font: 700 7px var(--font-utility);
  letter-spacing: 0.16em;
}
.operation-dialog p {
  margin: 0;
  color: var(--text-muted);
  font-size: 10px;
}
.operation-status {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.operation-status span {
  color: var(--text-secondary);
  font: 700 9px var(--font-utility);
  font-variant-numeric: tabular-nums;
}
.operation-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 20px;
}
</style>
