<script setup lang="ts">
import { useI18n } from "vue-i18n"
import type { AudioBenchmarkScenario } from "@heron/contracts"

defineProps<{ scenarios: readonly AudioBenchmarkScenario[] }>()
const { t } = useI18n()
function budgetUsePercent(scenario: AudioBenchmarkScenario): number {
  return Math.min(100, scenario.p99DeadlineUtilizationPercent)
}
function format(value: number, digits = 1): string {
  return value.toFixed(digits)
}
</script>

<template>
  <div class="result-heading">
    <div>
      <span class="kicker">{{ t("benchmark.scenarios.kicker") }}</span>
      <h3>{{ t("benchmark.scenarios.title") }}</h3>
    </div>
    <small>{{ t("benchmark.scenarios.subtitle") }}</small>
  </div>
  <div class="scenario-list">
    <article v-for="scenario in scenarios" :key="scenario.id" class="scenario-card">
      <header>
        <div>
          <h3>{{ scenario.label }}</h3>
          <p>{{ scenario.description }}</p>
        </div>
        <strong
          >{{ format(scenario.p99BlockMs, 3)
          }}<small> {{ t("benchmark.scenarios.p99Unit") }}</small></strong
        >
      </header>
      <div class="timing-lane">
        <span class="timing-fill" :style="{ width: `${budgetUsePercent(scenario)}%` }" />
        <span class="deadline-marker" />
      </div>
      <div class="scenario-meta">
        <span>{{ t("benchmark.scenarios.tracks", { count: scenario.tracks }) }}</span
        ><span>{{ t("benchmark.scenarios.buses", { count: scenario.buses }) }}</span>
        <span>{{ t("benchmark.scenarios.sends", { count: scenario.sends }) }}</span
        ><span>{{ t("benchmark.scenarios.plugins", { count: scenario.plugins }) }}</span>
        <span>{{ t("benchmark.scenarios.samples", { count: scenario.blockSize }) }}</span>
        <span>{{
          t("benchmark.scenarios.budget", { ms: format(scenario.bufferBudgetMs, 3) })
        }}</span>
        <span>{{
          t("benchmark.scenarios.late", {
            misses: scenario.deadlineMisses,
            blocks: scenario.measuredBlocks
          })
        }}</span>
        <span>{{
          t("benchmark.scenarios.realtimeFactor", { factor: format(scenario.realtimeFactor) })
        }}</span>
      </div>
    </article>
  </div>
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

.scenario-list {
  display: grid;
  gap: var(--ui-space-2);
}

.scenario-card {
  padding: var(--ui-space-4);
  border: 1px solid var(--ui-color-border);
  border-radius: var(--ui-radius-md);
  background: var(--ui-color-surface-raised);
}

.scenario-card header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--ui-space-4);
}

.scenario-card h3 {
  margin: 0;
  font-size: var(--ui-font-size-sm);
  font-weight: var(--ui-type-weight-semibold);
}

.scenario-card header p {
  margin: var(--ui-space-1) 0 0;
  color: var(--ui-color-text-muted);
  font-size: var(--ui-font-size-xs);
  line-height: var(--ui-type-leading-normal);
}

.scenario-card header strong {
  color: var(--ui-signal-audio);
  font: var(--ui-type-weight-semibold) var(--ui-font-size-lg) var(--ui-type-family-data);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.scenario-card header strong small {
  color: var(--ui-color-text-subtle);
  font-size: var(--ui-font-size-xs);
  font-weight: var(--ui-type-weight-regular);
}

.timing-lane {
  position: relative;
  height: 0.5rem;
  margin: var(--ui-space-3) 0;
  overflow: hidden;
  border-radius: var(--ui-radius-pill);
  background: var(--ui-color-surface-active);
}

.timing-fill {
  display: block;
  height: 100%;
  min-width: 2px;
  border-radius: inherit;
  background: var(--ui-signal-audio);
}

.deadline-marker {
  position: absolute;
  top: 0;
  right: 0;
  width: 2px;
  height: 100%;
  background: var(--ui-color-danger);
}

.scenario-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ui-space-2) var(--ui-space-4);
  color: var(--ui-color-text-subtle);
  font: var(--ui-font-size-xs) var(--ui-type-family-data);
  font-variant-numeric: tabular-nums;
}

@media (max-width: 560px) {
  .result-heading,
  .scenario-card header {
    align-items: flex-start;
    flex-direction: column;
    gap: var(--ui-space-2);
  }
}
</style>
