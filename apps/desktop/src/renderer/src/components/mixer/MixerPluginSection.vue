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

const props = defineProps<{
  channel: MixerChannelState
  instrument: PluginInstanceState | null
  inserts: PluginInstanceState[]
  runtime: Record<string, PluginRuntimeStatus>
  slotRows: number
}>()

const emit = defineEmits<{
  open: [instanceId: string]
  toggle: [instanceId: string, enabled: boolean]
  remove: [instanceId: string]
  insert: [descriptor: PluginDescriptor, slotOrder: number]
  move: [instanceId: string, slotOrder: number]
  assignInstrument: [descriptor: PluginDescriptor]
}>()

const orderedInserts = computed(() =>
  [...props.inserts].sort((left, right) => left.slotOrder - right.slotOrder)
)
const usedRows = computed(
  () => orderedInserts.value.length + (props.channel.kind === "instrument" ? 1 : 0)
)
const emptyRows = computed(() => Math.max(0, props.slotRows - usedRows.value))
const alignmentRows = computed(() => Math.max(0, emptyRows.value - 1))
const acceptsPlugins = computed(() => props.channel.kind !== "master")

function accepts(event: DragEvent): boolean {
  return [...(event.dataTransfer?.types ?? [])].includes(PLUGIN_DRAG_TYPE)
}

function allowDrop(event: DragEvent): void {
  if (!acceptsPlugins.value || !accepts(event)) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move"
}

function dropInstrument(event: DragEvent): void {
  event.preventDefault()
  const payload = readPluginDrag(event)
  if (payload?.source === "catalog" && payload.descriptor.kind === "instrument") {
    emit("assignInstrument", payload.descriptor)
  }
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
        v-if="channel.kind === 'instrument'"
        :class="['plugin-row', 'instrument-row', { empty: !instrument }]"
        @dragenter="allowDrop"
        @dragover="allowDrop"
        @drop="dropInstrument"
      >
        <template v-if="instrument">
          <i
            :class="runtime[instrument.id]?.state ?? (instrument.enabled ? 'active' : 'bypassed')"
          />
          <button
            class="plugin-name"
            draggable="false"
            :title="instrument.descriptor.name"
            @click="emit('open', instrument.id)"
          >
            {{ instrument.descriptor.name }}
          </button>
          <button
            :aria-label="`${instrument.enabled ? 'Bypass' : 'Enable'} ${instrument.descriptor.name}`"
            @click="emit('toggle', instrument.id, !instrument.enabled)"
          >
            <Power :size="9" />
          </button>
          <button
            :aria-label="`Remove ${instrument.descriptor.name}`"
            @click="emit('remove', instrument.id)"
          >
            <Trash2 :size="9" />
          </button>
        </template>
        <span v-else>DROP INSTRUMENT</span>
      </article>

      <article
        v-for="(plugin, index) in orderedInserts"
        :key="plugin.id"
        class="plugin-row"
        draggable="true"
        @dragstart="writePluginDrag($event, { source: 'rack', instanceId: plugin.id })"
        @dragenter="allowDrop"
        @dragover="allowDrop"
        @drop="dropInsert($event, index)"
      >
        <i :class="runtime[plugin.id]?.state ?? (plugin.enabled ? 'active' : 'bypassed')" />
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

      <article
        v-if="emptyRows > 0"
        class="plugin-row empty"
        @dragenter="allowDrop"
        @dragover="allowDrop"
        @drop="dropInsert($event, orderedInserts.length)"
      >
        <span>EMPTY SLOT</span>
      </article>
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
  border-bottom: 1px solid #444;
  background: #575757;
}
.plugin-row {
  display: grid;
  grid-template-columns: 6px minmax(0, 1fr) 18px 18px;
  align-items: center;
  min-width: 0;
  height: 23px;
  border: 1px solid #2e5d86;
  border-radius: 4px;
  color: #fff;
  background: linear-gradient(#3f91d4, #2871ae);
  box-shadow: 0 1px 0 #ffffff28 inset;
}
.plugin-row.instrument-row {
  border-color: #697654;
  background: linear-gradient(#7e9362, #63764d);
}
.plugin-row i {
  justify-self: center;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: #8cf59a;
  box-shadow: 0 0 4px #8cf59a;
}
.plugin-row i.bypassed {
  background: #b8b8b8;
  box-shadow: none;
}
.plugin-row i.failed,
.plugin-row i.missing,
.plugin-row i.quarantined {
  background: #ff7a68;
  box-shadow: 0 0 4px #ff7a68;
}
.plugin-row button {
  display: grid;
  place-items: center;
  width: 18px;
  height: 20px;
  padding: 0;
  border: 0;
  color: #f8f8f8;
  background: transparent;
  cursor: pointer;
}
.plugin-row .plugin-name {
  display: block;
  width: 100%;
  min-width: 0;
  padding: 0 3px;
  overflow: hidden;
  font-size: 8px;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.plugin-row button:hover {
  background: #ffffff22;
}
.plugin-row button:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: -2px;
}
.plugin-row.empty {
  display: grid;
  grid-template-columns: 1fr;
  place-items: center;
  border-color: #4c4c4c;
  color: #8f8f8f;
  background: #4d4d4d;
  box-shadow: 0 1px 2px #00000038 inset;
}
.plugin-row.empty span {
  font: 6px var(--font-utility);
  letter-spacing: 0.08em;
}
.plugin-row.empty:not(.disabled):hover {
  border-color: #4e8dbf;
  color: #b7d9f3;
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
