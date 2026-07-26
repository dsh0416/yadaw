<script setup lang="ts">
import { computed, onMounted, shallowRef } from "vue"
import { AudioWaveform, Piano, Plug, Search, SlidersHorizontal } from "@lucide/vue"
import type { ProjectAssetSummary as Asset } from "@yadaw/contracts"
import type { PluginDescriptor } from "@yadaw/contracts"
import { usePluginStore } from "../../stores/plugins"
import { writePluginDrag } from "../plugins/plugin-drag"

const props = defineProps<{ assets: Asset[] }>()
const pluginStore = usePluginStore()
const query = shallowRef("")
type BrowserSection = "instruments" | "effects" | "samples" | "plugins"
const activeSection = shallowRef<BrowserSection>("instruments")

function matches(value: string): boolean {
  return value.toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase())
}

const instruments = computed(() =>
  pluginStore.compatibleInstruments.filter((plugin) =>
    matches(`${plugin.name} ${plugin.vendor} ${plugin.category}`)
  )
)
const effects = computed(() =>
  pluginStore.compatibleEffects.filter((plugin) =>
    matches(`${plugin.name} ${plugin.vendor} ${plugin.category}`)
  )
)
const samples = computed(() => props.assets.filter((asset) => matches(asset.name)))
const allPlugins = computed(() =>
  pluginStore.catalog.plugins.filter((plugin) =>
    matches(`${plugin.name} ${plugin.vendor} ${plugin.category}`)
  )
)
const browserSections = computed<
  ReadonlyArray<{ value: BrowserSection; icon: typeof Piano; label: string; count: number }>
>(() => [
  { value: "instruments", icon: Piano, label: "Instruments", count: instruments.value.length },
  {
    value: "effects",
    icon: SlidersHorizontal,
    label: "Audio effects",
    count: effects.value.length
  },
  { value: "samples", icon: AudioWaveform, label: "Samples", count: samples.value.length },
  { value: "plugins", icon: Plug, label: "Plugins", count: allPlugins.value.length }
])

function activate(plugin: PluginDescriptor): void {
  void pluginStore.activate(plugin)
}

onMounted(() => void pluginStore.load())
</script>

<template>
  <aside class="browser-panel">
    <div class="panel-heading">
      <div><span>LIBRARY</span><strong>Sound browser</strong></div>
      <b>{{ assets.length }}</b>
    </div>
    <label class="search-field"
      ><Search :size="13" aria-hidden="true" /><input
        v-model="query"
        aria-label="Search sounds"
        placeholder="Search sounds & devices"
      /><kbd>/</kbd></label
    >
    <div class="browser-tabs">
      <div class="browser-nav" role="tablist" aria-label="Sound browser">
        <button
          v-for="section in browserSections"
          :key="section.value"
          class="browser-tab"
          role="tab"
          :aria-selected="activeSection === section.value"
          :tabindex="activeSection === section.value ? 0 : -1"
          @click="activeSection = section.value"
        >
          <component :is="section.icon" :size="14" /><span>{{ section.label }}</span
          ><small>{{ section.count }}</small>
        </button>
      </div>
      <hr class="panel-separator" />
      <section v-show="activeSection === 'instruments'" class="browser-content" role="tabpanel">
        <div class="library-scroll">
          <div class="library-viewport">
            <div class="library-heading">VST3 instruments</div>
            <button
              v-for="plugin in instruments"
              :key="plugin.classId"
              class="library-item"
              draggable="true"
              @dragstart="writePluginDrag($event, { source: 'catalog', descriptor: plugin })"
              @dblclick="activate(plugin)"
            >
              <span class="library-item-icon"><Piano :size="13" /></span
              ><span class="library-item-copy"
                ><b>{{ plugin.name }}</b
                ><small>{{ plugin.vendor }} · {{ plugin.category }}</small></span
              ><span class="item-dot compatible" />
            </button>
            <p v-if="!instruments.length" class="library-empty">
              No compatible VST3 instruments found.
            </p>
          </div>
        </div>
      </section>
      <section v-show="activeSection === 'effects'" class="browser-content" role="tabpanel">
        <div class="library-scroll">
          <div class="library-viewport">
            <div class="library-heading">VST3 audio effects</div>
            <button
              v-for="plugin in effects"
              :key="plugin.classId"
              class="library-item"
              draggable="true"
              @dragstart="writePluginDrag($event, { source: 'catalog', descriptor: plugin })"
              @dblclick="activate(plugin)"
            >
              <span class="library-item-icon"><SlidersHorizontal :size="13" /></span
              ><span class="library-item-copy"
                ><b>{{ plugin.name }}</b
                ><small>{{ plugin.vendor }} · {{ plugin.category }}</small></span
              ><span class="item-dot compatible" />
            </button>
            <p v-if="!effects.length" class="library-empty">No compatible VST3 effects found.</p>
          </div>
        </div>
      </section>
      <section v-show="activeSection === 'samples'" class="browser-content" role="tabpanel">
        <div class="library-scroll">
          <div class="library-viewport">
            <div class="library-heading">Project audio</div>
            <button v-for="asset in samples" :key="asset.id" class="library-item">
              <span class="library-item-icon"><AudioWaveform :size="13" /></span
              ><span class="library-item-copy"
                ><b>{{ asset.name }}</b
                ><small
                  >{{ asset.sampleRate.toLocaleString() }} Hz · {{ asset.bitDepth }}</small
                ></span
              ><span class="item-dot" />
            </button>
          </div>
        </div>
      </section>
      <section v-show="activeSection === 'plugins'" class="browser-content" role="tabpanel">
        <div class="plugin-scan">
          <button :disabled="pluginStore.catalog.scanning" @click="pluginStore.scan(false)">
            {{ pluginStore.catalog.scanning ? "Scanning…" : "Rescan VST3" }}
          </button>
          <small v-if="pluginStore.scanProgress"
            >{{ pluginStore.scanProgress.completed }}/{{ pluginStore.scanProgress.total }}</small
          >
        </div>
        <div class="library-scroll">
          <div class="library-viewport">
            <div class="library-heading">Plugin catalog</div>
            <article
              v-for="plugin in allPlugins"
              :key="`${plugin.modulePath}:${plugin.classId}`"
              class="library-item plugin-record"
            >
              <span class="library-item-icon"><Plug :size="13" /></span
              ><span class="library-item-copy"
                ><b>{{ plugin.name }}</b
                ><small>{{ plugin.vendor }} · {{ plugin.compatibility }}</small></span
              ><span :class="['item-dot', plugin.compatibility]" />
            </article>
            <p v-if="pluginStore.error" class="library-empty error">{{ pluginStore.error }}</p>
          </div>
        </div>
      </section>
    </div>
  </aside>
</template>

<style scoped>
.browser-panel {
  display: flex;
  min-height: 0;
  flex-direction: column;
  padding: 17px 12px 12px;
  border-right: 1px solid var(--line-soft);
  background: var(--surface-panel);
}
.panel-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 6px 14px;
}
.panel-heading span,
.panel-heading strong {
  display: block;
}
.panel-heading span {
  color: var(--accent);
  font: 700 7px var(--font-utility);
  letter-spacing: 0.18em;
}
.panel-heading strong {
  margin-top: 5px;
  color: var(--text-primary);
  font-family: var(--font-display);
  font-size: 13px;
  letter-spacing: 0.01em;
}
.panel-heading > b {
  display: grid;
  place-items: center;
  width: 24px;
  height: 20px;
  border: 1px solid var(--line-soft);
  border-radius: 5px;
  color: var(--text-faint);
  font: 8px var(--font-utility);
}
.search-field {
  display: grid;
  grid-template-columns: 14px 1fr auto;
  align-items: center;
  gap: 7px;
  padding: 0 9px;
  border: 1px solid var(--line-soft);
  border-radius: 7px;
  color: var(--text-faint);
  background: var(--surface-sunken);
}
.search-field:focus-within {
  border-color: var(--focus);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--focus) 18%, transparent);
}
.search-field input {
  min-width: 0;
  padding: 9px 0;
  border: 0;
  outline: none;
  color: var(--text-primary);
  background: transparent;
  font-size: 10px;
}
.search-field input::placeholder {
  color: var(--text-faint);
}
.search-field kbd {
  padding: 2px 5px;
  border: 1px solid var(--line-strong);
  border-radius: 4px;
  color: var(--text-muted);
  background: var(--daw-control);
  font: 8px var(--font-utility);
}
.browser-tabs {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
}
.browser-nav {
  display: grid;
  gap: 3px;
  margin-top: 12px;
}
.browser-tab {
  display: grid;
  grid-template-columns: 17px 1fr auto;
  align-items: center;
  gap: 8px;
  padding: 8px 9px;
  border: 1px solid transparent;
  border-radius: 6px;
  color: var(--text-muted);
  background: transparent;
  text-align: left;
  cursor: pointer;
  font-size: 10px;
}
.browser-tab:hover {
  color: var(--text-secondary);
  background: color-mix(in srgb, var(--text-primary) 4%, transparent);
}
.browser-tab:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}
.browser-tab[aria-selected="true"] {
  border-color: var(--line-strong);
  color: var(--text-primary);
  background: var(--surface-active);
  box-shadow: 2px 0 0 var(--accent) inset;
}
.browser-tab > svg {
  color: var(--text-muted);
}
.browser-tab[aria-selected="true"] > svg {
  color: var(--accent);
}
.browser-tab small {
  color: var(--text-faint);
  font: 8px var(--font-utility);
}
.panel-separator {
  width: 100%;
  height: 1px;
  margin: 12px 0;
  background: var(--line-soft);
  border: 0;
}
.browser-content {
  min-height: 0;
  flex: 1;
  outline: none;
}
.library-scroll,
.library-viewport {
  width: 100%;
  height: 100%;
}
.library-scroll {
  overflow-y: auto;
}
.library-heading {
  padding: 1px 6px 7px;
  color: var(--text-faint);
  font: 700 7px var(--font-utility);
  text-transform: uppercase;
  letter-spacing: 0.14em;
}
.library-item {
  display: grid;
  grid-template-columns: 29px 1fr auto;
  align-items: center;
  width: 100%;
  gap: 8px;
  padding: 7px 6px;
  border: 0;
  border-radius: 6px;
  color: var(--text-secondary);
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.library-item:hover,
.library-item:focus-visible {
  background: color-mix(in srgb, var(--text-primary) 5%, transparent);
  outline: none;
}
.library-item:focus-visible {
  box-shadow: 0 0 0 2px var(--focus) inset;
}
.library-item-icon {
  display: grid;
  place-items: center;
  width: 29px;
  height: 29px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  color: var(--signal-cyan);
  background: var(--daw-control);
}
.library-item-copy,
.library-item-copy b,
.library-item-copy small {
  display: block;
  min-width: 0;
}
.library-item-copy b {
  overflow: hidden;
  font-size: 9px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.library-item-copy small {
  margin-top: 3px;
  color: var(--text-faint);
  font: 7px var(--font-utility);
}
.item-dot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--line-strong);
}
.library-scrollbar {
  display: flex;
  width: 7px;
  padding: 2px;
  background: transparent;
  touch-action: none;
  user-select: none;
}
.library-scroll-thumb {
  position: relative;
  flex: 1;
  border-radius: 999px;
  background: var(--text-faint);
}
.library-empty {
  margin: 10px 6px;
  color: var(--text-faint);
  font-size: 8px;
  line-height: 1.5;
}
.library-empty.error {
  color: var(--record);
}
.item-dot.compatible {
  background: var(--ui-domain-color-73d6a2);
  box-shadow: 0 0 5px color-mix(in srgb, var(--ui-domain-color-73d6a2) 55%, transparent);
}
.item-dot.quarantined,
.item-dot.load-error {
  background: var(--record);
}
.plugin-record {
  cursor: default;
}
.plugin-scan {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
  padding: 0 5px;
}
.plugin-scan button {
  height: 25px;
  border: 1px solid var(--line-strong);
  border-radius: 4px;
  color: var(--text-secondary);
  background: var(--daw-control);
  font: 700 7px var(--font-utility);
  cursor: pointer;
}
.plugin-scan button:disabled {
  opacity: 0.45;
}
.plugin-scan small {
  color: var(--text-faint);
  font: 7px var(--font-utility);
}
</style>
