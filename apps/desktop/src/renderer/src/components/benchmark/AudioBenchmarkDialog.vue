<script setup lang="ts">
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import type { AudioBenchmarkRating, AudioBenchmarkReport } from "@yadaw/contracts"
import type { AudioBenchmarkStatus } from "../../stores/audioBenchmark"
import AudioBenchmarkIpcDiagnostics from "./AudioBenchmarkIpcDiagnostics.vue"
import AudioBenchmarkScenarioTable from "./AudioBenchmarkScenarioTable.vue"
import AudioBenchmarkSummary from "./AudioBenchmarkSummary.vue"

const props = defineProps<{
  status: AudioBenchmarkStatus
  report: AudioBenchmarkReport | null
  errorMessage: string
}>()

const emit = defineEmits<{
  close: []
  run: []
}>()

const { t } = useI18n()

const ratingCopy = computed<Record<AudioBenchmarkRating, { label: string; summary: string }>>(
  () => ({
    limited: {
      label: t("benchmark.rating.limited.label"),
      summary: t("benchmark.rating.limited.summary")
    },
    basic: {
      label: t("benchmark.rating.basic.label"),
      summary: t("benchmark.rating.basic.summary")
    },
    good: {
      label: t("benchmark.rating.good.label"),
      summary: t("benchmark.rating.good.summary")
    },
    excellent: {
      label: t("benchmark.rating.excellent.label"),
      summary: t("benchmark.rating.excellent.summary")
    }
  })
)

const rating = computed(() => (props.report ? ratingCopy.value[props.report.rating] : null))
const measuredAt = computed(() =>
  props.report ? new Date(props.report.measuredAt).toLocaleString() : ""
)

function format(value: number, digits = 1): string {
  return value.toFixed(digits)
}
</script>

<template>
  <section class="benchmark-dialog">
    <div v-if="status === 'idle'" class="intro-state">
      <p class="intro-summary">
        {{ t("benchmark.intro.summary") }}
      </p>
      <p class="intro-guidance">
        <strong>{{ t("benchmark.intro.beforeStart") }}</strong>
        <span>{{ t("benchmark.intro.guidance") }}</span>
      </p>
      <div class="intro-actions">
        <button class="primary-button" type="button" @click="emit('run')">
          {{ t("benchmark.intro.runBenchmark") }}
        </button>
      </div>
    </div>

    <div v-else-if="status === 'running'" class="running-state" aria-live="polite">
      <div class="scope" aria-hidden="true">
        <span v-for="lane in 3" :key="lane" :style="{ '--lane': lane }" />
      </div>
      <span class="kicker">{{ t("benchmark.running.kicker") }}</span>
      <h3>{{ t("benchmark.running.title") }}</h3>
      <p>{{ t("benchmark.running.description") }}</p>
      <div class="progress-track"><span /></div>
    </div>

    <div v-else-if="status === 'complete' && report && rating" class="report-state">
      <AudioBenchmarkSummary :report="report" :rating="rating" />
      <AudioBenchmarkScenarioTable :scenarios="report.scenarios" />
      <AudioBenchmarkIpcDiagnostics :report="report.ipc" />

      <footer class="report-footer">
        <div>
          <span>{{ report.system.cpuModel }}</span>
          <small>{{
            t("benchmark.footer.logicalCores", {
              count: report.system.logicalCores,
              platform: report.system.platform,
              architecture: report.system.architecture
            })
          }}</small>
          <small>{{
            t("benchmark.footer.measured", {
              measuredAt,
              duration: format(report.durationMs / 1_000, 2)
            })
          }}</small>
        </div>
        <div class="report-actions">
          <button class="secondary-button" type="button" @click="emit('close')">
            {{ t("benchmark.actions.close") }}
          </button>
          <button class="primary-button compact" type="button" @click="emit('run')">
            {{ t("benchmark.actions.runAgain") }}
          </button>
        </div>
      </footer>
    </div>

    <div v-else class="error-state" role="alert">
      <span class="kicker">{{ t("benchmark.error.kicker") }}</span>
      <h3>{{ t("benchmark.error.title") }}</h3>
      <p>{{ errorMessage }}</p>
      <div class="error-actions">
        <button class="secondary-button" type="button" @click="emit('close')">
          {{ t("benchmark.actions.close") }}
        </button>
        <button class="primary-button compact" type="button" @click="emit('run')">
          {{ t("benchmark.actions.tryAgain") }}
        </button>
      </div>
    </div>
  </section>
</template>

<style>
.benchmark-dialog {
  width: 100%;
  color: var(--text-primary);
}

.ipc-diagnostics-note {
  margin: 10px 0 0;
  color: var(--text-faint);
  font: var(--ui-type-size-caption) var(--ui-type-family-data);
  letter-spacing: var(--ui-type-tracking-wide);
}
.ipc-diagnostics-note b {
  color: var(--signal-cyan);
}

.kicker {
  color: var(--signal-cyan);
  font: var(--ui-type-weight-bold) var(--ui-type-size-caption) var(--ui-type-family-data);
  letter-spacing: var(--ui-type-tracking-widest);
}

.running-state,
.error-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 42px 48px 44px;
  text-align: center;
}

.running-state h3,
.error-state h3 {
  margin: 24px 0 8px;
  font: var(--ui-type-weight-semibold) var(--ui-type-size-page-title) var(--ui-type-family-display);
}

.running-state > p,
.error-state > p {
  max-width: 510px;
  margin: 0;
  color: var(--text-muted);
  font-size: var(--ui-type-size-section-title);
  line-height: var(--ui-type-leading-relaxed);
}

.intro-state {
  display: grid;
  gap: 18px;
}

.intro-summary {
  max-width: 38rem;
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--ui-type-size-section-title);
  line-height: var(--ui-type-leading-relaxed);
}

.intro-guidance {
  display: grid;
  gap: 4px;
  margin: 0;
  padding-left: 12px;
  border-left: 2px solid var(--warning);
  text-align: left;
}

.intro-guidance strong {
  color: var(--warning);
  font: var(--ui-type-weight-bold) var(--ui-type-size-control) var(--ui-type-family-data);
  text-transform: uppercase;
  letter-spacing: var(--ui-type-tracking-wide);
}

.intro-guidance span {
  color: var(--text-muted);
  font-size: var(--ui-type-size-body-compact);
  line-height: var(--ui-type-leading-normal);
}

.intro-actions {
  display: flex;
  justify-content: flex-end;
}

.primary-button,
.secondary-button {
  padding: 9px 16px;
  border: 1px solid transparent;
  border-radius: 7px;
  cursor: pointer;
}

.primary-button {
  color: var(--ui-domain-color-fff);
  background: linear-gradient(135deg, var(--ui-domain-color-7168e8), var(--ui-domain-color-625bc4));
  box-shadow: 0 8px 22px var(--ui-domain-color-514aa544);
}

.primary-button:hover,
.primary-button:focus-visible {
  border-color: var(--ui-domain-color-b7b1ff);
  background: linear-gradient(135deg, var(--ui-domain-color-8279f4), var(--ui-domain-color-6d65d4));
  outline: none;
}

.primary-button.compact,
.secondary-button {
  padding: 8px 12px;
  font-size: var(--ui-type-size-label);
}

.secondary-button {
  border-color: var(--line-strong);
  color: var(--text-secondary);
  background: var(--surface-2);
}

.secondary-button:hover,
.secondary-button:focus-visible {
  color: var(--text-primary);
  background: var(--surface-3);
  outline: 1px solid var(--focus);
}

.running-state {
  min-height: 390px;
  justify-content: center;
}

.running-state h3 {
  margin-top: 12px;
}

.scope {
  display: grid;
  gap: 9px;
  width: min(430px, 100%);
  margin-bottom: 30px;
  padding: 22px;
  border: 1px solid var(--line-soft);
  border-radius: 10px;
  background: var(--ui-domain-color-080d14);
  overflow: hidden;
}

.scope span {
  width: 160%;
  height: 2px;
  background: repeating-linear-gradient(
    90deg,
    transparent 0 15px,
    var(--signal-cyan) 16px 18px,
    transparent 19px 28px,
    var(--accent) 29px 32px
  );
  filter: drop-shadow(0 0 5px var(--ui-domain-color-67d9e788));
  animation: scope-flow 1.1s linear infinite;
  animation-delay: calc(var(--lane) * -170ms);
}

.progress-track {
  width: min(430px, 100%);
  height: 3px;
  margin-top: 28px;
  background: var(--line-soft);
  overflow: hidden;
}

.progress-track span {
  display: block;
  width: 32%;
  height: 100%;
  background: linear-gradient(90deg, var(--accent), var(--signal-cyan));
  animation: benchmark-progress 1.2s ease-in-out infinite;
}

.report-state {
  padding: 22px 24px 24px;
}

.score-panel {
  display: grid;
  grid-template-columns: 230px 1fr;
  align-items: center;
  min-height: 122px;
  border: 1px solid var(--ui-domain-color-3f4263);
  border-radius: 10px;
  background:
    radial-gradient(circle at 18% 50%, var(--ui-domain-color-625bc42b), transparent 42%),
    linear-gradient(110deg, var(--ui-domain-color-16172a), var(--ui-domain-color-111923));
  overflow: hidden;
}

.score-copy {
  padding: 22px 24px;
  border-right: 1px solid var(--ui-domain-color-34374e);
}

.score-copy strong {
  display: flex;
  align-items: baseline;
  gap: 7px;
  margin-top: 8px;
  color: var(--ui-domain-color-f1f0ff);
  font: var(--ui-type-weight-semibold) var(--ui-type-size-hero) var(--ui-type-family-display);
}

.score-copy small {
  color: var(--text-muted);
  font: var(--ui-type-size-control) var(--ui-type-family-data);
  text-transform: uppercase;
  letter-spacing: var(--ui-type-tracking-wide);
}

.rating-copy {
  padding: 22px 28px;
}

.rating-copy span {
  color: var(--accent-soft);
  font: var(--ui-type-weight-semibold) var(--ui-type-size-view-title) var(--ui-type-family-display);
}

.rating-copy p {
  margin: 6px 0 0;
  color: var(--text-muted);
  font-size: var(--ui-type-size-label);
  line-height: var(--ui-type-leading-relaxed);
}

.rating-limited {
  border-color: var(--ui-domain-color-76404b);
}
.rating-basic {
  border-color: var(--ui-domain-color-65543e);
}
.rating-good {
  border-color: var(--ui-domain-color-3a5961);
}
.rating-excellent {
  border-color: var(--ui-domain-color-514b88);
}

.scenario-list {
  display: grid;
  gap: 8px;
}

.result-heading {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 24px;
  margin: 22px 2px 10px;
}

.result-heading h3 {
  margin: 5px 0 0;
  font: var(--ui-type-weight-semibold) var(--ui-type-size-panel-title) var(--ui-type-family-display);
}

.result-heading > small {
  color: var(--text-faint);
  font: var(--ui-type-size-caption) var(--ui-type-family-data);
  text-transform: uppercase;
  letter-spacing: var(--ui-type-tracking-wide);
}

.scenario-card {
  padding: 14px 15px 12px;
  border: 1px solid var(--line-soft);
  border-radius: 8px;
  background: var(--ui-domain-color-0b111a);
}

.scenario-card header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.scenario-card h3 {
  margin: 0;
  font: var(--ui-type-weight-semibold) var(--ui-type-size-section-title)
    var(--ui-type-family-display);
}

.scenario-card header p {
  margin: 3px 0 0;
  color: var(--text-faint);
  font-size: var(--ui-type-size-control);
}

.scenario-card header strong {
  color: var(--signal-cyan);
  font: var(--ui-type-weight-semibold) var(--ui-type-size-feature-title)
    var(--ui-type-family-display);
}

.scenario-card header strong small {
  color: var(--text-faint);
  font: var(--ui-type-size-caption) var(--ui-type-family-data);
  text-transform: uppercase;
}

.timing-lane {
  position: relative;
  height: 5px;
  margin: 12px 0 10px;
  border-radius: 999px;
  background: var(--ui-domain-color-202a38);
  overflow: hidden;
}

.timing-fill {
  display: block;
  height: 100%;
  min-width: 2px;
  border-radius: inherit;
  background: linear-gradient(90deg, var(--signal-cyan), var(--accent));
}

.deadline-marker {
  position: absolute;
  top: 0;
  right: 0;
  width: 2px;
  height: 100%;
  background: var(--record);
}

.scenario-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 7px 14px;
  color: var(--text-muted);
  font: var(--ui-type-size-caption) var(--ui-type-family-data);
  text-transform: uppercase;
  letter-spacing: var(--ui-type-tracking-wide);
}

.ipc-heading {
  margin-top: 24px;
}

.ipc-table {
  border: 1px solid var(--line-soft);
  border-radius: 8px;
  background: var(--ui-domain-color-090f17);
  overflow: hidden;
}

.ipc-row {
  display: grid;
  grid-template-columns: minmax(210px, 1.7fr) 0.65fr 0.65fr 0.65fr 0.8fr;
  align-items: center;
  min-height: 42px;
  border-top: 1px solid var(--line-soft);
}

.ipc-row:first-child {
  border-top: 0;
}

.ipc-row > span {
  padding: 8px 10px;
  color: var(--text-muted);
  font: var(--ui-type-size-control) var(--ui-type-family-data);
  font-variant-numeric: tabular-nums;
}

.ipc-table-header {
  min-height: 28px;
  background: var(--ui-domain-color-101823);
}

.ipc-table-header > span {
  color: var(--text-faint);
  font-size: var(--ui-type-size-caption);
  text-transform: uppercase;
  letter-spacing: var(--ui-type-tracking-wide);
}

.ipc-name strong,
.ipc-name small {
  display: block;
}

.ipc-name strong {
  color: var(--text-secondary);
  font: var(--ui-type-weight-semibold) var(--ui-type-size-body-compact)
    var(--ui-type-family-display);
}

.ipc-name small {
  margin-top: 3px;
  color: var(--text-faint);
  font-size: var(--ui-type-size-caption);
  line-height: var(--ui-type-leading-compact);
}

.ipc-row .ipc-rate {
  color: var(--signal-cyan);
}

.report-footer {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 20px;
  margin-top: 16px;
  padding-top: 15px;
  border-top: 1px solid var(--line-soft);
}

.report-footer span,
.report-footer small {
  display: block;
}

.report-footer span {
  max-width: 430px;
  color: var(--text-secondary);
  font-size: var(--ui-type-size-body-compact);
}

.report-footer small {
  margin-top: 4px;
  color: var(--text-faint);
  font: var(--ui-type-size-caption) var(--ui-type-family-data);
}

.report-actions,
.error-actions {
  display: flex;
  gap: 8px;
}

.error-state {
  min-height: 330px;
  justify-content: center;
}

.error-state .kicker {
  color: var(--record);
}

.error-actions {
  margin-top: 24px;
}

@keyframes scope-flow {
  from {
    transform: translateX(-36%);
  }
  to {
    transform: translateX(0);
  }
}

@keyframes benchmark-progress {
  from {
    transform: translateX(-110%);
  }
  to {
    transform: translateX(410%);
  }
}

@media (max-width: 700px) {
  .running-state,
  .error-state {
    padding-inline: 24px;
  }
  .score-panel {
    grid-template-columns: 1fr;
  }
  .score-copy {
    border-right: 0;
    border-bottom: 1px solid var(--ui-domain-color-34374e);
  }
  .report-footer {
    align-items: stretch;
    flex-direction: column;
  }
  .report-actions {
    justify-content: flex-end;
  }
  .ipc-table {
    overflow-x: auto;
  }
  .ipc-row {
    min-width: 720px;
  }
}
</style>
