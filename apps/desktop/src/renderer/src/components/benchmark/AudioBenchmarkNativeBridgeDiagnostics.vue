<script setup lang="ts">
import { useI18n } from "vue-i18n"
import type { AudioNativeBenchmarkReport, AudioNativeBenchmarkScenario } from "@heron/contracts"

defineProps<{ report: AudioNativeBenchmarkReport }>()
const { t } = useI18n()
function format(value: number, digits = 1): string {
  return value.toFixed(digits)
}
function formatLatency(value: number | null): string {
  if (value === null) return "—"
  return value >= 1_000 ? `${format(value / 1_000, 2)} ms` : `${format(value, 1)} µs`
}
function formatPayload(bytes: number): string {
  if (bytes === 0) return "—"
  if (bytes >= 1024 * 1024) return `${format(bytes / (1024 * 1024), 1)} MiB`
  if (bytes >= 1024) return `${format(bytes / 1024, bytes % 1024 === 0 ? 0 : 1)} KiB`
  return `${bytes} B`
}
function ipcRate(scenario: AudioNativeBenchmarkScenario): string {
  return scenario.throughputMiBPerSecond === null
    ? t("benchmark.nativeBridge.rate.readsPerSecond", {
        rate: format(scenario.operationsPerSecond / 1_000, 1)
      })
    : t("benchmark.nativeBridge.rate.throughput", {
        rate: format(scenario.throughputMiBPerSecond, 1)
      })
}
</script>

<template>
  <div class="result-heading ipc-heading">
    <div>
      <span class="kicker">{{ t("benchmark.nativeBridge.kicker") }}</span>
      <h3>{{ t("benchmark.nativeBridge.title") }}</h3>
    </div>
    <small>{{
      t("benchmark.nativeBridge.suiteDuration", { ms: format(report.durationMs, 0) })
    }}</small>
  </div>
  <div class="ipc-table">
    <div class="ipc-row ipc-table-header" aria-hidden="true">
      <span>{{ t("benchmark.nativeBridge.table.path") }}</span
      ><span>{{ t("benchmark.nativeBridge.table.payload") }}</span
      ><span>{{ t("benchmark.nativeBridge.table.p50") }}</span
      ><span>{{ t("benchmark.nativeBridge.table.p99") }}</span
      ><span>{{ t("benchmark.nativeBridge.table.rate") }}</span>
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
      t("benchmark.nativeBridge.note.workers", {
        workers: report.runtime.workerThreads,
        blocking: report.runtime.maxBlockingThreads
      })
    }}
    ·
    {{
      t("benchmark.nativeBridge.note.messagePackBody", {
        size: formatPayload(report.messagePackBodyBytes)
      })
    }}
    <template v-if="report.buildProfile === 'debug'">
      · {{ t("benchmark.nativeBridge.note.debugOnly") }}
    </template>
  </p>
</template>

<style scoped>
.result-heading {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--ui-space-6);
  margin: var(--ui-space-6) var(--ui-space-1) var(--ui-space-3);
}

.kicker {
  color: var(--ui-signal-audio);
  font: var(--ui-type-weight-semibold) var(--ui-font-size-xs) var(--ui-type-family-data);
  letter-spacing: var(--ui-type-tracking-wider);
  text-transform: uppercase;
}

.result-heading h3 {
  margin: var(--ui-space-1) 0 0;
  font-size: var(--ui-font-size-lg);
  font-weight: var(--ui-type-weight-semibold);
  line-height: var(--ui-type-leading-tight);
}

.result-heading > small {
  color: var(--ui-color-text-subtle);
  font: var(--ui-font-size-xs) var(--ui-type-family-data);
}

.ipc-table {
  overflow: hidden;
  border: 1px solid var(--ui-color-border);
  border-radius: var(--ui-radius-md);
  background: var(--ui-color-surface-raised);
}

.ipc-row {
  display: grid;
  grid-template-columns: minmax(210px, 1.7fr) 0.65fr 0.65fr 0.65fr 0.8fr;
  align-items: center;
  min-height: var(--ui-control-lg);
  border-top: 1px solid var(--ui-color-border);
}

.ipc-row:first-child {
  border-top: 0;
}

.ipc-row > span {
  padding: var(--ui-space-2) var(--ui-space-3);
  color: var(--ui-color-text-muted);
  font: var(--ui-font-size-xs) var(--ui-type-family-data);
  font-variant-numeric: tabular-nums;
}

.ipc-table-header {
  min-height: var(--ui-control-sm);
  background: var(--ui-color-canvas-subtle);
}

.ipc-table-header > span {
  color: var(--ui-color-text-subtle);
  font-family: var(--ui-type-family-interface);
  font-weight: var(--ui-type-weight-semibold);
}

.ipc-name strong,
.ipc-name small {
  display: block;
}

.ipc-name strong {
  color: var(--ui-color-text);
  font-family: var(--ui-type-family-interface);
  font-weight: var(--ui-type-weight-semibold);
}

.ipc-name small {
  margin-top: var(--ui-space-1);
  color: var(--ui-color-text-subtle);
  font-family: var(--ui-type-family-interface);
  line-height: var(--ui-type-leading-normal);
}

.ipc-row .ipc-rate {
  color: var(--ui-signal-audio);
}

.ipc-diagnostics-note {
  margin: var(--ui-space-3) 0 0;
  color: var(--ui-color-text-subtle);
  font: var(--ui-font-size-xs) var(--ui-type-family-data);
  line-height: var(--ui-type-leading-normal);
}

.ipc-diagnostics-note b {
  color: var(--ui-signal-audio);
}

@media (max-width: 700px) {
  .ipc-table {
    overflow-x: auto;
  }

  .ipc-row {
    min-width: 720px;
  }
}

@media (max-width: 560px) {
  .result-heading {
    align-items: flex-start;
    flex-direction: column;
    gap: var(--ui-space-2);
  }
}
</style>
