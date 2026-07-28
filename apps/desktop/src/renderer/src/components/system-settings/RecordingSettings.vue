<script setup lang="ts">
import { computed, onMounted } from "vue"
import { storeToRefs } from "pinia"
import { UiSelect } from "@yadaw/ui"
import type { RecordingBitDepth } from "@yadaw/contracts"
import SettingsPage from "../settings/SettingsPage.vue"
import SettingsSection from "../settings/SettingsSection.vue"
import { useApplicationSettingsStore } from "../../stores/applicationSettings"
import { useRecordingStore } from "../../stores/recording"

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
    category="Audio"
    page="Recording"
    title="Recording"
    description="Capture stays in machine-local swap until a successful project archive save."
  >
    <SettingsSection
      title="Swap directory"
      description="Half-finished recordings and recoverable source BWF files live here."
    >
      <div class="path-control">
        <code>{{ settings?.swapDirectory ?? "Loading…" }}</code>
        <button type="button" :disabled="loading" @click="settingsStore.chooseSwapDirectory">
          Browse…
        </button>
        <button type="button" :disabled="loading" @click="settingsStore.openSwapDirectory">
          Open
        </button>
      </div>
    </SettingsSection>

    <SettingsSection
      title="Final bit depth"
      description="Swap is always float32. Integer output is dithered once after resampling."
    >
      <label class="recording-field">
        <span>Format</span>
        <UiSelect
          :model-value="settings?.recordingBitDepth ?? 'float32'"
          size="sm"
          aria-label="Final recording bit depth"
          @update:model-value="setBitDepth"
        >
          <option value="float32">32-bit float</option>
          <option value="pcm24">24-bit PCM</option>
          <option value="pcm16">16-bit PCM</option>
        </UiSelect>
      </label>
    </SettingsSection>

    <SettingsSection
      title="Software monitoring"
      description="Hear hardware inputs through the track's effects, fader, pan, sends, delay compensation, and output routing."
    >
      <label class="monitoring-control">
        <input
          type="checkbox"
          :checked="settings?.softwareMonitoringEnabled ?? false"
          :disabled="loading || applyingSoftwareMonitoring"
          @change="setSoftwareMonitoring"
        />
        <span>
          <b>Enable software monitoring</b>
          <small>
            Use headphones or mute direct monitoring on the audio interface. Open speakers can
            create loud feedback.
          </small>
        </span>
      </label>
      <p class="monitoring-state" aria-live="polite">
        {{
          applyingSoftwareMonitoring
            ? "Publishing the updated audio graph…"
            : settings?.softwareMonitoringEnabled
              ? "Available on Audio tracks with hardware inputs."
              : "Off. Existing per-track monitoring choices are preserved."
        }}
      </p>
    </SettingsSection>

    <SettingsSection
      title="Recovery"
      description="Files are never removed merely because the project was closed without saving."
    >
      <div class="recovery-count">
        <b>{{ pendingCount }}</b>
        <span>recordings waiting in swap</span>
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
