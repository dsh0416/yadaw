<script setup lang="ts">
import { Radio } from "@lucide/vue"
import { useI18n } from "vue-i18n"
import type { AudioRuntimeSnapshot } from "@yadaw/contracts"
import type { AudioTelemetryStatistics } from "../../stores/audioRuntime"

defineProps<{
  runtime: AudioRuntimeSnapshot
  statistics: AudioTelemetryStatistics
}>()
const { t } = useI18n()
function formatLatency(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1)} ms`
}
</script>

<template>
  <section class="performance-section audio-section">
    <div class="section-heading">
      <div>
        <Radio :size="13" /><strong>{{ t("performance.audioSection.title") }}</strong>
      </div>
      <span>{{ runtime.state }}</span>
    </div>
    <dl class="audio-timing-grid">
      <div>
        <dt>{{ t("performance.audioSection.roundTrip") }}</dt>
        <dd>{{ formatLatency(runtime.estimatedRoundTripLatencyMs) }}</dd>
      </div>
      <div>
        <dt>{{ t("performance.audioSection.rollingAvg") }}</dt>
        <dd>{{ formatLatency(statistics.averageRoundTripLatencyMs) }}</dd>
      </div>
      <div>
        <dt>{{ t("performance.audioSection.rollingMax") }}</dt>
        <dd>{{ formatLatency(statistics.maximumRoundTripLatencyMs) }}</dd>
      </div>
      <div>
        <dt>{{ t("performance.audioSection.output") }}</dt>
        <dd>{{ formatLatency(runtime.outputLatencyMs) }}</dd>
      </div>
      <div>
        <dt>{{ t("performance.audioSection.buffer") }}</dt>
        <dd>{{ runtime.outputBufferSize ?? "—" }} {{ t("performance.audioSection.frames") }}</dd>
      </div>
      <div :class="{ warning: statistics.sessionXruns > 0 }">
        <dt>{{ t("performance.audioSection.xrun") }}</dt>
        <dd>{{ statistics.sessionXruns }}</dd>
      </div>
    </dl>
  </section>
</template>
