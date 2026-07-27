<script setup lang="ts">
import { UiSelect } from "@yadaw/ui"
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
  return Number((event.target as HTMLInputElement).value)
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
          <UiSelect
            :model-value="String(configuration.sampleRate)"
            size="md"
            @update:model-value="
              update({ sampleRate: Number($event) as ProjectConfiguration['sampleRate'] })
            "
          >
            <option v-for="rate in PROJECT_SAMPLE_RATES" :key="rate" :value="String(rate)">
              {{ rate.toLocaleString() }} Hz
            </option>
          </UiSelect>
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
          <UiSelect
            :model-value="String(configuration.timeSignatureDenominator)"
            size="md"
            @update:model-value="update({ timeSignatureDenominator: Number($event) })"
          >
            <option v-for="value in [1, 2, 4, 8, 16, 32]" :key="value" :value="String(value)">
              {{ value }}
            </option>
          </UiSelect>
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
        <UiSelect
          :model-value="configuration.waveformDisplayMode"
          size="md"
          @update:model-value="
            update({
              waveformDisplayMode: $event as ProjectConfiguration['waveformDisplayMode']
            })
          "
        >
          <option value="separate">Separate channels</option>
          <option value="aggregate">Combined peak envelope</option>
        </UiSelect>
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
  font: var(--ui-type-weight-bold) var(--ui-type-size-caption) var(--ui-type-family-data);
  letter-spacing: var(--ui-type-tracking-wide);
  text-transform: uppercase;
}

.field input {
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

.field input:focus-visible {
  border-color: var(--focus);
  box-shadow: var(--ui-focus-ring);
}

.field small {
  color: var(--text-faint);
  font: var(--ui-type-weight-regular) var(--ui-type-size-caption) var(--ui-type-family-data);
  letter-spacing: var(--ui-type-tracking-normal);
  line-height: var(--ui-type-leading-normal);
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
