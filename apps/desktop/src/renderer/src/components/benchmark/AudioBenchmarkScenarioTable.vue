<script setup lang="ts">
import type { AudioBenchmarkScenario } from "@yadaw/contracts"

defineProps<{ scenarios: readonly AudioBenchmarkScenario[] }>()
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
      <span class="kicker">REAL-TIME DSP</span>
      <h3>Block deadline stability</h3>
    </div>
    <small>p99 timing is primary · real-time factor is diagnostic</small>
  </div>
  <div class="scenario-list">
    <article v-for="scenario in scenarios" :key="scenario.id" class="scenario-card">
      <header>
        <div>
          <h3>{{ scenario.label }}</h3>
          <p>{{ scenario.description }}</p>
        </div>
        <strong>{{ format(scenario.p99BlockMs, 3) }}<small> ms p99</small></strong>
      </header>
      <div class="timing-lane">
        <span class="timing-fill" :style="{ width: `${budgetUsePercent(scenario)}%` }" />
        <span class="deadline-marker" />
      </div>
      <div class="scenario-meta">
        <span>{{ scenario.tracks }} tracks</span><span>{{ scenario.buses }} buses</span>
        <span>{{ scenario.sends }} sends</span><span>{{ scenario.plugins }} VST3 effects</span>
        <span>{{ scenario.blockSize }} samples</span>
        <span>{{ format(scenario.bufferBudgetMs, 3) }} ms budget</span>
        <span>{{ scenario.deadlineMisses }} / {{ scenario.measuredBlocks }} late</span>
        <span>{{ format(scenario.realtimeFactor) }}× real time</span>
      </div>
    </article>
  </div>
</template>
