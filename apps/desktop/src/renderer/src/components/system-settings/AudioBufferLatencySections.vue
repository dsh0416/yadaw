<script setup lang="ts">
import { useI18n } from "vue-i18n"
import type { AudioRuntimeSnapshot } from "@yadaw/contracts"
import { UiSelect, type UiSelectOption } from "@yadaw/ui"
import SettingsSection from "../settings/SettingsSection.vue"
import RoundTripLatencyMeasurement from "./RoundTripLatencyMeasurement.vue"

defineProps<{
  bufferSize: string
  bufferOptions: readonly UiSelectOption[]
  runtime: AudioRuntimeSnapshot
  inputChannelCount: number
  outputChannelCount: number
}>()
const emit = defineEmits<{ "update:bufferSize": [value: string] }>()

const { t } = useI18n()

function formatLatency(value: number | null): string {
  return value === null ? t("common.notAvailable") : t("common.milliseconds", { value: value.toFixed(2) })
}
function formatFrames(value: number | null): string {
  return value === null ? t("common.notAvailable") : t("common.frames", { count: value })
}
</script>

<template>
  <SettingsSection
    :title="t('settings.audio.buffer.title')"
    :description="t('settings.audio.buffer.description')"
  >
    <label class="buffer-field">
      <span>{{ t("settings.audio.buffer.samplesLabel") }}</span>
      <UiSelect
        :model-value="bufferSize"
        :options="bufferOptions"
        size="sm"
        :aria-label="t('settings.audio.buffer.ariaLabel')"
        @update:model-value="emit('update:bufferSize', $event)"
      />
    </label>
  </SettingsSection>
  <SettingsSection
    :title="t('settings.audio.latency.title')"
    :description="t('settings.audio.latency.description')"
  >
    <div class="latency-grid" :aria-label="t('settings.audio.latency.ariaLabel')">
      <div class="latency-card">
        <span>{{ t("settings.audio.latency.output.label") }}</span>
        <strong>{{ formatLatency(runtime.outputLatencyMs) }}</strong>
        <small>{{
          t("settings.audio.latency.output.detail", { frames: formatFrames(runtime.outputBufferSize) })
        }}</small>
      </div>
      <div class="latency-card">
        <span>{{ t("settings.audio.latency.roundTrip.label") }}</span>
        <strong>{{ formatLatency(runtime.estimatedRoundTripLatencyMs) }}</strong>
        <small>{{ t("settings.audio.latency.roundTrip.detail") }}</small>
      </div>
      <div class="latency-card">
        <span>{{ t("settings.audio.latency.input.label") }}</span>
        <strong>{{ formatLatency(runtime.inputLatencyMs) }}</strong>
        <small>{{
          t("settings.audio.latency.input.detail", { frames: formatFrames(runtime.inputBufferSize) })
        }}</small>
      </div>
      <div class="latency-card">
        <span>{{ t("settings.audio.latency.ringBuffer.label") }}</span>
        <strong>{{ formatLatency(runtime.ringBufferLatencyMs) }}</strong>
        <small>
          {{ formatFrames(runtime.ringBufferFillFrames) }} /
          {{ formatFrames(runtime.ringBufferCapacityFrames) }}
        </small>
      </div>
    </div>
  </SettingsSection>
  <SettingsSection
    :title="t('settings.audio.latency.loopbackSection.title')"
    :description="t('settings.audio.latency.loopbackSection.description')"
  >
    <RoundTripLatencyMeasurement
      :runtime-state="runtime.state"
      :input-channel-count="inputChannelCount"
      :output-channel-count="outputChannelCount"
      :estimated-latency-ms="runtime.estimatedRoundTripLatencyMs"
    />
  </SettingsSection>
</template>
