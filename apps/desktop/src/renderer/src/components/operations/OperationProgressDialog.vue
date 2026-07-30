<script setup lang="ts">
import { computed } from "vue"
import type { OperationSnapshot } from "@yadaw/contracts"
import { UiButton, UiProgress, UiStatusNotice } from "@yadaw/ui"
import { useI18n } from "vue-i18n"

const props = defineProps<{ operation: OperationSnapshot }>()
const emit = defineEmits<{ cancel: [] }>()

const { t } = useI18n()

const phaseKeys: Record<OperationSnapshot["phase"], string> = {
  "closing-recording": "operation.phase.closingRecording",
  "repairing-header": "operation.phase.repairingHeader",
  hashing: "operation.phase.hashing",
  resampling: "operation.phase.resampling",
  quantizing: "operation.phase.quantizing",
  "writing-large-object": "operation.phase.writingLargeObject",
  "committing-database": "operation.phase.committingDatabase",
  "saving-archive": "operation.phase.savingArchive",
  "loading-project-archive": "operation.phase.loadingProjectArchive",
  "loading-project-database": "operation.phase.loadingProjectDatabase",
  "restoring-project-state": "operation.phase.restoringProjectState",
  "loading-mixer": "operation.phase.loadingMixer",
  "loading-project-assets": "operation.phase.loadingProjectAssets",
  "preparing-waveforms": "operation.phase.preparingWaveforms",
  "cleaning-up": "operation.phase.cleaningUp"
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
  if (props.operation.state === "completed") return t("operation.state.completed")
  if (props.operation.state === "failed") return t("operation.state.failed")
  if (props.operation.state === "cancelled") return t("operation.state.cancelled")
  return t("operation.state.inProgress")
})

const phaseLabel = computed(() => t(phaseKeys[props.operation.phase]))
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
      {{ t("operation.recordingDropoutsCaptured", { count: operation.dropoutFrames }) }}
    </UiStatusNotice>
    <div v-if="operation.state === 'running' && operation.cancellable" class="operation-actions">
      <UiButton @click="emit('cancel')">{{ t("dialog.actions.cancel") }}</UiButton>
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
  font: var(--ui-type-weight-semibold) var(--ui-font-size-xs) var(--ui-type-family-data);
  letter-spacing: var(--ui-type-tracking-wider);
  text-transform: uppercase;
}
.operation-status h3 {
  margin: 0;
  color: var(--ui-color-text);
  font-size: var(--ui-font-size-lg);
  font-weight: var(--ui-type-weight-semibold);
  line-height: var(--ui-type-leading-tight);
}
.operation-status {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--ui-space-4);
}
.operation-status span {
  color: var(--ui-color-text-muted);
  font: var(--ui-type-weight-semibold) var(--ui-font-size-sm) var(--ui-type-family-data);
  font-variant-numeric: tabular-nums;
}
.operation-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: var(--ui-space-5);
}
</style>
