<script setup lang="ts">
import { shallowRef } from "vue"
import type { PluginDescriptor } from "@yadaw/contracts"
import type { PluginInstanceState, PluginRuntimeStatus } from "@yadaw/contracts"
import PluginSlot from "./PluginSlot.vue"
import { PLUGIN_DRAG_TYPE, readPluginDrag } from "./plugin-drag"

const props = defineProps<{
  channelId: string
  plugins: PluginInstanceState[]
  runtime: Record<string, PluginRuntimeStatus>
}>()

const emit = defineEmits<{
  open: [instanceId: string]
  toggle: [instanceId: string, enabled: boolean]
  remove: [instanceId: string]
  insert: [descriptor: PluginDescriptor, slotOrder: number]
  move: [instanceId: string, slotOrder: number]
}>()

const dropIndex = shallowRef<number | null>(null)

function accepts(event: DragEvent): boolean {
  return [...(event.dataTransfer?.types ?? [])].includes(PLUGIN_DRAG_TYPE)
}

function dragOver(event: DragEvent, index: number): void {
  if (!accepts(event)) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move"
  dropIndex.value = index
}

function drop(event: DragEvent, index: number): void {
  event.preventDefault()
  dropIndex.value = null
  const payload = readPluginDrag(event)
  if (!payload) return
  if (payload.source === "catalog") {
    if (payload.descriptor.kind === "effect") emit("insert", payload.descriptor, index)
    return
  }
  const currentIndex = props.plugins.findIndex((plugin) => plugin.id === payload.instanceId)
  const adjustedIndex = currentIndex >= 0 && currentIndex < index ? index - 1 : index
  emit("move", payload.instanceId, adjustedIndex)
}
</script>

<template>
  <section class="plugin-rack" aria-label="Plugin insert rack">
    <div class="rack-heading"><span>INSERTS</span><b>{{ plugins.length }}</b></div>
    <template v-for="(plugin, index) in plugins" :key="plugin.id">
      <div
        :class="['drop-zone', { active: dropIndex === index }]"
        :data-drop-index="index"
        @dragenter="dragOver($event, index)"
        @dragover="dragOver($event, index)"
        @dragleave="dropIndex === index && (dropIndex = null)"
        @drop="drop($event, index)"
      />
      <PluginSlot
        :plugin="plugin"
        :runtime="runtime[plugin.id]"
        @open="$emit('open', $event)"
        @toggle="(id, enabled) => $emit('toggle', id, enabled)"
        @remove="$emit('remove', $event)"
      />
    </template>
    <div
      :class="['drop-zone', { active: dropIndex === plugins.length }]"
      :data-drop-index="plugins.length"
      @dragenter="dragOver($event, plugins.length)"
      @dragover="dragOver($event, plugins.length)"
      @dragleave="dropIndex === plugins.length && (dropIndex = null)"
      @drop="drop($event, plugins.length)"
    />
    <p v-if="plugins.length === 0">Double-click an effect in the Sound Browser to add it here.</p>
  </section>
</template>

<style scoped>
.plugin-rack{display:grid;gap:2px;padding:11px 13px;border-bottom:1px solid var(--line-soft)}.rack-heading{display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;color:var(--text-muted);font:700 7px var(--font-utility);letter-spacing:.14em}.rack-heading b{display:grid;place-items:center;min-width:16px;height:15px;border:1px solid var(--line-soft);border-radius:3px;color:var(--text-faint);font-size:6px}.drop-zone{position:relative;height:4px;margin:-2px 0;z-index:1}.drop-zone::after{position:absolute;inset:1px 0 auto;height:2px;border-radius:999px;background:transparent;content:"";pointer-events:none}.drop-zone.active::after{background:var(--signal-cyan);box-shadow:0 0 6px color-mix(in srgb,var(--signal-cyan) 58%,transparent)}.plugin-rack>p{margin:3px 0;color:var(--text-faint);font-size:8px;line-height:1.45}
</style>
