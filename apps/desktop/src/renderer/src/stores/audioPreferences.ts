import { useStorage } from "@vueuse/core"
import { acceptHMRUpdate, defineStore } from "pinia"
import { ref } from "vue"
import { AUDIO_BACKENDS, DEFAULT_AUDIO_PREFERENCES } from "@yadaw/contracts"
import type {
  AudioBackend,
  AudioBackendDescriptor,
  AudioBufferSize,
  AudioDeviceDescriptor,
  AudioPreferences
} from "@yadaw/contracts"
import { useAudioRuntimeStore } from "./audioRuntime"

const STORAGE_KEY = "yadaw.audio-preferences.v1"

function isAudioBackend(value: unknown): value is AudioBackend {
  return typeof value === "string" && AUDIO_BACKENDS.includes(value as AudioBackend)
}

function isAudioBufferSize(value: unknown): value is AudioBufferSize {
  return typeof value === "number" && Number.isInteger(value) && value >= 16 && value <= 16_384
}

function normalizePreferences(value: unknown): AudioPreferences {
  if (!value || typeof value !== "object") {
    return { ...DEFAULT_AUDIO_PREFERENCES }
  }

  const candidate = value as Partial<AudioPreferences>
  if (
    isAudioBackend(candidate.backend) &&
    isAudioBufferSize(candidate.bufferSize) &&
    typeof candidate.inputDeviceId === "string" &&
    typeof candidate.outputDeviceId === "string"
  ) {
    return {
      backend: candidate.backend,
      outputDeviceId: candidate.outputDeviceId,
      inputDeviceId: candidate.inputDeviceId,
      bufferSize: candidate.bufferSize
    }
  }

  return { ...DEFAULT_AUDIO_PREFERENCES }
}

function samePreferences(left: AudioPreferences, right: AudioPreferences): boolean {
  return (
    left.backend === right.backend &&
    left.inputDeviceId === right.inputDeviceId &&
    left.outputDeviceId === right.outputDeviceId &&
    left.bufferSize === right.bufferSize
  )
}

export const useAudioPreferencesStore = defineStore("audio-preferences", () => {
  const audioRuntimeStore = useAudioRuntimeStore()
  const preferences = useStorage<AudioPreferences>(
    STORAGE_KEY,
    { ...DEFAULT_AUDIO_PREFERENCES },
    window.localStorage,
    { mergeDefaults: true }
  )
  const applyError = ref("")
  const applyNotice = ref("")
  const applying = ref(false)
  const backends = ref<AudioBackendDescriptor[]>([])
  const inputDevices = ref<AudioDeviceDescriptor[]>([])
  const outputDevices = ref<AudioDeviceDescriptor[]>([])
  const discoveryState = ref<"idle" | "loading" | "ready" | "unavailable">("idle")
  const discoveryError = ref("")
  let restoreAttempted = false
  let discoveryGeneration = 0

  preferences.value = normalizePreferences(preferences.value)

  async function apply(nextPreferences: AudioPreferences): Promise<boolean> {
    const normalized = normalizePreferences(nextPreferences)
    if (
      audioRuntimeStore.runtime.state === "running" &&
      samePreferences(normalized, preferences.value)
    ) {
      applyError.value = ""
      return true
    }

    applying.value = true
    applyError.value = ""
    applyNotice.value = ""
    try {
      const runtime = await audioRuntimeStore.startEngine(normalized)
      const actualBufferSize = runtime.outputBufferSize ?? normalized.bufferSize
      preferences.value = { ...normalized, bufferSize: actualBufferSize }
      if (runtime.bufferFallback) {
        applyNotice.value = `Buffer ${normalized.bufferSize} was unavailable; the native engine selected ${actualBufferSize} frames.`
      }
      return true
    } catch (error) {
      applyError.value =
        error instanceof Error ? error.message : "Unable to start the native audio engine."
      return false
    } finally {
      applying.value = false
    }
  }

  async function restore(): Promise<void> {
    if (restoreAttempted) return
    restoreAttempted = true
    if (!preferences.value.inputDeviceId || !preferences.value.outputDeviceId) return

    await audioRuntimeStore.refresh()
    if (audioRuntimeStore.runtime.state === "stopped") {
      await apply(preferences.value)
    }
  }

  async function discoverBackends(): Promise<AudioBackendDescriptor[]> {
    const generation = ++discoveryGeneration
    discoveryState.value = "loading"
    discoveryError.value = ""
    try {
      const result = await window.yadaw.listAudioBackends()
      if (generation !== discoveryGeneration) return backends.value
      backends.value = result
      discoveryState.value = "ready"
      return result
    } catch (error) {
      if (generation !== discoveryGeneration) return backends.value
      backends.value = []
      discoveryState.value = "unavailable"
      discoveryError.value =
        error instanceof Error ? error.message : "Unable to query cpal backends."
      return []
    }
  }

  async function discoverDevices(backend: AudioBackend): Promise<void> {
    const generation = ++discoveryGeneration
    discoveryState.value = "loading"
    discoveryError.value = ""
    try {
      const devices = await window.yadaw.listAudioDevices(backend)
      if (generation !== discoveryGeneration) return
      inputDevices.value = devices.inputs
      outputDevices.value = devices.outputs
      discoveryState.value = "ready"
    } catch (error) {
      if (generation !== discoveryGeneration) return
      inputDevices.value = []
      outputDevices.value = []
      discoveryState.value = "unavailable"
      discoveryError.value =
        error instanceof Error ? error.message : "cpal device enumeration failed."
    }
  }

  function markBackendUnavailable(message: string): void {
    discoveryGeneration += 1
    inputDevices.value = []
    outputDevices.value = []
    discoveryState.value = "unavailable"
    discoveryError.value = message
  }

  return {
    preferences,
    applyError,
    applyNotice,
    applying,
    backends,
    inputDevices,
    outputDevices,
    discoveryState,
    discoveryError,
    apply,
    restore,
    discoverBackends,
    discoverDevices,
    markBackendUnavailable
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useAudioPreferencesStore, import.meta.hot))
}
