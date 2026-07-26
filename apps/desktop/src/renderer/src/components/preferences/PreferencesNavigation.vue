<script setup lang="ts">
import { computed } from "vue"
import { AudioLines, Cable, CircleDot, Gauge, Keyboard, Music2, Palette, Plug } from "@lucide/vue"

type PreferencesPageId = "devices" | "engine" | "recording" | "display-general" | "display-mixer"

const props = defineProps<{ activePage: PreferencesPageId }>()
const emit = defineEmits<{ select: [page: PreferencesPageId] }>()
const categories = [
  { id: "audio", label: "Audio", icon: AudioLines, disabled: false, page: "devices" },
  { id: "midi", label: "MIDI", icon: Music2, disabled: true, page: null },
  { id: "plugins", label: "Plugins", icon: Plug, disabled: true, page: null },
  { id: "display", label: "Display", icon: Palette, disabled: false, page: "display-general" },
  { id: "keyboard", label: "Keyboard", icon: Keyboard, disabled: true, page: null }
] as const
const activeCategory = computed(() =>
  props.activePage.startsWith("display-") ? "display" : "audio"
)

function selectCategory(page: PreferencesPageId | null): void {
  if (page) emit("select", page)
}
</script>

<template>
  <aside class="prefs-primary-nav">
    <div class="sidebar-label">SETTINGS</div>
    <nav class="settings-primary-nav" aria-label="Preference categories">
      <button
        :class="['settings-page-item', { active: activePage === 'engine' }]"
        :aria-current="activePage === 'engine' ? 'page' : undefined"
        @click="emit('select', 'engine')"
      >
        <Gauge :size="15" /><span><b>Engine</b><small>Async workers & IPC egress</small></span>
      </button>
      <button
        v-for="category in categories"
        :key="category.id"
        :class="['settings-nav-item', { active: category.id === activeCategory }]"
        :disabled="category.disabled"
        :aria-current="category.id === activeCategory ? 'page' : undefined"
        @click="selectCategory(category.page)"
      >
        <component :is="category.icon" :size="15" /><span>{{ category.label }}</span
        ><small v-if="category.disabled">SOON</small>
      </button>
    </nav>
    <div class="sidebar-version">YADAW / BUILD 0.0.0</div>
  </aside>
  <aside class="prefs-secondary-nav">
    <div class="secondary-sidebar-heading">
      <span>{{ activeCategory === "audio" ? "AUDIO" : "DISPLAY" }}</span>
      <strong>{{ activeCategory === "audio" ? "Signal path" : "Workspace" }}</strong>
    </div>
    <nav v-if="activeCategory === 'audio'" aria-label="Audio preference pages">
      <button
        :class="['settings-page-item', { active: activePage === 'devices' }]"
        :aria-current="activePage === 'devices' ? 'page' : undefined"
        @click="emit('select', 'devices')"
      >
        <Cable :size="15" /><span><b>Devices</b><small>Host, hardware I/O & latency</small></span>
      </button>
      <button
        :class="['settings-page-item', { active: activePage === 'recording' }]"
        :aria-current="activePage === 'recording' ? 'page' : undefined"
        @click="emit('select', 'recording')"
      >
        <CircleDot :size="15" /><span><b>Recording</b><small>Swap, format & recovery</small></span>
      </button>
    </nav>
    <nav v-else aria-label="Display preference pages">
      <button
        :class="['settings-page-item', { active: activePage === 'display-general' }]"
        :aria-current="activePage === 'display-general' ? 'page' : undefined"
        @click="emit('select', 'display-general')"
      >
        <Palette :size="15" /><span><b>General</b><small>Light, dark & system</small></span>
      </button>
      <button
        :class="['settings-page-item', { active: activePage === 'display-mixer' }]"
        :aria-current="activePage === 'display-mixer' ? 'page' : undefined"
        @click="emit('select', 'display-mixer')"
      >
        <Gauge :size="15" /><span><b>Mixer</b><small>Meter hold & return</small></span>
      </button>
    </nav>
    <div v-if="activeCategory === 'audio'" class="signal-route" aria-hidden="true">
      <span>HOST</span><i /><span>I/O</span><i /><span>DSP</span>
    </div>
  </aside>
</template>

<style scoped>
.prefs-primary-nav {
  position: relative;
  min-width: 0;
  padding: 24px 11px;
  border-right: 1px solid var(--line-soft);
  background: var(--surface-panel);
}
.prefs-secondary-nav {
  min-width: 0;
  padding: 24px 11px;
  border-right: 1px solid var(--line-soft);
  background: var(--surface-1);
}
.sidebar-label {
  margin: 0 9px 10px;
  color: var(--text-faint);
  font: 700 7px var(--font-utility);
  letter-spacing: 0.16em;
}
.settings-primary-nav {
  display: grid;
  gap: 3px;
}
.settings-nav-item {
  display: grid;
  grid-template-columns: 17px 1fr auto;
  align-items: center;
  width: 100%;
  gap: 8px;
  padding: 9px;
  border: 1px solid transparent;
  border-radius: 6px;
  color: var(--text-muted);
  background: transparent;
  text-align: left;
  font-size: 9px;
  cursor: pointer;
}
.settings-nav-item.active {
  border-color: color-mix(in srgb, var(--accent) 28%, transparent);
  color: var(--text-primary);
  background: var(--surface-active);
  box-shadow: 2px 0 0 var(--accent) inset;
}
.settings-nav-item:disabled {
  opacity: 0.42;
  cursor: default;
}
.settings-nav-item small {
  color: var(--text-faint);
  font: 6px var(--font-utility);
  letter-spacing: 0.08em;
}
.sidebar-version {
  position: absolute;
  right: 20px;
  bottom: 18px;
  left: 20px;
  color: var(--text-faint);
  font: 6px var(--font-utility);
  letter-spacing: 0.06em;
}
.secondary-sidebar-heading {
  margin: 0 9px 17px;
}
.secondary-sidebar-heading span,
.secondary-sidebar-heading strong {
  display: block;
}
.secondary-sidebar-heading span {
  color: var(--accent);
  font: 700 7px var(--font-utility);
  letter-spacing: 0.17em;
}
.secondary-sidebar-heading strong {
  margin-top: 6px;
  color: var(--text-primary);
  font-family: var(--font-display);
  font-size: 14px;
}
.settings-page-item {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr);
  width: 100%;
  gap: 8px;
  margin-bottom: 5px;
  padding: 10px;
  border: 1px solid transparent;
  border-radius: 7px;
  color: var(--text-muted);
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.settings-page-item.active {
  border-color: var(--line-strong);
  color: var(--text-primary);
  background: var(--surface-active);
}
.settings-page-item > svg {
  margin-top: 1px;
  color: var(--accent);
}
.settings-page-item b,
.settings-page-item small {
  display: block;
}
.settings-page-item b {
  font-size: 9px;
}
.settings-page-item small {
  margin-top: 4px;
  color: var(--text-faint);
  font-size: 7px;
  line-height: 1.4;
}
.settings-page-item:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}
.signal-route {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  margin: 24px 8px;
  color: var(--text-faint);
  font: 6px var(--font-utility);
}
.signal-route i {
  width: 16px;
  height: 1px;
  background: var(--line-strong);
}
</style>
