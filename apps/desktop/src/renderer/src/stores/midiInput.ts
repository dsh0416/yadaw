import { acceptHMRUpdate, defineStore } from "pinia"
import { computed, shallowRef } from "vue"
import type { MidiControlEvent, MidiInputSnapshot, MidiSyncPreferences } from "@yadaw/contracts"
import { useApplicationSettingsStore } from "./applicationSettings"

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
  const snapshot = shallowRef<MidiInputSnapshot>(structuredClone(EMPTY_SNAPSHOT))
  const loading = shallowRef(false)
  const applying = shallowRef(false)
  const learning = shallowRef(false)
  const error = shallowRef("")
  let unsubscribe: (() => void) | null = null
  let lastControlGeneration = 0
  const controlListeners = new Set<(event: MidiControlEvent) => void>()

  const connectedPorts = computed(() => snapshot.value.ports.filter((port) => port.connected))
  const sourceMissing = computed(
    () =>
      snapshot.value.sync.sourcePortId !== null &&
      !snapshot.value.ports.some(
        (port) => port.id === snapshot.value.sync.sourcePortId && port.connected
      )
  )

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

  async function load(): Promise<void> {
    if (loading.value || unsubscribe) return
    loading.value = true
    error.value = ""
    try {
      applySnapshot(await window.yadaw.midiInputSnapshot(), false)
      if (!unsubscribe) {
        unsubscribe = window.yadaw.subscribeMidiInput((next) => {
          applySnapshot(next, true)
        })
      }
    } catch (reason) {
      error.value = reason instanceof Error ? reason.message : "Unable to read MIDI inputs."
    } finally {
      loading.value = false
    }
  }

  async function configure(preferences: MidiSyncPreferences): Promise<boolean> {
    if (applying.value) return false
    applying.value = true
    error.value = ""
    try {
      applySnapshot(await window.yadaw.configureMidiInput(preferences), false)
      if (applicationSettings.settings) {
        applicationSettings.settings = {
          ...applicationSettings.settings,
          midiSync: structuredClone(preferences)
        }
      }
      return true
    } catch (reason) {
      error.value = reason instanceof Error ? reason.message : "Unable to configure MIDI input."
      return false
    } finally {
      applying.value = false
    }
  }

  function subscribeControls(listener: (event: MidiControlEvent) => void): () => void {
    controlListeners.add(listener)
    return () => controlListeners.delete(listener)
  }

  async function beginLearning(): Promise<boolean> {
    if (learning.value) return true
    error.value = ""
    try {
      await window.yadaw.setMidiControlLearning(true)
      learning.value = true
      return true
    } catch (reason) {
      error.value = reason instanceof Error ? reason.message : "Unable to start MIDI Learn."
      return false
    }
  }

  async function endLearning(): Promise<void> {
    if (!learning.value) return
    learning.value = false
    try {
      await window.yadaw.setMidiControlLearning(false)
    } catch (reason) {
      error.value = reason instanceof Error ? reason.message : "Unable to stop MIDI Learn."
    }
  }

  function dispose(): void {
    unsubscribe?.()
    unsubscribe = null
    snapshot.value = structuredClone(EMPTY_SNAPSHOT)
    lastControlGeneration = 0
    if (learning.value) void endLearning()
    controlListeners.clear()
    error.value = ""
  }

  return {
    snapshot,
    connectedPorts,
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
