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

const stateLabel = computed(() => {
  if (props.operation.state === "completed") return "Completed"
  if (props.operation.state === "failed") return "Failed"
  if (props.operation.state === "cancelled") return "Cancelled"
  return "In progress"
})

const phaseLabel = computed(() => phaseLabels[props.operation.phase])
</script>

<template>
  <section class="operation-dialog">
    <span class="operation-kicker">{{ stateLabel }}</span>
    <div class="operation-status">
      <h3>{{ phaseLabel }}</h3>
      <span v-if="progressLabel">{{ progressLabel }}</span>
    </div>
    <UiProgress :value="progress" :label="phaseLabel" :value-text="progressLabel ?? undefined" />
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
  color: var(--ui-color-action);
  font: var(--ui-weight-semibold) var(--ui-font-size-xs) var(--ui-font-mono);
  letter-spacing: 0.12em;
  text-transform: uppercase;
}
.operation-status h3 {
  margin: 0;
  color: var(--ui-color-text);
  font-size: var(--ui-font-size-lg);
  font-weight: var(--ui-weight-semibold);
  line-height: var(--ui-line-tight);
}
.operation-status {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--ui-space-4);
}
.operation-status span {
  color: var(--ui-color-text-muted);
  font: var(--ui-weight-semibold) var(--ui-font-size-sm) var(--ui-font-mono);
  font-variant-numeric: tabular-nums;
}
.operation-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: var(--ui-space-5);
}
</style>
