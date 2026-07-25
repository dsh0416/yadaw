<script setup lang="ts">
import type { PluginInstanceState, PluginRuntimeStatus } from "@yadaw/contracts"
import PluginSlot from "./PluginSlot.vue"

defineProps<{
  plugins: PluginInstanceState[]
  runtime: Record<string, PluginRuntimeStatus>
}>()

defineEmits<{
  open: [instanceId: string]
  toggle: [instanceId: string, enabled: boolean]
  remove: [instanceId: string]
}>()
</script>

<template>
  <section class="plugin-rack" aria-label="Plugin insert rack">
    <div class="rack-heading"><span>INSERTS</span><b>{{ plugins.length }}</b></div>
    <PluginSlot
      v-for="plugin in plugins"
      :key="plugin.id"
      :plugin="plugin"
      :runtime="runtime[plugin.id]"
      @open="$emit('open', $event)"
      @toggle="(id, enabled) => $emit('toggle', id, enabled)"
      @remove="$emit('remove', $event)"
    />
    <p v-if="plugins.length === 0">Double-click an effect in the Sound Browser to add it here.</p>
  </section>
</template>

<style scoped>
.plugin-rack{display:grid;gap:6px;padding:11px 13px;border-bottom:1px solid var(--line-soft)}.rack-heading{display:flex;align-items:center;justify-content:space-between;color:var(--text-muted);font:700 7px var(--font-utility);letter-spacing:.14em}.rack-heading b{display:grid;place-items:center;min-width:16px;height:15px;border:1px solid var(--line-soft);border-radius:3px;color:var(--text-faint);font-size:6px}.plugin-rack>p{margin:1px 0;color:var(--text-faint);font-size:8px;line-height:1.45}
</style>
