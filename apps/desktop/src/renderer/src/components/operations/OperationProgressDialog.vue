<script setup lang="ts">
import { computed } from "vue"
import type { OperationSnapshot } from "@heron/contracts"
import { UiButton, UiProgress } from "@heron/ui"
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
  "preparing-project": "operation.phase.preparingProject",
  "loading-project-archive": "operation.phase.loadingProjectArchive",
  "loading-project-database": "operation.phase.loadingProjectDatabase",
  "restoring-project-state": "operation.phase.restoringProjectState",
  "loading-mixer": "operation.phase.loadingMixer",
  "loading-project-assets": "operation.phase.loadingProjectAssets",
  "preparing-project-graph": "operation.phase.preparingProjectGraph",
  "preparing-waveforms": "operation.phase.preparingWaveforms",
  "synchronizing-plugin-state": "operation.phase.synchronizingPluginState",
  "stopping-playback": "operation.phase.stoppingPlayback",
  "closing-project-database": "operation.phase.closingProjectDatabase",
  "releasing-project-graph": "operation.phase.releasingProjectGraph",
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
const detailLabel = computed(() => {
  if (props.operation.error) return t(props.operation.error.userMessageKey)
  if (props.operation.dropoutFrames > 0) {
    return t("operation.recordingDropoutsCaptured", {
      count: props.operation.dropoutFrames
    })
  }
  if (props.operation.state !== "running") return stateLabel.value
  return phaseLabel.value
})
const description = computed(() => `${props.operation.title} · ${detailLabel.value}`)
</script>

<template>
  <section class="operation-dialog">
    <div class="operation-meta">
      <p
        class="operation-description"
        :class="{
          'operation-description--danger': operation.state === 'failed',
          'operation-description--warning': !operation.error && operation.dropoutFrames > 0
        }"
        :title="description"
        :aria-live="operation.state === 'failed' ? 'assertive' : 'polite'"
        aria-atomic="true"
      >
        {{ description }}
      </p>
      <UiButton
        v-if="operation.state === 'running' && operation.cancellable"
        size="sm"
        variant="ghost"
        @click="emit('cancel')"
      >
        {{ t("dialog.actions.cancel") }}
      </UiButton>
    </div>
    <UiProgress :value="progress" :label="phaseLabel" :value-text="progressLabel ?? undefined" />
  </section>
</template>

<style scoped>
.operation-dialog {
  display: grid;
  gap: var(--ui-space-2);
}
.operation-meta {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: var(--ui-space-2);
}
.operation-description {
  min-width: 0;
  margin: 0;
  overflow: hidden;
  color: var(--ui-color-text-muted);
  font-size: var(--ui-font-size-xs);
  line-height: var(--ui-type-leading-tight);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.operation-description--danger {
  color: var(--ui-color-danger);
}
.operation-description--warning {
  color: var(--ui-color-warning);
}
</style>
