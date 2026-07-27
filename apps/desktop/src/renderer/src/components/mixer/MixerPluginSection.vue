<script setup lang="ts">
import { computed } from "vue"
import { Power, Trash2 } from "@lucide/vue"
import type {
  MixerChannelState,
  PluginDescriptor,
  PluginInstanceState,
  PluginRuntimeStatus
} from "@yadaw/contracts"
import { PLUGIN_DRAG_TYPE, readPluginDrag, writePluginDrag } from "../plugins/plugin-drag"
import MixerPluginPicker from "./MixerPluginPicker.vue"

const props = defineProps<{
  channel: MixerChannelState
  inserts: PluginInstanceState[]
  runtime: Record<string, PluginRuntimeStatus>
  effectPlugins: PluginDescriptor[]
  slotRows: number
}>()

const emit = defineEmits<{
  open: [instanceId: string]
  toggle: [instanceId: string, enabled: boolean]
  remove: [instanceId: string]
  insert: [descriptor: PluginDescriptor, slotOrder: number]
  move: [instanceId: string, slotOrder: number]
}>()

const orderedInserts = computed(() =>
  [...props.inserts].sort((left, right) => left.slotOrder - right.slotOrder)
)
const emptyRows = computed(() => Math.max(0, props.slotRows - orderedInserts.value.length))
const alignmentRows = computed(() => Math.max(0, emptyRows.value - 1))
const acceptsPlugins = computed(() => props.channel.kind !== "master")

function pluginState(plugin: PluginInstanceState): PluginRuntimeStatus["state"] {
  return props.runtime[plugin.id]?.state ?? (plugin.enabled ? "active" : "bypassed")
}

function accepts(event: DragEvent): boolean {
  return [...(event.dataTransfer?.types ?? [])].includes(PLUGIN_DRAG_TYPE)
}

function allowDrop(event: DragEvent): void {
  if (!acceptsPlugins.value || !accepts(event)) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move"
}

function dropInsert(event: DragEvent, slotOrder: number): void {
  event.preventDefault()
  const payload = readPluginDrag(event)
  if (!payload) return
  if (payload.source === "catalog") {
    if (payload.descriptor.kind === "effect") emit("insert", payload.descriptor, slotOrder)
    return
  }
  const currentIndex = orderedInserts.value.findIndex((plugin) => plugin.id === payload.instanceId)
  const adjustedIndex = currentIndex >= 0 && currentIndex < slotOrder ? slotOrder - 1 : slotOrder
  emit("move", payload.instanceId, adjustedIndex)
}
</script>

<template>
  <section class="plugin-section" data-section="plugins" aria-label="Audio effects">
    <template v-if="acceptsPlugins">
      <article
        v-for="(plugin, index) in orderedInserts"
        :key="plugin.id"
        :class="['plugin-row', pluginState(plugin)]"
        :aria-label="`${plugin.descriptor.name} plugin ${pluginState(plugin)}`"
        draggable="true"
        @dragstart="writePluginDrag($event, { source: 'rack', instanceId: plugin.id })"
        @dragenter="allowDrop"
        @dragover="allowDrop"
        @drop="dropInsert($event, index)"
      >
        <button
          class="plugin-name"
          :title="`${plugin.descriptor.name} · ${plugin.descriptor.vendor}`"
          :aria-label="`Open ${plugin.descriptor.name} editor`"
          @click="emit('open', plugin.id)"
        >
          {{ plugin.descriptor.name }}
        </button>
        <button
          :aria-label="`${plugin.enabled ? 'Bypass' : 'Enable'} ${plugin.descriptor.name}`"
          @click="emit('toggle', plugin.id, !plugin.enabled)"
        >
          <Power :size="9" />
        </button>
        <button :aria-label="`Remove ${plugin.descriptor.name}`" @click="emit('remove', plugin.id)">
          <Trash2 :size="9" />
        </button>
      </article>

      <MixerPluginPicker
        v-if="emptyRows > 0"
        :plugins="effectPlugins"
        title="Add audio effect"
        search-label="Search VST3 audio effects"
        empty-message="No compatible VST3 effects found. Rescan from the Sound Browser."
        @select="emit('insert', $event, orderedInserts.length)"
      >
        <button
          type="button"
          class="plugin-row empty picker-trigger"
          aria-label="Add VST3 audio effect"
          @dragenter="allowDrop"
          @dragover="allowDrop"
          @drop="dropInsert($event, orderedInserts.length)"
        >
          <span>EMPTY SLOT</span>
        </button>
      </MixerPluginPicker>
      <span
        v-for="index in alignmentRows"
        :key="`alignment-${index}`"
        class="plugin-row alignment-spacer"
        aria-hidden="true"
      />
    </template>
    <template v-else>
      <article class="plugin-row empty disabled">
        <span>NO INSERT</span>
      </article>
      <span
        v-for="index in Math.max(0, slotRows - 1)"
        :key="index"
        class="plugin-row alignment-spacer"
        aria-hidden="true"
      />
    </template>
  </section>
</template>

<style scoped>
.plugin-section {
  display: grid;
  grid-auto-rows: 24px;
  align-content: start;
  min-width: 0;
  padding: 6px 7px;
  border-bottom: 1px solid var(--ui-domain-color-444);
  background: var(--ui-domain-color-575757);
}
.plugin-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 18px 18px;
  align-items: center;
  min-width: 0;
  height: 23px;
  border: 1px solid var(--ui-domain-color-2e5d86);
  border-radius: 4px;
  color: var(--ui-domain-color-fff);
  background: linear-gradient(var(--ui-domain-color-3f91d4), var(--ui-domain-color-2871ae));
  box-shadow: 0 1px 0 var(--ui-domain-color-ffffff28) inset;
}
.plugin-row.bypassed {
  border-color: var(--ui-domain-color-505050);
  color: var(--ui-domain-color-a7a7a7);
  background: linear-gradient(var(--ui-domain-color-5b5b5b), var(--ui-domain-color-4b4b4b));
  box-shadow: 0 1px 0 var(--ui-domain-color-ffffff12) inset;
}
.plugin-row.loading,
.plugin-row.unloaded {
  border-color: var(--ui-domain-color-566a78);
  color: var(--ui-domain-color-c5d0d7);
  background: linear-gradient(var(--ui-domain-color-617685), var(--ui-domain-color-526573));
}
.plugin-row.failed,
.plugin-row.missing,
.plugin-row.quarantined {
  border-color: var(--ui-domain-color-8d4a43);
  color: var(--ui-domain-color-ffd4ce);
  background: linear-gradient(var(--ui-domain-color-884f49), var(--ui-domain-color-6d3e39));
  box-shadow: 0 1px 0 var(--ui-domain-color-ffffff16) inset;
}
.plugin-row button {
  display: grid;
  place-items: center;
  width: 18px;
  height: 20px;
  padding: 0;
  border: 0;
  color: inherit;
  background: transparent;
  cursor: pointer;
}
.plugin-row .plugin-name {
  display: block;
  width: 100%;
  min-width: 0;
  padding: 0 3px;
  overflow: hidden;
  font-size: var(--ui-type-size-control);
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.plugin-row button:hover {
  background: var(--ui-domain-color-ffffff22);
}
.plugin-row button:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: -2px;
}
.plugin-row.empty {
  display: grid;
  grid-template-columns: 1fr;
  place-items: center;
  border-color: var(--ui-domain-color-4c4c4c);
  color: var(--ui-domain-color-8f8f8f);
  background: var(--ui-domain-color-4d4d4d);
  box-shadow: 0 1px 2px var(--ui-domain-color-00000038) inset;
}
.plugin-row.empty span {
  font: var(--ui-type-size-micro) var(--ui-type-family-data);
  letter-spacing: var(--ui-type-tracking-wide);
}
.plugin-row.empty:not(.disabled):hover {
  border-color: var(--ui-domain-color-4e8dbf);
  color: var(--ui-domain-color-b7d9f3);
}
.plugin-row.picker-trigger {
  width: 100%;
  padding: 0;
  font: inherit;
  cursor: pointer;
}
.plugin-row.picker-trigger:focus-visible {
  border-color: var(--focus);
  outline: 2px solid var(--focus);
  outline-offset: -2px;
}
.plugin-row.alignment-spacer {
  border-color: transparent;
  background: transparent;
  box-shadow: none;
  pointer-events: none;
}
.plugin-row.disabled {
  opacity: 0.65;
}
</style>
