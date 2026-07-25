<script setup lang="ts">
import { GripVertical, Power, SquareArrowOutUpRight, Trash2 } from "@lucide/vue"
import type { PluginInstanceState, PluginRuntimeStatus } from "@yadaw/contracts"

defineProps<{
  plugin: PluginInstanceState
  runtime?: PluginRuntimeStatus
}>()

defineEmits<{
  open: [instanceId: string]
  toggle: [instanceId: string, enabled: boolean]
  remove: [instanceId: string]
}>()
</script>

<template>
  <article class="plugin-slot">
    <GripVertical :size="11" class="grip" aria-hidden="true" />
    <i :class="runtime?.state ?? (plugin.enabled ? 'active' : 'bypassed')" />
    <div><strong>{{ plugin.descriptor.name }}</strong><small>{{ plugin.descriptor.vendor }}</small></div>
    <button :aria-label="`${plugin.enabled ? 'Bypass' : 'Enable'} ${plugin.descriptor.name}`" @click="$emit('toggle', plugin.id, !plugin.enabled)"><Power :size="10" /></button>
    <button :aria-label="`Open ${plugin.descriptor.name} editor`" @click="$emit('open', plugin.id)"><SquareArrowOutUpRight :size="10" /></button>
    <button :aria-label="`Remove ${plugin.descriptor.name}`" @click="$emit('remove', plugin.id)"><Trash2 :size="10" /></button>
  </article>
</template>

<style scoped>
.plugin-slot{display:grid;grid-template-columns:12px 5px minmax(0,1fr) repeat(3,22px);align-items:center;gap:5px;min-height:31px;padding:4px;border:1px solid var(--line-strong);border-radius:3px;background:var(--surface-sunken)}.grip{color:var(--text-faint);cursor:grab}.plugin-slot i{width:5px;height:5px;border-radius:50%;background:var(--signal-cyan);box-shadow:0 0 5px color-mix(in srgb,var(--signal-cyan) 55%,transparent)}.plugin-slot i.bypassed{background:var(--text-faint);box-shadow:none}.plugin-slot i.failed,.plugin-slot i.missing,.plugin-slot i.quarantined{background:var(--record)}.plugin-slot strong,.plugin-slot small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.plugin-slot strong{font-size:8px}.plugin-slot small{margin-top:2px;color:var(--text-faint);font-size:6px}.plugin-slot button{display:grid;place-items:center;width:22px;height:22px;padding:0;border:1px solid var(--line-soft);border-radius:3px;color:var(--text-muted);background:var(--daw-control);cursor:pointer}
</style>
