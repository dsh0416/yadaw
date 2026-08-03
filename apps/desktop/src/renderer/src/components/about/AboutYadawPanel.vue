<script setup lang="ts">
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import type { DesktopPlatform } from "@yadaw/contracts"
import { YadawLogo } from "@yadaw/ui"
import AsioLegalNotice from "./AsioLegalNotice.vue"
import ThirdPartyNotices from "./ThirdPartyNotices.vue"
import VstLegalNotice from "./VstLegalNotice.vue"

const props = defineProps<{
  version: string
  platform: DesktopPlatform
}>()

const { t } = useI18n()
const platformLabel = computed(() => t(`about.platforms.${props.platform}`))
const projectUrl = "https://github.com/dsh0416/yadaw"
const manualUrl = "https://yadaw.minori.live/manual/"
</script>

<template>
  <article class="about-panel">
    <div class="brand-stage">
      <YadawLogo class="brand-logo" />
    </div>

    <dl class="build-facts">
      <div class="build-fact">
        <dt class="fact-label">{{ t("about.version") }}</dt>
        <dd class="fact-value">v{{ version }}</dd>
      </div>
      <div class="build-fact">
        <dt class="fact-label">{{ t("about.platform") }}</dt>
        <dd class="fact-value">{{ platformLabel }}</dd>
      </div>
      <div class="build-fact">
        <dt class="fact-label">{{ t("about.license") }}</dt>
        <dd class="fact-value">GPL-3.0-only</dd>
      </div>
    </dl>

    <VstLegalNotice />
    <AsioLegalNotice />
    <ThirdPartyNotices />

    <nav class="about-links" :aria-label="t('about.links')">
      <a class="about-link" :href="projectUrl" target="_blank" rel="noopener noreferrer">
        <span class="link-label">{{ t("about.projectWebsite") }}</span>
        <span class="link-arrow" aria-hidden="true">↗</span>
      </a>
      <a class="about-link" :href="manualUrl" target="_blank" rel="noreferrer">
        <span class="link-label">{{ t("about.userManual") }}</span>
        <span class="link-arrow" aria-hidden="true">↗</span>
      </a>
    </nav>
  </article>
</template>

<style scoped>
.about-panel {
  display: grid;
  gap: var(--ui-space-5);
}

.brand-stage {
  display: grid;
  min-height: 7.5rem;
  align-content: center;
  justify-items: center;
  padding: var(--ui-space-6);
  border: 1px solid var(--ui-color-border);
  border-left: var(--ui-signal-rail-width) solid var(--ui-signal-audio);
  border-radius: var(--ui-radius-lg);
  background: var(--ui-color-canvas-subtle);
  box-shadow: var(--ui-shadow-highlight-inset);
}

.brand-logo {
  --yadaw-logo-highlight: var(--ui-signal-midi);
  --yadaw-logo-lockup-wordmark-size: 0.62em;

  color: var(--ui-color-text);
  font-size: var(--ui-font-size-4xl);
}

.build-facts {
  display: grid;
  margin: 0;
  border: 1px solid var(--ui-color-border);
  border-radius: var(--ui-radius-md);
  background: var(--ui-color-surface-raised);
}

.build-fact {
  display: grid;
  grid-template-columns: minmax(6rem, 0.7fr) minmax(0, 1.3fr);
  align-items: baseline;
  gap: var(--ui-space-4);
  padding: var(--ui-space-3) var(--ui-space-4);
  border-top: 1px solid var(--ui-color-border);
}

.build-fact:first-child {
  border-top: 0;
}

.fact-label {
  color: var(--ui-color-text-subtle);
  font-size: var(--ui-font-size-xs);
}

.fact-value {
  overflow: hidden;
  margin: 0;
  color: var(--ui-color-text);
  font: var(--ui-font-size-xs) var(--ui-type-family-data);
  font-variant-numeric: tabular-nums;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.about-links {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--ui-space-2);
}

.about-link {
  display: flex;
  min-height: var(--ui-control-md);
  align-items: center;
  justify-content: space-between;
  gap: var(--ui-space-3);
  padding: 0 var(--ui-space-3);
  border: 1px solid var(--ui-color-border);
  border-radius: var(--ui-radius-md);
  color: var(--ui-color-text);
  background: var(--ui-color-surface-raised);
  font-size: var(--ui-font-size-xs);
  font-weight: var(--ui-type-weight-semibold);
  text-decoration: none;
  transition:
    background var(--ui-motion-fast) var(--ui-ease-standard),
    border-color var(--ui-motion-fast) var(--ui-ease-standard);
}

.about-link:hover {
  border-color: var(--ui-color-border-strong);
  background: var(--ui-color-surface-hover);
}

.about-link:focus-visible {
  outline: var(--ui-focus-width) solid var(--ui-color-focus);
  outline-offset: var(--ui-focus-width);
}

.link-arrow {
  color: var(--ui-signal-audio);
  font-family: var(--ui-type-family-data);
}

@media (max-width: 30rem) {
  .about-links {
    grid-template-columns: 1fr;
  }
}
</style>
