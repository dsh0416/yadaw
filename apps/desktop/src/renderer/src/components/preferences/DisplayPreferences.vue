<script setup lang="ts">
import { onMounted } from "vue"
import { storeToRefs } from "pinia"
import { Monitor, Moon, Sun } from "@lucide/vue"
import type { Component } from "vue"
import type { ThemePreference } from "@yadaw/contracts"
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
  <section class="display-preferences">
    <div class="settings-intro">
      <span class="section-kicker">Display <b>/</b> General</span>
      <h2>General</h2>
      <p>Choose a comfortable workspace for long editing and mixing sessions.</p>
    </div>

    <div class="display-setting">
      <div class="settings-copy">
        <h3>Color theme</h3>
        <p>Changes apply immediately across every project and are remembered on this device.</p>
      </div>
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
            <span class="preview-content"> <i /><i /><i /> </span>
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
    </div>

    <div class="comfort-note">
      <span>LONG SESSION PALETTE</span>
      <p>
        Large surfaces use low-chroma neutral grays. Saturated color is reserved for transport
        state, meters, recording, and other information that needs attention.
      </p>
    </div>
    <p v-if="error" class="display-error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.display-preferences {
  min-width: 0;
  overflow: auto;
  padding: 38px clamp(30px, 4.5vw, 68px) 60px;
  background: var(--canvas);
}
.settings-intro {
  max-width: 900px;
}
.section-kicker {
  color: var(--accent);
  font: 700 7px var(--font-utility);
  letter-spacing: 0.17em;
}
.section-kicker b {
  color: var(--text-faint);
}
.settings-intro h2 {
  margin: 8px 0 6px;
  font: 560 27px var(--font-display);
}
.settings-intro p,
.settings-copy p {
  margin: 0;
  color: var(--text-muted);
  font-size: 9px;
  line-height: 1.55;
}
.display-setting {
  display: grid;
  grid-template-columns: minmax(170px, 230px) minmax(390px, 1fr);
  max-width: 900px;
  gap: 48px;
  padding: 26px 0;
  border-bottom: 1px solid var(--line-soft);
}
.settings-copy h3 {
  margin: 0 0 6px;
  font: 600 11px var(--font-display);
}
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
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 30%, transparent) inset;
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
  border: 1px solid #0002;
  border-radius: 5px;
  background: #d8dade;
  overflow: hidden;
}
.preview-sidebar {
  background: #c8cacf;
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
  background: #a8acb2;
}
.preview-content i:first-child {
  width: 58%;
  background: #768994;
}
.preview-content i:last-child {
  width: 75%;
}
.theme-preview-dark {
  background: #202020;
}
.theme-preview-dark .preview-sidebar {
  background: #171717;
}
.theme-preview-dark .preview-content i {
  background: #414141;
}
.theme-preview-dark .preview-content i:first-child {
  background: #8ba6b4;
}
.theme-preview-system {
  grid-template-columns: 25% 37.5% 37.5%;
  background: linear-gradient(90deg, #d8dade 0 50%, #202020 50%);
}
.theme-preview-system .preview-sidebar {
  background: #c4c6ca;
}
.theme-preview-system .preview-content {
  grid-column: 2/-1;
  background: linear-gradient(90deg, transparent 0 50%, #202020 50%);
}
.theme-preview-system .preview-content i {
  background: linear-gradient(90deg, #a8acb2 0 50%, #414141 50%);
}
.theme-preview-system .preview-content i:first-child {
  background: linear-gradient(90deg, #607984 0 50%, #8ba6b4 50%);
}
.theme-option-copy {
  display: grid;
  grid-template-columns: 16px 1fr;
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
  font-size: 9px;
}
.theme-option-copy small {
  min-height: 29px;
  margin-top: 4px;
  color: var(--text-faint);
  font-size: 7px;
  line-height: 1.4;
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
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent);
}
.comfort-note {
  max-width: 900px;
  margin-top: 26px;
  padding: 14px;
  border-left: 2px solid var(--accent);
  color: var(--text-muted);
  background: var(--surface-1);
}
.comfort-note span {
  color: var(--accent);
  font: 700 7px var(--font-utility);
  letter-spacing: 0.14em;
}
.comfort-note p {
  max-width: 620px;
  margin: 7px 0 0;
  font-size: 8px;
  line-height: 1.6;
}
.display-error {
  max-width: 900px;
  color: var(--record);
  font-size: 9px;
}
@media (max-width: 1120px) {
  .display-setting {
    grid-template-columns: 1fr;
    gap: 17px;
  }
  .theme-options {
    grid-template-columns: repeat(3, minmax(120px, 1fr));
  }
}
</style>
