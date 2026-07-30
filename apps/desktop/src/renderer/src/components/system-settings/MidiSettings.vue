<script setup lang="ts">
import { computed, onMounted } from "vue"
import type { Component } from "vue"
import { storeToRefs } from "pinia"
import { useI18n } from "vue-i18n"
import { Music2, Piano } from "@lucide/vue"
import type { MidiCenterCStandard } from "@yadaw/contracts"
import SettingsPage from "../settings/SettingsPage.vue"
import SettingsSection from "../settings/SettingsSection.vue"
import { useApplicationSettingsStore } from "../../stores/applicationSettings"

const { t } = useI18n()
const settingsStore = useApplicationSettingsStore()
const { settings, loading, error } = storeToRefs(settingsStore)

const centerCOptions = computed<
  ReadonlyArray<{
    value: MidiCenterCStandard
    label: string
    description: string
    icon: Component
  }>
>(() => [
  {
    value: "yamaha-c3",
    label: t("settings.midi.centerC.yamaha.label"),
    description: t("settings.midi.centerC.yamaha.description"),
    icon: Piano
  },
  {
    value: "roland-c4",
    label: t("settings.midi.centerC.roland.label"),
    description: t("settings.midi.centerC.roland.description"),
    icon: Music2
  }
])

onMounted(() => {
  if (!settings.value) void settingsStore.load()
})
</script>

<template>
  <SettingsPage
    :category="t('settings.midi.category')"
    :page="t('settings.midi.page')"
    :title="t('settings.midi.title')"
    :description="t('settings.midi.description')"
  >
    <SettingsSection
      :title="t('settings.midi.centerC.title')"
      :description="t('settings.midi.centerC.description')"
    >
      <div
        class="center-c-options"
        role="radiogroup"
        :aria-label="t('settings.midi.centerC.ariaLabel')"
      >
        <button
          v-for="option in centerCOptions"
          :key="option.value"
          class="center-c-option"
          :class="{ selected: (settings?.midiCenterCStandard ?? 'roland-c4') === option.value }"
          type="button"
          role="radio"
          :aria-checked="(settings?.midiCenterCStandard ?? 'roland-c4') === option.value"
          :disabled="loading"
          @click="settingsStore.setMidiCenterCStandard(option.value)"
        >
          <span class="center-c-option-copy">
            <component :is="option.icon" :size="14" aria-hidden="true" />
            <span>
              <b>{{ option.label }}</b>
              <small>{{ option.description }}</small>
            </span>
          </span>
          <span class="selection-dot" aria-hidden="true" />
        </button>
      </div>
    </SettingsSection>

    <p v-if="error" class="midi-error" role="alert">{{ error }}</p>
  </SettingsPage>
</template>

<style scoped>
.center-c-options {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 9px;
}

.center-c-option {
  position: relative;
  display: grid;
  gap: 11px;
  padding: 10px;
  border: 1px solid var(--line-soft);
  border-radius: 7px;
  color: var(--text-secondary);
  background: var(--surface-1);
  text-align: left;
  cursor: pointer;
}

.center-c-option:hover {
  border-color: var(--line-strong);
  background: var(--surface-2);
}

.center-c-option.selected {
  border-color: var(--accent);
  box-shadow: var(--ui-shadow-selected-outline);
}

.center-c-option:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}

.center-c-option:disabled {
  cursor: wait;
  opacity: 0.6;
}

.center-c-option-copy {
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr);
  gap: 7px;
}

.center-c-option-copy > svg {
  margin-top: 1px;
  color: var(--accent);
}

.center-c-option-copy b,
.center-c-option-copy small {
  display: block;
}

.center-c-option-copy b {
  font-size: var(--ui-type-size-body-compact);
}

.center-c-option-copy small {
  min-height: 29px;
  margin-top: 4px;
  color: var(--text-faint);
  font-size: var(--ui-type-size-caption);
  line-height: var(--ui-type-leading-compact);
}

.selection-dot {
  position: absolute;
  top: 15px;
  right: 15px;
  width: 7px;
  height: 7px;
  border: 1px solid var(--line-strong);
  border-radius: 50%;
  background: var(--surface-1);
}

.selected .selection-dot {
  border-color: var(--accent);
  background: var(--accent);
  box-shadow: var(--ui-focus-ring);
}

.midi-error {
  color: var(--record);
  font-size: var(--ui-type-size-body-compact);
}

@media (max-width: 1120px) {
  .center-c-options {
    grid-template-columns: 1fr;
  }
}
</style>
