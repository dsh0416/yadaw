<script setup lang="ts">
import { YadawLogo } from "@yadaw/ui"
import { computed, onMounted } from "vue"
import { useStartupStore } from "../stores/startup"

const startup = useStartupStore()
const projectUrl = "https://github.com/dsh0416/yadaw"
const appVersion = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.0.0"
const percentage = computed(() => Math.round(startup.progress.progress * 100))

onMounted(() => void startup.load())
</script>

<template>
  <main class="splash-shell" :data-phase="startup.progress.phase">
    <header class="brand">
      <h1 class="brand-heading"><YadawLogo class="brand-logo" /></h1>
      <p class="project-url">{{ projectUrl }}</p>
      <p class="version">v{{ appVersion }}</p>
    </header>

    <section class="startup-status" aria-live="polite">
      <div class="status-heading">
        <p>{{ startup.progress.label }}</p>
        <strong>{{ percentage }}%</strong>
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
      </div>
    </section>
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
  font-family: var(--ui-type-family-interface);
  user-select: none;
}

.splash-shell {
  position: relative;
  display: grid;
  grid-template-rows: 1fr auto;
  width: 100%;
  height: 100%;
  padding: 44px 48px 40px;
  overflow: hidden;
  border: 1px solid var(--ui-color-border);
  background:
    radial-gradient(
      circle at 50% 34%,
      color-mix(in srgb, var(--ui-signal-audio) 8%, transparent),
      transparent 42%
    ),
    var(--ui-color-canvas-subtle);
  box-shadow: var(--ui-shadow-highlight-inset);
  -webkit-app-region: drag;
}

.brand {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  align-self: stretch;
  text-align: center;
}

.brand-heading {
  margin: 0;
}

.brand-logo {
  --yadaw-logo-highlight: var(--ui-signal-midi);
  --yadaw-logo-lockup-wordmark-size: 0.62em;

  color: var(--ui-color-text);
  font-size: 72px;
}

.project-url,
.version,
.status-heading {
  font-family: var(--ui-type-family-data);
}

.project-url {
  margin: 22px 0 0;
  color: var(--ui-color-text-subtle);
  font-size: var(--ui-type-size-control);
  letter-spacing: var(--ui-type-tracking-normal);
}

.version {
  margin: 8px 0 0;
  color: var(--ui-color-text-muted);
  font-size: var(--ui-type-size-caption);
  letter-spacing: var(--ui-type-tracking-wide);
  font-variant-numeric: tabular-nums;
}

.startup-status {
  width: 100%;
}

.status-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
  color: var(--ui-color-text-subtle);
  font-size: var(--ui-type-size-control);
}

.status-heading p {
  margin: 0;
  overflow: hidden;
  letter-spacing: var(--ui-type-tracking-normal);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status-heading > strong {
  color: var(--ui-color-text);
  font-weight: var(--ui-type-weight-semibold);
  font-variant-numeric: tabular-nums;
}

.progress-track {
  position: relative;
  height: 8px;
  overflow: hidden;
  border: 1px solid var(--ui-color-border);
  border-radius: 999px;
  background: var(--ui-color-canvas);
  box-shadow: var(--ui-shadow-highlight-inset);
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

.splash-shell[data-phase="failed"] .status-heading {
  color: var(--ui-color-danger);
}

.splash-shell[data-phase="failed"] .progress-fill {
  background: var(--ui-color-danger);
  box-shadow: var(--ui-focus-ring);
}

@media (prefers-reduced-motion: reduce) {
  .progress-fill {
    transition: none;
  }
}
</style>
