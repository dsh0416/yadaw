import { acceptHMRUpdate, defineStore } from "pinia"
import { shallowRef } from "vue"
import type { DesktopLifecycleEvent, DesktopLifecycleSnapshot, RpcEvent } from "@yadaw/contracts"
import { useAudioRuntimeStore } from "./audioRuntime"
import { useApplicationSettingsStore } from "./applicationSettings"
import { useProjectStore } from "./project"
import { useRecordingStore } from "./recording"
import { readMeta, rpcErrorMessage } from "../rpc"

export const useLifecycleStore = defineStore("lifecycle", () => {
  const projectStore = useProjectStore()
  const settingsStore = useApplicationSettingsStore()
  const audioRuntimeStore = useAudioRuntimeStore()
  const recordingStore = useRecordingStore()
  const ready = shallowRef(false)
  const error = shallowRef("")
  const revisions = { project: -1, audio: -1, recording: -1 }
  let sourceEpoch: string | null = null
  let lastSequence = 0
  let unsubscribe: (() => void) | null = null
  let initializePromise: Promise<void> | null = null

  function applyEvent(event: DesktopLifecycleEvent): void {
    if (event.revision <= revisions[event.type]) return
    revisions[event.type] = event.revision
    if (event.type === "project") projectStore.applyLifecycleState(event.state)
    else if (event.type === "audio") {
      audioRuntimeStore.applyResources(event.resources)
      audioRuntimeStore.applyLifecycleState(event.state)
    } else {
      recordingStore.applyResource(event.resource)

      recordingStore.applyLifecycleState(event.state)
    }
  }

  function receiveEvent(envelope: RpcEvent<DesktopLifecycleEvent>): void {
    if (
      sourceEpoch !== null &&
      (envelope.sourceEpoch !== sourceEpoch || envelope.sequence !== lastSequence + 1)
    ) {
      sourceEpoch = envelope.sourceEpoch
      lastSequence = envelope.sequence
      ready.value = false
      void initialize(true)
      return
    }
    sourceEpoch = envelope.sourceEpoch
    lastSequence = envelope.sequence
    applyEvent(envelope.payload)
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

  function initialize(force = false): Promise<void> {
    if (initializePromise) return initializePromise
    if (ready.value && !force) return Promise.resolve()
    initializePromise = (async () => {
      error.value = ""
      unsubscribe ??= window.yadaw.subscribeLifecycle(receiveEvent)
      try {
        const result = await window.yadaw.bootstrap(readMeta())
        if (!result.ok) {
          error.value = rpcErrorMessage(result.error)
          ready.value = true
          return
        }
        if (result.value.lifecycle.revision >= revisions.project) {
          projectStore.applyBootstrap(result.value)
        } else {
          projectStore.applyDesktopSession(result.value.desktopSession)
        }
        sourceEpoch = result.value.mainEpoch
        lastSequence =
          sourceEpoch === result.value.mainEpoch
            ? Math.max(lastSequence, result.value.revision)
            : result.value.revision
        settingsStore.applySnapshot(result.value.settings, result.value.desktopSession)
        audioRuntimeStore.applyResources(result.value.audioResources)
        recordingStore.applyResource(result.value.recordingResource)
        applySnapshot(result.value.lifecycle)
        ready.value = true
      } catch (reason) {
        unsubscribe?.()
        unsubscribe = null
        error.value =
          reason instanceof Error ? reason.message : "Unable to restore native lifecycle state."
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
    sourceEpoch = null
    lastSequence = 0
  }

  return { ready, error, initialize, dispose, applyEvent, applySnapshot }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useLifecycleStore, import.meta.hot))
}
