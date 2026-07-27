<script setup lang="ts">
import { YadawLogo } from "@yadaw/ui"
import { computed, onMounted } from "vue"
import { useStartupStore } from "../stores/startup"

const startup = useStartupStore()
const percentage = computed(() => Math.round(startup.progress.progress * 100))
const scanCount = computed(() => {
  if (startup.progress.completed === null || startup.progress.total === null) return null
  return `${startup.progress.completed} / ${startup.progress.total}`
})

onMounted(() => void startup.load())
</script>

<template>
  <main class="splash-shell" :data-phase="startup.progress.phase">
    <div class="signal-field" aria-hidden="true">
      <i v-for="index in 24" :key="index" :style="{ '--index': index }" />
    </div>

    <header class="brand">
      <div class="brand-mark" aria-hidden="true">
        <YadawLogo class="brand-mark-logo" variant="mark" decorative />
      </div>
      <div>
        <p>DIGITAL AUDIO WORKSTATION</p>
        <h1><YadawLogo variant="wordmark" /></h1>
      </div>
      <b>STARTUP / VST3 INDEX</b>
    </header>

    <section class="startup-status" aria-live="polite">
      <div class="status-heading">
        <div>
          <p>{{ startup.progress.phase === "failed" ? "STARTUP INTERRUPTED" : "NOW LOADING" }}</p>
          <h2>{{ startup.progress.label }}</h2>
        </div>
        <strong>{{ percentage }}<small>%</small></strong>
      </div>

      <div
        class="progress-track"
        role="progressbar"
        :aria-label="startup.progress.label"
        aria-valuemin="0"
        aria-valuemax="100"
        :aria-valuenow="percentage"
      >
        <span class="progress-fill" :style="{ width: `${percentage}%` }" />
        <i v-for="tick in 16" :key="tick" aria-hidden="true" />
      </div>

      <div class="progress-detail">
        <span class="activity-dot" aria-hidden="true" />
        <p :title="startup.progress.detail">{{ startup.progress.detail }}</p>
        <b v-if="scanCount">{{ scanCount }}</b>
      </div>
    </section>

    <footer>
      <span>{{
        startup.progress.warnings > 0
          ? `${startup.progress.warnings} plug-ins quarantined`
          : "SAFE SCAN"
      }}</span>
      <span>64-BIT AUDIO ENGINE</span>
    </footer>
  </main>
</template>

<style scoped>
:global(*) {
  box-sizing: border-box;
}

:global(html),
:global(body),
:global(#splash-root) {
  width: 100%;
  height: 100%;
  margin: 0;
  overflow: hidden;
}

:global(body) {
  color: var(--ui-color-text);
  background: var(--ui-color-canvas);
  font-family: "Segoe UI Variable", "Aptos", "Helvetica Neue", sans-serif;
  user-select: none;
}

.splash-shell {
  position: relative;
  display: grid;
  grid-template-rows: auto 1fr auto;
  width: 100%;
  height: 100%;
  padding: 30px 34px 24px;
  overflow: hidden;
  border: 1px solid var(--ui-color-border);
  background:
    linear-gradient(
      115deg,
      color-mix(in srgb, var(--ui-signal-audio) 7%, transparent),
      transparent 38%
    ),
    radial-gradient(
      circle at 86% 13%,
      color-mix(in srgb, var(--ui-signal-midi) 12%, transparent),
      transparent 32%
    ),
    var(--ui-color-canvas-subtle);
  box-shadow: var(--ui-shadow-highlight-inset);
  -webkit-app-region: drag;
}

.splash-shell::before {
  position: absolute;
  inset: 0;
  opacity: 0.12;
  background-image: linear-gradient(
    color-mix(in srgb, var(--ui-color-text) 8%, transparent) 1px,
    transparent 1px
  );
  background-size: 100% 4px;
  content: "";
  pointer-events: none;
}

.signal-field {
  position: absolute;
  top: 108px;
  right: 22px;
  left: 22px;
  display: flex;
  align-items: center;
  height: 82px;
  gap: 5px;
  opacity: 0.13;
  pointer-events: none;
}

.signal-field i {
  flex: 1;
  height: calc(12px + (var(--index) % 7) * 8px);
  border-radius: 1px;
  background: linear-gradient(var(--ui-signal-midi), var(--ui-signal-audio));
  transform: scaleY(0.75);
  transform-origin: center;
  animation: meter 1.6s ease-in-out infinite alternate;
  animation-delay: calc(var(--index) * -55ms);
}

.brand {
  position: relative;
  display: grid;
  grid-template-columns: 42px 1fr auto;
  align-items: center;
  gap: 13px;
  z-index: var(--ui-z-local-content);
}

.brand-mark {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 42px;
  gap: 3px;
  border: 1px solid var(--ui-color-border-strong);
  background: var(--ui-color-surface);
  box-shadow: var(--ui-shadow-selected-outline);
}

.brand-mark-logo {
  --yadaw-logo-highlight: var(--ui-signal-midi);

  color: var(--ui-signal-audio);
  font-size: 30px;
}

.brand p,
.startup-status p,
footer {
  font-family: "Cascadia Mono", "SFMono-Regular", Consolas, monospace;
  letter-spacing: 0.13em;
}

.brand p {
  margin: 0 0 2px;
  color: var(--ui-color-text-subtle);
  font-size: 7px;
  font-weight: 700;
}

.brand h1 {
  margin: 0;
  color: var(--ui-color-text);
  font-size: 23px;
  line-height: 1;
}

.brand > b {
  align-self: start;
  padding: 5px 7px;
  border: 1px solid var(--ui-color-border);
  color: var(--ui-color-text-subtle);
  background: color-mix(in srgb, var(--ui-color-canvas) 52%, transparent);
  font:
    600 7px "Cascadia Mono",
    Consolas,
    monospace;
  letter-spacing: 0.08em;
}

.startup-status {
  position: relative;
  align-self: end;
  z-index: var(--ui-z-local-content);
}

.status-heading {
  display: flex;
  align-items: end;
  justify-content: space-between;
  min-height: 94px;
  margin-bottom: 14px;
}

.status-heading p {
  margin: 0 0 7px;
  color: var(--ui-signal-audio);
  font-size: 7px;
  font-weight: 700;
}

.status-heading h2 {
  max-width: 430px;
  margin: 0;
  overflow: hidden;
  font-size: 19px;
  font-weight: 520;
  letter-spacing: -0.02em;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status-heading > strong {
  color: var(--ui-color-text);
  font:
    300 44px/0.9 "Segoe UI Variable",
    sans-serif;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.07em;
}

.status-heading > strong small {
  margin-left: 3px;
  color: var(--ui-color-text-subtle);
  font-size: 12px;
  letter-spacing: 0;
}

.progress-track {
  position: relative;
  display: grid;
  grid-template-columns: repeat(16, 1fr);
  height: 14px;
  overflow: hidden;
  border: 1px solid var(--ui-color-border);
  background: var(--ui-color-canvas);
  box-shadow: var(--ui-shadow-sm);
}

.progress-track > i {
  border-right: 1px solid color-mix(in srgb, var(--ui-color-text) 8%, transparent);
  z-index: var(--ui-z-local-raised);
}

.progress-fill {
  position: absolute;
  inset: 0 auto 0 0;
  min-width: 2px;
  background:
    linear-gradient(
      90deg,
      color-mix(in srgb, var(--ui-signal-audio) 76%, var(--ui-color-canvas)),
      var(--ui-signal-audio) 72%,
      var(--ui-signal-midi)
    ),
    var(--ui-signal-audio);
  box-shadow: var(--ui-shadow-selected-outline);
  transition: width 180ms ease-out;
}

.progress-fill::after {
  position: absolute;
  inset: 0 0 0 auto;
  width: 18px;
  background: linear-gradient(
    90deg,
    transparent,
    color-mix(in srgb, var(--ui-color-text) 72%, transparent)
  );
  content: "";
  animation: head-pulse 700ms ease-in-out infinite alternate;
}

.progress-detail {
  display: grid;
  grid-template-columns: 7px minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  min-height: 30px;
  color: var(--ui-color-text-subtle);
  font:
    8px "Cascadia Mono",
    Consolas,
    monospace;
}

.progress-detail p {
  margin: 0;
  overflow: hidden;
  letter-spacing: 0;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.progress-detail b {
  color: var(--ui-color-text-muted);
  font-variant-numeric: tabular-nums;
}

.activity-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--ui-signal-audio);
  box-shadow: var(--ui-shadow-selected-outline);
  animation: head-pulse 650ms ease-in-out infinite alternate;
}

footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: 12px;
  border-top: 1px solid var(--ui-color-border);
  color: var(--ui-color-text-subtle);
  font-size: 6px;
  font-weight: 700;
  z-index: var(--ui-z-local-content);
}

.splash-shell[data-phase="failed"] .status-heading p,
.splash-shell[data-phase="failed"] .progress-detail,
.splash-shell[data-phase="failed"] .activity-dot {
  color: var(--ui-color-danger);
}

.splash-shell[data-phase="failed"] .activity-dot,
.splash-shell[data-phase="failed"] .progress-fill {
  background: var(--ui-color-danger);
  box-shadow: var(--ui-focus-ring);
}

@keyframes meter {
  to {
    transform: scaleY(1);
  }
}

@keyframes head-pulse {
  from {
    opacity: 0.38;
  }
  to {
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .signal-field i,
  .progress-fill::after,
  .activity-dot {
    animation: none;
  }

  .progress-fill {
    transition: none;
  }
}
</style>
