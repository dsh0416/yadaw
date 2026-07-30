<script setup lang="ts">
import { useI18n } from "vue-i18n"
import type { AudioBenchmarkReport } from "@yadaw/contracts"

defineProps<{
  report: AudioBenchmarkReport
  rating: { label: string; summary: string }
}>()

const { t } = useI18n()

function deadlineHeadroom(report: AudioBenchmarkReport): number {
  return Math.max(0, 100 - report.worstP99DeadlineUtilizationPercent)
}
</script>

<template>
  <section class="score-panel" :class="`rating-${report.rating}`">
    <div class="score-copy">
      <span class="kicker">{{ t("benchmark.summary.kicker") }}</span>
      <strong
        >{{ deadlineHeadroom(report).toFixed(0)
        }}<small>{{ t("benchmark.summary.headroom") }}</small></strong
      >
    </div>
    <div class="rating-copy">
      <span>{{ rating.label }}</span>
      <p>{{ rating.summary }}</p>
    </div>
  </section>
</template>
