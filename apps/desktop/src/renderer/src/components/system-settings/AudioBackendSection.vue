<script setup lang="ts">
import { useI18n } from "vue-i18n"
import { UiRadioGroup, type UiRadioOption } from "@yadaw/ui"
import SettingsSection from "../settings/SettingsSection.vue"

defineProps<{
  modelValue: string
  options: readonly UiRadioOption[]
  optionCount: number
  discoveryState: string
}>()
const emit = defineEmits<{ "update:modelValue": [value: string] }>()

const { t } = useI18n()
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
  </SettingsSection>
</template>
