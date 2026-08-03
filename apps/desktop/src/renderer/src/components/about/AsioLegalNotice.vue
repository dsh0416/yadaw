<script setup lang="ts">
import { useI18n } from "vue-i18n"
import { AsioCompatibleLogo } from "@heron/ui"

const { t } = useI18n()
</script>

<template>
  <section class="asio-legal-notice" aria-labelledby="asio-legal-notice-title">
    <AsioCompatibleLogo decorative />
    <div class="asio-legal-copy">
      <h2 id="asio-legal-notice-title" class="asio-legal-title">
        {{ t("about.asioCompatibility") }}
      </h2>
      <p class="asio-trademark">
        ASIO is a registered trademark of Steinberg Media Technologies GmbH.
      </p>
    </div>
  </section>
</template>

<style scoped>
.asio-legal-notice {
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

.asio-compatible-logo {
  --asio-compatible-logo-width: 24mm;
}

.asio-legal-copy {
  display: grid;
  gap: var(--ui-space-2);
}

.asio-legal-title,
.asio-trademark {
  margin: 0;
}

.asio-legal-title {
  color: var(--ui-color-text);
  font: var(--ui-type-weight-semibold) var(--ui-font-size-sm) var(--ui-type-family-data);
  letter-spacing: var(--ui-type-tracking-wide);
}

.asio-trademark {
  color: var(--ui-color-text-subtle);
  font-size: var(--ui-font-size-xs);
  line-height: var(--ui-type-leading-normal);
}

@media (max-width: 30rem) {
  .asio-legal-notice {
    grid-template-columns: 1fr;
  }
}
</style>
