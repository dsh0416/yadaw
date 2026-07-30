<script setup lang="ts">
import { useI18n } from "vue-i18n"
import type { AudioBenchmarkScenario } from "@yadaw/contracts"

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
        <strong>{{ format(scenario.p99BlockMs, 3) }}<small> {{ t("benchmark.scenarios.p99Unit") }}</small></strong>
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
        <span>{{ t("benchmark.scenarios.budget", { ms: format(scenario.bufferBudgetMs, 3) }) }}</span>
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
