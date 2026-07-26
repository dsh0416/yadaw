<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue"
import { storeToRefs } from "pinia"
import { Check, ChevronDown, Info, RefreshCw } from "@lucide/vue"
import {
  RadioGroupIndicator,
  RadioGroupItem,
  RadioGroupRoot,
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectPortal,
  SelectRoot,
  SelectTrigger,
  SelectValue,
  SelectViewport,
  Separator
} from "reka-ui"
import { AUDIO_BUFFER_SIZES } from "@yadaw/contracts"
import type {
  AudioBackend,
  AudioDeviceDescriptor,
  AudioHostRuntimePreferences,
  AudioPreferences,
  ResolvedAudioHostRuntimePreferences,
  AudioRuntimeSnapshot
} from "@yadaw/contracts"
import PreferencesHeader from "./PreferencesHeader.vue"
import PreferencesNavigation from "./PreferencesNavigation.vue"
import DisplayPreferences from "./DisplayPreferences.vue"
import MixerDisplayPreferences from "./MixerDisplayPreferences.vue"
import RecordingPreferences from "./RecordingPreferences.vue"
import AudioEngineRuntimePreferences from "./AudioEngineRuntimePreferences.vue"
import { useAudioPreferencesStore } from "../../stores/audioPreferences"

const props = defineProps<{
  modelValue: AudioPreferences
  runtime: AudioRuntimeSnapshot
  applyError: string
  applyNotice: string
  applying: boolean
  audioHostRuntime: AudioHostRuntimePreferences
  resolvedAudioHostRuntime: ResolvedAudioHostRuntimePreferences | null
  audioHostRuntimeApplying: boolean
  audioHostRuntimeError: string
}>()
const emit = defineEmits<{
  cancel: []
  save: [preferences: AudioPreferences]
  configureRuntime: [preferences: AudioHostRuntimePreferences]
}>()
const activePage = ref<"devices" | "engine" | "recording" | "display-general" | "display-mixer">(
  "devices"
)
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

const draft = reactive<AudioPreferences>({ ...props.modelValue })
const backendAvailability = reactive<Record<AudioBackend, boolean>>({
  wasapi: false,
  asio: false,
  coreaudio: false,
  alsa: false
})
const availableBackendOptions = computed(() =>
  backendOptions.filter((backend) => backendAvailability[backend.value])
)

const selectedInputDevice = computed(() =>
  inputDevices.value.find((device) => device.id === draft.inputDeviceId)
)
const selectedOutputDevice = computed(() =>
  outputDevices.value.find((device) => device.id === draft.outputDeviceId)
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
      draft.bufferSize
    ]
      .filter((size): size is number => size !== null)
      .filter((size, index, sizes) => sizes.indexOf(size) === index)
      .sort((left, right) => left - right)
  }
  const candidates = new Set<number>([...AUDIO_BUFFER_SIZES, ...minimums, ...maximums])

  return [...candidates]
    .filter((size) => size >= minimum && size <= maximum)
    .sort((left, right) => left - right)
})

const bufferSizeModel = computed({
  get: () => String(draft.bufferSize),
  set: (value: string) => {
    const size = Number(value)
    if (supportedBufferSizes.value.includes(size)) {
      draft.bufferSize = size
    }
  }
})

function formatLatency(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(2)} ms`
}

function formatFrames(value: number | null): string {
  return value === null ? "—" : `${value} frames`
}

function preferredDeviceId(currentId: string, devices: AudioDeviceDescriptor[]): string {
  if (devices.some((device) => device.id === currentId)) {
    return currentId
  }

  return devices.find((device) => device.isDefault)?.id ?? devices[0]?.id ?? ""
}

async function refreshDevices(): Promise<void> {
  const backend = draft.backend

  if (!backendAvailability[backend]) {
    draft.inputDeviceId = ""
    draft.outputDeviceId = ""
    audioPreferencesStore.markBackendUnavailable(
      "This cpal host is not available in the current native build."
    )
    return
  }

  await audioPreferencesStore.discoverDevices(backend)
  if (backend !== draft.backend || discoveryState.value !== "ready") {
    draft.inputDeviceId = ""
    draft.outputDeviceId = ""
    return
  }
  draft.inputDeviceId = preferredDeviceId(draft.inputDeviceId, inputDevices.value)
  draft.outputDeviceId = preferredDeviceId(draft.outputDeviceId, outputDevices.value)
}

async function loadBackends(): Promise<void> {
  const backends = await audioPreferencesStore.discoverBackends()
  for (const backend of backends) {
    backendAvailability[backend.id] = backend.available
  }

  if (!backendAvailability[draft.backend]) {
    const firstAvailable = backends.find((backend) => backend.available)
    if (!firstAvailable) {
      audioPreferencesStore.markBackendUnavailable("cpal did not report an available audio host.")
      return
    }
    draft.backend = firstAvailable.id
    return
  }

  await refreshDevices()
}

function save(): void {
  emit("save", { ...draft })
}

onMounted(() => {
  void loadBackends()
})

watch(
  () => draft.backend,
  () => {
    void refreshDevices()
  }
)

watch(supportedBufferSizes, (sizes) => {
  const firstSize = sizes[0]
  if (firstSize !== undefined && !sizes.includes(draft.bufferSize)) {
    draft.bufferSize = firstSize
  }
})
</script>

<template>
  <main class="preferences-page">
    <PreferencesHeader
      :applying="applying"
      :can-save="
        backendAvailability[draft.backend] &&
        Boolean(draft.outputDeviceId) &&
        Boolean(draft.inputDeviceId)
      "
      :show-audio-apply="activePage === 'devices'"
      @cancel="emit('cancel')"
      @save="save"
    />
    <PreferencesNavigation :active-page="activePage" @select="activePage = $event" />

    <section v-if="activePage === 'devices'" class="preferences-content">
      <div class="settings-intro">
        <div>
          <span class="section-kicker">Audio <b>/</b> Devices</span>
          <h2>Devices</h2>
          <p>Choose the host API, audio devices, and real-time I/O buffer.</p>
        </div>
      </div>

      <Separator class="settings-separator" />

      <section class="settings-group">
        <div class="settings-copy">
          <h3>Backend</h3>
          <p>Select the host API used by the native audio engine.</p>
        </div>
        <RadioGroupRoot v-model="draft.backend" class="backend-grid" aria-label="Audio backend">
          <RadioGroupItem
            v-for="backend in availableBackendOptions"
            :key="backend.value"
            class="backend-card"
            :value="backend.value"
          >
            <span class="radio-control" aria-hidden="true">
              <RadioGroupIndicator class="radio-indicator"><span /></RadioGroupIndicator>
            </span>
            <span class="backend-card-copy">
              <span class="backend-card-heading">
                <span class="backend-card-title">
                  <b>{{ backend.label }}</b>
                  <small>{{ backend.platform }}</small>
                </span>
              </span>
              <em>{{ backend.description }}</em>
            </span>
          </RadioGroupItem>
          <p v-if="availableBackendOptions.length === 0" class="backend-empty">
            {{
              discoveryState === "loading"
                ? "Scanning cpal hosts…"
                : "No cpal audio backend is available."
            }}
          </p>
        </RadioGroupRoot>
      </section>

      <Separator class="settings-separator" />

      <section class="settings-group">
        <div class="settings-copy">
          <h3>Output device</h3>
          <p>Select the cpal device used for monitoring and playback.</p>
          <button
            class="refresh-button"
            :disabled="discoveryState === 'loading'"
            @click="refreshDevices"
          >
            <RefreshCw :size="12" :class="{ spinning: discoveryState === 'loading' }" />
            {{ discoveryState === "loading" ? "Scanning…" : "Refresh devices" }}
          </button>
          <p v-if="discoveryError" class="discovery-error">{{ discoveryError }}</p>
        </div>
        <label class="device-field">
          <span>Device</span>
          <SelectRoot
            v-model="draft.outputDeviceId"
            :disabled="discoveryState !== 'ready' || outputDevices.length === 0"
          >
            <SelectTrigger class="select-trigger" aria-label="Output device">
              <SelectValue
                :placeholder="outputDevices.length ? 'Choose an output' : 'No cpal output devices'"
              />
              <SelectIcon class="select-icon"><ChevronDown :size="14" /></SelectIcon>
            </SelectTrigger>
            <SelectPortal>
              <SelectContent class="select-content" position="popper" :side-offset="6">
                <SelectViewport class="select-viewport">
                  <SelectItem
                    v-for="device in outputDevices"
                    :key="device.id"
                    class="select-item"
                    :value="device.id"
                  >
                    <SelectItemIndicator class="select-item-indicator"
                      ><Check :size="13"
                    /></SelectItemIndicator>
                    <SelectItemText
                      >{{ device.name }}{{ device.isDefault ? " · Default" : "" }}</SelectItemText
                    >
                  </SelectItem>
                </SelectViewport>
              </SelectContent>
            </SelectPortal>
          </SelectRoot>
        </label>
      </section>

      <Separator class="settings-separator" />

      <section class="settings-group">
        <div class="settings-copy">
          <h3>Input device</h3>
          <p>Select the cpal device used for recording.</p>
        </div>
        <label class="device-field">
          <span>Device</span>
          <SelectRoot
            v-model="draft.inputDeviceId"
            :disabled="discoveryState !== 'ready' || inputDevices.length === 0"
          >
            <SelectTrigger class="select-trigger" aria-label="Input device">
              <SelectValue
                :placeholder="inputDevices.length ? 'Choose an input' : 'No cpal input devices'"
              />
              <SelectIcon class="select-icon"><ChevronDown :size="14" /></SelectIcon>
            </SelectTrigger>
            <SelectPortal>
              <SelectContent class="select-content" position="popper" :side-offset="6">
                <SelectViewport class="select-viewport">
                  <SelectItem
                    v-for="device in inputDevices"
                    :key="device.id"
                    class="select-item"
                    :value="device.id"
                  >
                    <SelectItemIndicator class="select-item-indicator"
                      ><Check :size="13"
                    /></SelectItemIndicator>
                    <SelectItemText
                      >{{ device.name }}{{ device.isDefault ? " · Default" : "" }}</SelectItemText
                    >
                  </SelectItem>
                </SelectViewport>
              </SelectContent>
            </SelectPortal>
          </SelectRoot>
        </label>
      </section>

      <Separator class="settings-separator" />

      <section class="settings-group">
        <div class="settings-copy">
          <h3>I/O buffer size</h3>
          <p>Smaller buffers reduce latency but require more CPU headroom.</p>
        </div>
        <label class="buffer-field">
          <span>Samples</span>
          <SelectRoot v-model="bufferSizeModel">
            <SelectTrigger class="select-trigger" aria-label="I/O buffer size">
              <SelectValue />
              <SelectIcon class="select-icon"><ChevronDown :size="14" /></SelectIcon>
            </SelectTrigger>
            <SelectPortal>
              <SelectContent class="select-content" position="popper" :side-offset="6">
                <SelectViewport class="select-viewport">
                  <SelectItem
                    v-for="size in supportedBufferSizes"
                    :key="size"
                    class="select-item"
                    :value="String(size)"
                  >
                    <SelectItemIndicator class="select-item-indicator"
                      ><Check :size="13"
                    /></SelectItemIndicator>
                    <SelectItemText>{{ size }} samples</SelectItemText>
                  </SelectItem>
                </SelectViewport>
              </SelectContent>
            </SelectPortal>
          </SelectRoot>
        </label>
      </section>

      <Separator class="settings-separator" />

      <section class="settings-group">
        <div class="settings-copy">
          <h3>Latency</h3>
          <p>
            Reported by the running Rust engine from CPAL timestamps and the live ring-buffer fill.
          </p>
        </div>
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
            <small
              >{{ formatFrames(runtime.ringBufferFillFrames) }} /
              {{ formatFrames(runtime.ringBufferCapacityFrames) }}</small
            >
          </div>
        </div>
      </section>

      <div class="binding-note">
        <span><Info :size="13" /></span>
        <p>
          <b>{{
            runtime.state === "running"
              ? "Native streams are running."
              : "Apply settings to open native streams."
          }}</b>
          Audio callbacks and the SPSC ring buffer stay entirely inside Rust. UI polling only reads
          an atomic snapshot.
          <template v-if="runtime.clockSync === 'adaptive-resampled'">
            Input {{ runtime.inputSampleRate?.toLocaleString() }} Hz is adaptively resampled to the
            {{ runtime.sampleRate?.toLocaleString() }} Hz engine/output clock.
          </template>
          <template v-if="runtime.xruns > 0"> XRuns: {{ runtime.xruns }}.</template>
        </p>
      </div>
      <p v-if="applyError" class="apply-error">{{ applyError }}</p>
      <p v-if="applyNotice" class="apply-notice">{{ applyNotice }}</p>
    </section>
    <AudioEngineRuntimePreferences
      v-else-if="activePage === 'engine'"
      :model-value="audioHostRuntime"
      :resolved="resolvedAudioHostRuntime"
      :applying="audioHostRuntimeApplying"
      :error="audioHostRuntimeError"
      @apply="emit('configureRuntime', $event)"
    />
    <RecordingPreferences v-else-if="activePage === 'recording'" />
    <DisplayPreferences v-else-if="activePage === 'display-general'" />
    <MixerDisplayPreferences v-else />
  </main>
</template>

<style scoped>
.preferences-page {
  display: grid;
  grid-template: 76px 1fr / 188px 202px minmax(0, 1fr);
  width: 100vw;
  height: 100vh;
  color: #e5e9ef;
  background: #0c1015;
}
.preferences-header {
  grid-column: 1 / -1;
  display: grid;
  grid-template-columns: 40px 1fr auto;
  align-items: center;
  gap: 14px;
  padding: 0 24px;
  border-bottom: 1px solid #252b34;
  background: #12171e;
  -webkit-app-region: drag;
}
.preferences-header button {
  -webkit-app-region: no-drag;
}
.back-button {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  padding: 0;
  border: 1px solid #303844;
  border-radius: 9px;
  color: #aeb7c3;
  background: #1a2029;
  cursor: pointer;
}
.preferences-eyebrow {
  color: #5ed9ad;
  font-size: 8px;
  font-weight: 800;
  letter-spacing: 0.2em;
}
.preferences-header h1 {
  margin: 3px 0 0;
  font-size: 14px;
  font-weight: 650;
}
.preferences-actions {
  display: flex;
  gap: 8px;
}
.secondary-button,
.save-button {
  padding: 9px 14px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 10px;
}
.secondary-button {
  border: 1px solid #343c47;
  color: #aab3bf;
  background: #181e26;
}
.save-button {
  border: 1px solid #4dc499;
  color: #bff6e1;
  background: #1b513f;
}
.save-button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.preferences-primary-sidebar {
  position: relative;
  min-width: 0;
  padding: 28px 12px;
  border-right: 1px solid #242a33;
  background: #0f141a;
}
.preferences-secondary-sidebar {
  min-width: 0;
  padding: 28px 12px;
  border-right: 1px solid #242a33;
  background: #12171e;
}
.sidebar-label {
  margin: 0 10px 10px;
  color: #5e6876;
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.14em;
}
.settings-primary-nav,
.settings-secondary-nav {
  display: grid;
  gap: 4px;
}
.settings-nav-item {
  display: flex;
  align-items: center;
  width: 100%;
  gap: 10px;
  padding: 10px;
  border: 0;
  border-radius: 8px;
  color: #77818f;
  background: transparent;
  text-align: left;
  font-size: 11px;
}
.settings-nav-item.active {
  color: #a9f2d6;
  background: #192a27;
}
.settings-nav-item:disabled {
  opacity: 0.48;
}
.settings-nav-item > svg {
  flex: none;
  width: 16px;
}
.sidebar-version {
  position: absolute;
  right: 22px;
  bottom: 20px;
  left: 22px;
  color: #47515e;
  font:
    8px ui-monospace,
    monospace;
}
.secondary-sidebar-heading {
  margin: 0 10px 18px;
}
.secondary-sidebar-heading span,
.secondary-sidebar-heading strong {
  display: block;
}
.secondary-sidebar-heading span {
  color: #586371;
  font-size: 8px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.14em;
}
.secondary-sidebar-heading strong {
  margin-top: 6px;
  color: #dce2e9;
  font-size: 15px;
}
.settings-page-item {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr);
  width: 100%;
  gap: 8px;
  padding: 10px;
  border: 1px solid transparent;
  border-radius: 8px;
  color: #77818f;
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.settings-page-icon {
  margin-top: 1px;
}
.settings-page-copy,
.settings-page-copy span,
.settings-page-item small {
  display: block;
  min-width: 0;
  overflow-wrap: anywhere;
}
.settings-page-copy span {
  font-size: 10px;
  font-weight: 650;
}
.settings-page-item small {
  margin-top: 4px;
  color: #5f6a78;
  font-size: 8px;
  line-height: 1.4;
}
.settings-page-item.active {
  border-color: #30443e;
  color: #adf0d7;
  background: #18241f;
}
.settings-page-item.active small {
  color: #738b82;
}
.settings-page-item:focus-visible {
  outline: 2px solid #58d6aa;
  outline-offset: 1px;
}
.preferences-content {
  min-width: 0;
  overflow: auto;
  padding: 44px clamp(32px, 5vw, 76px) 64px;
}
.settings-intro {
  max-width: 920px;
}
.section-kicker {
  color: #58d3a6;
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.14em;
}
.section-kicker b {
  margin: 0 5px;
  color: #46525f;
  font-weight: 500;
}
.settings-intro h2 {
  margin: 8px 0 7px;
  font-size: 28px;
  font-weight: 620;
  letter-spacing: -0.03em;
}
.settings-intro p,
.settings-copy p {
  margin: 0;
  color: #727d8b;
  font-size: 11px;
  line-height: 1.55;
}
.settings-separator {
  max-width: 920px;
  height: 1px;
  margin: 30px 0;
  background: #252c35;
}
.settings-group {
  display: grid;
  grid-template-columns: minmax(180px, 260px) minmax(420px, 1fr);
  max-width: 920px;
  gap: 54px;
  align-items: start;
}
.settings-copy h3 {
  margin: 0 0 7px;
  font-size: 12px;
}
.backend-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 10px;
}
.backend-card {
  display: grid;
  grid-template-columns: 16px 1fr;
  gap: 10px;
  min-height: 82px;
  padding: 13px;
  border: 1px solid #2b333e;
  border-radius: 10px;
  color: #a9b2bf;
  background: #121820;
  text-align: left;
  cursor: pointer;
}
.backend-card:hover {
  border-color: #3a4653;
  background: #151d25;
}
.backend-card[data-state="checked"] {
  border-color: #4ab88f;
  background: #172a25;
  box-shadow: inset 0 0 0 1px #4ab88f44;
}
.backend-card:focus-visible {
  outline: 2px solid #58d6aa;
  outline-offset: 2px;
}
.radio-control {
  display: grid;
  place-items: center;
  width: 14px;
  height: 14px;
  margin-top: 2px;
  border: 1px solid #56616f;
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
  background: #6ce0b6;
}
.backend-card-copy {
  display: block;
  min-width: 0;
}
.backend-card-heading {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: 8px;
}
.backend-card-title {
  display: flex;
  align-items: baseline;
  min-width: 0;
  gap: 7px;
}
.backend-card-copy b {
  font-size: 11px;
}
.backend-card-copy small {
  color: #657180;
  font-size: 8px;
}
.backend-card-copy em {
  display: block;
  margin-top: 8px;
  color: #6d7886;
  font-size: 9px;
  font-style: normal;
  line-height: 1.4;
}
.backend-empty {
  grid-column: 1 / -1;
  margin: 0;
  padding: 18px;
  border: 1px dashed #303844;
  border-radius: 10px;
  color: #687483;
  background: #11171e;
  font-size: 10px;
}
.device-field,
.buffer-field {
  display: grid;
  gap: 7px;
  color: #8d98a6;
  font-size: 9px;
}
.select-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  min-height: 38px;
  padding: 0 12px;
  border: 1px solid #303844;
  border-radius: 8px;
  color: #c9d0d9;
  background: #141a22;
  cursor: pointer;
  font-size: 10px;
}
.select-trigger:hover {
  border-color: #414c59;
}
.select-trigger:focus-visible {
  outline: 2px solid #58d6aa;
  outline-offset: 2px;
}
.select-icon {
  color: #687483;
}
.refresh-button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-top: 12px;
  padding: 0;
  border: 0;
  color: #6fdbb2;
  background: transparent;
  cursor: pointer;
  font-size: 9px;
}
.refresh-button:disabled {
  color: #5f6976;
  cursor: wait;
}
.refresh-button .spinning {
  animation: icon-spin 800ms linear infinite;
}
.discovery-error {
  margin-top: 8px !important;
  color: #d98d83 !important;
  font-size: 9px !important;
  overflow-wrap: anywhere;
}
.buffer-field {
  width: 220px;
}
.latency-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.latency-card {
  display: grid;
  gap: 5px;
  padding: 14px;
  border: 1px solid #29313b;
  border-radius: 10px;
  background: #11171e;
}
.latency-card span,
.latency-card small {
  color: #697584;
  font-size: 8px;
}
.latency-card strong {
  color: #8ee9c7;
  font:
    16px ui-monospace,
    monospace;
}
.apply-error {
  max-width: 920px;
  margin: 12px 0 0;
  color: #ff9b9b;
  font-size: 10px;
  line-height: 1.5;
}
.apply-notice {
  max-width: 920px;
  margin: 12px 0 0;
  color: #8ee9c7;
  font-size: 10px;
  line-height: 1.5;
}
.binding-note {
  display: grid;
  grid-template-columns: 24px 1fr;
  max-width: 920px;
  gap: 10px;
  margin-top: 34px;
  padding: 12px;
  border: 1px solid #2e3942;
  border-radius: 9px;
  color: #7e8997;
  background: #121a21;
  font-size: 9px;
}
.binding-note > span {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  color: #80dfbc;
  background: #1b3c33;
  font-weight: 700;
}
.binding-note p {
  margin: 2px 0 0;
  line-height: 1.5;
}
.binding-note b {
  color: #aeb8c4;
}
@keyframes icon-spin {
  to {
    transform: rotate(1turn);
  }
}
@media (max-width: 1120px) {
  .preferences-page {
    grid-template-columns: 164px 184px minmax(0, 1fr);
  }
  .preferences-content {
    padding-right: 30px;
    padding-left: 30px;
  }
  .settings-group {
    grid-template-columns: 1fr;
    gap: 20px;
  }
}

/* Signal-console refinement: the form stays quiet so device state and latency read first. */
.preferences-page {
  grid-template: 60px 1fr/174px 194px minmax(0, 1fr);
  color: var(--text-primary);
  background: var(--canvas);
}
.preferences-content {
  padding: 38px clamp(30px, 4.5vw, 68px) 60px;
  background: radial-gradient(circle at 72% 0, #25234b24, transparent 32%), var(--canvas);
}
.settings-intro {
  max-width: 900px;
}
.section-kicker {
  color: var(--accent);
  font: 700 7px var(--font-utility);
  letter-spacing: 0.17em;
}
.section-kicker b {
  color: #465267;
}
.settings-intro h2 {
  margin: 8px 0 6px;
  font-family: var(--font-display);
  font-size: 27px;
  font-weight: 560;
  letter-spacing: -0.015em;
}
.settings-intro p,
.settings-copy p {
  color: var(--text-muted);
  font-size: 9px;
  line-height: 1.55;
}
.settings-separator {
  max-width: 900px;
  margin: 25px 0;
  background: var(--line-soft);
}
.settings-group {
  grid-template-columns: minmax(170px, 230px) minmax(390px, 1fr);
  max-width: 900px;
  gap: 48px;
}
.settings-copy h3 {
  margin-bottom: 6px;
  font-family: var(--font-display);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.01em;
}
.backend-grid {
  gap: 8px;
}
.backend-card {
  min-height: 76px;
  padding: 12px;
  border-color: var(--line-soft);
  border-radius: 7px;
  color: var(--text-secondary);
  background: #111722;
  box-shadow: 0 1px 0 #ffffff04 inset;
}
.backend-card:hover {
  border-color: #465168;
  background: #151d29;
}
.backend-card[data-state="checked"] {
  border-color: #7c74d8;
  background: linear-gradient(135deg, #232142, #192238);
  box-shadow:
    2px 0 0 var(--accent) inset,
    0 0 18px #756dd51a;
}
.backend-card:focus-visible {
  outline-color: var(--focus);
}
.radio-control {
  border-color: #5b6680;
}
.radio-indicator span {
  background: var(--accent-soft);
  box-shadow: 0 0 7px var(--accent);
}
.backend-card-copy b {
  color: #d8dbea;
  font-size: 10px;
}
.backend-card-copy small,
.backend-card-copy em {
  color: var(--text-faint);
  font-size: 7px;
}
.backend-empty {
  border-color: var(--line-strong);
  border-radius: 7px;
  color: var(--text-muted);
  background: #101620;
  font-size: 9px;
}
.device-field,
.buffer-field {
  gap: 7px;
  color: var(--text-muted);
  font: 7px var(--font-utility);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.select-trigger {
  min-height: 36px;
  border-color: var(--line-strong);
  border-radius: 7px;
  color: #d5d9e4;
  background: #121925;
  font-size: 9px;
  text-transform: none;
  letter-spacing: 0;
}
.select-trigger:hover {
  border-color: #56627a;
}
.select-trigger:focus-visible {
  outline-color: var(--focus);
}
.select-icon {
  color: #707c91;
}
.refresh-button {
  color: var(--signal-cyan);
  font-size: 8px;
}
.refresh-button:disabled {
  color: var(--text-faint);
}
.discovery-error {
  color: #ef93a0 !important;
  font-size: 8px !important;
}
.latency-grid {
  gap: 8px;
}
.latency-card {
  position: relative;
  gap: 4px;
  padding: 13px;
  border-color: var(--line-soft);
  border-radius: 7px;
  background: linear-gradient(145deg, #111722, #0e141e);
  overflow: hidden;
}
.latency-card::before {
  content: "";
  position: absolute;
  top: 0;
  right: 0;
  left: 0;
  height: 2px;
  background: linear-gradient(90deg, var(--accent), var(--signal-cyan));
  opacity: 0.65;
}
.latency-card span,
.latency-card small {
  color: var(--text-faint);
  font-size: 7px;
}
.latency-card strong {
  color: #b9eaf0;
  font: 15px var(--font-utility);
  text-shadow: 0 0 14px #67d9e733;
}
.binding-note {
  max-width: 900px;
  margin-top: 30px;
  border-color: #303951;
  border-radius: 7px;
  color: var(--text-muted);
  background: #121826;
  font-size: 8px;
}
.binding-note > span {
  border-radius: 5px;
  color: var(--accent-soft);
  background: #28264b;
}
.binding-note b {
  color: var(--text-secondary);
}
.apply-error {
  color: #ff9dab;
}
.apply-notice {
  color: var(--signal-cyan);
}
@media (max-width: 1120px) {
  .preferences-page {
    grid-template-columns: 150px 174px minmax(0, 1fr);
  }
  .settings-group {
    grid-template-columns: 1fr;
    gap: 17px;
  }
}
</style>

<style>
.select-content {
  z-index: 100;
  min-width: var(--reka-select-trigger-width);
  overflow: hidden;
  border: 1px solid #343d49;
  border-radius: 9px;
  color: #c7ced8;
  background: #171d25;
  box-shadow: 0 14px 40px #000a;
}
.select-viewport {
  padding: 5px;
}
.select-item {
  position: relative;
  display: flex;
  align-items: center;
  min-height: 32px;
  padding: 0 30px 0 28px;
  border-radius: 6px;
  outline: none;
  cursor: pointer;
  font-size: 10px;
  user-select: none;
}
.select-item[data-highlighted] {
  color: #c8f7e5;
  background: #21453a;
}
.select-item-indicator {
  position: absolute;
  left: 9px;
  color: #67dbaa;
}
.select-content {
  border-color: var(--line-strong);
  border-radius: 7px;
  color: #d6dae4;
  background: #161d29;
}
.select-item {
  border-radius: 5px;
  font-size: 9px;
}
.select-item[data-highlighted] {
  color: #eeedff;
  background: #2b2852;
}
.select-item-indicator {
  color: var(--accent-soft);
}
</style>
