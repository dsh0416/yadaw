<script setup lang="ts">
import type { ApplicationSettings, CreateProjectRequest } from "@heron/contracts"
import { HeronLogo } from "@heron/ui"
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import ProjectWelcomeRecent from "./ProjectWelcomeRecent.vue"

const props = defineProps<{
  settings: ApplicationSettings | null
  busy: boolean
  error: string
}>()

const emit = defineEmits<{
  create: [request: CreateProjectRequest]
  open: [path?: string]
}>()

const { t } = useI18n()
const recentProjects = computed(() => props.settings?.recentProjects ?? [])

function createProject(): void {
  emit("create", {
    name: t("welcome.untitledProject"),
    sampleRate: 48_000,
    timeSignatureNumerator: 4,
    timeSignatureDenominator: 4,
    waveformDisplayMode: "separate"
  })
}
</script>

<template>
  <main class="project-welcome">
    <div class="project-welcome__atmosphere" aria-hidden="true">
      <span class="project-welcome__orb" />
      <svg class="project-welcome__wave" viewBox="0 0 760 220" preserveAspectRatio="none">
        <defs>
          <filter
            id="welcome-wave-shadow-motion"
            x="-8%"
            y="-40%"
            width="116%"
            height="180%"
            color-interpolation-filters="sRGB"
          >
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.008 0.035"
              numOctaves="2"
              seed="2"
              result="wave-noise"
            >
              <animate
                attributeName="seed"
                dur="8s"
                values="2;11;5;17;3;13;7;2"
                calcMode="discrete"
                repeatCount="indefinite"
              />
              <animate
                attributeName="baseFrequency"
                dur="8s"
                values="0.008 0.035;0.012 0.052;0.006 0.041;0.015 0.03;0.008 0.035"
                repeatCount="indefinite"
              />
            </feTurbulence>
            <feDisplacementMap
              in="SourceGraphic"
              in2="wave-noise"
              scale="7"
              xChannelSelector="R"
              yChannelSelector="B"
              result="displaced-wave"
            >
              <animate
                attributeName="scale"
                dur="2s"
                values="5;15;6;5;12;6;5;13;6;5;11;6;5"
                keyTimes="0;0.04;0.16;0.25;0.29;0.41;0.5;0.54;0.66;0.75;0.79;0.91;1"
                repeatCount="indefinite"
              />
            </feDisplacementMap>
            <feGaussianBlur in="displaced-wave" stdDeviation="3">
              <animate
                attributeName="stdDeviation"
                dur="2s"
                values="2.5;4.8;2.8;2.5;4.1;2.8;2.5;4.4;2.8;2.5;3.8;2.8;2.5"
                keyTimes="0;0.04;0.16;0.25;0.29;0.41;0.5;0.54;0.66;0.75;0.79;0.91;1"
                repeatCount="indefinite"
              />
            </feGaussianBlur>
          </filter>
        </defs>
        <path class="project-welcome__wave-grid" d="M0 44H760M0 88H760M0 132H760M0 176H760" />
        <path
          class="project-welcome__waveform project-welcome__waveform--back project-welcome__waveform--motion"
          filter="url(#welcome-wave-shadow-motion)"
          d="M0 113C18 113 22 105 40 105S62 122 80 122s22-46 40-46 22 77 40 77 22-30 40-30 22-13 40-13 22 34 40 34 22-71 40-71 22 43 40 43 22-19 40-19 22 7 40 7 22 41 40 41 22-82 40-82 22 59 40 59 22-21 40-21 22 17 40 17 22-35 40-35 22 27 40 27 22-9 40-9 22-14 40-14 22 26 40 26"
        />
        <path
          class="project-welcome__waveform project-welcome__waveform--back project-welcome__waveform--static"
          d="M0 113C18 113 22 105 40 105S62 122 80 122s22-46 40-46 22 77 40 77 22-30 40-30 22-13 40-13 22 34 40 34 22-71 40-71 22 43 40 43 22-19 40-19 22 7 40 7 22 41 40 41 22-82 40-82 22 59 40 59 22-21 40-21 22 17 40 17 22-35 40-35 22 27 40 27 22-9 40-9 22-14 40-14 22 26 40 26"
        />
        <path
          class="project-welcome__waveform"
          d="M0 108C18 108 22 101 40 101S62 117 80 117s22-42 40-42 22 68 40 68 22-27 40-27 22-12 40-12 22 31 40 31 22-64 40-64 22 39 40 39 22-17 40-17 22 6 40 6 22 37 40 37 22-74 40-74 22 53 40 53 22-19 40-19 22 15 40 15 22-32 40-32 22 25 40 25 22-8 40-8 22-13 40-13 22 23 40 23"
        />
        <g class="project-welcome__playhead">
          <path d="M0 11V209" />
          <circle cx="0" cy="11" r="5" />
        </g>
      </svg>
    </div>

    <section class="project-welcome__hero" aria-labelledby="welcome-heading">
      <HeronLogo class="project-welcome__logo" />

      <div class="project-welcome__copy">
        <p class="project-welcome__eyebrow">{{ t("welcome.eyebrow") }}</p>
        <h1 id="welcome-heading" class="project-welcome__headline">
          <span>{{ t("welcome.headline") }}</span>
          {{ " " }}
          <span class="project-welcome__headline-accent">{{ t("welcome.headlineAccent") }}</span>
        </h1>
        <p class="project-welcome__body">{{ t("welcome.body") }}</p>
      </div>
    </section>

    <aside class="project-welcome__launchpad" :aria-label="t('welcome.actionsLabel')">
      <section class="project-welcome__new-project" aria-labelledby="new-project-heading">
        <div class="project-welcome__section-label">
          <span class="project-welcome__label-mark" aria-hidden="true">
            <svg viewBox="0 0 20 20">
              <path d="M10 3v14M3 10h14" />
            </svg>
          </span>
          {{ t("welcome.newProjectLabel") }}
        </div>
        <h2 id="new-project-heading">{{ t("welcome.newProjectTitle") }}</h2>
        <p>{{ t("welcome.newProjectBody") }}</p>
        <button
          class="project-welcome__create"
          type="button"
          :disabled="props.busy"
          @click="createProject"
        >
          <span>{{ props.busy ? t("welcome.creating") : t("welcome.createProject") }}</span>
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path d="M5 12h14M14 7l5 5-5 5" />
          </svg>
        </button>
      </section>

      <ProjectWelcomeRecent
        :projects="recentProjects"
        :busy="props.busy"
        @open="emit('open', $event)"
      />
    </aside>

    <p v-if="props.error" role="alert" class="project-welcome__error">{{ props.error }}</p>
  </main>
</template>

<style scoped>
.project-welcome {
  position: relative;
  isolation: isolate;
  display: grid;
  width: 100%;
  height: 100%;
  grid-template-columns: minmax(0, 1.2fr) minmax(330px, 0.8fr);
  gap: clamp(32px, 6vw, 96px);
  padding: clamp(34px, 5.5vw, 76px);
  overflow: auto;
  color: var(--text-primary);
  background:
    radial-gradient(
      circle at 12% 18%,
      color-mix(in srgb, var(--accent) 12%, transparent),
      transparent 30%
    ),
    linear-gradient(
      125deg,
      var(--canvas) 0%,
      color-mix(in srgb, var(--canvas) 94%, var(--surface-3)) 100%
    );
}

.project-welcome__atmosphere {
  position: absolute;
  z-index: var(--ui-z-local-base);
  inset: 0;
  overflow: hidden;
  pointer-events: none;
}

.project-welcome__orb {
  position: absolute;
  top: 8%;
  left: 34%;
  width: min(36vw, 520px);
  aspect-ratio: 1;
  border: 1px solid color-mix(in srgb, var(--accent) 12%, transparent);
  border-radius: 50%;
  opacity: 0.6;
  transform: translate(-50%, -50%);
}

.project-welcome__orb::before,
.project-welcome__orb::after {
  position: absolute;
  border: inherit;
  border-radius: inherit;
  content: "";
}

.project-welcome__orb::before {
  inset: 18%;
}

.project-welcome__orb::after {
  inset: 38%;
}

.project-welcome__wave {
  position: absolute;
  bottom: 2%;
  left: -3%;
  width: min(61vw, 840px);
  height: 29%;
  min-height: 180px;
  opacity: 0.42;
}

.project-welcome__wave-grid {
  fill: none;
  stroke: color-mix(in srgb, var(--line-soft) 72%, transparent);
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}

.project-welcome__waveform {
  fill: none;
  stroke: var(--signal-cyan);
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 2;
  vector-effect: non-scaling-stroke;
}

.project-welcome__waveform--back {
  opacity: 0.36;
  stroke-width: 12;
}

.project-welcome__waveform--static {
  display: none;
}

.project-welcome__playhead {
  color: var(--accent-soft);
  animation: welcome-playhead 8s linear infinite;
}

.project-welcome__playhead path {
  fill: none;
  stroke: currentColor;
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}

.project-welcome__playhead circle {
  fill: currentColor;
}

.project-welcome__hero {
  position: relative;
  z-index: var(--ui-z-local-content);
  display: grid;
  min-width: 0;
  align-content: space-between;
}

.project-welcome__logo {
  --heron-logo-highlight: var(--signal-cyan);

  justify-self: start;
  color: var(--text-secondary);
  font-size: var(--ui-font-size-xl);
}

.project-welcome__copy {
  max-width: 700px;
  margin: clamp(54px, 10vh, 124px) 0 clamp(130px, 21vh, 230px);
}

.project-welcome__eyebrow,
.project-welcome__section-label {
  color: var(--accent-soft);
  font: var(--ui-type-weight-bold) var(--ui-font-size-xs) / var(--ui-type-leading-tight)
    var(--ui-type-family-data);
  letter-spacing: var(--ui-type-tracking-widest);
  text-transform: uppercase;
}

.project-welcome__headline {
  margin: 18px 0 22px;
  font-family: var(--ui-type-family-display);
  font-size: clamp(var(--ui-font-size-5xl), 7.6vw, calc(var(--ui-font-size-5xl) * 1.6));
  font-weight: var(--ui-type-weight-semibold);
  line-height: var(--ui-type-leading-none);
  letter-spacing: var(--ui-type-tracking-tight);
  text-wrap: balance;
}

.project-welcome__headline > span {
  display: block;
}

.project-welcome__headline-accent {
  color: var(--accent-soft);
  font-style: italic;
}

.project-welcome__body {
  max-width: 560px;
  margin: 0;
  color: var(--text-muted);
  font-size: clamp(var(--ui-font-size-md), 1.35vw, var(--ui-font-size-lg));
  line-height: var(--ui-type-leading-relaxed);
  text-wrap: pretty;
}

.project-welcome__launchpad {
  position: relative;
  z-index: var(--ui-z-local-content);
  align-self: center;
  min-width: 0;
  max-height: 100%;
  padding: clamp(22px, 3vw, 38px);
  border: 1px solid color-mix(in srgb, var(--line-strong) 82%, transparent);
  border-radius: 3px 28px;
  background: color-mix(in srgb, var(--surface-1) 92%, transparent);
  box-shadow: var(--ui-shadow-lg), var(--ui-shadow-highlight-inset);
  backdrop-filter: blur(20px);
}

.project-welcome__new-project {
  padding-bottom: clamp(26px, 4vh, 42px);
  border-bottom: 1px solid var(--line-soft);
}

.project-welcome__section-label {
  display: flex;
  align-items: center;
  gap: 10px;
}

.project-welcome__label-mark {
  display: grid;
  width: 24px;
  height: 24px;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--accent) 48%, transparent);
  border-radius: 50%;
}

.project-welcome__label-mark svg {
  width: 13px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
}

.project-welcome__new-project h2 {
  margin: 26px 0 9px;
  font-family: var(--ui-type-family-display);
  font-size: clamp(var(--ui-font-size-2xl), 3vw, var(--ui-font-size-4xl));
  font-weight: var(--ui-type-weight-semibold);
  line-height: var(--ui-type-leading-tight);
  letter-spacing: var(--ui-type-tracking-tight);
}

.project-welcome__new-project p {
  max-width: 420px;
  margin: 0;
  color: var(--text-muted);
  font-size: var(--ui-font-size-sm);
  line-height: var(--ui-type-leading-relaxed);
}

.project-welcome__create {
  display: flex;
  width: 100%;
  min-height: 56px;
  align-items: center;
  justify-content: space-between;
  margin-top: 28px;
  padding: 0 20px;
  border: 1px solid var(--accent-strong);
  border-radius: var(--ui-radius-md);
  color: var(--button-primary-text);
  background: var(--button-primary);
  box-shadow: var(--ui-shadow-md);
  font-weight: var(--ui-type-weight-semibold);
  cursor: pointer;
  transition:
    background var(--ui-motion-fast) var(--ui-ease-standard),
    box-shadow var(--ui-motion-fast) var(--ui-ease-standard),
    transform var(--ui-motion-fast) var(--ui-ease-standard);
}

.project-welcome__create svg {
  width: 21px;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.6;
  transition: transform var(--ui-motion-fast) var(--ui-ease-standard);
}

.project-welcome__create:disabled {
  cursor: wait;
  opacity: 0.58;
}

.project-welcome__create:focus-visible {
  outline: 2px solid var(--accent-soft);
  outline-offset: 3px;
}

.project-welcome__error {
  position: fixed;
  z-index: var(--ui-z-local-content);
  right: 24px;
  bottom: 24px;
  max-width: min(520px, calc(100vw - 48px));
  margin: 0;
  padding: 12px 16px;
  border: 1px solid color-mix(in srgb, var(--record) 45%, transparent);
  border-radius: var(--ui-radius-md);
  color: var(--ui-domain-color-ff9dab);
  background: color-mix(in srgb, var(--ui-domain-color-321923) 92%, transparent);
  box-shadow: var(--ui-shadow-md);
  font-size: var(--ui-type-size-body-compact);
}

@media (hover: hover) {
  .project-welcome__create:hover:not(:disabled) {
    background: var(--ui-color-action-hover);
    box-shadow: var(--ui-shadow-lg);
    transform: translateY(-1px);
  }

  .project-welcome__create:hover:not(:disabled) svg {
    transform: translateX(3px);
  }
}

@media (max-width: 900px) {
  .project-welcome {
    height: auto;
    min-height: 100%;
    grid-template-columns: 1fr;
    gap: 42px;
  }

  .project-welcome__copy {
    margin-bottom: 160px;
  }

  .project-welcome__wave {
    top: 300px;
    bottom: auto;
    width: 100%;
    height: 220px;
  }

  .project-welcome__launchpad {
    width: min(100%, 620px);
    justify-self: end;
  }
}

@media (max-width: 560px) {
  .project-welcome {
    gap: 28px;
    padding: 26px 20px 34px;
  }

  .project-welcome__copy {
    margin: 56px 0 130px;
  }

  .project-welcome__headline {
    font-size: clamp(var(--ui-font-size-4xl), 18vw, var(--ui-font-size-5xl));
  }

  .project-welcome__body {
    font-size: var(--ui-font-size-sm);
  }

  .project-welcome__launchpad {
    padding: 22px 18px;
    border-radius: 2px 22px;
  }
}

@keyframes welcome-playhead {
  from {
    transform: translateX(20px);
  }

  to {
    transform: translateX(720px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .project-welcome__waveform--motion {
    display: none;
  }

  .project-welcome__waveform--static {
    display: block;
  }

  .project-welcome__playhead {
    animation: none;
    transform: translateX(380px);
  }
}
</style>
