import { defineStore } from "pinia"
import { ref } from "vue"
import type { PendingRecording, RecordingSession } from "@yadaw/contracts"
import { useProjectStore } from "./project"

export const useRecordingStore = defineStore("recording", () => {
  const projectStore = useProjectStore()
  const active = ref<RecordingSession | null>(null)
  const pending = ref<PendingRecording[]>([])
  const error = ref("")

  async function toggle(): Promise<void> {
    error.value = ""
    try {
      if (active.value) {
        await window.yadaw.stopRecording()
        active.value = null
        await projectStore.refreshAssets()
        await refreshPending()
      } else {
        active.value = await window.yadaw.startRecording()
      }
    } catch (reason) {
      error.value = reason instanceof Error ? reason.message : "Recording failed."
    }
  }

  async function refreshPending(): Promise<void> {
    pending.value = await window.yadaw.listPendingRecordings()
  }

  async function recover(recording: PendingRecording): Promise<void> {
    if (projectStore.session?.path !== recording.projectPath) {
      if (projectStore.session && !await projectStore.close()) return
      if (!await projectStore.open(recording.projectPath)) return
    }
    await window.yadaw.recoverRecording(recording.id)
    await projectStore.refreshAssets()
    await refreshPending()
  }

  async function remove(recording: PendingRecording): Promise<void> {
    await window.yadaw.deletePendingRecording(recording.id)
    await refreshPending()
  }

  return { active, pending, error, toggle, refreshPending, recover, remove }
})
