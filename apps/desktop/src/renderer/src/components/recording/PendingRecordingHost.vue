<script setup lang="ts">
import { computed, onMounted, shallowRef } from "vue"
import { storeToRefs } from "pinia"
import { useRouter } from "vue-router"
import { UiButton, UiDialog, UiStatusNotice } from "@yadaw/ui"
import { useRecordingStore } from "../../stores/recording"
import { useStudioWorkflowStore } from "../../stores/studioWorkflow"

const store = useRecordingStore()
const workflowStore = useStudioWorkflowStore()
const router = useRouter()
const { pending } = storeToRefs(store)
const visible = shallowRef(true)
const actionable = computed(() => pending.value.filter((recording) => !recording.assetExists))
const open = computed({
  get: () => visible.value && actionable.value.length > 0,
  set: (value: boolean) => {
    visible.value = value
  }
})

onMounted(() => void store.refreshPending())

async function recover(recording: (typeof pending.value)[number]): Promise<void> {
  if (await workflowStore.recoverRecording(recording)) {
    void router.push({ name: "studio" })
  }
}
</script>

<template>
  <UiDialog
    v-if="actionable.length"
    v-model="open"
    title="Unfinished recordings found"
    description="Swap recordings are kept until you recover or explicitly delete them."
    size="lg"
  >
    <UiStatusNotice tone="warning" title="Recovery available">
      Review every take before continuing. Deleting a take cannot be undone from YADAW.
    </UiStatusNotice>
    <ul class="recovery-list">
      <li v-for="recording in actionable" :key="recording.id">
        <div>
          <b>{{ new Date(recording.startedAt).toLocaleString() }}</b>
          <small>{{ recording.state }} · {{ recording.projectPath }}</small>
        </div>
        <div class="recovery-actions">
          <UiButton size="sm" variant="primary" @click="recover(recording)">Recover</UiButton>
          <UiButton size="sm" variant="danger" @click="store.remove(recording)">Delete</UiButton>
        </div>
      </li>
    </ul>
    <template #actions>
      <UiButton @click="visible = false">Keep for later</UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.recovery-list {
  display: grid;
  gap: var(--ui-space-3);
  padding: 0;
  margin: var(--ui-space-5) 0 0;
  list-style: none;
}

.recovery-list li {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: var(--ui-space-4);
  padding: var(--ui-space-3);
  background: var(--ui-color-canvas-subtle);
  border: 1px solid var(--ui-color-border);
  border-radius: var(--ui-radius-md);
}

.recovery-list b,
.recovery-list small {
  display: block;
}

.recovery-list b {
  font-size: var(--ui-font-size-sm);
}

.recovery-list small {
  margin-top: var(--ui-space-1);
  overflow-wrap: anywhere;
  color: var(--ui-color-text-muted);
  font: var(--ui-font-size-xs) var(--ui-font-mono);
}

.recovery-actions {
  display: flex;
  flex: none;
  gap: var(--ui-space-2);
}

@media (max-width: 30rem) {
  .recovery-list li {
    align-items: stretch;
    flex-direction: column;
  }

  .recovery-actions > * {
    flex: 1;
  }
}
</style>
