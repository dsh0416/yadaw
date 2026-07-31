import { acceptHMRUpdate, defineStore } from "pinia"
import { computed, ref, shallowRef } from "vue"
import type {
  PendingRecording,
  RecordingLifecycleState,
  RecordingResourceSnapshot,
  RecordingSession
} from "@yadaw/contracts"
import { mutationMeta, readMeta, rpcErrorMessage } from "../rpc"
import { useAudioRuntimeStore } from "./audioRuntime"
import { useProjectStore } from "./project"

export const useRecordingStore = defineStore("recording", () => {
  const projectStore = useProjectStore()
  const audioRuntimeStore = useAudioRuntimeStore()
  const lifecycle = shallowRef<RecordingLifecycleState>({ status: "idle", error: null })
  const resource = shallowRef<RecordingResourceSnapshot | null>(null)
  const pending = ref<PendingRecording[]>([])

  const active = computed<RecordingSession | null>(() => resource.value?.session ?? null)
  const busy = computed(
    () => lifecycle.value.status !== "idle" && lifecycle.value.status !== "recording"
  )
  const error = computed(() => lifecycle.value.error ?? "")

  function applyLifecycleState(state: RecordingLifecycleState): void {
    lifecycle.value = structuredClone(state)
  }

  function applyResource(value: RecordingResourceSnapshot | null): void {
    resource.value = value ? structuredClone(value) : null
  }

  async function start(): Promise<RecordingSession | null> {
    if (lifecycle.value.status !== "idle") return null
    const project = projectStore.projectRef
    const projectGraph = projectStore.projectGraphRef
    const audioEngine = audioRuntimeStore.audioEngineRef
    if (!project || !projectGraph || !audioEngine) {
      lifecycle.value = { status: "idle", error: "Recording dependencies are unavailable." }
      return null
    }
    lifecycle.value = { status: "starting", error: null }
    const result = await window.yadaw.startRecording(
      mutationMeta(project, "recording-start", projectStore.projectRevision),
      { project, projectGraph, audioEngine }
    )
    if (!result.ok) {
      lifecycle.value = {
        status: "idle",
        error: rpcErrorMessage(result.error)
      }
      return null
    }
    applyResource(result.value)
    lifecycle.value = {
      status: "recording",
      session: structuredClone(result.value.session),
      error: null
    }
    return structuredClone(result.value.session)
  }

  async function stop(): Promise<PendingRecording | null> {
    const current = resource.value
    if (lifecycle.value.status !== "recording" || !current) return null
    const session = current.session
    lifecycle.value = { status: "stopping", session, error: null }
    const result = await window.yadaw.stopRecording(
      mutationMeta(current.recording, "recording-stop", current.revision)
    )
    applyResource(null)
    if (!result.ok) {
      lifecycle.value = {
        status: "idle",
        error: rpcErrorMessage(result.error)
      }
      return null
    }
    projectStore.applyWorkspace(result.value.workspace)
    lifecycle.value = { status: "idle", error: null }
    await refreshPending()
    return structuredClone(result.value.pending)
  }

  async function refreshPending(): Promise<void> {
    const project = projectStore.projectRef
    if (!project) {
      pending.value = []
      return
    }
    const result = await window.yadaw.listPendingRecordings(readMeta(project))
    if (!result.ok) {
      lifecycle.value = { status: "idle", error: rpcErrorMessage(result.error) }
      return
    }
    pending.value = structuredClone(result.value)
  }

  async function recover(recording: PendingRecording): Promise<boolean> {
    if (lifecycle.value.status !== "idle") return false
    const project = projectStore.projectRef
    if (!project) return false
    lifecycle.value = { status: "recovering", recordingId: recording.id, error: null }
    const result = await window.yadaw.recoverRecording(
      mutationMeta(project, "recording-recover", projectStore.projectRevision),
      recording.id
    )
    if (!result.ok) {
      lifecycle.value = {
        status: "idle",
        error: rpcErrorMessage(result.error)
      }
      return false
    }
    projectStore.applyWorkspace(result.value.workspace)
    lifecycle.value = { status: "idle", error: null }
    await refreshPending()
    return true
  }

  async function remove(recording: PendingRecording): Promise<void> {
    if (lifecycle.value.status !== "idle") return
    const project = projectStore.projectRef
    if (!project) return
    const result = await window.yadaw.deletePendingRecording(
      mutationMeta(project, "recording-delete", projectStore.projectRevision),
      recording.id
    )
    if (!result.ok) {
      lifecycle.value = { status: "idle", error: rpcErrorMessage(result.error) }
      return
    }
    await refreshPending()
  }

  return {
    lifecycle,
    resource,
    active,
    pending,
    error,
    busy,
    applyLifecycleState,
    applyResource,
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
