import { defineStore } from "pinia"
import { ref, shallowRef } from "vue"
import type { PendingRecording, RecordingSession } from "@yadaw/contracts"
import { useProjectStore } from "./project"

export const useRecordingStore = defineStore("recording", () => {
  const projectStore = useProjectStore()
  const active = ref<RecordingSession | null>(null)
  const pending = ref<PendingRecording[]>([])
  const error = shallowRef("")
  const busy = shallowRef(false)

  async function toggle(): Promise<PendingRecording | null> {
    if (busy.value) return null
    busy.value = true
    error.value = ""
    try {
      if (active.value) {
        const completed = await window.yadaw.stopRecording()
        active.value = null
        await projectStore.refreshAssets()
        projectStore.markDirty()
        await refreshPending()
        return completed
      } else {
        active.value = await window.yadaw.startRecording()
        return null
      }
    } catch (reason) {
      error.value = reason instanceof Error ? reason.message : "Recording failed."
      return null
    } finally {
      busy.value = false
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
    projectStore.markDirty()
    await refreshPending()
  }

  async function remove(recording: PendingRecording): Promise<void> {
    await window.yadaw.deletePendingRecording(recording.id)
    await refreshPending()
  }

  return { active, pending, error, busy, toggle, refreshPending, recover, remove }
})
