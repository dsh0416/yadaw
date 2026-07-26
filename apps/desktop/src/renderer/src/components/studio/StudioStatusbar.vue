<script setup lang="ts">
import { CircleGauge, Radio } from "@lucide/vue"
import type { AudioRuntimeSnapshot } from "@yadaw/contracts"
import PerformanceMonitorPopover from "../performance/PerformanceMonitorPopover.vue"
import type { AudioTelemetryStatistics, AudioWarning } from "../../stores/audioRuntime"

defineProps<{
  runtime: AudioRuntimeSnapshot
  statistics: AudioTelemetryStatistics
  audioWarnings: AudioWarning[]
}>()

function formatLatency(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1)} ms`
}
</script>

<template>
  <footer class="statusbar">
    <span class="engine-state"
      ><i :class="{ active: runtime.state === 'running' }" />{{
        runtime.state === "running" ? "Audio active" : "Audio stopped"
      }}</span
    >
    <span
      ><Radio :size="10" />{{ runtime.sampleRate ? `${runtime.sampleRate / 1000} kHz` : "— kHz" }} ·
      24 bit</span
    >
    <span><CircleGauge :size="10" />Buffer {{ runtime.outputBufferSize ?? "—" }}</span>
    <span>RTL {{ formatLatency(runtime.estimatedRoundTripLatencyMs) }}</span>
    <span>AVG {{ formatLatency(statistics.averageRoundTripLatencyMs) }}</span>
    <span class="status-spacer" />
    <span :class="{ alert: statistics.sessionXruns > 0 }">XRUN {{ statistics.sessionXruns }}</span>
    <PerformanceMonitorPopover
      :runtime="runtime"
      :statistics="statistics"
      :audio-warnings="audioWarnings"
    />
  </footer>
</template>

<style scoped>
.statusbar {
  grid-column: 1/-1;
  display: flex;
  align-items: center;
  gap: 16px;
  min-width: 0;
  padding: 0 6px 0 13px;
  border-top: 1px solid var(--line-strong);
  color: var(--text-muted);
  background: var(--daw-statusbar);
  font: 7px var(--font-utility);
  letter-spacing: 0.02em;
}
.statusbar > span {
  display: flex;
  align-items: center;
  gap: 5px;
  white-space: nowrap;
}
.engine-state {
  color: var(--text-secondary);
}
.engine-state i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--text-faint);
}
.engine-state i.active {
  background: var(--signal-cyan);
  box-shadow: 0 0 6px var(--signal-cyan);
}
.status-spacer {
  flex: 1;
}
.statusbar .alert {
  color: var(--record);
}
</style>
