<script setup lang="ts">
import { storeToRefs } from "pinia"
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import { CircleAlert, RefreshCw, TriangleAlert } from "@lucide/vue"
import type { AudioRuntimeSnapshot } from "@yadaw/contracts"
import { UiPopover } from "@yadaw/ui"
import type { AudioTelemetryStatistics, AudioWarning } from "../../stores/audioRuntime"
import {
  classifyUpperBound,
  highestSeverity,
  PERFORMANCE_THRESHOLDS,
  useSystemPerformanceStore
} from "../../stores/systemPerformance"
import type { HealthSeverity, PerformanceWarning } from "../../stores/systemPerformance"
import PerformanceAudioSection from "./PerformanceAudioSection.vue"
import PerformanceIpcSection from "./PerformanceIpcSection.vue"
import PerformanceResourceSections from "./PerformanceResourceSections.vue"

const props = defineProps<{
  runtime: AudioRuntimeSnapshot
  statistics: AudioTelemetryStatistics
  audioWarnings: AudioWarning[]
}>()

const systemPerformanceStore = useSystemPerformanceStore()
const { t } = useI18n()
const {
  snapshot,
  warnings: systemWarnings,
  severity: systemSeverity,
  isRefreshing
} = storeToRefs(systemPerformanceStore)

const monitoredRoundTripLatency = computed<number | null>(() => {
  if (props.runtime.state !== "running") return null
  const values = [
    props.runtime.estimatedRoundTripLatencyMs,
    props.statistics.averageRoundTripLatencyMs
  ].filter((value): value is number => value !== null)
  return values.length > 0 ? Math.max(...values) : null
})

const latencySeverity = computed<HealthSeverity>(() => {
  if (props.runtime.state !== "running") return "normal"
  return classifyUpperBound(
    monitoredRoundTripLatency.value,
    PERFORMANCE_THRESHOLDS.audioRoundTrip.warningMs,
    PERFORMANCE_THRESHOLDS.audioRoundTrip.criticalMs
  )
})

const audioSeverity = computed<HealthSeverity>(() =>
  highestSeverity([
    latencySeverity.value,
    ...props.audioWarnings.map((warning) => warning.severity)
  ])
)

const severity = computed<HealthSeverity>(() =>
  highestSeverity([systemSeverity.value, audioSeverity.value])
)

const latencyWarning = computed<PerformanceWarning | null>(() => {
  if (latencySeverity.value === "normal") return null
  const value = props.runtime.estimatedRoundTripLatencyMs
  return {
    id: "audio-latency",
    severity: latencySeverity.value,
    title:
      latencySeverity.value === "critical"
        ? t("performance.latency.criticalTitle")
        : t("performance.latency.warningTitle"),
    message: t("performance.latency.message", {
      latency: formatLatency(monitoredRoundTripLatency.value ?? value)
    })
  }
})

const activeWarnings = computed<PerformanceWarning[]>(() => [
  ...systemWarnings.value,
  ...props.audioWarnings.map((warning) => ({ ...warning })),
  ...(latencyWarning.value ? [latencyWarning.value] : [])
])

const cpuUsage = computed(() => snapshot.value?.cpu.overallUsagePercent ?? null)
const memoryUsage = computed(() => snapshot.value?.memory.usagePercent ?? null)
const audioIpc = computed(() => snapshot.value?.audioIpc ?? null)

function formatPercent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value)}%`
}

function formatLatency(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1)} ms`
}
</script>

<template>
  <UiPopover align="end" side="top" :side-offset="9">
    <template #trigger>
      <button
        :class="['performance-trigger', severity]"
        :aria-label="
          t('performance.trigger.ariaLabel', {
            severity: t(`performance.severity.${severity}`)
          })
        "
      >
        <span class="health-light" aria-hidden="true" />
        <span>{{ t("performance.trigger.cpu") }} {{ formatPercent(cpuUsage) }}</span>
        <span>{{ t("performance.trigger.mem") }} {{ formatPercent(memoryUsage) }}</span>
      </button>
    </template>
    <div class="performance-popover">
      <header class="performance-header">
        <div>
          <span>{{ t("performance.header.kicker") }}</span>
          <strong>{{ t("performance.header.title") }}</strong>
        </div>
        <div class="performance-header-actions">
          <span :class="['health-badge', severity]">{{
            t(`performance.severity.${severity}`)
          }}</span>
          <button
            class="refresh-performance"
            :aria-label="t('performance.header.refreshAria')"
            :disabled="isRefreshing"
            @click="systemPerformanceStore.refresh"
          >
            <RefreshCw :class="{ spinning: isRefreshing }" :size="12" />
          </button>
        </div>
      </header>

      <div v-if="activeWarnings.length > 0" class="performance-alerts" aria-live="polite">
        <article
          v-for="warning in activeWarnings"
          :key="warning.id"
          :class="['performance-alert', warning.severity]"
        >
          <component
            :is="warning.severity === 'critical' ? CircleAlert : TriangleAlert"
            :size="12"
          />
          <div>
            <strong>{{ warning.title }}</strong
            ><span>{{ warning.message }}</span>
          </div>
        </article>
      </div>

      <PerformanceResourceSections :snapshot="snapshot" />

      <PerformanceAudioSection :runtime="runtime" :statistics="statistics" />

      <PerformanceIpcSection :audio-ipc="audioIpc" />

      <footer class="threshold-note">
        {{
          t("performance.thresholdNote", {
            cpuWarning: PERFORMANCE_THRESHOLDS.cpu.warningPercent,
            cpuCritical: PERFORMANCE_THRESHOLDS.cpu.criticalPercent,
            memWarning: PERFORMANCE_THRESHOLDS.memory.warningPercent,
            memCritical: PERFORMANCE_THRESHOLDS.memory.criticalPercent,
            rtlWarning: PERFORMANCE_THRESHOLDS.audioRoundTrip.warningMs,
            rtlCritical: PERFORMANCE_THRESHOLDS.audioRoundTrip.criticalMs
          })
        }}
      </footer>
    </div>
  </UiPopover>
</template>

<style>
.performance-trigger {
  display: flex;
  align-items: center;
  height: 20px;
  padding: 0 7px;
  border: 1px solid transparent;
  border-radius: 4px;
  gap: 8px;
  color: var(--text-muted);
  background: transparent;
  font: var(--ui-type-size-caption) var(--ui-type-family-data);
  letter-spacing: var(--ui-type-tracking-wide);
  cursor: pointer;
}
.performance-trigger:hover {
  border-color: var(--line-strong);
  color: var(--text-secondary);
  background: var(--daw-control);
}
.performance-trigger:focus-visible,
.refresh-performance:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}
.performance-trigger.warning {
  border-color: color-mix(in srgb, var(--warning) 45%, var(--line-strong));
  color: var(--warning);
  background: color-mix(in srgb, var(--warning) 10%, var(--daw-statusbar));
}
.performance-trigger.critical {
  border-color: color-mix(in srgb, var(--record) 45%, var(--line-strong));
  color: var(--record);
  background: color-mix(in srgb, var(--record) 10%, var(--daw-statusbar));
}
.health-light {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--signal-cyan);
  box-shadow: 0 0 6px color-mix(in srgb, var(--signal-cyan) 60%, transparent);
}
.warning .health-light {
  background: var(--warning);
  box-shadow: 0 0 7px color-mix(in srgb, var(--warning) 66%, transparent);
}
.critical .health-light {
  background: var(--record);
  box-shadow: 0 0 7px color-mix(in srgb, var(--record) 72%, transparent);
}
.performance-popover {
  z-index: var(--ui-z-dropdown);
  width: 520px;
  max-width: calc(100vw - 24px);
  max-height: calc(100vh - 48px);
  overflow: auto;
  padding: 0;
  border: 1px solid var(--line-strong);
  border-radius: 10px;
  outline: none;
  color: var(--text-primary);
  background: var(--surface-panel);
  box-shadow: 0 24px 64px var(--shadow);
  transform-origin: var(--reka-popover-content-transform-origin);
  animation: performance-surface-in 120ms ease-out;
}
.performance-header {
  position: sticky;
  z-index: var(--ui-z-local-raised);
  top: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 13px 15px;
  border-bottom: 1px solid var(--line-soft);
  background: color-mix(in srgb, var(--surface-2) 93%, transparent);
  backdrop-filter: blur(10px);
}
.performance-header > div:first-child > span,
.performance-header > div:first-child > strong {
  display: block;
}
.performance-header > div:first-child > span {
  color: var(--accent);
  font: var(--ui-type-weight-bold) var(--ui-type-size-caption) var(--ui-type-family-data);
  text-transform: uppercase;
  letter-spacing: var(--ui-type-tracking-widest);
}
.performance-header > div:first-child > strong {
  margin-top: 4px;
  font-size: var(--ui-type-size-section-title);
}
.performance-header-actions {
  display: flex;
  align-items: center;
  gap: 7px;
}
.health-badge {
  padding: 4px 7px;
  border: 1px solid color-mix(in srgb, var(--signal-cyan) 50%, var(--line-strong));
  border-radius: 4px;
  color: var(--signal-cyan);
  background: color-mix(in srgb, var(--signal-cyan) 10%, var(--surface-2));
  font: var(--ui-type-size-caption) var(--ui-type-family-data);
  text-transform: uppercase;
  letter-spacing: var(--ui-type-tracking-wide);
}
.health-badge.warning {
  border-color: color-mix(in srgb, var(--warning) 45%, var(--line-strong));
  color: var(--warning);
  background: color-mix(in srgb, var(--warning) 10%, var(--surface-2));
}
.health-badge.critical {
  border-color: color-mix(in srgb, var(--record) 45%, var(--line-strong));
  color: var(--record);
  background: color-mix(in srgb, var(--record) 10%, var(--surface-2));
}
.refresh-performance {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid var(--line-strong);
  border-radius: 5px;
  color: var(--text-muted);
  background: var(--daw-control);
  cursor: pointer;
}
.refresh-performance:hover {
  color: var(--text-primary);
  background: var(--daw-control-hover);
}
.refresh-performance:disabled {
  cursor: wait;
  opacity: 0.55;
}
.spinning {
  animation: monitor-spin 0.8s linear infinite;
}
.performance-alerts {
  display: grid;
  padding: 8px;
  border-bottom: 1px solid var(--line-soft);
  gap: 5px;
  background: var(--surface-panel);
}
.performance-alert {
  display: grid;
  grid-template-columns: 15px minmax(0, 1fr);
  align-items: start;
  padding: 7px 8px;
  border: 1px solid color-mix(in srgb, var(--warning) 42%, var(--line-strong));
  border-radius: 6px;
  gap: 7px;
  color: var(--warning);
  background: color-mix(in srgb, var(--warning) 10%, var(--surface-1));
}
.performance-alert.critical {
  border-color: color-mix(in srgb, var(--record) 45%, var(--line-strong));
  color: var(--record);
  background: color-mix(in srgb, var(--record) 10%, var(--surface-1));
}
.performance-alert div {
  min-width: 0;
}
.performance-alert strong,
.performance-alert span {
  display: block;
}
.performance-alert strong {
  font-size: var(--ui-type-size-control);
}
.performance-alert span {
  margin-top: 3px;
  color: var(--text-muted);
  font-size: var(--ui-type-size-caption);
  line-height: var(--ui-type-leading-normal);
}
.performance-alert.critical span {
  color: var(--text-muted);
}
.performance-section {
  padding: 12px 15px;
  border-bottom: 1px solid var(--line-soft);
}
.section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}
.section-heading > div {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--text-secondary);
}
.section-heading strong {
  font-size: var(--ui-type-size-body-compact);
}
.section-heading > span {
  color: var(--text-faint);
  font: var(--ui-type-size-caption) var(--ui-type-family-data);
  text-transform: uppercase;
  letter-spacing: var(--ui-type-tracking-wide);
}
.core-bank {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(30px, 1fr));
  gap: 5px;
}
.core-channel {
  display: grid;
  grid-template-rows: 10px 46px 10px;
  justify-items: center;
  gap: 4px;
  min-width: 0;
}
.core-value,
.core-label {
  color: var(--text-faint);
  font: var(--ui-type-size-micro) var(--ui-type-family-data);
}
.core-meter {
  position: relative;
  width: 9px;
  height: 46px;
  overflow: hidden;
  border: 1px solid var(--line-strong);
  border-radius: 2px;
  background: repeating-linear-gradient(
    to top,
    var(--daw-control) 0,
    var(--daw-control) 4px,
    var(--daw-meter-well) 4px,
    var(--daw-meter-well) 6px
  );
}
.core-meter i {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  height: var(--core-load);
  background: linear-gradient(to top, var(--accent), var(--signal-cyan));
  box-shadow: 0 0 7px color-mix(in srgb, var(--signal-cyan) 40%, transparent);
}
.core-channel.warning .core-meter i {
  background: var(--warning);
  box-shadow: 0 0 7px color-mix(in srgb, var(--warning) 53%, transparent);
}
.core-channel.critical .core-meter i {
  background: var(--record);
  box-shadow: 0 0 7px color-mix(in srgb, var(--record) 60%, transparent);
}
.core-channel.warning .core-value {
  color: var(--warning);
}
.core-channel.critical .core-value {
  color: var(--record);
}
.monitor-placeholder {
  padding: 15px;
  border: 1px dashed var(--line-strong);
  border-radius: 6px;
  color: var(--text-faint);
  font-size: var(--ui-type-size-control);
  text-align: center;
}
.memory-readout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) repeat(3, auto);
  align-items: center;
  gap: 10px;
}
.linear-meter {
  height: 6px;
  overflow: hidden;
  border: 1px solid var(--line-strong);
  border-radius: 2px;
  background: var(--daw-meter-well);
}
.linear-meter i {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, var(--accent), var(--signal-cyan));
  box-shadow: 0 0 8px color-mix(in srgb, var(--signal-cyan) 40%, transparent);
}
.memory-readout > span {
  color: var(--text-faint);
  font: var(--ui-type-size-caption) var(--ui-type-family-data);
}
.storage-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 7px;
}
.storage-space {
  min-width: 0;
  padding: 9px 10px;
  border: 1px solid var(--line-soft);
  border-radius: 6px;
  background: var(--surface-1);
}
.storage-space > span,
.storage-space > strong,
.storage-space > small {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.storage-space > span {
  color: var(--text-faint);
  font: var(--ui-type-size-caption) var(--ui-type-family-data);
  text-transform: uppercase;
  letter-spacing: var(--ui-type-tracking-wide);
}
.storage-space > strong {
  margin-top: 5px;
  color: var(--text-secondary);
  font: var(--ui-type-size-body-compact) var(--ui-type-family-data);
}
.storage-space > small {
  margin-top: 4px;
  color: var(--text-muted);
  font-size: var(--ui-type-size-caption);
}
.storage-space.warning {
  border-color: color-mix(in srgb, var(--warning) 42%, var(--line-strong));
  background: color-mix(in srgb, var(--warning) 10%, var(--surface-1));
}
.storage-space.warning > strong {
  color: var(--warning);
}
.storage-space.critical {
  border-color: color-mix(in srgb, var(--record) 45%, var(--line-strong));
  background: color-mix(in srgb, var(--record) 10%, var(--surface-1));
}
.storage-space.critical > strong {
  color: var(--record);
}
.audio-timing-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  margin: 0;
  gap: 6px;
}
.audio-timing-grid > div {
  min-width: 0;
  padding: 8px;
  border: 1px solid var(--line-soft);
  border-radius: 5px;
  background: var(--surface-1);
}
.audio-timing-grid dt {
  color: var(--text-faint);
  font-size: var(--ui-type-size-caption);
}
.audio-timing-grid dd {
  margin: 4px 0 0;
  color: var(--signal-cyan);
  font: var(--ui-type-size-control) var(--ui-type-family-data);
  white-space: nowrap;
}
.audio-timing-grid .warning {
  border-color: color-mix(in srgb, var(--warning) 42%, var(--line-strong));
}
.audio-timing-grid .warning dd {
  color: var(--warning);
}
.threshold-note {
  padding: 8px 15px;
  color: var(--text-faint);
  background: var(--surface-sunken);
  font: var(--ui-type-size-micro) var(--ui-type-family-data);
  line-height: var(--ui-type-leading-normal);
}
.performance-popover-arrow {
  fill: var(--line-strong);
}
.ipc-diagnostics-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
}
.ipc-diagnostics-grid > div {
  min-width: 0;
  padding: 8px;
  border: 1px solid var(--line-soft);
  border-radius: 5px;
  background: var(--surface-1);
}
.ipc-diagnostics-grid dt {
  color: var(--text-faint);
  font-size: var(--ui-type-size-caption);
}
.ipc-diagnostics-grid dd {
  overflow: hidden;
  margin: 4px 0 0;
  color: var(--signal-cyan);
  font: var(--ui-type-size-control) var(--ui-type-family-data);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ipc-diagnostics-grid small {
  display: block;
  overflow: hidden;
  margin-top: 4px;
  color: var(--text-faint);
  font: var(--ui-type-size-micro) var(--ui-type-family-data);
  line-height: var(--ui-type-leading-compact);
  text-overflow: ellipsis;
  white-space: nowrap;
}
@keyframes monitor-spin {
  to {
    transform: rotate(360deg);
  }
}
@keyframes performance-surface-in {
  from {
    opacity: 0;
    transform: translateY(3px) scale(0.98);
  }
}
@media (max-width: 700px) {
  .memory-readout {
    grid-template-columns: 1fr 1fr;
  }
  .linear-meter {
    grid-column: 1/-1;
  }
  .storage-grid {
    grid-template-columns: 1fr;
  }
  .audio-timing-grid,
  .ipc-diagnostics-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (prefers-reduced-motion: reduce) {
  .spinning {
    animation: none;
  }
}
</style>
