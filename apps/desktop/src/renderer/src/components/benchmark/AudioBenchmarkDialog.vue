<script setup lang="ts">
import { computed, onMounted, useTemplateRef } from "vue"
import type {
  AudioBenchmarkRating,
  AudioBenchmarkReport,
  AudioBenchmarkScenario,
  AudioIpcBenchmarkScenario
} from "@yadaw/contracts"
import type { AudioBenchmarkStatus } from "../../stores/audioBenchmark"

const props = defineProps<{
  status: AudioBenchmarkStatus
  report: AudioBenchmarkReport | null
  errorMessage: string
}>()

const emit = defineEmits<{
  close: []
  run: []
}>()

const dialog = useTemplateRef<HTMLElement>("dialog")

const ratingCopy: Record<AudioBenchmarkRating, { label: string; summary: string }> = {
  limited: {
    label: "Limited headroom",
    summary: "Use larger buffers and keep sessions compact for reliable playback."
  },
  basic: {
    label: "Basic",
    summary: "Suitable for focused projects with moderate track and routing counts."
  },
  good: {
    label: "Good",
    summary: "Comfortable real-time capacity for most production sessions."
  },
  excellent: {
    label: "Excellent",
    summary: "Strong real-time headroom for dense sessions and low-latency work."
  }
}

const rating = computed(() => (props.report ? ratingCopy[props.report.rating] : null))
const measuredAt = computed(() =>
  props.report ? new Date(props.report.measuredAt).toLocaleString() : ""
)

function format(value: number, digits = 1): string {
  return value.toFixed(digits)
}

function budgetUsePercent(scenario: AudioBenchmarkScenario): number {
  return Math.min(100, scenario.p99DeadlineUtilizationPercent)
}

function deadlineHeadroom(report: AudioBenchmarkReport): number {
  return Math.max(0, 100 - report.worstP99DeadlineUtilizationPercent)
}

function formatLatency(value: number | null): string {
  if (value === null) return "—"
  return value >= 1_000 ? `${format(value / 1_000, 2)} ms` : `${format(value, 1)} µs`
}

function formatPayload(bytes: number): string {
  if (bytes === 0) return "shared page"
  if (bytes >= 1024 * 1024) return `${format(bytes / (1024 * 1024), 1)} MiB`
  if (bytes >= 1024) return `${format(bytes / 1024, bytes % 1024 === 0 ? 0 : 1)} KiB`
  return `${bytes} B`
}

function ipcRate(scenario: AudioIpcBenchmarkScenario): string {
  return scenario.throughputMiBPerSecond === null
    ? `${format(scenario.operationsPerSecond / 1_000, 1)}k reads/s`
    : `${format(scenario.throughputMiBPerSecond, 1)} MiB/s`
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") emit("close")
}

onMounted(() => dialog.value?.focus())
</script>

<template>
  <section
    ref="dialog"
    class="benchmark-dialog"
    role="dialog"
    aria-modal="true"
    aria-labelledby="audio-benchmark-title"
    tabindex="-1"
    @keydown="handleKeydown"
  >
    <header class="dialog-header">
      <div>
        <span class="kicker">SYSTEM / AUDIO ENGINE</span>
        <h2 id="audio-benchmark-title">Audio performance benchmark</h2>
      </div>
      <button class="icon-button" type="button" aria-label="Close benchmark" @click="emit('close')">
        ×
      </button>
    </header>

    <div v-if="status === 'idle'" class="intro-state">
      <div class="signal-map" aria-hidden="true">
        <span v-for="track in 6" :key="track" class="signal-track" />
        <span class="signal-bus">DSP</span>
        <span class="signal-output" />
      </div>
      <h3>Measure DSP deadlines and IPC</h3>
      <p>
        YADAW will measure block deadline stability, shared-memory transfers, concurrent request
        routing, and telemetry reads. It does not use your audio devices.
      </p>
      <div class="notice">
        <span>Before you run it</span>
        <p>
          Pause playback and close CPU-heavy apps. Audio may stutter while the processor is under
          test.
        </p>
      </div>
      <button class="primary-button" type="button" @click="emit('run')">Run benchmark</button>
    </div>

    <div v-else-if="status === 'running'" class="running-state" aria-live="polite">
      <div class="scope" aria-hidden="true">
        <span v-for="lane in 3" :key="lane" :style="{ '--lane': lane }" />
      </div>
      <span class="kicker">MEASURING</span>
      <h3>Measuring engine paths…</h3>
      <p>Block deadlines · IPC round trips · Shared pages</p>
      <div class="progress-track"><span /></div>
    </div>

    <div v-else-if="status === 'complete' && report && rating" class="report-state">
      <section class="score-panel" :class="`rating-${report.rating}`">
        <div class="score-copy">
          <span class="kicker">WORST P99 DEADLINE</span>
          <strong>{{ format(deadlineHeadroom(report), 0) }}<small>% headroom</small></strong>
        </div>
        <div class="rating-copy">
          <span>{{ rating.label }}</span>
          <p>{{ rating.summary }}</p>
        </div>
      </section>

      <div class="result-heading">
        <div>
          <span class="kicker">REAL-TIME DSP</span>
          <h3>Block deadline stability</h3>
        </div>
        <small>p99 timing is primary · real-time factor is diagnostic</small>
      </div>

      <div class="scenario-list">
        <article v-for="scenario in report.scenarios" :key="scenario.id" class="scenario-card">
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
            <span>{{ scenario.tracks }} tracks</span>
            <span>{{ scenario.buses }} buses</span>
            <span>{{ scenario.sends }} sends</span>
            <span>{{ scenario.blockSize }} samples</span>
            <span>{{ format(scenario.bufferBudgetMs, 3) }} ms budget</span>
            <span>{{ scenario.deadlineMisses }} / {{ scenario.measuredBlocks }} late</span>
            <span>{{ format(scenario.realtimeFactor) }}× real time</span>
          </div>
        </article>
      </div>

      <div class="result-heading ipc-heading">
        <div>
          <span class="kicker">PROCESS BOUNDARY</span>
          <h3>IPC transport</h3>
        </div>
        <small>{{ format(report.ipc.durationMs, 0) }} ms suite</small>
      </div>

      <div class="ipc-table">
        <div class="ipc-row ipc-table-header" aria-hidden="true">
          <span>Path</span>
          <span>Payload</span>
          <span>P50</span>
          <span>P99</span>
          <span>Rate</span>
        </div>
        <div v-for="scenario in report.ipc.scenarios" :key="scenario.id" class="ipc-row">
          <span class="ipc-name">
            <strong>{{ scenario.label }}</strong>
            <small>{{ scenario.description }}</small>
          </span>
          <span>{{ formatPayload(scenario.payloadBytes) }}</span>
          <span>{{ formatLatency(scenario.latencyP50Us) }}</span>
          <span>{{ formatLatency(scenario.latencyP99Us) }}</span>
          <span class="ipc-rate">{{ ipcRate(scenario) }}</span>
        </div>
      </div>
      <p class="ipc-diagnostics-note">
        <b>{{ report.ipc.buildProfile.toUpperCase() }}</b>
        · {{ report.ipc.runtime.workerThreads }} workers /
        {{ report.ipc.runtime.maxBlockingThreads }} blocking /
        {{ report.ipc.runtime.egressConcurrency }} egress · {{ report.ipc.arenaOffers }} arena
        offers · {{ formatPayload(report.ipc.messagePackBodyBytes) }} MessagePack body
        <template v-if="report.ipc.buildProfile === 'debug'">
          · Diagnostic only; formal bandwidth grading uses a release build.
        </template>
      </p>

      <footer class="report-footer">
        <div>
          <span>{{ report.system.cpuModel }}</span>
          <small
            >{{ report.system.logicalCores }} logical cores · {{ report.system.platform }} ·
            {{ report.system.architecture }}</small
          >
          <small>Measured {{ measuredAt }} in {{ format(report.durationMs / 1_000, 2) }} s</small>
        </div>
        <div class="report-actions">
          <button class="secondary-button" type="button" @click="emit('close')">Close</button>
          <button class="primary-button compact" type="button" @click="emit('run')">
            Run again
          </button>
        </div>
      </footer>
    </div>

    <div v-else class="error-state" role="alert">
      <span class="kicker">BENCHMARK INTERRUPTED</span>
      <h3>Performance test did not finish</h3>
      <p>{{ errorMessage }}</p>
      <div class="error-actions">
        <button class="secondary-button" type="button" @click="emit('close')">Close</button>
        <button class="primary-button compact" type="button" @click="emit('run')">Try again</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.benchmark-dialog {
  width: min(860px, calc(100vw - 48px));
  max-height: calc(100vh - 56px);
  overflow: auto;
  border: 1px solid #303b4c;
  border-radius: 14px;
  outline: none;
  color: var(--text-primary);
  background: #0d131dcf;
  box-shadow:
    0 34px 110px #000e,
    inset 0 1px #ffffff08;
  backdrop-filter: blur(22px);
}

.ipc-diagnostics-note {
  margin: 10px 0 0;
  color: var(--text-faint);
  font: 7px var(--font-utility);
  letter-spacing: 0.02em;
}
.ipc-diagnostics-note b {
  color: var(--signal-cyan);
}

.dialog-header {
  position: sticky;
  z-index: 2;
  top: 0;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding: 22px 24px 17px;
  border-bottom: 1px solid var(--line-soft);
  background: #0d131df2;
  backdrop-filter: blur(18px);
}

.kicker {
  color: var(--signal-cyan);
  font: 700 7px var(--font-utility);
  letter-spacing: 0.18em;
}

.dialog-header h2 {
  margin: 7px 0 0;
  font: 600 20px var(--font-display);
  letter-spacing: 0.015em;
}

.icon-button {
  width: 28px;
  height: 28px;
  border: 1px solid transparent;
  border-radius: 7px;
  color: var(--text-muted);
  background: transparent;
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
}

.icon-button:hover,
.icon-button:focus-visible {
  border-color: var(--line-strong);
  color: var(--text-primary);
  background: var(--surface-3);
  outline: none;
}

.intro-state,
.running-state,
.error-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 42px 48px 44px;
  text-align: center;
}

.intro-state h3,
.running-state h3,
.error-state h3 {
  margin: 24px 0 8px;
  font: 600 22px var(--font-display);
}

.intro-state > p,
.running-state > p,
.error-state > p {
  max-width: 510px;
  margin: 0;
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1.7;
}

.signal-map {
  position: relative;
  display: grid;
  grid-template-columns: repeat(6, 34px) 68px 44px;
  align-items: center;
  gap: 8px;
  height: 72px;
}

.signal-track {
  width: 34px;
  height: 42px;
  border: 1px solid #2c3849;
  border-radius: 6px;
  background:
    linear-gradient(90deg, transparent 46%, #657187 47% 53%, transparent 54%),
    linear-gradient(#151d29, #101722);
}

.signal-track::after {
  content: "";
  display: block;
  width: 4px;
  height: 4px;
  margin: 7px auto;
  border-radius: 50%;
  background: var(--signal-cyan);
  box-shadow: 0 0 10px #67d9e799;
}

.signal-bus {
  display: grid;
  place-items: center;
  height: 56px;
  border: 1px solid #5d57a1;
  border-radius: 8px;
  color: var(--accent-soft);
  background: #211f3a;
  font: 700 8px var(--font-utility);
  letter-spacing: 0.12em;
}

.signal-output {
  width: 34px;
  height: 8px;
  border-radius: 999px;
  background: linear-gradient(90deg, var(--accent), var(--signal-cyan));
  box-shadow: 0 0 18px #8c83ff55;
}

.notice {
  width: min(500px, 100%);
  margin: 27px 0 22px;
  padding: 12px 14px;
  border: 1px solid #3a3443;
  border-radius: 8px;
  text-align: left;
  background: #17151d;
}

.notice span {
  color: var(--warning);
  font: 700 8px var(--font-utility);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.notice p {
  margin: 5px 0 0;
  color: var(--text-muted);
  font-size: 9px;
  line-height: 1.5;
}

.primary-button,
.secondary-button {
  padding: 9px 16px;
  border: 1px solid transparent;
  border-radius: 7px;
  cursor: pointer;
}

.primary-button {
  color: #fff;
  background: linear-gradient(135deg, #7168e8, #625bc4);
  box-shadow: 0 8px 22px #514aa544;
}

.primary-button:hover,
.primary-button:focus-visible {
  border-color: #b7b1ff;
  background: linear-gradient(135deg, #8279f4, #6d65d4);
  outline: none;
}

.primary-button.compact,
.secondary-button {
  padding: 8px 12px;
  font-size: 10px;
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
  background: #080d14;
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
  filter: drop-shadow(0 0 5px #67d9e788);
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
  border: 1px solid #3f4263;
  border-radius: 10px;
  background:
    radial-gradient(circle at 18% 50%, #625bc42b, transparent 42%),
    linear-gradient(110deg, #16172a, #111923);
  overflow: hidden;
}

.score-copy {
  padding: 22px 24px;
  border-right: 1px solid #34374e;
}

.score-copy strong {
  display: flex;
  align-items: baseline;
  gap: 7px;
  margin-top: 8px;
  color: #f1f0ff;
  font: 600 34px var(--font-display);
}

.score-copy small {
  color: var(--text-muted);
  font: 8px var(--font-utility);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.rating-copy {
  padding: 22px 28px;
}

.rating-copy span {
  color: var(--accent-soft);
  font: 600 15px var(--font-display);
}

.rating-copy p {
  margin: 6px 0 0;
  color: var(--text-muted);
  font-size: 10px;
  line-height: 1.6;
}

.rating-limited {
  border-color: #76404b;
}
.rating-basic {
  border-color: #65543e;
}
.rating-good {
  border-color: #3a5961;
}
.rating-excellent {
  border-color: #514b88;
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
  font: 600 13px var(--font-display);
}

.result-heading > small {
  color: var(--text-faint);
  font: 7px var(--font-utility);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.scenario-card {
  padding: 14px 15px 12px;
  border: 1px solid var(--line-soft);
  border-radius: 8px;
  background: #0b111a;
}

.scenario-card header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.scenario-card h3 {
  margin: 0;
  font: 600 11px var(--font-display);
}

.scenario-card header p {
  margin: 3px 0 0;
  color: var(--text-faint);
  font-size: 8px;
}

.scenario-card header strong {
  color: var(--signal-cyan);
  font: 600 18px var(--font-display);
}

.scenario-card header strong small {
  color: var(--text-faint);
  font: 7px var(--font-utility);
  text-transform: uppercase;
}

.timing-lane {
  position: relative;
  height: 5px;
  margin: 12px 0 10px;
  border-radius: 999px;
  background: #202a38;
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
  font: 7px var(--font-utility);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.ipc-heading {
  margin-top: 24px;
}

.ipc-table {
  border: 1px solid var(--line-soft);
  border-radius: 8px;
  background: #090f17;
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
  font: 8px var(--font-utility);
  font-variant-numeric: tabular-nums;
}

.ipc-table-header {
  min-height: 28px;
  background: #101823;
}

.ipc-table-header > span {
  color: var(--text-faint);
  font-size: 7px;
  text-transform: uppercase;
  letter-spacing: 0.07em;
}

.ipc-name strong,
.ipc-name small {
  display: block;
}

.ipc-name strong {
  color: var(--text-secondary);
  font: 600 9px var(--font-display);
}

.ipc-name small {
  margin-top: 3px;
  color: var(--text-faint);
  font-size: 7px;
  line-height: 1.35;
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
  font-size: 9px;
}

.report-footer small {
  margin-top: 4px;
  color: var(--text-faint);
  font: 7px var(--font-utility);
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
  .intro-state,
  .running-state,
  .error-state {
    padding-inline: 24px;
  }
  .signal-map {
    transform: scale(0.82);
  }
  .score-panel {
    grid-template-columns: 1fr;
  }
  .score-copy {
    border-right: 0;
    border-bottom: 1px solid #34374e;
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
