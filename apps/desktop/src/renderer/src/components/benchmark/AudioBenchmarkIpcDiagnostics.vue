<script setup lang="ts">
import type { AudioIpcBenchmarkReport, AudioIpcBenchmarkScenario } from "@yadaw/contracts"

defineProps<{ report: AudioIpcBenchmarkReport }>()
function format(value: number, digits = 1): string {
  return value.toFixed(digits)
}
function formatLatency(value: number | null): string {
  if (value === null) return "—"
  return value >= 1_000 ? `${format(value / 1_000, 2)} ms` : `${format(value, 1)} µs`
}
function formatPayload(bytes: number): string {
  if (bytes === 0) return "shared page"
  if (bytes >= 1024 * 1024) return `${format(bytes / (1024 * 1024), 1)} MiB`
  if (bytes >= 1024) return `${format(bytes / 1024, bytes % 1024 === 0 ? 0 : 1)} KiB`
  return `${bytes} B`
}
function ipcRate(scenario: AudioIpcBenchmarkScenario): string {
  return scenario.throughputMiBPerSecond === null
    ? `${format(scenario.operationsPerSecond / 1_000, 1)}k reads/s`
    : `${format(scenario.throughputMiBPerSecond, 1)} MiB/s`
}
</script>

<template>
  <div class="result-heading ipc-heading">
    <div>
      <span class="kicker">PROCESS BOUNDARY</span>
      <h3>IPC transport</h3>
    </div>
    <small>{{ format(report.durationMs, 0) }} ms suite</small>
  </div>
  <div class="ipc-table">
    <div class="ipc-row ipc-table-header" aria-hidden="true">
      <span>Path</span><span>Payload</span><span>P50</span><span>P99</span><span>Rate</span>
    </div>
    <div v-for="scenario in report.scenarios" :key="scenario.id" class="ipc-row">
      <span class="ipc-name"
        ><strong>{{ scenario.label }}</strong
        ><small>{{ scenario.description }}</small></span
      >
      <span>{{ formatPayload(scenario.payloadBytes) }}</span>
      <span>{{ formatLatency(scenario.latencyP50Us) }}</span>
      <span>{{ formatLatency(scenario.latencyP99Us) }}</span>
      <span class="ipc-rate">{{ ipcRate(scenario) }}</span>
    </div>
  </div>
  <p class="ipc-diagnostics-note">
    <b>{{ report.buildProfile.toUpperCase() }}</b>
    · {{ report.runtime.workerThreads }} workers / {{ report.runtime.maxBlockingThreads }} blocking
    / {{ report.runtime.egressConcurrency }} egress · {{ report.arenaOffers }} arena offers ·
    {{ formatPayload(report.messagePackBodyBytes) }} MessagePack body
    <template v-if="report.buildProfile === 'debug'">
      · Diagnostic only; formal bandwidth grading uses a release build.
    </template>
  </p>
</template>
