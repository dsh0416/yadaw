<script setup lang="ts">
import { useI18n } from "vue-i18n"
import type { AudioPreferences, AudioRuntimeSnapshot } from "@yadaw/contracts"
import SettingsPage from "../settings/SettingsPage.vue"
import AudioBackendSection from "./AudioBackendSection.vue"
import AudioBufferLatencySections from "./AudioBufferLatencySections.vue"
import AudioDeviceSections from "./AudioDeviceSections.vue"
import { useAudioDeviceOptions } from "./useAudioDeviceOptions"

const { t } = useI18n()

const props = defineProps<{
  runtime: AudioRuntimeSnapshot
  applyError: string
}>()
const preferences = defineModel<AudioPreferences>({ required: true })
const emit = defineEmits<{ validityChange: [valid: boolean] }>()

const {
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
} = useAudioDeviceOptions(
  preferences,
  () => props.runtime,
  (valid) => emit("validityChange", valid)
)
</script>

<template>
  <SettingsPage
    :category="t('settings.audio.devices.category')"
    :page="t('settings.audio.devices.page')"
    :title="t('settings.audio.devices.title')"
    :description="t('settings.audio.devices.description')"
  >
    <AudioBackendSection
      v-model="backendSelection"
      :options="backendUiOptions"
      :option-count="availableBackendOptions.length"
      :discovery-state="discoveryState"
    />
    <AudioDeviceSections
      v-model:output-device-id="outputDeviceModel"
      v-model:input-device-id="inputDeviceModel"
      :output-options="outputDeviceOptions"
      :input-options="inputDeviceOptions"
      :discovery-state="discoveryState"
      :discovery-error="discoveryError"
      @refresh="refreshDevices"
    />
    <AudioBufferLatencySections
      v-model:buffer-size="bufferSizeModel"
      :buffer-options="bufferSizeOptions"
      :runtime="runtime"
      :input-channel-count="selectedInputDevice?.channelCount ?? 0"
      :output-channel-count="selectedOutputDevice?.channelCount ?? 0"
    />
    <p v-if="applyError" class="apply-error" role="alert">{{ applyError }}</p>
  </SettingsPage>
</template>

<style>
.backend-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  gap: 8px;
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
.refresh-button:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
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
  color: var(--record);
  font-size: var(--ui-type-size-body-compact);
  line-height: var(--ui-type-leading-normal);
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
