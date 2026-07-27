<script setup lang="ts">
import { onMounted } from "vue"
import { storeToRefs } from "pinia"
import { UiSelect } from "@yadaw/ui"
import type { MeterPeakHold, MeterReturnRate } from "@yadaw/contracts"
import SettingsPage from "../settings/SettingsPage.vue"
import SettingsSection from "../settings/SettingsSection.vue"
import { useApplicationSettingsStore } from "../../stores/applicationSettings"

const settingsStore = useApplicationSettingsStore()
const { settings, loading, error } = storeToRefs(settingsStore)

const peakHoldOptions: ReadonlyArray<{ value: MeterPeakHold; label: string }> = [
  { value: "800ms", label: "800 ms" },
  { value: "2s", label: "2 seconds" },
  { value: "4s", label: "4 seconds" },
  { value: "infinite", label: "Infinite" }
]

const returnRateOptions: ReadonlyArray<{ value: MeterReturnRate; label: string }> = [
  { value: "iec-type-i", label: "IEC Type I (11.8 dB/s)" }
]

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
    category="Display"
    page="Mixer"
    title="Mixer meters"
    description="Control how channel peaks remain visible and return after transients."
  >
    <SettingsSection
      title="Peak hold time"
      description="Keeps the highest level visible long enough to identify short transients."
    >
      <label class="setting-field">
        <span>Duration</span>
        <UiSelect
          :model-value="settings?.meterPeakHold ?? '800ms'"
          :options="peakHoldOptions"
          size="sm"
          :disabled="loading"
          aria-label="Mixer meter peak hold time"
          @update:model-value="selectPeakHold"
        />
      </label>
    </SettingsSection>

    <SettingsSection
      title="Return time"
      description="Sets how quickly the displayed level falls after the signal peak."
    >
      <label class="setting-field">
        <span>Response</span>
        <UiSelect
          :model-value="settings?.meterReturnRate ?? 'iec-type-i'"
          :options="returnRateOptions"
          size="sm"
          :disabled="loading"
          aria-label="Mixer meter return time"
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
