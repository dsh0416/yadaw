<script setup lang="ts">
import { Radio } from "@lucide/vue"
import type { AudioRuntimeSnapshot } from "@yadaw/contracts"
import type { AudioTelemetryStatistics } from "../../stores/audioRuntime"

defineProps<{
  runtime: AudioRuntimeSnapshot
  statistics: AudioTelemetryStatistics
}>()
function formatLatency(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1)} ms`
}
</script>

<template>
  <section class="performance-section audio-section">
    <div class="section-heading">
      <div><Radio :size="13" /><strong>Audio timing</strong></div>
      <span>{{ runtime.state }}</span>
    </div>
    <dl class="audio-timing-grid">
      <div>
        <dt>Round trip</dt>
        <dd>{{ formatLatency(runtime.estimatedRoundTripLatencyMs) }}</dd>
      </div>
      <div>
        <dt>Rolling avg</dt>
        <dd>{{ formatLatency(statistics.averageRoundTripLatencyMs) }}</dd>
      </div>
      <div>
        <dt>Rolling max</dt>
        <dd>{{ formatLatency(statistics.maximumRoundTripLatencyMs) }}</dd>
      </div>
      <div>
        <dt>Output</dt>
        <dd>{{ formatLatency(runtime.outputLatencyMs) }}</dd>
      </div>
      <div>
        <dt>Buffer</dt>
        <dd>{{ runtime.outputBufferSize ?? "—" }} frames</dd>
      </div>
      <div :class="{ warning: statistics.sessionXruns > 0 }">
        <dt>XRUN</dt>
        <dd>{{ statistics.sessionXruns }}</dd>
      </div>
    </dl>
  </section>
</template>
