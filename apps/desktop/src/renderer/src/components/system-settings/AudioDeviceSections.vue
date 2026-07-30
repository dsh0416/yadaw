<script setup lang="ts">
import { useI18n } from "vue-i18n"
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

const { t } = useI18n()
</script>

<template>
  <SettingsSection
    :title="t('settings.audio.deviceSections.output.title')"
    :description="t('settings.audio.deviceSections.output.description')"
  >
    <button
      class="refresh-button"
      type="button"
      :disabled="discoveryState === 'loading'"
      @click="emit('refresh')"
    >
      <RefreshCw :size="12" :class="{ spinning: discoveryState === 'loading' }" />
      {{
        discoveryState === "loading"
          ? t("settings.audio.deviceSections.refresh.scanning")
          : t("settings.audio.deviceSections.refresh.refresh")
      }}
    </button>
    <p v-if="discoveryError" class="discovery-error">{{ discoveryError }}</p>
    <label class="device-field">
      <span>{{ t("common.device") }}</span>
      <UiSelect
        :model-value="outputDeviceId"
        :options="outputOptions"
        :placeholder="
          outputOptions.length
            ? t('settings.audio.deviceSections.output.placeholder')
            : t('settings.audio.deviceSections.output.emptyPlaceholder')
        "
        size="sm"
        :aria-label="t('settings.audio.deviceSections.output.ariaLabel')"
        :disabled="discoveryState !== 'ready' || outputOptions.length === 0"
        @update:model-value="emit('update:outputDeviceId', $event)"
      />
    </label>
  </SettingsSection>
  <SettingsSection
    :title="t('settings.audio.deviceSections.input.title')"
    :description="t('settings.audio.deviceSections.input.description')"
  >
    <label class="device-field">
      <span>{{ t("common.device") }}</span>
      <UiSelect
        :model-value="inputDeviceId"
        :options="inputOptions"
        :placeholder="
          inputOptions.length
            ? t('settings.audio.deviceSections.input.placeholder')
            : t('settings.audio.deviceSections.input.emptyPlaceholder')
        "
        size="sm"
        :aria-label="t('settings.audio.deviceSections.input.ariaLabel')"
        :disabled="discoveryState !== 'ready' || inputOptions.length === 0"
        @update:model-value="emit('update:inputDeviceId', $event)"
      />
    </label>
  </SettingsSection>
</template>
