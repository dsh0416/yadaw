<script setup lang="ts">
import { computed, onMounted, reactive, watch } from "vue"
import { storeToRefs } from "pinia"
import { RefreshCw } from "@lucide/vue"
import { UiRadioGroup, UiSelect } from "@yadaw/ui"
import type { UiRadioOption, UiSelectOption } from "@yadaw/ui"
import { AUDIO_BUFFER_SIZES } from "@yadaw/contracts"
import type {
  AudioBackend,
  AudioDeviceDescriptor,
  AudioPreferences,
  AudioRuntimeSnapshot
} from "@yadaw/contracts"
import SettingsPage from "../settings/SettingsPage.vue"
import SettingsSection from "../settings/SettingsSection.vue"
import { useAudioPreferencesStore } from "../../stores/audioPreferences"

const props = defineProps<{
  runtime: AudioRuntimeSnapshot
  applyError: string
}>()

const preferences = defineModel<AudioPreferences>({ required: true })
const emit = defineEmits<{ validityChange: [valid: boolean] }>()

const audioPreferencesStore = useAudioPreferencesStore()
const { inputDevices, outputDevices, discoveryState, discoveryError } =
  storeToRefs(audioPreferencesStore)

const backendOptions: ReadonlyArray<{
  value: AudioBackend
  label: string
  platform: string
  description: string
}> = [
  {
    value: "wasapi",
    label: "WASAPI",
    platform: "Windows",
    description: "Windows shared and exclusive audio"
  },
  {
    value: "asio",
    label: "ASIO",
    platform: "Windows",
    description: "Low-latency professional audio drivers"
  },
  {
    value: "coreaudio",
    label: "CoreAudio",
    platform: "macOS",
    description: "Native macOS audio device layer"
  },
  {
    value: "alsa",
    label: "ALSA",
    platform: "Linux",
    description: "Native Linux audio device layer"
  }
]

const backendAvailability = reactive<Record<AudioBackend, boolean>>({
  wasapi: false,
  asio: false,
  coreaudio: false,
  alsa: false
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
  backendOptions.filter((backend) => backendAvailability[backend.value])
)
const backendSelection = computed({
  get: () => backendModel.value,
  set: (value: string) => {
    backendModel.value = value as AudioBackend
  }
})
const backendUiOptions = computed<readonly UiRadioOption[]>(() =>
  availableBackendOptions.value.map((backend) => ({
    value: backend.value,
    label: `${backend.label} · ${backend.platform}`,
    description: backend.description
  }))
)
const outputDeviceOptions = computed<readonly UiSelectOption[]>(() =>
  outputDevices.value.map((device) => ({
    value: device.id,
    label: `${device.name}${device.isDefault ? " · Default" : ""}`
  }))
)
const inputDeviceOptions = computed<readonly UiSelectOption[]>(() =>
  inputDevices.value.map((device) => ({
    value: device.id,
    label: `${device.name}${device.isDefault ? " · Default" : ""}`
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
      props.runtime.inputBufferSize,
      props.runtime.outputBufferSize,
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
    label: `${size} samples`
  }))
)

const canApply = computed(
  () =>
    backendAvailability[preferences.value.backend] &&
    Boolean(preferences.value.outputDeviceId) &&
    Boolean(preferences.value.inputDeviceId)
)

function formatLatency(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(2)} ms`
}

function formatFrames(value: number | null): string {
  return value === null ? "—" : `${value} frames`
}

function preferredDeviceId(currentId: string, devices: AudioDeviceDescriptor[]): string {
  if (devices.some((device) => device.id === currentId)) return currentId
  return devices.find((device) => device.isDefault)?.id ?? devices[0]?.id ?? ""
}

async function refreshDevices(): Promise<void> {
  const backend = preferences.value.backend

  if (!backendAvailability[backend]) {
    updatePreferences({ inputDeviceId: "", outputDeviceId: "" })
    audioPreferencesStore.markBackendUnavailable(
      "This CPAL host is not available in the current native build."
    )
    return
  }

  await audioPreferencesStore.discoverDevices(backend)
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
  const backends = await audioPreferencesStore.discoverBackends()
  for (const backend of backends) backendAvailability[backend.id] = backend.available

  if (!backendAvailability[preferences.value.backend]) {
    const firstAvailable = backends.find((backend) => backend.available)
    if (!firstAvailable) {
      audioPreferencesStore.markBackendUnavailable("CPAL did not report an available audio host.")
      return
    }
    backendModel.value = firstAvailable.id
    return
  }

  await refreshDevices()
}

onMounted(() => {
  void loadBackends()
})

watch(
  () => preferences.value.backend,
  () => {
    void refreshDevices()
  }
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

watch(canApply, (valid) => emit("validityChange", valid), { immediate: true })
</script>

<template>
  <SettingsPage
    category="Audio"
    page="Devices"
    title="Devices"
    description="Choose the host API, audio devices, and real-time I/O buffer."
  >
    <SettingsSection
      title="Backend"
      description="Select the host API used by the native audio engine."
    >
      <div class="backend-grid">
        <UiRadioGroup
          v-model="backendSelection"
          label="Audio backend"
          :options="backendUiOptions"
        />
        <p v-if="availableBackendOptions.length === 0" class="backend-empty">
          {{
            discoveryState === "loading"
              ? "Scanning cpal hosts…"
              : "No CPAL audio backend is available."
          }}
        </p>
      </div>
    </SettingsSection>

    <SettingsSection
      title="Output device"
      description="Select the CPAL device used for monitoring and playback."
    >
      <button
        class="refresh-button"
        type="button"
        :disabled="discoveryState === 'loading'"
        @click="refreshDevices"
      >
        <RefreshCw :size="12" :class="{ spinning: discoveryState === 'loading' }" />
        {{ discoveryState === "loading" ? "Scanning…" : "Refresh devices" }}
      </button>
      <p v-if="discoveryError" class="discovery-error">{{ discoveryError }}</p>
      <label class="device-field">
        <span>Device</span>
        <UiSelect
          v-model="outputDeviceModel"
          :options="outputDeviceOptions"
          :placeholder="outputDevices.length ? 'Choose an output' : 'No CPAL output devices'"
          size="sm"
          aria-label="Output device"
          :disabled="discoveryState !== 'ready' || outputDevices.length === 0"
        />
      </label>
    </SettingsSection>

    <SettingsSection title="Input device" description="Select the CPAL device used for recording.">
      <label class="device-field">
        <span>Device</span>
        <UiSelect
          v-model="inputDeviceModel"
          :options="inputDeviceOptions"
          :placeholder="inputDevices.length ? 'Choose an input' : 'No CPAL input devices'"
          size="sm"
          aria-label="Input device"
          :disabled="discoveryState !== 'ready' || inputDevices.length === 0"
        />
      </label>
    </SettingsSection>

    <SettingsSection
      title="I/O buffer size"
      description="Smaller buffers reduce latency but require more CPU headroom."
    >
      <label class="buffer-field">
        <span>Samples</span>
        <UiSelect
          v-model="bufferSizeModel"
          :options="bufferSizeOptions"
          size="sm"
          aria-label="I/O buffer size"
        />
      </label>
    </SettingsSection>

    <SettingsSection
      title="Latency"
      description="Reported by the running Rust engine from CPAL timestamps and the live ring-buffer fill."
    >
      <div class="latency-grid" aria-label="Runtime latency">
        <div class="latency-card">
          <span>Output latency</span>
          <strong>{{ formatLatency(runtime.outputLatencyMs) }}</strong>
          <small>Output callback → DAC · {{ formatFrames(runtime.outputBufferSize) }}</small>
        </div>
        <div class="latency-card">
          <span>Round-trip latency</span>
          <strong>{{ formatLatency(runtime.estimatedRoundTripLatencyMs) }}</strong>
          <small>ADC → input → ring → graph → output → DAC</small>
        </div>
        <div class="latency-card">
          <span>Input latency</span>
          <strong>{{ formatLatency(runtime.inputLatencyMs) }}</strong>
          <small>ADC → input callback · {{ formatFrames(runtime.inputBufferSize) }}</small>
        </div>
        <div class="latency-card">
          <span>Ring-buffer latency</span>
          <strong>{{ formatLatency(runtime.ringBufferLatencyMs) }}</strong>
          <small>
            {{ formatFrames(runtime.ringBufferFillFrames) }} /
            {{ formatFrames(runtime.ringBufferCapacityFrames) }}
          </small>
        </div>
      </div>
    </SettingsSection>

    <p v-if="applyError" class="apply-error" role="alert">{{ applyError }}</p>
  </SettingsPage>
</template>

<style scoped>
.backend-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  gap: 8px;
}

.backend-card {
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr);
  gap: 10px;
  min-height: 76px;
  padding: 12px;
  border: 1px solid var(--line-soft);
  border-radius: 7px;
  color: var(--text-secondary);
  background: var(--surface-1);
  text-align: left;
  cursor: pointer;
}

.backend-card:hover {
  border-color: var(--line-strong);
  background: var(--surface-2);
}

.backend-card[data-state="checked"] {
  border-color: var(--accent);
  background: var(--surface-active);
  box-shadow: var(--ui-shadow-selected-edge);
}

.backend-card:focus-visible,
.refresh-button:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}

.radio-control {
  display: grid;
  place-items: center;
  width: 14px;
  height: 14px;
  margin-top: 2px;
  border: 1px solid var(--text-faint);
  border-radius: 50%;
}

.radio-indicator {
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
}

.radio-indicator span {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent-soft);
}

.backend-card-copy,
.backend-card-title {
  display: block;
  min-width: 0;
}

.backend-card-title b,
.backend-card-title small {
  display: inline;
}

.backend-card-title b {
  color: var(--text-primary);
  font-size: var(--ui-type-size-label);
}

.backend-card-title small,
.backend-card-copy em {
  color: var(--text-faint);
  font-size: var(--ui-type-size-caption);
}

.backend-card-title small {
  margin-left: 7px;
}

.backend-card-copy em {
  display: block;
  margin-top: 8px;
  font-style: normal;
  line-height: var(--ui-type-leading-compact);
}

.backend-empty {
  grid-column: 1 / -1;
  margin: 0;
  padding: 18px;
  border: 1px dashed var(--line-strong);
  border-radius: 7px;
  color: var(--text-muted);
  background: var(--surface-1);
  font-size: var(--ui-type-size-body-compact);
}

.device-field,
.buffer-field {
  display: grid;
  gap: 7px;
  color: var(--text-muted);
  font: var(--ui-type-size-caption) var(--ui-type-family-data);
  letter-spacing: var(--ui-type-tracking-wide);
  text-transform: uppercase;
}

.device-field {
  margin-top: 12px;
}

.buffer-field {
  width: min(220px, 100%);
}

.refresh-button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0;
  border: 0;
  color: var(--signal-cyan);
  background: transparent;
  cursor: pointer;
  font-size: var(--ui-type-size-control);
}

.refresh-button:disabled {
  color: var(--text-faint);
  cursor: wait;
}

.spinning {
  animation: icon-spin 800ms linear infinite;
}

.discovery-error {
  margin: 8px 0 0;
  color: var(--record);
  font-size: var(--ui-type-size-control);
  overflow-wrap: anywhere;
}

.latency-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.latency-card {
  display: grid;
  gap: 4px;
  padding: 13px;
  border: 1px solid var(--line-soft);
  border-radius: 7px;
  background: var(--surface-1);
}

.latency-card span,
.latency-card small {
  color: var(--text-faint);
  font-size: var(--ui-type-size-caption);
}

.latency-card strong {
  color: var(--signal-cyan);
  font: var(--ui-type-size-view-title) var(--ui-type-family-data);
}

.apply-error {
  margin: 12px 0 0;
  font-size: var(--ui-type-size-body-compact);
  line-height: var(--ui-type-leading-normal);
}

.apply-error {
  color: var(--record);
}

@keyframes icon-spin {
  to {
    transform: rotate(1turn);
  }
}

@media (max-width: 1120px) {
  .latency-grid {
    grid-template-columns: 1fr;
  }
}
</style>
