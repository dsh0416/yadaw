<script setup lang="ts">
import { computed, shallowRef } from "vue"
import { Trash2 } from "@lucide/vue"
import type { PluginDescriptor, PluginInstanceState, PluginRuntimeStatus } from "@yadaw/contracts"
import { PLUGIN_DRAG_TYPE, readPluginDrag } from "../plugins/plugin-drag"
import PluginAudioModeMenu from "../plugins/PluginAudioModeMenu.vue"
import { pluginAudioModeBadge, type PluginSelection } from "../plugins/plugin-audio-mode"
import MixerPluginPicker from "./MixerPluginPicker.vue"

const props = defineProps<{
  instrument: PluginInstanceState | null
  runtime: Record<string, PluginRuntimeStatus>
  plugins: PluginDescriptor[]
}>()

const emit = defineEmits<{
  open: [instanceId: string]
  remove: [instanceId: string]
  assign: [selection: PluginSelection]
}>()
const pendingDrop = shallowRef<PluginDescriptor | null>(null)

const instrumentState = computed<PluginRuntimeStatus["state"]>(() => {
  if (!props.instrument) return "unloaded"
  return (
    props.runtime[props.instrument.id]?.state ?? (props.instrument.enabled ? "active" : "bypassed")
  )
})

function allowDrop(event: DragEvent): void {
  if (![...(event.dataTransfer?.types ?? [])].includes(PLUGIN_DRAG_TYPE)) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy"
}

function dropInstrument(event: DragEvent): void {
  event.preventDefault()
  const payload = readPluginDrag(event)
  if (payload?.source === "catalog" && payload.descriptor.kind === "instrument") {
    pendingDrop.value = payload.descriptor
  }
}

function confirmDrop(selection: PluginSelection): void {
  emit("assign", selection)
  pendingDrop.value = null
}
</script>

<template>
  <div class="instrument-input-wrapper">
    <article
      v-if="instrument"
      :class="['instrument-input', instrumentState]"
      :aria-label="`${instrument.descriptor.name} instrument input ${instrumentState}`"
      @dragenter="allowDrop"
      @dragover="allowDrop"
      @drop="dropInstrument"
    >
      <button
        class="instrument-name"
        :title="instrument.descriptor.name"
        :aria-label="`Open ${instrument.descriptor.name} instrument editor`"
        @click="emit('open', instrument.id)"
      >
        {{ instrument.descriptor.name }}
      </button>
      <span class="mode-badge" :title="`Audio mode: ${instrument.audioMode}`">{{
        pluginAudioModeBadge(instrument.audioMode)
      }}</span>
      <button
        :aria-label="`Remove ${instrument.descriptor.name}`"
        @click="emit('remove', instrument.id)"
      >
        <Trash2 :size="10" />
      </button>
    </article>

    <MixerPluginPicker
      v-else
      :plugins="plugins"
      title="Choose instrument"
      search-label="Search VST3 instruments"
      empty-message="No compatible VST3 instruments found. Rescan from the Sound Browser."
      @select="emit('assign', $event)"
    >
      <button
        type="button"
        class="instrument-input empty"
        aria-label="Assign VST3 instrument input"
        @dragenter="allowDrop"
        @dragover="allowDrop"
        @drop="dropInstrument"
      />
    </MixerPluginPicker>
    <div v-if="pendingDrop" class="drop-mode-menu">
      <PluginAudioModeMenu
        :descriptor="pendingDrop"
        @select="confirmDrop({ descriptor: pendingDrop, audioMode: $event })"
        @cancel="pendingDrop = null"
      />
    </div>
  </div>
</template>

<style scoped>
.instrument-input-wrapper {
  position: relative;
}
.instrument-input {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto 22px;
  align-items: center;
  width: 100%;
  height: 28px;
  min-width: 0;
  padding: 0;
  border: 1px solid var(--ui-domain-color-697654);
  border-radius: 4px;
  color: var(--ui-domain-color-fff);
  background: linear-gradient(var(--ui-domain-color-7e9362), var(--ui-domain-color-63764d));
  box-shadow: 0 1px 0 var(--ui-domain-color-ffffff28) inset;
}
.mode-badge {
  padding: 1px 4px;
  border: 1px solid var(--ui-domain-color-ffffff28);
  border-radius: 3px;
  font: var(--ui-type-size-micro) var(--ui-type-family-data);
}
.drop-mode-menu {
  position: absolute;
  z-index: var(--ui-z-popover);
  top: 32px;
  left: 0;
  width: 232px;
  padding: 9px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  color: var(--text-primary);
  background: var(--surface-1);
  box-shadow: 0 14px 36px var(--ui-domain-color-00000075);
}
.instrument-input.bypassed {
  border-color: var(--ui-domain-color-505050);
  color: var(--ui-domain-color-a7a7a7);
  background: linear-gradient(var(--ui-domain-color-5b5b5b), var(--ui-domain-color-4b4b4b));
  box-shadow: 0 1px 0 var(--ui-domain-color-ffffff12) inset;
}
.instrument-input.loading,
.instrument-input.unloaded {
  border-color: var(--ui-domain-color-566a78);
  color: var(--ui-domain-color-c5d0d7);
  background: linear-gradient(var(--ui-domain-color-617685), var(--ui-domain-color-526573));
}
.instrument-input.failed,
.instrument-input.missing,
.instrument-input.quarantined {
  border-color: var(--ui-domain-color-8d4a43);
  color: var(--ui-domain-color-ffd4ce);
  background: linear-gradient(var(--ui-domain-color-884f49), var(--ui-domain-color-6d3e39));
  box-shadow: 0 1px 0 var(--ui-domain-color-ffffff16) inset;
}
.instrument-input button {
  display: grid;
  place-items: center;
  width: 22px;
  height: 26px;
  padding: 0;
  border: 0;
  color: inherit;
  background: transparent;
  cursor: pointer;
}
.instrument-input .instrument-name {
  display: block;
  width: 100%;
  min-width: 0;
  padding: 0 7px;
  overflow: hidden;
  font-size: var(--ui-type-size-control);
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.instrument-input button:hover {
  background: var(--ui-domain-color-ffffff22);
}
.instrument-input button:focus-visible,
.instrument-input.empty:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: -2px;
}
.instrument-input.empty {
  display: grid;
  grid-template-columns: 1fr;
  place-items: center;
  border-color: var(--ui-domain-color-4c4c4c);
  color: var(--ui-domain-color-8f8f8f);
  background: var(--ui-domain-color-4d4d4d);
  box-shadow: 0 1px 2px var(--ui-domain-color-00000038) inset;
  font: inherit;
  cursor: pointer;
}
.instrument-input.empty:hover {
  border-color: var(--ui-domain-color-768a61);
  color: var(--ui-domain-color-d6e4ca);
}
</style>
