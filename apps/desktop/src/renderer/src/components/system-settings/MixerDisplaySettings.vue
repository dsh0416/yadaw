<script setup lang="ts">
import { computed, onMounted } from "vue"
import { useI18n } from "vue-i18n"
import { storeToRefs } from "pinia"
import { UiSelect } from "@yadaw/ui"
import type { MeterPeakHold, MeterReturnRate } from "@yadaw/contracts"
import SettingsPage from "../settings/SettingsPage.vue"
import SettingsSection from "../settings/SettingsSection.vue"
import { useApplicationSettingsStore } from "../../stores/applicationSettings"

const { t } = useI18n()
const settingsStore = useApplicationSettingsStore()
const { settings, loading, error } = storeToRefs(settingsStore)

const peakHoldOptions = computed<ReadonlyArray<{ value: MeterPeakHold; label: string }>>(() => [
  { value: "800ms", label: t("settings.audio.mixerDisplay.peakHold.800ms") },
  { value: "2s", label: t("settings.audio.mixerDisplay.peakHold.2s") },
  { value: "4s", label: t("settings.audio.mixerDisplay.peakHold.4s") },
  { value: "infinite", label: t("settings.audio.mixerDisplay.peakHold.infinite") }
])

const returnRateOptions = computed<ReadonlyArray<{ value: MeterReturnRate; label: string }>>(() => [
  { value: "iec-type-i", label: t("settings.audio.mixerDisplay.returnRate.iecTypeI") }
])

function selectPeakHold(value: string): void {
  void settingsStore.setMeterPeakHold(value as MeterPeakHold)
}

function selectReturnRate(value: string): void {
  void settingsStore.setMeterReturnRate(value as MeterReturnRate)
}

onMounted(() => {
  if (!settings.value) void settingsStore.load()
})
</script>

<template>
  <SettingsPage
    :category="t('settings.audio.mixerDisplay.category')"
    :page="t('settings.audio.mixerDisplay.page')"
    :title="t('settings.audio.mixerDisplay.title')"
    :description="t('settings.audio.mixerDisplay.description')"
  >
    <SettingsSection
      :title="t('settings.audio.mixerDisplay.peakHold.title')"
      :description="t('settings.audio.mixerDisplay.peakHold.description')"
    >
      <label class="setting-field">
        <span>{{ t("common.duration") }}</span>
        <UiSelect
          :model-value="settings?.meterPeakHold ?? '800ms'"
          :options="peakHoldOptions"
          size="sm"
          :disabled="loading"
          :aria-label="t('settings.audio.mixerDisplay.peakHold.ariaLabel')"
          @update:model-value="selectPeakHold"
        />
      </label>
    </SettingsSection>

    <SettingsSection
      :title="t('settings.audio.mixerDisplay.returnRate.title')"
      :description="t('settings.audio.mixerDisplay.returnRate.description')"
    >
      <label class="setting-field">
        <span>{{ t("common.response") }}</span>
        <UiSelect
          :model-value="settings?.meterReturnRate ?? 'iec-type-i'"
          :options="returnRateOptions"
          size="sm"
          :disabled="loading"
          :aria-label="t('settings.audio.mixerDisplay.returnRate.ariaLabel')"
          @update:model-value="selectReturnRate"
        />
      </label>
    </SettingsSection>

    <p v-if="error" class="display-error" role="alert">{{ error }}</p>
  </SettingsPage>
</template>

<style scoped>
.setting-field {
  display: grid;
  align-content: start;
  width: min(420px, 100%);
  gap: 7px;
  color: var(--text-muted);
  font: var(--ui-type-size-caption) var(--ui-type-family-data);
  letter-spacing: var(--ui-type-tracking-wide);
}

.display-error {
  color: var(--record);
  font-size: var(--ui-type-size-body-compact);
}
</style>
