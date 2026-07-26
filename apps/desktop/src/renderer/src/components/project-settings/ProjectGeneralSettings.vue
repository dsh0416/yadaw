<script setup lang="ts">
import { PROJECT_SAMPLE_RATES } from "@yadaw/contracts"
import type { ProjectConfiguration } from "@yadaw/contracts"
import SettingsPage from "../settings/SettingsPage.vue"
import SettingsSection from "../settings/SettingsSection.vue"

const configuration = defineModel<ProjectConfiguration>({ required: true })

function update(patch: Partial<ProjectConfiguration>): void {
  configuration.value = { ...configuration.value, ...patch }
}

function textValue(event: Event): string {
  return (event.target as HTMLInputElement).value
}

function numberValue(event: Event): number {
  return Number((event.target as HTMLInputElement | HTMLSelectElement).value)
}
</script>

<template>
  <SettingsPage
    category="Project"
    page="General"
    title="General"
    description="Parameters stored inside this project and shared wherever it is opened."
  >
    <SettingsSection
      eyebrow="Identity"
      title="Project identity"
      description="The name shown throughout the workspace and recent project list."
    >
      <label class="field">
        <span>Project name</span>
        <input :value="configuration.name" required @input="update({ name: textValue($event) })" />
      </label>
    </SettingsSection>

    <SettingsSection
      eyebrow="Session format"
      title="Meter and audio basis"
      description="Tempo is edited on the tempo track; these values define new media and the initial musical meter."
    >
      <div class="field-grid">
        <label class="field wide">
          <span>Sample rate</span>
          <select
            :value="configuration.sampleRate"
            @change="
              update({ sampleRate: numberValue($event) as ProjectConfiguration['sampleRate'] })
            "
          >
            <option v-for="rate in PROJECT_SAMPLE_RATES" :key="rate" :value="rate">
              {{ rate.toLocaleString() }} Hz
            </option>
          </select>
          <small>Existing assets remain unchanged.</small>
        </label>
        <label class="field">
          <span>Meter numerator</span>
          <input
            :value="configuration.timeSignatureNumerator"
            type="number"
            min="1"
            max="32"
            @input="update({ timeSignatureNumerator: numberValue($event) })"
          />
        </label>
        <label class="field">
          <span>Meter denominator</span>
          <select
            :value="configuration.timeSignatureDenominator"
            @change="update({ timeSignatureDenominator: numberValue($event) })"
          >
            <option v-for="value in [1, 2, 4, 8, 16, 32]" :key="value" :value="value">
              {{ value }}
            </option>
          </select>
        </label>
      </div>
    </SettingsSection>

    <SettingsSection
      eyebrow="Waveforms"
      title="Channel display"
      description="Choose how multichannel audio is represented inside timeline clips."
    >
      <label class="field">
        <span>Waveform channels</span>
        <select
          :value="configuration.waveformDisplayMode"
          @change="
            update({
              waveformDisplayMode: textValue($event) as ProjectConfiguration['waveformDisplayMode']
            })
          "
        >
          <option value="separate">Separate channels</option>
          <option value="aggregate">Combined peak envelope</option>
        </select>
        <small>
          Separate mode creates one lane per channel and remains compatible with future surround
          formats.
        </small>
      </label>
    </SettingsSection>
  </SettingsPage>
</template>

<style scoped>
.field-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 18px;
}

.field.wide {
  grid-column: 1 / -1;
}

.field {
  display: grid;
  align-content: start;
  gap: 7px;
  color: var(--text-muted);
  font: 700 7px var(--font-utility);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.field input,
.field select {
  width: 100%;
  height: 40px;
  padding: 0 11px;
  border: 1px solid var(--line-strong);
  border-radius: 7px;
  color: var(--text-primary);
  background: var(--surface-1);
  outline: none;
  text-transform: none;
}

.field input:focus-visible,
.field select:focus-visible {
  border-color: var(--focus);
  box-shadow: var(--ui-focus-ring);
}

.field small {
  color: var(--text-faint);
  font: normal 7px var(--font-utility);
  letter-spacing: 0;
  line-height: 1.45;
  text-transform: none;
}

@media (max-width: 1120px) {
  .field-grid {
    grid-template-columns: 1fr;
  }

  .field.wide {
    grid-column: auto;
  }
}
</style>
