<script setup lang="ts">
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import { UiRadioGroup, type UiRadioOption } from "@yadaw/ui"
import SettingsSection from "../settings/SettingsSection.vue"
import AsioConfigurationNotice from "./AsioConfigurationNotice.vue"

const props = defineProps<{
  modelValue: string
  options: readonly UiRadioOption[]
  optionCount: number
  discoveryState: string
}>()
const emit = defineEmits<{ "update:modelValue": [value: string] }>()

const { t } = useI18n()
const hasAsioOption = computed(() => props.options.some((option) => option.value === "asio"))
</script>

<template>
  <SettingsSection
    :title="t('settings.audio.backend.title')"
    :description="t('settings.audio.backend.description')"
  >
    <div class="backend-grid">
      <UiRadioGroup
        :model-value="modelValue"
        :label="t('settings.audio.backend.ariaLabel')"
        :options="options"
        @update:model-value="emit('update:modelValue', $event)"
      />
      <p v-if="optionCount === 0" class="backend-empty">
        {{
          discoveryState === "loading"
            ? t("settings.audio.backend.scanning")
            : t("settings.audio.backend.unavailable")
        }}
      </p>
    </div>
    <AsioConfigurationNotice v-if="hasAsioOption" />
  </SettingsSection>
</template>
