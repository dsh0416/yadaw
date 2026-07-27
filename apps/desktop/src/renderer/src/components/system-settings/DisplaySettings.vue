<script setup lang="ts">
import { onMounted } from "vue"
import { storeToRefs } from "pinia"
import { Monitor, Moon, Sun } from "@lucide/vue"
import type { Component } from "vue"
import type { ThemePreference } from "@yadaw/contracts"
import SettingsPage from "../settings/SettingsPage.vue"
import SettingsSection from "../settings/SettingsSection.vue"
import { useApplicationSettingsStore } from "../../stores/applicationSettings"

const settingsStore = useApplicationSettingsStore()
const { settings, loading, error } = storeToRefs(settingsStore)

const themeOptions: ReadonlyArray<{
  value: ThemePreference
  label: string
  description: string
  icon: Component
}> = [
  {
    value: "light",
    label: "Light",
    description: "A soft neutral-gray workspace for bright rooms.",
    icon: Sun
  },
  {
    value: "dark",
    label: "Dark",
    description: "Low-glare graphite surfaces for long sessions.",
    icon: Moon
  },
  {
    value: "system",
    label: "Follow system",
    description: "Switch automatically with your operating system.",
    icon: Monitor
  }
]

onMounted(() => {
  if (!settings.value) void settingsStore.load()
})
</script>

<template>
  <SettingsPage
    category="Display"
    page="General"
    title="General"
    description="Choose a comfortable workspace for long editing and mixing sessions."
  >
    <SettingsSection
      title="Color theme"
      description="Changes apply immediately across every project and are remembered on this device."
    >
      <div class="theme-options" role="radiogroup" aria-label="Color theme">
        <button
          v-for="option in themeOptions"
          :key="option.value"
          class="theme-option"
          :class="{ selected: settings?.theme === option.value }"
          type="button"
          role="radio"
          :aria-checked="settings?.theme === option.value"
          :disabled="loading"
          @click="settingsStore.setTheme(option.value)"
        >
          <span class="theme-preview" :class="`theme-preview-${option.value}`" aria-hidden="true">
            <span class="preview-sidebar" />
            <span class="preview-content"><i /><i /><i /></span>
          </span>
          <span class="theme-option-copy">
            <component :is="option.icon" :size="14" />
            <span>
              <b>{{ option.label }}</b>
              <small>{{ option.description }}</small>
            </span>
          </span>
          <span class="selection-dot" aria-hidden="true" />
        </button>
      </div>
    </SettingsSection>

    <p v-if="error" class="display-error" role="alert">{{ error }}</p>
  </SettingsPage>
</template>

<style scoped>
.theme-options {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 9px;
}

.theme-option {
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

.theme-option:hover {
  border-color: var(--line-strong);
  background: var(--surface-2);
}

.theme-option.selected {
  border-color: var(--accent);
  box-shadow: var(--ui-shadow-selected-outline);
}

.theme-option:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}

.theme-option:disabled {
  cursor: wait;
  opacity: 0.6;
}

.theme-preview {
  display: grid;
  grid-template-columns: 25% 1fr;
  height: 72px;
  border: 1px solid color-mix(in srgb, var(--text-primary) 18%, transparent);
  border-radius: 5px;
  background: var(--canvas);
  overflow: hidden;
}

.preview-sidebar {
  background: var(--surface-panel);
}

.preview-content {
  display: grid;
  align-content: center;
  gap: 6px;
  padding: 11px;
}

.preview-content i {
  display: block;
  height: 5px;
  border-radius: 2px;
  background: var(--line-strong);
}

.preview-content i:first-child {
  width: 58%;
  background: var(--accent);
}

.preview-content i:last-child {
  width: 75%;
}

.theme-preview-light {
  --canvas: var(--ui-domain-color-d8d9db);
  --surface-panel: var(--ui-domain-color-c5c7ca);
  --line-strong: var(--ui-domain-color-a4a8ae);
  --accent: var(--ui-domain-color-657f8d);
}

.theme-preview-dark {
  --canvas: var(--ui-domain-color-202020);
  --surface-panel: var(--ui-domain-color-171717);
  --line-strong: var(--ui-domain-color-414141);
  --accent: var(--ui-domain-color-8ba6b4);
}

.theme-preview-system {
  background: linear-gradient(
    90deg,
    var(--ui-domain-color-d8d9db) 0 50%,
    var(--ui-domain-color-202020) 50%
  );
}

.theme-preview-system .preview-sidebar {
  background: linear-gradient(
    90deg,
    var(--ui-domain-color-c5c7ca) 0 50%,
    var(--ui-domain-color-171717) 50%
  );
}

.theme-preview-system .preview-content i {
  background: linear-gradient(
    90deg,
    var(--ui-domain-color-a4a8ae) 0 50%,
    var(--ui-domain-color-414141) 50%
  );
}

.theme-preview-system .preview-content i:first-child {
  background: linear-gradient(
    90deg,
    var(--ui-domain-color-657f8d) 0 50%,
    var(--ui-domain-color-8ba6b4) 50%
  );
}

.theme-option-copy {
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr);
  gap: 7px;
}

.theme-option-copy > svg {
  margin-top: 1px;
  color: var(--accent);
}

.theme-option-copy b,
.theme-option-copy small {
  display: block;
}

.theme-option-copy b {
  font-size: var(--ui-type-size-body-compact);
}

.theme-option-copy small {
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

.display-error {
  color: var(--record);
  font-size: var(--ui-type-size-body-compact);
}

@media (max-width: 1120px) {
  .theme-options {
    grid-template-columns: repeat(3, minmax(120px, 1fr));
  }
}
</style>
