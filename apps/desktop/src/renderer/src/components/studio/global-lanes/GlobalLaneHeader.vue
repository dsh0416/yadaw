<script setup lang="ts">
const props = defineProps<{
  label: string
  eyebrow: string
  value: number
  unit: string
  minimum: number
  maximum: number
  expanded: boolean
  color: string
}>()

const emit = defineEmits<{
  toggle: []
  updateValue: [value: number]
}>()

function updateValue(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  if (!Number.isFinite(value)) return
  emit("updateValue", Math.min(props.maximum, Math.max(props.minimum, value)))
}
</script>

<template>
  <section
    class="global-lane-header"
    :class="{ collapsed: !expanded }"
    :style="{ '--lane-color': color }"
    :aria-label="`${label} global track`"
  >
    <button
      class="lane-toggle"
      type="button"
      :aria-expanded="expanded"
      :aria-label="`${expanded ? 'Collapse' : 'Expand'} ${label} track`"
      @click="emit('toggle')"
    >
      <span aria-hidden="true">{{ expanded ? "▾" : "▸" }}</span>
    </button>
    <div class="lane-copy">
      <span>{{ eyebrow }}</span>
      <strong>{{ label }}</strong>
    </div>
    <label v-if="expanded" class="lane-value">
      <span>Selected</span>
      <span class="value-control">
        <input
          :value="value.toFixed(2)"
          type="number"
          :min="minimum"
          :max="maximum"
          step="0.01"
          :aria-label="`Selected ${label} value`"
          @change="updateValue"
        >
        <b>{{ unit }}</b>
      </span>
    </label>
  </section>
</template>

<style scoped>
.global-lane-header{--lane-color:#65a8ff;position:relative;display:grid;grid-template-columns:20px minmax(0,1fr);grid-template-rows:auto 1fr;gap:5px 7px;padding:9px 10px;border-bottom:1px solid var(--line-strong);background:linear-gradient(90deg,color-mix(in srgb,var(--lane-color) 8%,var(--daw-track-header)),var(--daw-track-header) 74%);box-shadow:3px 0 0 var(--lane-color) inset}.global-lane-header.collapsed{grid-template-rows:1fr;align-items:center;padding-block:4px}.lane-toggle{grid-column:1;grid-row:1;width:20px;height:20px;padding:0;border:1px solid var(--line-soft);border-radius:3px;color:var(--text-muted);background:var(--daw-control);font:8px var(--font-utility);cursor:pointer}.lane-toggle:hover{border-color:color-mix(in srgb,var(--lane-color) 55%,var(--line-strong));color:var(--text-primary)}.lane-toggle:focus-visible{outline:2px solid var(--focus);outline-offset:1px}.lane-copy{grid-column:2;grid-row:1;min-width:0}.lane-copy span,.lane-copy strong{display:block}.lane-copy span{color:var(--lane-color);font:700 6px var(--font-utility);letter-spacing:.15em}.lane-copy strong{margin-top:3px;color:var(--text-primary);font:10px var(--font-display)}.collapsed .lane-copy{display:flex;align-items:center;gap:7px}.collapsed .lane-copy strong{margin:0}.lane-value{grid-column:2;grid-row:2;align-self:end}.lane-value>span:first-child{display:block;margin-bottom:4px;color:var(--text-faint);font:6px var(--font-utility);letter-spacing:.1em;text-transform:uppercase}.value-control{display:grid;grid-template-columns:minmax(0,1fr) 28px;height:25px;border:1px solid var(--line-soft);border-radius:3px;background:var(--surface-sunken);overflow:hidden}.value-control input{min-width:0;padding:0 6px;border:0;color:var(--text-primary);background:transparent;font:9px var(--font-utility);font-variant-numeric:tabular-nums;outline:none}.value-control b{display:grid;place-items:center;border-left:1px solid var(--line-soft);color:var(--lane-color);font:700 6px var(--font-utility);letter-spacing:.08em}.value-control:focus-within{border-color:var(--lane-color);box-shadow:0 0 0 1px color-mix(in srgb,var(--lane-color) 22%,transparent)}
</style>
