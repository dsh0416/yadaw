import { computed, onMounted, reactive, watch, type Ref } from "vue"
import { useI18n } from "vue-i18n"
import { storeToRefs } from "pinia"
import { AUDIO_BUFFER_SIZES } from "@yadaw/contracts"
import type {
  AudioBackend,
  AudioDeviceDescriptor,
  AudioPreferences,
  AudioRuntimeSnapshot
} from "@yadaw/contracts"
import type { UiRadioOption, UiSelectOption } from "@yadaw/ui"
import { useAudioPreferencesStore } from "../../stores/audioPreferences"

const BACKEND_IDS: readonly AudioBackend[] = ["wasapi", "asio", "coreaudio", "alsa", "mock"]

export function useAudioDeviceOptions(
  preferences: Ref<AudioPreferences>,
  runtime: () => AudioRuntimeSnapshot,
  validityChange: (valid: boolean) => void
) {
  const { t } = useI18n()
  const store = useAudioPreferencesStore()
  const { inputDevices, outputDevices, discoveryState, discoveryError } = storeToRefs(store)
  const backendAvailability = reactive<Record<AudioBackend, boolean>>({
    wasapi: false,
    asio: false,
    coreaudio: false,
    alsa: false,
    mock: false
  })
  function updatePreferences(patch: Partial<AudioPreferences>): void {
    preferences.value = { ...preferences.value, ...patch }
  }
  const backendModel = computed({
    get: () => preferences.value.backend,
    set: (backend: AudioBackend) => updatePreferences({ backend })
  })
  const outputDeviceModel = computed({
    get: () => preferences.value.outputDeviceId,
    set: (outputDeviceId: string) => updatePreferences({ outputDeviceId })
  })
  const inputDeviceModel = computed({
    get: () => preferences.value.inputDeviceId,
    set: (inputDeviceId: string) => updatePreferences({ inputDeviceId })
  })
  const availableBackendOptions = computed(() =>
    BACKEND_IDS.filter((backend) => backendAvailability[backend])
  )
  const backendSelection = computed({
    get: () => backendModel.value,
    set: (value: string) => {
      backendModel.value = value as AudioBackend
    }
  })
  const backendUiOptions = computed<readonly UiRadioOption[]>(() =>
    availableBackendOptions.value.map((backend) => ({
      value: backend,
      label: `${t(`settings.backends.${backend}.label`)} · ${t(`settings.backends.${backend}.platform`)}`,
      description: t(`settings.backends.${backend}.description`)
    }))
  )
  const outputDeviceOptions = computed<readonly UiSelectOption[]>(() =>
    outputDevices.value.map((device) => ({
      value: device.id,
      label: `${device.name}${device.isDefault ? ` · ${t("common.default")}` : ""}`
    }))
  )
  const inputDeviceOptions = computed<readonly UiSelectOption[]>(() =>
    inputDevices.value.map((device) => ({
      value: device.id,
      label: `${device.name}${device.isDefault ? ` · ${t("common.default")}` : ""}`
    }))
  )
  const selectedInputDevice = computed(() =>
    inputDevices.value.find((device) => device.id === preferences.value.inputDeviceId)
  )
  const selectedOutputDevice = computed(() =>
    outputDevices.value.find((device) => device.id === preferences.value.outputDeviceId)
  )
  const supportedBufferSizes = computed(() => {
    const devices = [selectedInputDevice.value, selectedOutputDevice.value].filter(
      (device): device is AudioDeviceDescriptor => device !== undefined
    )
    const minimums = devices
      .map((device) => device.minBufferSize)
      .filter((value): value is number => value !== null)
    const maximums = devices
      .map((device) => device.maxBufferSize)
      .filter((value): value is number => value !== null)
    const minimum = minimums.length ? Math.max(...minimums) : 16
    const maximum = maximums.length ? Math.min(...maximums) : 16_384
    if (minimum > maximum) {
      return [
        ...minimums,
        ...maximums,
        runtime().inputBufferSize,
        runtime().outputBufferSize,
        preferences.value.bufferSize
      ]
        .filter((size): size is number => size !== null)
        .filter((size, index, sizes) => sizes.indexOf(size) === index)
        .sort((left, right) => left - right)
    }
    return [...new Set<number>([...AUDIO_BUFFER_SIZES, ...minimums, ...maximums])]
      .filter((size) => size >= minimum && size <= maximum)
      .sort((left, right) => left - right)
  })
  const bufferSizeModel = computed({
    get: () => String(preferences.value.bufferSize),
    set: (value: string) => {
      const bufferSize = Number(value)
      if (supportedBufferSizes.value.includes(bufferSize)) updatePreferences({ bufferSize })
    }
  })
  const bufferSizeOptions = computed<readonly UiSelectOption[]>(() =>
    supportedBufferSizes.value.map((size) => ({
      value: String(size),
      label: t("settings.audio.buffer.optionLabel", { size })
    }))
  )
  const canApply = computed(
    () =>
      backendAvailability[preferences.value.backend] &&
      Boolean(preferences.value.outputDeviceId) &&
      Boolean(preferences.value.inputDeviceId)
  )
  function preferredDeviceId(currentId: string, devices: AudioDeviceDescriptor[]): string {
    if (devices.some((device) => device.id === currentId)) return currentId
    return devices.find((device) => device.isDefault)?.id ?? devices[0]?.id ?? ""
  }
  async function refreshDevices(): Promise<void> {
    const backend = preferences.value.backend
    if (!backendAvailability[backend]) {
      updatePreferences({ inputDeviceId: "", outputDeviceId: "" })
      store.markBackendUnavailable(t("settings.audio.backend.hostUnavailable"))
      return
    }
    await store.discoverDevices(backend)
    if (backend !== preferences.value.backend || discoveryState.value !== "ready") {
      updatePreferences({ inputDeviceId: "", outputDeviceId: "" })
      return
    }
    updatePreferences({
      inputDeviceId: preferredDeviceId(preferences.value.inputDeviceId, inputDevices.value),
      outputDeviceId: preferredDeviceId(preferences.value.outputDeviceId, outputDevices.value)
    })
  }
  async function loadBackends(): Promise<void> {
    const backends = await store.discoverBackends()
    for (const backend of backends) backendAvailability[backend.id] = backend.available
    if (!backendAvailability[preferences.value.backend]) {
      const firstAvailable = backends.find((backend) => backend.available)
      if (!firstAvailable) {
        store.markBackendUnavailable(t("settings.audio.backend.noHostReported"))
        return
      }
      backendModel.value = firstAvailable.id
      return
    }
    await refreshDevices()
  }
  onMounted(() => void loadBackends())
  watch(
    () => preferences.value.backend,
    () => void refreshDevices()
  )
  watch(
    supportedBufferSizes,
    (sizes) => {
      const firstSize = sizes[0]
      if (firstSize !== undefined && !sizes.includes(preferences.value.bufferSize)) {
        updatePreferences({ bufferSize: firstSize })
      }
    },
    { immediate: true }
  )
  watch(canApply, validityChange, { immediate: true })

  return {
    inputDevices,
    outputDevices,
    discoveryState,
    discoveryError,
    availableBackendOptions,
    backendSelection,
    backendUiOptions,
    outputDeviceModel,
    inputDeviceModel,
    outputDeviceOptions,
    inputDeviceOptions,
    selectedInputDevice,
    selectedOutputDevice,
    bufferSizeModel,
    bufferSizeOptions,
    refreshDevices
  }
}
