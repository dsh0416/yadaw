<script setup lang="ts">
import { RefreshCw } from "@lucide/vue"
import { UiSelect, type UiSelectOption } from "@yadaw/ui"
import SettingsSection from "../settings/SettingsSection.vue"

defineProps<{
  outputDeviceId: string
  inputDeviceId: string
  outputOptions: readonly UiSelectOption[]
  inputOptions: readonly UiSelectOption[]
  discoveryState: string
  discoveryError: string
}>()
const emit = defineEmits<{
  "update:outputDeviceId": [value: string]
  "update:inputDeviceId": [value: string]
  refresh: []
}>()
</script>

<template>
  <SettingsSection
    title="Output device"
    description="Select the CPAL device used for monitoring and playback."
  >
    <button
      class="refresh-button"
      type="button"
      :disabled="discoveryState === 'loading'"
      @click="emit('refresh')"
    >
      <RefreshCw :size="12" :class="{ spinning: discoveryState === 'loading' }" />
      {{ discoveryState === "loading" ? "Scanning…" : "Refresh devices" }}
    </button>
    <p v-if="discoveryError" class="discovery-error">{{ discoveryError }}</p>
    <label class="device-field">
      <span>Device</span>
      <UiSelect
        :model-value="outputDeviceId"
        :options="outputOptions"
        :placeholder="outputOptions.length ? 'Choose an output' : 'No CPAL output devices'"
        size="sm"
        aria-label="Output device"
        :disabled="discoveryState !== 'ready' || outputOptions.length === 0"
        @update:model-value="emit('update:outputDeviceId', $event)"
      />
    </label>
  </SettingsSection>
  <SettingsSection title="Input device" description="Select the CPAL device used for recording.">
    <label class="device-field">
      <span>Device</span>
      <UiSelect
        :model-value="inputDeviceId"
        :options="inputOptions"
        :placeholder="inputOptions.length ? 'Choose an input' : 'No CPAL input devices'"
        size="sm"
        aria-label="Input device"
        :disabled="discoveryState !== 'ready' || inputOptions.length === 0"
        @update:model-value="emit('update:inputDeviceId', $event)"
      />
    </label>
  </SettingsSection>
</template>
