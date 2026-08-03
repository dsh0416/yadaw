<script setup lang="ts">
import { useI18n } from "vue-i18n"
import type { AudioBenchmarkReport } from "@heron/contracts"

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

<style scoped>
.score-panel {
  display: grid;
  grid-template-columns: minmax(12rem, 0.8fr) minmax(0, 1.8fr);
  align-items: stretch;
  min-height: 8rem;
  overflow: hidden;
  border: 1px solid var(--ui-color-border-strong);
  border-radius: var(--ui-radius-lg);
  background: var(--ui-color-surface-raised);
}

.score-copy,
.rating-copy {
  display: grid;
  align-content: center;
  padding: var(--ui-space-5) var(--ui-space-6);
}

.score-copy {
  border-right: 1px solid var(--ui-color-border);
  background: var(--ui-color-canvas-subtle);
}

.kicker {
  color: var(--ui-color-text-subtle);
  font: var(--ui-type-weight-semibold) var(--ui-font-size-xs) var(--ui-type-family-data);
  letter-spacing: var(--ui-type-tracking-wider);
  text-transform: uppercase;
}

.score-copy strong {
  display: flex;
  align-items: baseline;
  gap: var(--ui-space-2);
  margin-top: var(--ui-space-2);
  color: var(--ui-color-text);
  font: var(--ui-type-weight-semibold) var(--ui-font-size-2xl) var(--ui-type-family-data);
  font-variant-numeric: tabular-nums;
}

.score-copy small {
  color: var(--ui-color-text-muted);
  font: var(--ui-font-size-xs) var(--ui-type-family-interface);
}

.rating-copy span {
  color: var(--ui-color-text);
  font-size: var(--ui-font-size-lg);
  font-weight: var(--ui-type-weight-semibold);
  line-height: var(--ui-type-leading-tight);
}

.rating-copy p {
  margin: var(--ui-space-2) 0 0;
  color: var(--ui-color-text-muted);
  font-size: var(--ui-font-size-sm);
  line-height: var(--ui-type-leading-normal);
}

.rating-limited {
  border-color: color-mix(in srgb, var(--ui-color-danger) 62%, var(--ui-color-border));
}

.rating-basic {
  border-color: color-mix(in srgb, var(--ui-color-warning) 62%, var(--ui-color-border));
}

.rating-good {
  border-color: color-mix(in srgb, var(--ui-signal-audio) 62%, var(--ui-color-border));
}

.rating-excellent {
  border-color: color-mix(in srgb, var(--ui-color-success) 62%, var(--ui-color-border));
}

@media (max-width: 700px) {
  .score-panel {
    grid-template-columns: 1fr;
  }

  .score-copy {
    border-right: 0;
    border-bottom: 1px solid var(--ui-color-border);
  }
}
</style>
