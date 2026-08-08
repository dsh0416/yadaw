<script setup lang="ts">
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import type { PluginCatalogSnapshot } from "@heron/contracts"
import SettingsPage from "../settings/SettingsPage.vue"
import SettingsSection from "../settings/SettingsSection.vue"

const props = defineProps<{
  catalog: PluginCatalogSnapshot
  scanProgress: { completed: number; total: number; path: string } | null
  loading: boolean
  error: string
}>()

const emit = defineEmits<{
  rescan: []
}>()

const { locale, t } = useI18n()
const compatibleEffects = computed(
  () =>
    props.catalog.plugins.filter(
      (plugin) => plugin.kind === "effect" && plugin.compatibility === "compatible"
    ).length
)
const compatibleInstruments = computed(
  () =>
    props.catalog.plugins.filter(
      (plugin) => plugin.kind === "instrument" && plugin.compatibility === "compatible"
    ).length
)
const unavailablePlugins = computed(
  () => props.catalog.plugins.filter((plugin) => plugin.compatibility !== "compatible").length
)
const scanBusy = computed(() => props.loading || props.catalog.scanning)
const lastScan = computed(() =>
  props.catalog.scannedAt === null
    ? t("settings.system.plugins.catalog.neverScanned")
    : new Intl.DateTimeFormat(locale.value, {
        dateStyle: "medium",
        timeStyle: "short"
      }).format(props.catalog.scannedAt)
)
</script>

<template>
  <SettingsPage
    :category="t('settings.system.plugins.category')"
    :page="t('settings.system.plugins.page')"
    :title="t('settings.system.plugins.title')"
    :description="t('settings.system.plugins.description')"
  >
    <SettingsSection
      :title="t('settings.system.plugins.catalog.title')"
      :description="t('settings.system.plugins.catalog.description')"
    >
      <div class="catalog-summary">
        <div class="catalog-metric">
          <strong>{{ compatibleEffects }}</strong>
          <span>{{ t("settings.system.plugins.catalog.effects") }}</span>
        </div>
        <div class="catalog-metric">
          <strong>{{ compatibleInstruments }}</strong>
          <span>{{ t("settings.system.plugins.catalog.instruments") }}</span>
        </div>
        <div class="catalog-metric catalog-metric-muted">
          <strong>{{ unavailablePlugins }}</strong>
          <span>{{ t("settings.system.plugins.catalog.unavailable") }}</span>
        </div>
        <p class="last-scan">
          <span>{{ t("settings.system.plugins.catalog.lastScan") }}</span>
          <b>{{ lastScan }}</b>
        </p>
      </div>
    </SettingsSection>

    <SettingsSection
      :title="t('settings.system.plugins.discovery.title')"
      :description="t('settings.system.plugins.discovery.description')"
    >
      <div class="scan-control">
        <button type="button" :disabled="scanBusy" @click="emit('rescan')">
          {{
            scanBusy
              ? t("settings.system.plugins.discovery.scanning")
              : t("settings.system.plugins.discovery.rescan")
          }}
        </button>
        <span v-if="scanProgress" role="status">
          {{
            t("settings.system.plugins.discovery.progress", {
              completed: scanProgress.completed,
              total: scanProgress.total
            })
          }}
        </span>
      </div>
      <p v-if="error" class="scan-error" role="alert">{{ error }}</p>
    </SettingsSection>
  </SettingsPage>
</template>

<style scoped>
.catalog-summary {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.catalog-metric {
  display: grid;
  gap: 5px;
  min-width: 0;
  padding: 13px 12px;
  border: 1px solid var(--line-soft);
  border-radius: 7px;
  background: var(--surface-2);
}

.catalog-metric strong {
  color: var(--accent);
  font: var(--ui-type-weight-semibold) var(--ui-font-size-lg) var(--ui-type-family-data);
}

.catalog-metric span,
.last-scan span,
.scan-control span {
  color: var(--text-muted);
  font-size: var(--ui-type-size-caption);
}

.catalog-metric-muted strong {
  color: var(--text-secondary);
}

.last-scan {
  grid-column: 1 / -1;
  display: flex;
  justify-content: space-between;
  gap: 16px;
  margin: 2px 0 0;
  color: var(--text-secondary);
  font: var(--ui-type-size-caption) var(--ui-type-family-data);
}

.last-scan b {
  font-weight: var(--ui-type-weight-medium);
}

.scan-control {
  display: flex;
  align-items: center;
  gap: 12px;
}

.scan-control button {
  min-height: 36px;
  padding: 0 14px;
  border: 1px solid var(--line-strong);
  border-radius: 7px;
  color: var(--text-secondary);
  background: var(--surface-3);
  cursor: pointer;
  font-size: var(--ui-type-size-body-compact);
}

.scan-control button:hover:not(:disabled) {
  color: var(--text-primary);
  background: var(--surface-4);
}

.scan-control button:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}

.scan-control button:disabled {
  opacity: 0.45;
  cursor: default;
}

.scan-error {
  margin: 12px 0 0;
  padding: 11px;
  border-radius: 7px;
  color: var(--record);
  background: color-mix(in srgb, var(--record) 9%, var(--surface-1));
  font-size: var(--ui-type-size-body-compact);
}

@media (max-width: 760px) {
  .catalog-summary {
    grid-template-columns: 1fr;
  }

  .last-scan {
    grid-column: 1;
  }
}
</style>
