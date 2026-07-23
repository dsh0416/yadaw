<script setup lang="ts">
import { computed } from "vue"
import type { OperationSnapshot } from "@yadaw/contracts"

const props = defineProps<{ operation: OperationSnapshot }>()
const emit = defineEmits<{ cancel: []; dismiss: [] }>()

const phaseLabels: Record<OperationSnapshot["phase"], string> = {
  "closing-recording": "Closing recording",
  "repairing-header": "Repairing BWF header",
  hashing: "Hashing audio",
  resampling: "Resampling audio",
  quantizing: "Quantizing audio",
  "writing-large-object": "Writing project asset",
  "committing-database": "Committing database",
  "saving-archive": "Saving project archive",
  "cleaning-up": "Cleaning swap files"
}

const progress = computed(() => {
  if (props.operation.state === "completed") return 100
  if (!props.operation.totalBytes || props.operation.completedBytes === null) return null
  return Math.min(100, props.operation.completedBytes / props.operation.totalBytes * 100)
})

const statusLabel = computed(() => {
  if (props.operation.state === "completed") return "Completed"
  if (props.operation.state === "failed") return "Failed"
  return phaseLabels[props.operation.phase]
})
</script>

<template>
  <section class="operation-dialog" role="dialog" aria-modal="true" :aria-labelledby="`operation-${operation.id}`">
    <span class="operation-kicker">BACKGROUND OPERATION</span>
    <h2 :id="`operation-${operation.id}`">{{ operation.title }}</h2>
    <p>{{ statusLabel }}</p>
    <div class="progress-track" :class="{ indeterminate: progress === null && operation.state === 'running' }" role="progressbar" :aria-valuenow="progress ?? undefined">
      <span :style="progress === null ? undefined : { width: `${progress}%` }" />
    </div>
    <p v-if="operation.message" :class="['operation-message', operation.state]">{{ operation.message }}</p>
    <p v-if="operation.dropoutFrames > 0" class="dropout-warning">{{ operation.dropoutFrames }} captured frames were dropped.</p>
    <div class="operation-actions">
      <button v-if="operation.state === 'running'" :disabled="!operation.cancellable" @click="emit('cancel')">
        {{ operation.cancellable ? "Cancel" : "This phase cannot be cancelled" }}
      </button>
      <button v-else @click="emit('dismiss')">Close</button>
    </div>
  </section>
</template>

<style scoped>
.operation-dialog{width:min(460px,calc(100vw - 40px));padding:24px;border:1px solid var(--line-strong);border-radius:12px;color:var(--text-primary);background:#111824;box-shadow:0 28px 80px #000c}.operation-kicker{color:var(--accent);font:700 7px var(--font-utility);letter-spacing:.16em}.operation-dialog h2{margin:8px 0 6px;font:600 18px var(--font-display)}.operation-dialog p{margin:0;color:var(--text-muted);font-size:10px}.progress-track{height:7px;margin:20px 0;border-radius:999px;background:#080d15;overflow:hidden}.progress-track span{display:block;width:38%;height:100%;border-radius:inherit;background:linear-gradient(90deg,var(--accent),var(--signal-cyan))}.progress-track.indeterminate span{animation:operation-progress 1.1s ease-in-out infinite}.operation-message{margin-top:12px!important}.operation-message.failed,.dropout-warning{color:#ff9dab!important}.operation-actions{display:flex;justify-content:flex-end;margin-top:20px}.operation-actions button{padding:8px 12px;border:1px solid var(--line-strong);border-radius:7px;color:var(--text-secondary);background:var(--surface-3);cursor:pointer}.operation-actions button:disabled{cursor:not-allowed;opacity:.55}@keyframes operation-progress{from{transform:translateX(-110%)}to{transform:translateX(300%)}}
</style>
