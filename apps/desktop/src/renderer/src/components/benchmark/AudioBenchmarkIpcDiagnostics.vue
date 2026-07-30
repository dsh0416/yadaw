<script setup lang="ts">
import { useI18n } from "vue-i18n"
import type { AudioIpcBenchmarkReport, AudioIpcBenchmarkScenario } from "@yadaw/contracts"

defineProps<{ report: AudioIpcBenchmarkReport }>()
const { t } = useI18n()
function format(value: number, digits = 1): string {
  return value.toFixed(digits)
}
function formatLatency(value: number | null): string {
  if (value === null) return "—"
  return value >= 1_000 ? `${format(value / 1_000, 2)} ms` : `${format(value, 1)} µs`
}
function formatPayload(bytes: number): string {
  if (bytes === 0) return t("benchmark.ipc.payload.sharedPage")
  if (bytes >= 1024 * 1024) return `${format(bytes / (1024 * 1024), 1)} MiB`
  if (bytes >= 1024) return `${format(bytes / 1024, bytes % 1024 === 0 ? 0 : 1)} KiB`
  return `${bytes} B`
}
function ipcRate(scenario: AudioIpcBenchmarkScenario): string {
  return scenario.throughputMiBPerSecond === null
    ? t("benchmark.ipc.rate.readsPerSecond", {
        rate: format(scenario.operationsPerSecond / 1_000, 1)
      })
    : t("benchmark.ipc.rate.throughput", { rate: format(scenario.throughputMiBPerSecond, 1) })
}
</script>

<template>
  <div class="result-heading ipc-heading">
    <div>
      <span class="kicker">{{ t("benchmark.ipc.kicker") }}</span>
      <h3>{{ t("benchmark.ipc.title") }}</h3>
    </div>
    <small>{{ t("benchmark.ipc.suiteDuration", { ms: format(report.durationMs, 0) }) }}</small>
  </div>
  <div class="ipc-table">
    <div class="ipc-row ipc-table-header" aria-hidden="true">
      <span>{{ t("benchmark.ipc.table.path") }}</span
      ><span>{{ t("benchmark.ipc.table.payload") }}</span
      ><span>{{ t("benchmark.ipc.table.p50") }}</span
      ><span>{{ t("benchmark.ipc.table.p99") }}</span
      ><span>{{ t("benchmark.ipc.table.rate") }}</span>
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
    ·
    {{
      t("benchmark.ipc.note.workers", {
        workers: report.runtime.workerThreads,
        blocking: report.runtime.maxBlockingThreads,
        egress: report.runtime.egressConcurrency
      })
    }}
    · {{ t("benchmark.ipc.note.arenaOffers", { count: report.arenaOffers }) }} ·
    {{ t("benchmark.ipc.note.messagePackBody", { size: formatPayload(report.messagePackBodyBytes) }) }}
    <template v-if="report.buildProfile === 'debug'">
      · {{ t("benchmark.ipc.note.debugOnly") }}
    </template>
  </p>
</template>
