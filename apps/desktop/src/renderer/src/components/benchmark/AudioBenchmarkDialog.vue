<script setup lang="ts">
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import { UiButton, UiProgress, UiStatusNotice } from "@heron/ui"
import type { AudioBenchmarkRating, AudioBenchmarkReport } from "@heron/contracts"
import type { AudioBenchmarkStatus } from "../../stores/audioBenchmark"
import AudioBenchmarkNativeBridgeDiagnostics from "./AudioBenchmarkNativeBridgeDiagnostics.vue"
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
        <UiButton class="benchmark-run-button" variant="primary" @click="emit('run')">
          {{ t("benchmark.intro.runBenchmark") }}
        </UiButton>
      </div>
    </div>

    <div v-else-if="status === 'running'" class="running-state" aria-live="polite">
      <div class="scope" aria-hidden="true">
        <span v-for="lane in 3" :key="lane" :style="{ '--lane': lane }" />
      </div>
      <span class="kicker">{{ t("benchmark.running.kicker") }}</span>
      <h3>{{ t("benchmark.running.title") }}</h3>
      <p>{{ t("benchmark.running.description") }}</p>
      <UiProgress
        class="benchmark-progress"
        :label="t('benchmark.running.description')"
        :value="null"
      />
    </div>

    <div v-else-if="status === 'complete' && report && rating" class="report-state">
      <AudioBenchmarkSummary :report="report" :rating="rating" />
      <AudioBenchmarkScenarioTable :scenarios="report.scenarios" />
      <AudioBenchmarkNativeBridgeDiagnostics :report="report.nativeBridge" />

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
          <UiButton size="sm" @click="emit('close')">
            {{ t("benchmark.actions.close") }}
          </UiButton>
          <UiButton size="sm" variant="primary" @click="emit('run')">
            {{ t("benchmark.actions.runAgain") }}
          </UiButton>
        </div>
      </footer>
    </div>

    <div v-else class="error-state" role="alert">
      <span class="kicker">{{ t("benchmark.error.kicker") }}</span>
      <h3>{{ t("benchmark.error.title") }}</h3>
      <UiStatusNotice class="error-notice" tone="danger" live="assertive">
        {{ errorMessage }}
      </UiStatusNotice>
      <div class="error-actions">
        <UiButton @click="emit('close')">
          {{ t("benchmark.actions.close") }}
        </UiButton>
        <UiButton variant="primary" @click="emit('run')">
          {{ t("benchmark.actions.tryAgain") }}
        </UiButton>
      </div>
    </div>
  </section>
</template>

<style scoped>
.benchmark-dialog {
  width: 100%;
  color: var(--ui-color-text);
}

.kicker {
  color: var(--ui-signal-audio);
  font: var(--ui-type-weight-semibold) var(--ui-font-size-xs) var(--ui-type-family-data);
  letter-spacing: var(--ui-type-tracking-wider);
  text-transform: uppercase;
}

.running-state,
.error-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: var(--ui-space-10) var(--ui-space-8);
  text-align: center;
}

.running-state h3,
.error-state h3 {
  margin: var(--ui-space-5) 0 var(--ui-space-2);
  font-size: var(--ui-font-size-xl);
  font-weight: var(--ui-type-weight-semibold);
  line-height: var(--ui-type-leading-tight);
}

.running-state > p {
  max-width: 510px;
  margin: 0;
  color: var(--ui-color-text-muted);
  font-size: var(--ui-font-size-sm);
  line-height: var(--ui-type-leading-normal);
}

.intro-state {
  display: grid;
  gap: var(--ui-space-5);
}

.intro-summary {
  max-width: 38rem;
  margin: 0;
  color: var(--ui-color-text-muted);
  font-size: var(--ui-font-size-sm);
  line-height: var(--ui-type-leading-normal);
}

.intro-guidance {
  display: grid;
  gap: var(--ui-space-1);
  margin: 0;
  padding: var(--ui-space-3) var(--ui-space-4);
  border: 1px solid color-mix(in srgb, var(--ui-color-warning) 42%, var(--ui-color-border));
  border-radius: var(--ui-radius-md);
  background: color-mix(in srgb, var(--ui-color-warning) 8%, var(--ui-color-surface));
  text-align: left;
}

.intro-guidance strong {
  color: var(--ui-color-warning);
  font-size: var(--ui-font-size-sm);
  font-weight: var(--ui-type-weight-semibold);
}

.intro-guidance span {
  color: var(--ui-color-text-muted);
  font-size: var(--ui-font-size-xs);
  line-height: var(--ui-type-leading-normal);
}

.intro-actions {
  display: flex;
  justify-content: flex-end;
}

.running-state {
  min-height: 24rem;
  justify-content: center;
}

.running-state h3 {
  margin-top: 12px;
}

.scope {
  display: grid;
  gap: var(--ui-space-2);
  width: min(430px, 100%);
  margin-bottom: var(--ui-space-8);
  padding: var(--ui-space-5);
  border: 1px solid var(--ui-color-border);
  border-radius: var(--ui-radius-md);
  background: var(--ui-color-canvas-subtle);
  overflow: hidden;
}

.scope span {
  width: 160%;
  height: 2px;
  background: repeating-linear-gradient(
    90deg,
    transparent 0 15px,
    var(--ui-signal-audio) 16px 18px,
    transparent 19px 28px,
    var(--ui-color-text-subtle) 29px 32px
  );
  filter: drop-shadow(0 0 5px color-mix(in srgb, var(--ui-signal-audio) 52%, transparent));
  animation: scope-flow 1.1s linear infinite;
  animation-delay: calc(var(--lane) * -170ms);
}

.benchmark-progress {
  width: min(430px, 100%);
  margin-top: var(--ui-space-8);
}

.report-state {
  padding: 0;
}

.report-footer {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--ui-space-5);
  margin-top: var(--ui-space-5);
  padding-top: var(--ui-space-4);
  border-top: 1px solid var(--ui-color-border);
}

.report-footer span,
.report-footer small {
  display: block;
}

.report-footer span {
  max-width: 430px;
  color: var(--ui-color-text);
  font-size: var(--ui-font-size-sm);
}

.report-footer small {
  margin-top: var(--ui-space-1);
  color: var(--ui-color-text-subtle);
  font: var(--ui-font-size-xs) var(--ui-type-family-data);
}

.report-actions,
.error-actions {
  display: flex;
  gap: var(--ui-space-2);
}

.error-state {
  min-height: 20rem;
  justify-content: center;
}

.error-state .kicker {
  color: var(--ui-color-danger);
}

.error-notice {
  width: min(32rem, 100%);
  margin-top: var(--ui-space-4);
  text-align: left;
}

.error-actions {
  margin-top: var(--ui-space-6);
}

@keyframes scope-flow {
  from {
    transform: translateX(-36%);
  }
  to {
    transform: translateX(0);
  }
}

@media (max-width: 700px) {
  .running-state,
  .error-state {
    padding-inline: 24px;
  }
  .report-footer {
    align-items: stretch;
    flex-direction: column;
  }
  .report-actions {
    justify-content: flex-end;
  }
}

@media (prefers-reduced-motion: reduce) {
  .scope span {
    animation: none;
  }
}
</style>
