<script setup lang="ts">
import { UiRadioGroup, type UiRadioOption } from "@yadaw/ui"
import SettingsSection from "../settings/SettingsSection.vue"

defineProps<{
  modelValue: string
  options: readonly UiRadioOption[]
  optionCount: number
  discoveryState: string
}>()
const emit = defineEmits<{ "update:modelValue": [value: string] }>()
</script>

<template>
  <SettingsSection
    title="Backend"
    description="Select the host API used by the native audio engine."
  >
    <div class="backend-grid">
      <UiRadioGroup
        :model-value="modelValue"
        label="Audio backend"
        :options="options"
        @update:model-value="emit('update:modelValue', $event)"
      />
      <p v-if="optionCount === 0" class="backend-empty">
        {{
          discoveryState === "loading"
            ? "Scanning cpal hosts…"
            : "No CPAL audio backend is available."
        }}
      </p>
    </div>
  </SettingsSection>
</template>
