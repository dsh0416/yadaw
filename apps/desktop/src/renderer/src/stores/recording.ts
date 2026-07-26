import { acceptHMRUpdate, defineStore } from "pinia"
import { computed, ref, shallowRef } from "vue"
import type { PendingRecording, RecordingLifecycleState, RecordingSession } from "@yadaw/contracts"

export const useRecordingStore = defineStore("recording", () => {
  const lifecycle = shallowRef<RecordingLifecycleState>({ status: "idle", error: null })
  const pending = ref<PendingRecording[]>([])

  const active = computed<RecordingSession | null>(() =>
    "session" in lifecycle.value ? lifecycle.value.session : null
  )
  const busy = computed(
    () => lifecycle.value.status !== "idle" && lifecycle.value.status !== "recording"
  )
  const error = computed(() => lifecycle.value.error ?? "")

  function applyLifecycleState(state: RecordingLifecycleState): void {
    lifecycle.value = structuredClone(state)
  }

  async function start(): Promise<RecordingSession | null> {
    if (lifecycle.value.status !== "idle") return null
    lifecycle.value = { status: "starting", error: null }
    try {
      const session = await window.yadaw.startRecording()
      lifecycle.value = { status: "recording", session, error: null }
      return session
    } catch (reason) {
      lifecycle.value = {
        status: "idle",
        error: reason instanceof Error ? reason.message : "Recording failed."
      }
      return null
    }
  }

  async function stop(): Promise<PendingRecording | null> {
    if (lifecycle.value.status !== "recording") return null
    const session = lifecycle.value.session
    lifecycle.value = { status: "stopping", session, error: null }
    try {
      const completed = await window.yadaw.stopRecording()
      lifecycle.value = { status: "idle", error: null }
      await refreshPending()
      return completed
    } catch (reason) {
      lifecycle.value = {
        status: "idle",
        error: reason instanceof Error ? reason.message : "Recording failed."
      }
      return null
    }
  }

  async function refreshPending(): Promise<void> {
    pending.value = await window.yadaw.listPendingRecordings()
  }

  async function recover(recording: PendingRecording): Promise<boolean> {
    if (lifecycle.value.status !== "idle") return false
    lifecycle.value = { status: "recovering", recordingId: recording.id, error: null }
    try {
      await window.yadaw.recoverRecording(recording.id)
      lifecycle.value = { status: "idle", error: null }
      await refreshPending()
      return true
    } catch (reason) {
      lifecycle.value = {
        status: "idle",
        error: reason instanceof Error ? reason.message : "Recording recovery failed."
      }
      return false
    }
  }

  async function remove(recording: PendingRecording): Promise<void> {
    if (lifecycle.value.status !== "idle") return
    await window.yadaw.deletePendingRecording(recording.id)
    await refreshPending()
  }

  return {
    lifecycle,
    active,
    pending,
    error,
    busy,
    applyLifecycleState,
    start,
    stop,
    refreshPending,
    recover,
    remove
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useRecordingStore, import.meta.hot))
}
