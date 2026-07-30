import { acceptHMRUpdate, defineStore } from "pinia"
import { computed, shallowRef } from "vue"
import type { MidiInputSnapshot, MidiSyncPreferences } from "@yadaw/contracts"
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
  capturedAt: 0
}

export const useMidiInputStore = defineStore("midi-input", () => {
  const applicationSettings = useApplicationSettingsStore()
  const snapshot = shallowRef<MidiInputSnapshot>(structuredClone(EMPTY_SNAPSHOT))
  const loading = shallowRef(false)
  const applying = shallowRef(false)
  const error = shallowRef("")
  let unsubscribe: (() => void) | null = null

  const connectedPorts = computed(() => snapshot.value.ports.filter((port) => port.connected))
  const sourceMissing = computed(
    () =>
      snapshot.value.sync.sourcePortId !== null &&
      !snapshot.value.ports.some(
        (port) => port.id === snapshot.value.sync.sourcePortId && port.connected
      )
  )

  async function load(): Promise<void> {
    if (loading.value || unsubscribe) return
    loading.value = true
    error.value = ""
    try {
      snapshot.value = await window.yadaw.midiInputSnapshot()
      if (!unsubscribe) {
        unsubscribe = window.yadaw.subscribeMidiInput((next) => {
          snapshot.value = next
          error.value = next.sync.error ?? ""
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
      snapshot.value = await window.yadaw.configureMidiInput(preferences)
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

  function dispose(): void {
    unsubscribe?.()
    unsubscribe = null
    snapshot.value = structuredClone(EMPTY_SNAPSHOT)
    error.value = ""
  }

  return {
    snapshot,
    connectedPorts,
    sourceMissing,
    loading,
    applying,
    error,
    load,
    configure,
    dispose
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useMidiInputStore, import.meta.hot))
}
