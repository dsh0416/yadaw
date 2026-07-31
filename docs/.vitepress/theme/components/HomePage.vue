<script setup lang="ts">
import { withBase } from "vitepress"
import { useHomeCopy, useLocalePrefix } from "../i18n"
import SessionPreview from "./SessionPreview.vue"

const t = useHomeCopy()
const prefix = useLocalePrefix()

const signalClasses = [
  "capability__signal--record",
  "capability__signal--midi",
  "capability__signal--meter"
]
</script>

<template>
  <main class="home">
    <section class="hero">
      <div class="hero__copy">
        <p class="eyebrow"><span /> {{ t.heroEyebrow }}</p>
        <h1 class="hero__title">
          {{ t.heroTitleTop }}<br /><em>{{ t.heroTitleAccent }}</em>
        </h1>
        <p class="hero__lead">
          {{ t.heroLead }}
        </p>
        <div class="hero__actions">
          <a class="button button--primary" :href="withBase(`${prefix}/manual/`)">
            {{ t.openManual }} <span>→</span>
          </a>
          <a class="button" href="https://github.com/dsh0416/yadaw/releases">{{ t.getRelease }}</a>
        </div>
        <p class="hero__notice">
          <strong>{{ t.noticeStrong }}</strong> {{ t.noticeRest }}
        </p>
      </div>
      <div class="hero__stage">
        <SessionPreview />
        <p class="hero__caption">
          <span v-for="caption in t.captions" :key="caption">{{ caption }}</span>
        </p>
      </div>
    </section>

    <section class="manifesto">
      <p class="section-label">{{ t.manifestoLabel }}</p>
      <p class="manifesto__statement">
        {{ t.manifestoStatement }}
      </p>
    </section>

    <section class="capabilities" aria-labelledby="capabilities-title">
      <div class="capabilities__heading">
        <p class="section-label">{{ t.capabilitiesLabel }}</p>
        <h2 id="capabilities-title">{{ t.capabilitiesTitle }}</h2>
      </div>
      <div class="capability-grid">
        <article
          v-for="(capability, i) in t.capabilities"
          :key="capability.index"
          class="capability"
        >
          <span class="capability__signal" :class="signalClasses[i]" />
          <p class="capability__index">{{ capability.index }}</p>
          <h3>{{ capability.title }}</h3>
          <p>
            {{ capability.body }}
          </p>
        </article>
      </div>
    </section>

    <section class="principles">
      <div class="principles__copy">
        <p class="section-label">{{ t.principlesLabel }}</p>
        <h2>{{ t.principlesTitleTop }}<br />{{ t.principlesTitleBottom }}</h2>
      </div>
      <div class="principles__list">
        <p v-for="(principle, i) in t.principles" :key="principle">
          <span>0{{ i + 1 }}</span> {{ principle }}
        </p>
      </div>
    </section>

    <section class="final-cta">
      <p class="section-label">{{ t.ctaLabel }}</p>
      <h2>{{ t.ctaTitle }}</h2>
      <a class="button button--primary" :href="withBase(`${prefix}/manual/first-project`)">
        {{ t.ctaButton }}
      </a>
    </section>
  </main>
</template>

<style scoped>
.home {
  --home-width: 1180px;

  color: var(--vp-c-text-1);
}

.hero,
.manifesto,
.capabilities,
.principles,
.final-cta {
  width: min(var(--home-width), calc(100% - 48px));
  margin: 0 auto;
}

.hero {
  display: grid;
  min-height: min(780px, calc(100vh - var(--vp-nav-height)));
  grid-template-columns: minmax(360px, 0.88fr) minmax(520px, 1.25fr);
  align-items: center;
  gap: clamp(40px, 6vw, 96px);
  padding: 96px 0 108px;
}

.eyebrow,
.section-label {
  margin: 0;
  color: var(--vp-c-text-3);
  font-family: var(--vp-font-family-mono);
  font-size: 11px;
  font-weight: 650;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

.eyebrow {
  display: flex;
  align-items: center;
  gap: 10px;
}

.eyebrow span {
  width: 28px;
  height: 1px;
  background: var(--yadaw-cyan);
}

.hero__title {
  margin: 28px 0 24px;
  color: var(--vp-c-text-1);
  font-family: var(--yadaw-display);
  font-size: clamp(52px, 6.8vw, 88px);
  font-stretch: condensed;
  font-weight: 720;
  letter-spacing: -0.055em;
  line-height: 0.92;
}

.hero__title em {
  color: var(--yadaw-cyan);
  font-style: normal;
  font-weight: 520;
}

.hero__lead {
  max-width: 560px;
  margin: 0;
  color: var(--vp-c-text-2);
  font-size: clamp(17px, 1.8vw, 21px);
  line-height: 1.55;
}

.hero__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 34px;
}

.button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 44px;
  gap: 20px;
  padding: 0 18px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 7px;
  color: var(--vp-c-text-1);
  background: var(--vp-c-bg-soft);
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
  font-weight: 650;
  letter-spacing: 0.04em;
  text-decoration: none;
  transition:
    border-color 150ms ease,
    background 150ms ease,
    transform 150ms ease;
}

.button:hover {
  border-color: var(--vp-c-text-3);
  background: var(--vp-c-bg-alt);
  transform: translateY(-1px);
}

.button:focus-visible {
  outline: 2px solid var(--yadaw-cyan);
  outline-offset: 3px;
}

.button--primary {
  border-color: var(--yadaw-cyan-dark);
  color: #071315;
  background: var(--yadaw-cyan);
}

.button--primary:hover {
  border-color: var(--yadaw-cyan-light);
  background: var(--yadaw-cyan-light);
}

.hero__notice {
  margin: 20px 0 0;
  color: var(--vp-c-text-3);
  font-size: 12px;
}

.hero__notice strong {
  color: var(--yadaw-warning);
  font-weight: 650;
}

.hero__stage {
  position: relative;
}

.hero__stage::before {
  position: absolute;
  z-index: -1;
  inset: 12% -5% -8% 8%;
  border: 1px solid rgb(114 195 199 / 16%);
  background:
    linear-gradient(90deg, rgb(114 195 199 / 4%) 1px, transparent 1px),
    linear-gradient(rgb(114 195 199 / 4%) 1px, transparent 1px);
  background-size: 24px 24px;
  content: "";
  mask-image: linear-gradient(135deg, #000, transparent 76%);
}

.hero__caption {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 22px;
  margin: 12px 4px 0 0;
  color: var(--vp-c-text-3);
  font-family: var(--vp-font-family-mono);
  font-size: 9px;
  letter-spacing: 0.12em;
  line-height: 1;
  text-transform: uppercase;
}

.hero__caption span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.hero__caption span::before {
  width: 5px;
  height: 5px;
  flex: none;
  border-radius: 50%;
  background: var(--yadaw-meter);
  content: "";
}

.manifesto {
  display: grid;
  grid-template-columns: 0.7fr 2fr;
  gap: 48px;
  padding: 96px 0;
  border-top: 1px solid var(--vp-c-divider);
}

.manifesto__statement {
  max-width: 900px;
  margin: -8px 0 0;
  font-family: var(--yadaw-display);
  font-size: clamp(30px, 4vw, 52px);
  font-weight: 520;
  letter-spacing: -0.035em;
  line-height: 1.12;
}

.capabilities {
  padding: 112px 0;
}

.capabilities__heading {
  display: grid;
  max-width: 760px;
  gap: 20px;
}

.capabilities__heading h2,
.principles__copy h2,
.final-cta h2 {
  margin: 0;
  font-family: var(--yadaw-display);
  font-size: clamp(36px, 5vw, 64px);
  font-weight: 650;
  letter-spacing: -0.045em;
  line-height: 1;
}

.capability-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  margin-top: 64px;
  border-top: 1px solid var(--vp-c-divider);
  border-bottom: 1px solid var(--vp-c-divider);
}

.capability {
  position: relative;
  min-height: 310px;
  padding: 32px;
  border-right: 1px solid var(--vp-c-divider);
}

.capability:last-child {
  border-right: 0;
}

.capability__signal {
  position: absolute;
  top: -3px;
  left: 32px;
  width: 42px;
  height: 5px;
}

.capability__signal--record {
  background: var(--yadaw-record);
}

.capability__signal--midi {
  background: var(--yadaw-midi);
}

.capability__signal--meter {
  background: var(--yadaw-meter);
}

.capability__index {
  margin: 0 0 62px;
  color: var(--vp-c-text-3);
  font-family: var(--vp-font-family-mono);
  font-size: 10px;
  letter-spacing: 0.16em;
}

.capability h3 {
  margin: 0 0 18px;
  font-family: var(--yadaw-display);
  font-size: 26px;
  font-weight: 650;
  letter-spacing: -0.025em;
  line-height: 1.05;
}

.capability > p:last-child {
  margin: 0;
  color: var(--vp-c-text-2);
  font-size: 14px;
  line-height: 1.7;
}

.principles {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 80px;
  padding: 120px 0;
  border-top: 1px solid var(--vp-c-divider);
}

.principles__copy {
  display: grid;
  align-content: start;
  gap: 24px;
}

.principles__list {
  display: grid;
  align-content: center;
}

.principles__list p {
  display: grid;
  grid-template-columns: 44px 1fr;
  margin: 0;
  padding: 21px 0;
  border-bottom: 1px solid var(--vp-c-divider);
  font-size: 17px;
}

.principles__list span {
  color: var(--yadaw-cyan);
  font-family: var(--vp-font-family-mono);
  font-size: 10px;
}

.final-cta {
  display: grid;
  justify-items: start;
  gap: 28px;
  padding: 100px 0 140px;
  border-top: 1px solid var(--vp-c-divider);
}

.final-cta h2 {
  max-width: 860px;
}

@media (max-width: 960px) {
  .hero {
    min-height: auto;
    grid-template-columns: 1fr;
    padding-top: 72px;
  }

  .hero__copy {
    max-width: 720px;
  }

  .manifesto,
  .principles {
    grid-template-columns: 1fr;
    gap: 36px;
  }

  .capability-grid {
    grid-template-columns: 1fr;
  }

  .capability {
    min-height: 0;
    border-right: 0;
    border-bottom: 1px solid var(--vp-c-divider);
  }

  .capability:last-child {
    border-bottom: 0;
  }

  .capability__index {
    margin-bottom: 38px;
  }
}

@media (max-width: 640px) {
  .hero,
  .manifesto,
  .capabilities,
  .principles,
  .final-cta {
    width: min(var(--home-width), calc(100% - 32px));
  }

  .hero {
    gap: 54px;
    padding: 56px 0 76px;
  }

  .hero__title {
    font-size: clamp(48px, 16vw, 68px);
  }

  .hero__caption {
    justify-content: flex-start;
    gap: 12px;
  }

  .manifesto,
  .capabilities,
  .principles {
    padding: 78px 0;
  }

  .capability {
    padding: 28px 0;
  }

  .capability__signal {
    left: 0;
  }

  .principles__list p {
    font-size: 15px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .button {
    transition: none;
  }
}
</style>
