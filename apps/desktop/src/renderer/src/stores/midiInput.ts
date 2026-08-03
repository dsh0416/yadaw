import { acceptHMRUpdate, defineStore } from "pinia"
import { computed, shallowRef } from "vue"
import type {
  MidiControlEvent,
  MidiInputSnapshot,
  MidiRuntimeResourceSnapshot,
  MidiSyncPreferences,
  ResourceRef,
  RpcEvent
} from "@heron/contracts"
import { mutationMeta, readMeta, rpcErrorMessage } from "../rpc"
import { useApplicationSettingsStore } from "./applicationSettings"
import { useAudioRuntimeStore } from "./audioRuntime"

const EMPTY_SNAPSHOT: MidiInputSnapshot = {
  ports: [],
  sync: {
    state: "internal",
    sourcePortId: null,
    sourcePortName: null,
    effectiveBpm: null,
    jitterMicroseconds: null,
    lastClockAgeMs: null,
    droppedEvents: 0,
    ignoredSystemMessages: 0,
    error: null
  },
  controlEvents: [],
  capturedAt: 0
}

export const useMidiInputStore = defineStore("midi-input", () => {
  const applicationSettings = useApplicationSettingsStore()
  const audioRuntime = useAudioRuntimeStore()
  const snapshot = shallowRef<MidiInputSnapshot>(structuredClone(EMPTY_SNAPSHOT))
  const resource = shallowRef<MidiRuntimeResourceSnapshot | null>(null)
  const loading = shallowRef(false)
  const applying = shallowRef(false)
  const learning = shallowRef(false)
  const error = shallowRef("")
  let unsubscribe: (() => void) | null = null
  let lastControlGeneration = 0
  let sourceEpoch: string | null = null
  let lastSequence = 0
  const controlListeners = new Set<(event: MidiControlEvent) => void>()

  const connectedPorts = computed(() => snapshot.value.ports.filter((port) => port.connected))
  const sourceMissing = computed(
    () =>
      snapshot.value.sync.sourcePortId !== null &&
      !snapshot.value.ports.some(
        (port) => port.id === snapshot.value.sync.sourcePortId && port.connected
      )
  )

  function sameRef(left: ResourceRef | null, right: ResourceRef | null): boolean {
    return Boolean(
      left &&
      right &&
      left.kind === right.kind &&
      left.id === right.id &&
      left.epoch === right.epoch &&
      left.generation === right.generation
    )
  }

  function applySnapshot(next: MidiInputSnapshot, publishControls: boolean): void {
    snapshot.value = next
    error.value = next.sync.error ?? ""
    const events = [...next.controlEvents].sort((left, right) => left.generation - right.generation)
    if (!publishControls) {
      lastControlGeneration = events.at(-1)?.generation ?? lastControlGeneration
      return
    }
    const newestGeneration = events.at(-1)?.generation
    if (newestGeneration !== undefined && newestGeneration < lastControlGeneration) {
      lastControlGeneration = 0
    }
    for (const event of events) {
      if (event.generation <= lastControlGeneration) continue
      lastControlGeneration = event.generation
      for (const listener of controlListeners) listener(event)
    }
  }

  function applyResource(next: MidiRuntimeResourceSnapshot, publishControls: boolean): void {
    if (!sameRef(next.runtime, audioRuntime.midiRuntimeRef)) return
    resource.value = structuredClone(next)
    applySnapshot(structuredClone(next.snapshot), publishControls)
  }

  async function load(): Promise<void> {
    if (loading.value) return
    const target = audioRuntime.midiRuntimeRef
    if (!target) return
    loading.value = true
    error.value = ""
    function receiveResource(event: RpcEvent<MidiRuntimeResourceSnapshot>): void {
      const gap =
        sourceEpoch !== null &&
        (event.sourceEpoch !== sourceEpoch || event.sequence !== lastSequence + 1)
      sourceEpoch = event.sourceEpoch
      lastSequence = event.sequence
      if (gap) {
        void load()
        return
      }
      applyResource(event.payload, true)
    }

    if (!unsubscribe) {
      unsubscribe = window.heron.subscribeMidiInput(receiveResource)
    }
    const result = await window.heron.midiInputSnapshot(readMeta(target))
    if (!result.ok) {
      error.value = rpcErrorMessage(result.error)
      loading.value = false
      return
    }
    applyResource(result.value, false)
    loading.value = false
  }

  async function configure(preferences: MidiSyncPreferences): Promise<boolean> {
    if (applying.value) return false
    const target = audioRuntime.midiRuntimeRef
    if (!target) return false
    applying.value = true
    error.value = ""
    const result = await window.heron.configureMidiInput(
      mutationMeta(target, "midi-input-configure", resource.value?.revision ?? 0),
      preferences
    )
    applying.value = false
    if (!result.ok) {
      error.value = rpcErrorMessage(result.error)
      return false
    }
    applyResource(result.value, false)
    if (applicationSettings.settings) {
      applicationSettings.settings = {
        ...applicationSettings.settings,
        midiSync: structuredClone(preferences)
      }
    }
    return true
  }

  function subscribeControls(listener: (event: MidiControlEvent) => void): () => void {
    controlListeners.add(listener)
    return () => controlListeners.delete(listener)
  }

  async function beginLearning(): Promise<boolean> {
    if (learning.value) return true
    const target = audioRuntime.midiRuntimeRef
    if (!target) return false
    error.value = ""
    const result = await window.heron.setMidiControlLearning(
      mutationMeta(target, "midi-control-learning", resource.value?.revision ?? 0),
      true
    )
    if (!result.ok) {
      error.value = rpcErrorMessage(result.error)
      return false
    }
    applyResource(result.value, false)
    learning.value = true
    return true
  }

  async function endLearning(): Promise<void> {
    if (!learning.value) return
    learning.value = false
    const target = audioRuntime.midiRuntimeRef
    if (!target) return
    const result = await window.heron.setMidiControlLearning(
      mutationMeta(target, "midi-control-learning", resource.value?.revision ?? 0),
      false
    )
    if (!result.ok) {
      error.value = rpcErrorMessage(result.error)
      return
    }
    applyResource(result.value, false)
  }

  function dispose(): void {
    unsubscribe?.()
    unsubscribe = null
    snapshot.value = structuredClone(EMPTY_SNAPSHOT)
    lastControlGeneration = 0
    resource.value = null
    if (learning.value) void endLearning()
    controlListeners.clear()
    error.value = ""
    sourceEpoch = null
    lastSequence = 0
  }

  return {
    snapshot,
    connectedPorts,
    resource,
    sourceMissing,
    loading,
    applying,
    learning,
    error,
    load,
    configure,
    subscribeControls,
    beginLearning,
    endLearning,
    dispose
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useMidiInputStore, import.meta.hot))
}
