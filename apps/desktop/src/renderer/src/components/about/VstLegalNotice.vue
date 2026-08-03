<script setup lang="ts">
import { useI18n } from "vue-i18n"
import { VstCompatibleLogo } from "@heron/ui"

const { t } = useI18n()
</script>

<template>
  <section class="vst-legal-notice" aria-labelledby="vst-legal-notice-title">
    <VstCompatibleLogo appearance="on-dark" decorative />
    <div class="vst-legal-copy">
      <h2 id="vst-legal-notice-title" class="vst-legal-title">
        {{ t("about.vstCompatibility") }}
      </h2>
      <p class="vst-trademark">
        VST is a registered trademark of Steinberg Media Technologies GmbH.
      </p>
    </div>
  </section>
</template>

<style scoped>
.vst-legal-notice {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: var(--ui-space-4);
  padding: var(--ui-space-4);
  border: 1px solid var(--ui-color-border);
  border-left: var(--ui-signal-rail-width) solid var(--ui-signal-audio);
  border-radius: var(--ui-radius-md);
  background: var(--ui-color-canvas-subtle);
}

.vst-compatible-logo {
  --vst-compatible-logo-width: 18mm;
}

.vst-legal-copy {
  display: grid;
  gap: var(--ui-space-2);
}

.vst-legal-title,
.vst-trademark {
  margin: 0;
}

.vst-legal-title {
  color: var(--ui-color-text);
  font: var(--ui-type-weight-semibold) var(--ui-font-size-sm) var(--ui-type-family-data);
  letter-spacing: var(--ui-type-tracking-wide);
}

.vst-trademark {
  color: var(--ui-color-text-subtle);
  font-size: var(--ui-font-size-xs);
  line-height: var(--ui-type-leading-normal);
}

@media (max-width: 30rem) {
  .vst-legal-notice {
    grid-template-columns: 1fr;
  }
}
</style>
