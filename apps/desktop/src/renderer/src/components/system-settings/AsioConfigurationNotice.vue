<script setup lang="ts">
import { useI18n } from "vue-i18n"
import { AsioCompatibleLogo } from "@heron/ui"

const { t } = useI18n()
</script>

<template>
  <aside
    class="asio-configuration-notice"
    :aria-label="t('settings.audio.backend.asioCompatibility')"
  >
    <AsioCompatibleLogo decorative />
    <div class="asio-configuration-copy">
      <p class="asio-configuration-title">
        {{ t("settings.audio.backend.asioCompatibility") }}
      </p>
      <p class="asio-configuration-statement">
        ASIO is a registered trademark of Steinberg Media Technologies GmbH.
      </p>
    </div>
  </aside>
</template>

<style scoped>
.asio-configuration-notice {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 14px;
  margin-top: 12px;
  padding: 14px;
  border: 1px solid var(--line-soft);
  border-left: var(--ui-signal-rail-width) solid var(--signal-cyan);
  border-radius: 7px;
  color: var(--text-strong);
  background: var(--surface-1);
}

.asio-compatible-logo {
  --asio-compatible-logo-width: 24mm;
}

.asio-configuration-copy {
  display: grid;
  gap: 5px;
}

.asio-configuration-title,
.asio-configuration-statement {
  margin: 0;
}

.asio-configuration-title {
  font: var(--ui-type-weight-semibold) var(--ui-type-size-body-compact) var(--ui-type-family-data);
  letter-spacing: var(--ui-type-tracking-wide);
  text-transform: uppercase;
}

.asio-configuration-statement {
  color: var(--text-muted);
  font-size: var(--ui-type-size-control);
  line-height: var(--ui-type-leading-normal);
}

@media (max-width: 680px) {
  .asio-configuration-notice {
    grid-template-columns: 1fr;
  }
}
</style>
