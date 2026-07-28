<script setup lang="ts">
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

function formatLatency(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(2)} ms`
}
function formatFrames(value: number | null): string {
  return value === null ? "—" : `${value} frames`
}
</script>

<template>
  <SettingsSection
    title="I/O buffer size"
    description="Smaller buffers reduce latency but require more CPU headroom."
  >
    <label class="buffer-field">
      <span>Samples</span>
      <UiSelect
        :model-value="bufferSize"
        :options="bufferOptions"
        size="sm"
        aria-label="I/O buffer size"
        @update:model-value="emit('update:bufferSize', $event)"
      />
    </label>
  </SettingsSection>
  <SettingsSection
    title="Latency"
    description="Reported by the running Rust engine from CPAL timestamps and the live ring-buffer fill."
  >
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
        <small>
          {{ formatFrames(runtime.ringBufferFillFrames) }} /
          {{ formatFrames(runtime.ringBufferCapacityFrames) }}
        </small>
      </div>
    </div>
  </SettingsSection>
  <SettingsSection
    title="Physical loopback"
    description="Measure actual hardware round-trip latency with a direct output-to-input cable."
  >
    <RoundTripLatencyMeasurement
      :runtime-state="runtime.state"
      :input-channel-count="inputChannelCount"
      :output-channel-count="outputChannelCount"
      :estimated-latency-ms="runtime.estimatedRoundTripLatencyMs"
    />
  </SettingsSection>
</template>
