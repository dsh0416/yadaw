<script setup lang="ts">
import { computed, onMounted } from "vue"
import { useI18n } from "vue-i18n"
import { storeToRefs } from "pinia"
import { UiSelect } from "@heron/ui"
import type { RecordingBitDepth } from "@heron/contracts"
import SettingsPage from "../settings/SettingsPage.vue"
import SettingsSection from "../settings/SettingsSection.vue"
import { useApplicationSettingsStore } from "../../stores/applicationSettings"
import { useRecordingStore } from "../../stores/recording"

const { t } = useI18n()
const settingsStore = useApplicationSettingsStore()
const recordingStore = useRecordingStore()
const { settings, loading, error, applyingSoftwareMonitoring } = storeToRefs(settingsStore)
const { pending } = storeToRefs(recordingStore)
const pendingCount = computed(
  () => pending.value.filter((recording) => !recording.assetExists).length
)

onMounted(async () => {
  if (!settings.value) await settingsStore.load()
  await recordingStore.refreshPending()
})

function setBitDepth(value: string): void {
  void settingsStore.update({ recordingBitDepth: value as RecordingBitDepth })
}

function setSoftwareMonitoring(event: Event): void {
  const enabled = (event.currentTarget as HTMLInputElement).checked
  void settingsStore.setSoftwareMonitoringEnabled(enabled).catch(() => undefined)
}
</script>

<template>
  <SettingsPage
    :category="t('settings.audio.recording.category')"
    :page="t('settings.audio.recording.page')"
    :title="t('settings.audio.recording.title')"
    :description="t('settings.audio.recording.description')"
  >
    <SettingsSection
      :title="t('settings.audio.recording.swapDirectory.title')"
      :description="t('settings.audio.recording.swapDirectory.description')"
    >
      <div class="path-control">
        <code>{{ settings?.swapDirectory ?? t("common.loading") }}</code>
        <button type="button" :disabled="loading" @click="settingsStore.chooseSwapDirectory">
          {{ t("common.browse") }}
        </button>
        <button type="button" :disabled="loading" @click="settingsStore.openSwapDirectory">
          {{ t("common.open") }}
        </button>
      </div>
    </SettingsSection>

    <SettingsSection
      :title="t('settings.audio.recording.bitDepth.title')"
      :description="t('settings.audio.recording.bitDepth.description')"
    >
      <label class="recording-field">
        <span>{{ t("common.format") }}</span>
        <UiSelect
          :model-value="settings?.recordingBitDepth ?? 'float32'"
          size="sm"
          :aria-label="t('settings.audio.recording.bitDepth.ariaLabel')"
          @update:model-value="setBitDepth"
        >
          <option value="float32">{{ t("settings.audio.recording.bitDepth.float32") }}</option>
          <option value="pcm24">{{ t("settings.audio.recording.bitDepth.pcm24") }}</option>
          <option value="pcm16">{{ t("settings.audio.recording.bitDepth.pcm16") }}</option>
        </UiSelect>
      </label>
    </SettingsSection>

    <SettingsSection
      :title="t('settings.audio.recording.softwareMonitoring.title')"
      :description="t('settings.audio.recording.softwareMonitoring.description')"
    >
      <label class="monitoring-control">
        <input
          type="checkbox"
          :checked="settings?.softwareMonitoringEnabled ?? false"
          :disabled="loading || applyingSoftwareMonitoring"
          @change="setSoftwareMonitoring"
        />
        <span>
          <b>{{ t("settings.audio.recording.softwareMonitoring.enable") }}</b>
          <small>{{ t("settings.audio.recording.softwareMonitoring.warning") }}</small>
        </span>
      </label>
      <p class="monitoring-state" aria-live="polite">
        {{
          applyingSoftwareMonitoring
            ? t("settings.audio.recording.softwareMonitoring.publishing")
            : settings?.softwareMonitoringEnabled
              ? t("settings.audio.recording.softwareMonitoring.enabled")
              : t("settings.audio.recording.softwareMonitoring.disabled")
        }}
      </p>
    </SettingsSection>

    <SettingsSection
      :title="t('settings.audio.recording.recovery.title')"
      :description="t('settings.audio.recording.recovery.description')"
    >
      <div class="recovery-count">
        <b>{{ pendingCount }}</b>
        <span>{{ t("settings.audio.recording.recovery.pending") }}</span>
      </div>
    </SettingsSection>

    <p v-if="error" role="alert" class="recording-error">{{ error }}</p>
  </SettingsPage>
</template>

<style scoped>
.path-control {
  display: flex;
  gap: 8px;
}

.path-control code {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  padding: 11px;
  border: 1px solid var(--line-strong);
  border-radius: 7px;
  color: var(--text-secondary);
  background: var(--surface-1);
  font: var(--ui-type-size-control) var(--ui-type-family-data);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.path-control button {
  padding: 0 12px;
  border: 1px solid var(--line-strong);
  border-radius: 7px;
  color: var(--text-secondary);
  background: var(--surface-3);
}

.path-control button {
  cursor: pointer;
}

.path-control button:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}

.path-control button:disabled {
  cursor: wait;
  opacity: 0.6;
}

.recording-field {
  display: grid;
  width: min(240px, 100%);
  gap: 7px;
  color: var(--text-muted);
  font: var(--ui-type-size-caption) var(--ui-type-family-data);
  letter-spacing: var(--ui-type-tracking-wide);
}

.recovery-count {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.monitoring-control {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  max-width: 620px;
  color: var(--text-secondary);
  cursor: pointer;
}

.monitoring-control input {
  margin-top: 3px;
  accent-color: var(--mixer-input);
}

.monitoring-control span {
  display: grid;
  gap: 5px;
}

.monitoring-control b {
  font-size: var(--ui-type-size-body-compact);
}

.monitoring-control small,
.monitoring-state {
  color: var(--text-muted);
  font-size: var(--ui-type-size-caption);
  line-height: var(--ui-type-leading-normal);
}

.monitoring-state {
  margin: 10px 0 0 26px;
}

.recovery-count b {
  color: var(--signal-cyan);
  font: var(--ui-font-size-2xl) var(--ui-type-family-data);
}

.recovery-count span {
  color: var(--text-muted);
  font-size: var(--ui-type-size-body-compact);
}

.recording-error {
  padding: 11px;
  border-radius: 7px;
  font-size: var(--ui-type-size-body-compact);
}

.recording-error {
  color: var(--record);
  background: color-mix(in srgb, var(--record) 9%, var(--surface-1));
}
</style>
