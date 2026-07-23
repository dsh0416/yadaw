<script setup lang="ts">
import { AudioWaveform, Piano, Plug, Search, SlidersHorizontal } from "@lucide/vue"
import { ScrollAreaRoot, ScrollAreaScrollbar, ScrollAreaThumb, ScrollAreaViewport, Separator, TabsContent, TabsList, TabsRoot, TabsTrigger } from "reka-ui"
import type { Asset } from "@yadaw/project-db/schema"

defineProps<{ assets: Asset[] }>()

const browserSections = [
  { value: "instruments", icon: Piano, label: "Instruments", items: ["Analog Bloom", "Glass Keys", "Sub Current", "Felt Motion"] },
  { value: "effects", icon: SlidersHorizontal, label: "Audio effects", items: ["Tape Color", "Room Space", "Transient Shape", "Utility"] },
  { value: "samples", icon: AudioWaveform, label: "Samples", items: ["Dusty Drums", "Modular Chords", "Field Notes", "One Shots"] },
  { value: "plugins", icon: Plug, label: "Plugins", items: ["Audio Units", "VST3", "CLAP", "Plugin settings"] }
] as const
</script>

<template>
  <aside class="browser-panel">
    <div class="panel-heading"><div><span>LIBRARY</span><strong>Sound browser</strong></div><b>{{ assets.length }}</b></div>
    <label class="search-field"><Search :size="13" aria-hidden="true" /><input aria-label="Search sounds" placeholder="Search sounds & devices" /><kbd>/</kbd></label>
    <TabsRoot class="browser-tabs" default-value="instruments" orientation="vertical">
      <TabsList class="browser-nav" aria-label="Sound browser">
        <TabsTrigger v-for="section in browserSections" :key="section.value" class="browser-tab" :value="section.value"><component :is="section.icon" :size="14" /><span>{{ section.label }}</span><small>{{ section.items.length }}</small></TabsTrigger>
      </TabsList>
      <Separator class="panel-separator" orientation="horizontal" />
      <TabsContent v-for="section in browserSections" :key="section.value" class="browser-content" :value="section.value">
        <ScrollAreaRoot class="library-scroll" type="auto">
          <ScrollAreaViewport class="library-viewport">
            <div class="library-heading">Factory collection</div>
            <button v-for="asset in section.value === 'samples' ? assets : []" :key="asset.id" class="library-item"><span class="library-item-icon"><AudioWaveform :size="13" /></span><span class="library-item-copy"><b>{{ asset.name }}</b><small>{{ asset.sampleRate.toLocaleString() }} Hz · {{ asset.bitDepth }}</small></span><span class="item-dot" /></button>
            <button v-for="(item, index) in section.items" :key="item" class="library-item"><span class="library-item-icon"><component :is="section.icon" :size="13" /></span><span class="library-item-copy"><b>{{ item }}</b><small>Factory · {{ index + 1 }}</small></span><span class="item-dot" /></button>
          </ScrollAreaViewport>
          <ScrollAreaScrollbar class="library-scrollbar" orientation="vertical"><ScrollAreaThumb class="library-scroll-thumb" /></ScrollAreaScrollbar>
        </ScrollAreaRoot>
      </TabsContent>
    </TabsRoot>
  </aside>
</template>

<style scoped>
.browser-panel{display:flex;min-height:0;flex-direction:column;padding:17px 12px 12px;border-right:1px solid var(--line-soft);background:var(--surface-panel)}.panel-heading{display:flex;align-items:center;justify-content:space-between;padding:0 6px 14px}.panel-heading span,.panel-heading strong{display:block}.panel-heading span{color:var(--accent);font:700 7px var(--font-utility);letter-spacing:.18em}.panel-heading strong{margin-top:5px;color:var(--text-primary);font-family:var(--font-display);font-size:13px;letter-spacing:.01em}.panel-heading>b{display:grid;place-items:center;width:24px;height:20px;border:1px solid var(--line-soft);border-radius:5px;color:var(--text-faint);font:8px var(--font-utility)}.search-field{display:grid;grid-template-columns:14px 1fr auto;align-items:center;gap:7px;padding:0 9px;border:1px solid var(--line-soft);border-radius:7px;color:var(--text-faint);background:#090d15}.search-field:focus-within{border-color:#7b73d2;box-shadow:0 0 0 2px #7b73d220}.search-field input{min-width:0;padding:9px 0;border:0;outline:none;color:var(--text-primary);background:transparent;font-size:10px}.search-field input::placeholder{color:#536075}.search-field kbd{padding:2px 5px;border:1px solid #2e3747;border-radius:4px;color:#59667a;background:#121824;font:8px var(--font-utility)}.browser-tabs{display:flex;min-height:0;flex:1;flex-direction:column}.browser-nav{display:grid;gap:3px;margin-top:12px}.browser-tab{display:grid;grid-template-columns:17px 1fr auto;align-items:center;gap:8px;padding:8px 9px;border:1px solid transparent;border-radius:6px;color:var(--text-muted);background:transparent;text-align:left;cursor:pointer;font-size:10px}.browser-tab:hover{color:var(--text-secondary);background:#ffffff05}.browser-tab:focus-visible{outline:2px solid var(--focus);outline-offset:1px}.browser-tab[data-state=active]{border-color:#6f67c833;color:#d1ceff;background:linear-gradient(90deg,#24234a,#1a1d33);box-shadow:2px 0 0 var(--accent) inset}.browser-tab>svg{color:#647187}.browser-tab[data-state=active]>svg{color:var(--accent-soft)}.browser-tab small{color:#505c70;font:8px var(--font-utility)}.panel-separator{width:100%;height:1px;margin:12px 0;background:var(--line-soft)}.browser-content{min-height:0;flex:1;outline:none}.library-scroll,.library-viewport{width:100%;height:100%}.library-scroll{overflow:hidden}.library-heading{padding:1px 6px 7px;color:#536075;font:700 7px var(--font-utility);text-transform:uppercase;letter-spacing:.14em}.library-item{display:grid;grid-template-columns:29px 1fr auto;align-items:center;width:100%;gap:8px;padding:7px 6px;border:0;border-radius:6px;color:var(--text-secondary);background:transparent;text-align:left;cursor:pointer}.library-item:hover,.library-item:focus-visible{background:#ffffff06;outline:none}.library-item:focus-visible{box-shadow:0 0 0 2px var(--focus) inset}.library-item-icon{display:grid;place-items:center;width:29px;height:29px;border:1px solid #303a4a;border-radius:6px;color:var(--signal-cyan);background:linear-gradient(145deg,#151d2a,#101621)}.library-item-copy,.library-item-copy b,.library-item-copy small{display:block;min-width:0}.library-item-copy b{overflow:hidden;font-size:9px;font-weight:600;text-overflow:ellipsis;white-space:nowrap}.library-item-copy small{margin-top:3px;color:var(--text-faint);font:7px var(--font-utility)}.item-dot{width:4px;height:4px;border-radius:50%;background:#364155}.library-scrollbar{display:flex;width:7px;padding:2px;background:transparent;touch-action:none;user-select:none}.library-scroll-thumb{position:relative;flex:1;border-radius:999px;background:#3a4558}
</style>
