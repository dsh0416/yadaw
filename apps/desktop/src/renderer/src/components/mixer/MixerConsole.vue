<script setup lang="ts">
import { Plus, RotateCcw, RotateCw } from "@lucide/vue"
import { useMixerStore } from "../../stores/mixer"
import MixerChannelStrip from "./MixerChannelStrip.vue"

defineProps<{
  density: "full" | "dock"
}>()

const mixerStore = useMixerStore()
</script>

<template>
  <section :class="['mixer-console', density]" aria-label="Mixer console">
    <header class="mixer-toolbar">
      <div>
        <span>MIXER</span>
        <strong>{{ mixerStore.audioTracks.length }} tracks · {{ mixerStore.buses.length }} buses</strong>
      </div>
      <nav aria-label="Mixer actions">
        <button aria-label="Add mono audio track" @click="mixerStore.createAudioTrack('mono')"><Plus :size="12" />Mono</button>
        <button aria-label="Add stereo audio track" @click="mixerStore.createAudioTrack('stereo')"><Plus :size="12" />Stereo</button>
        <button aria-label="Add bus" @click="mixerStore.createBus"><Plus :size="12" />Bus</button>
        <button aria-label="Undo mixer change" :disabled="!mixerStore.canUndo" @click="mixerStore.undo"><RotateCcw :size="13" /></button>
        <button aria-label="Redo mixer change" :disabled="!mixerStore.canRedo" @click="mixerStore.redo"><RotateCw :size="13" /></button>
      </nav>
    </header>
    <div class="channel-scroll">
      <MixerChannelStrip
        v-for="channel in mixerStore.orderedChannels"
        :key="channel.id"
        :channel="channel"
        :sends="mixerStore.sendsFor(channel.id)"
        :meter="mixerStore.meterFor(channel.id)"
        :outputs="mixerStore.availableOutputs(channel.id)"
        :selected="channel.id === mixerStore.selectedChannelId"
        :density="density"
        @select="mixerStore.selectedChannelId = $event"
        @preview="mixerStore.preview"
        @update-channel="mixerStore.updateChannel"
        @reset-meter-clips="mixerStore.clearMeterClips"
      />
    </div>
    <p v-if="mixerStore.error" class="mixer-error" role="alert">{{ mixerStore.error }}</p>
  </section>
</template>

<style scoped>
.mixer-console{position:relative;display:grid;grid-template-rows:43px minmax(0,1fr);min-width:0;min-height:0;background:var(--daw-workspace);overflow:hidden}.mixer-toolbar{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:0 11px 0 14px;border-bottom:1px solid var(--line-strong);background:var(--surface-1)}.mixer-toolbar>div span,.mixer-toolbar>div strong{display:block}.mixer-toolbar>div span{color:var(--accent);font:700 7px var(--font-utility);letter-spacing:.17em}.mixer-toolbar>div strong{margin-top:3px;color:var(--text-muted);font-size:9px;font-weight:600}.mixer-toolbar nav{display:flex;gap:5px}.mixer-toolbar button{display:flex;align-items:center;gap:4px;height:27px;padding:0 8px;border:1px solid var(--line-strong);border-radius:4px;color:var(--text-secondary);background:var(--daw-control);font-size:7px;cursor:pointer}.mixer-toolbar button:hover{color:var(--text-primary);background:var(--daw-control-hover)}.mixer-toolbar button:disabled{opacity:.3;cursor:not-allowed}.mixer-toolbar button:focus-visible{outline:2px solid var(--focus);outline-offset:1px}.channel-scroll{display:flex;align-items:stretch;min-width:0;min-height:0;overflow-x:auto;overflow-y:hidden;background-color:var(--daw-workspace);background-image:linear-gradient(90deg,color-mix(in srgb,var(--text-primary) 3%,transparent) 1px,transparent 1px);background-size:112px 100%}.dock .mixer-toolbar{grid-template-columns:1fr auto;height:36px}.dock .mixer-toolbar>div strong{display:none}.dock .mixer-toolbar button{height:23px;padding:0 6px}.dock{grid-template-rows:36px minmax(0,1fr)}.mixer-error{position:absolute;right:10px;bottom:8px;margin:0;padding:6px 9px;border:1px solid color-mix(in srgb,var(--record) 55%,var(--line-strong));border-radius:4px;color:var(--record);background:color-mix(in srgb,var(--record) 14%,var(--surface-1));font-size:8px}
</style>
