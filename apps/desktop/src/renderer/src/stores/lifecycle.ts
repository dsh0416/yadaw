import { acceptHMRUpdate, defineStore } from "pinia"
import { shallowRef } from "vue"
import type { DesktopLifecycleEvent, DesktopLifecycleSnapshot } from "@yadaw/contracts"
import { useAudioRuntimeStore } from "./audioRuntime"
import { useProjectStore } from "./project"
import { useRecordingStore } from "./recording"

export const useLifecycleStore = defineStore("lifecycle", () => {
  const projectStore = useProjectStore()
  const audioRuntimeStore = useAudioRuntimeStore()
  const recordingStore = useRecordingStore()
  const ready = shallowRef(false)
  const error = shallowRef("")
  const revisions = { project: -1, audio: -1, recording: -1 }
  let unsubscribe: (() => void) | null = null
  let initializePromise: Promise<void> | null = null

  function applyEvent(event: DesktopLifecycleEvent): void {
    if (event.revision <= revisions[event.type]) return
    revisions[event.type] = event.revision
    if (event.type === "project") projectStore.applyLifecycleState(event.state)
    else if (event.type === "audio") audioRuntimeStore.applyLifecycleState(event.state)
    else recordingStore.applyLifecycleState(event.state)
  }

  function applySnapshot(snapshot: DesktopLifecycleSnapshot): void {
    if (snapshot.revision >= revisions.project) {
      revisions.project = snapshot.revision
      projectStore.applyLifecycleState(snapshot.project)
    }
    if (snapshot.revision >= revisions.audio) {
      revisions.audio = snapshot.revision
      audioRuntimeStore.applyLifecycleState(snapshot.audio)
    }
    if (snapshot.revision >= revisions.recording) {
      revisions.recording = snapshot.revision
      recordingStore.applyLifecycleState(snapshot.recording)
    }
  }

  function initialize(): Promise<void> {
    if (initializePromise) return initializePromise
    if (ready.value) return Promise.resolve()
    initializePromise = (async () => {
      error.value = ""
      unsubscribe ??= window.yadaw.subscribeLifecycle(applyEvent)
      try {
        applySnapshot(await window.yadaw.lifecycleSnapshot())
        ready.value = true
      } catch (reason) {
        unsubscribe?.()
        unsubscribe = null
        error.value = reason instanceof Error ? reason.message : "Unable to restore native lifecycle state."
        ready.value = true
      } finally {
        initializePromise = null
      }
    })()
    return initializePromise
  }

  function dispose(): void {
    unsubscribe?.()
    unsubscribe = null
    ready.value = false
    revisions.project = -1
    revisions.audio = -1
    revisions.recording = -1
  }

  return { ready, error, initialize, dispose, applyEvent, applySnapshot }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useLifecycleStore, import.meta.hot))
}
