<script setup lang="ts">
import { X } from "@lucide/vue"
import type { PluginInstanceState, PluginParameterInfo } from "@yadaw/contracts"

defineProps<{
  plugin: PluginInstanceState
  parameters: PluginParameterInfo[]
  error: string
}>()

const emit = defineEmits<{
  close: []
  begin: [parameterId: number, normalized: number]
  perform: [parameterId: number, normalized: number]
  end: [parameterId: number, normalized: number]
}>()

function normalized(event: Event): number {
  return Number((event.target as HTMLInputElement).value)
}
</script>

<template>
  <section class="parameter-panel" aria-label="Generic plugin parameters">
    <header>
      <div>
        <span>GENERIC PARAMETERS</span>
        <strong>{{ plugin.descriptor.name }}</strong>
      </div>
      <button aria-label="Close generic parameter panel" @click="emit('close')">
        <X :size="12" />
      </button>
    </header>
    <p v-if="error" class="parameter-error">{{ error }}</p>
    <p v-else-if="parameters.length === 0" class="parameter-empty">
      This plugin did not expose editable parameters.
    </p>
    <label v-for="parameter in parameters" :key="parameter.id">
      <span>
        <b>{{ parameter.title }}</b>
        <output>{{ Math.round(parameter.normalized * 100) }}% {{ parameter.units }}</output>
      </span>
      <input
        type="range"
        min="0"
        max="1"
        step="0.001"
        :value="parameter.normalized"
        :aria-label="parameter.title"
        @pointerdown="emit('begin', parameter.id, parameter.normalized)"
        @input="emit('perform', parameter.id, normalized($event))"
        @change="emit('end', parameter.id, normalized($event))"
      />
    </label>
  </section>
</template>

<style scoped>
.parameter-panel {
  display: grid;
  gap: 10px;
  padding: 11px 13px;
  border-bottom: 1px solid var(--line-soft);
  background: var(--surface-1);
}
.parameter-panel header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.parameter-panel header span,
.parameter-panel header strong {
  display: block;
}
.parameter-panel header span {
  color: var(--accent);
  font: 700 7px var(--font-utility);
  letter-spacing: 0.13em;
}
.parameter-panel header strong {
  margin-top: 3px;
  font-size: 9px;
}
.parameter-panel header button {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid var(--line-soft);
  border-radius: 3px;
  color: var(--text-muted);
  background: var(--daw-control);
  cursor: pointer;
}
.parameter-panel label {
  display: grid;
  gap: 5px;
}
.parameter-panel label > span {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  color: var(--text-muted);
  font-size: 7px;
}
.parameter-panel label b {
  overflow: hidden;
  color: var(--text-secondary);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.parameter-panel output {
  white-space: nowrap;
}
.parameter-panel input {
  width: 100%;
  accent-color: var(--accent);
}
.parameter-error,
.parameter-empty {
  margin: 0;
  color: var(--text-faint);
  font-size: 8px;
  line-height: 1.5;
}
.parameter-error {
  color: var(--record);
}
</style>
