<script setup lang="ts">
import { Power, SquareArrowOutUpRight, Trash2 } from "@lucide/vue"
import type { PluginInstanceState, PluginRuntimeStatus } from "@yadaw/contracts"

defineProps<{
  plugin: PluginInstanceState | null
  runtime?: PluginRuntimeStatus
}>()

defineEmits<{
  open: [instanceId: string]
  toggle: [instanceId: string, enabled: boolean]
  remove: [instanceId: string]
}>()
</script>

<template>
  <section class="instrument-slot" aria-label="Instrument slot">
    <div class="slot-heading"><span>INSTRUMENT</span><b>{{ plugin ? "VST3" : "EMPTY" }}</b></div>
    <div v-if="plugin" class="slot-body">
      <i :class="runtime?.state ?? (plugin.enabled ? 'active' : 'bypassed')" />
      <div><strong>{{ plugin.descriptor.name }}</strong><small>{{ plugin.descriptor.vendor }}</small></div>
      <button :aria-label="`${plugin.enabled ? 'Bypass' : 'Enable'} instrument`" @click="$emit('toggle', plugin.id, !plugin.enabled)"><Power :size="11" /></button>
      <button aria-label="Open instrument editor" @click="$emit('open', plugin.id)"><SquareArrowOutUpRight :size="11" /></button>
      <button aria-label="Remove instrument" @click="$emit('remove', plugin.id)"><Trash2 :size="11" /></button>
    </div>
    <p v-else>Choose an instrument from the Sound Browser.</p>
    <small v-if="runtime?.error" class="slot-error">{{ runtime.error }}</small>
  </section>
</template>

<style scoped>
.instrument-slot{display:grid;gap:7px;padding:11px 13px;border-bottom:1px solid var(--line-soft);background:linear-gradient(90deg,color-mix(in srgb,#73D6A2 5%,transparent),transparent 55%)}.slot-heading{display:flex;align-items:center;justify-content:space-between;color:#73D6A2;font:700 7px var(--font-utility);letter-spacing:.13em}.slot-heading b{color:var(--text-faint);font-size:6px}.slot-body{display:grid;grid-template-columns:6px minmax(0,1fr) repeat(3,24px);align-items:center;gap:5px;min-height:34px;padding:5px 5px 5px 7px;border:1px solid var(--line-strong);border-radius:4px;background:var(--surface-sunken);box-shadow:inset 2px 0 0 color-mix(in srgb,#73D6A2 72%,transparent)}.slot-body i{width:5px;height:5px;border-radius:50%;background:#73D6A2;box-shadow:0 0 5px color-mix(in srgb,#73D6A2 60%,transparent)}.slot-body i.bypassed{background:var(--text-faint);box-shadow:none}.slot-body i.failed,.slot-body i.missing,.slot-body i.quarantined{background:var(--record);box-shadow:0 0 5px color-mix(in srgb,var(--record) 55%,transparent)}.slot-body strong,.slot-body small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.slot-body strong{font-size:8px}.slot-body small{margin-top:2px;color:var(--text-faint);font-size:6px}.slot-body button{display:grid;place-items:center;width:24px;height:24px;padding:0;border:1px solid var(--line-soft);border-radius:3px;color:var(--text-muted);background:var(--daw-control);cursor:pointer}.instrument-slot>p{margin:0;color:var(--text-faint);font-size:8px;line-height:1.45}.slot-error{color:var(--record);font-size:7px}
</style>
