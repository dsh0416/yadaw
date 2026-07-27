<script setup lang="ts">
defineProps<{
  label: string
  eyebrow: string
  expanded: boolean
  color: string
}>()

defineSlots<{
  controls(): unknown
}>()

const emit = defineEmits<{
  toggle: []
}>()
</script>

<template>
  <section
    class="global-event-lane-header"
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
    <div v-if="expanded" class="lane-controls">
      <slot name="controls" />
    </div>
  </section>
</template>

<style scoped>
.global-event-lane-header {
  --lane-color: var(--ui-domain-color-65a8ff);
  position: relative;
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr);
  grid-template-rows: auto auto;
  gap: 3px 7px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--line-strong);
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--lane-color) 8%, var(--daw-track-header)),
    var(--daw-track-header) 74%
  );
  box-shadow: 3px 0 0 var(--lane-color) inset;
}
.global-event-lane-header.collapsed {
  grid-template-rows: 1fr;
  align-items: center;
  padding-block: 4px;
}
.lane-toggle {
  grid-column: 1;
  grid-row: 1;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 1px solid var(--line-soft);
  border-radius: 3px;
  color: var(--text-muted);
  background: var(--daw-control);
  font: var(--ui-type-size-control) var(--ui-type-family-data);
  cursor: pointer;
}
.lane-toggle:hover {
  border-color: color-mix(in srgb, var(--lane-color) 55%, var(--line-strong));
  color: var(--text-primary);
}
.lane-toggle:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}
.lane-copy {
  grid-column: 2;
  grid-row: 1;
  min-width: 0;
}
.lane-copy span,
.lane-copy strong {
  display: block;
}
.lane-copy span {
  color: var(--lane-color);
  font: var(--ui-type-weight-bold) var(--ui-type-size-micro) var(--ui-type-family-data);
  letter-spacing: var(--ui-type-tracking-wider);
}
.lane-copy strong {
  margin-top: 1px;
  color: var(--text-primary);
  font: var(--ui-type-size-label) var(--ui-type-family-display);
}
.collapsed .lane-copy {
  display: flex;
  align-items: center;
  gap: 7px;
}
.collapsed .lane-copy strong {
  margin: 0;
}
.lane-controls {
  grid-column: 2;
  grid-row: 2;
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
.lane-controls :deep(input) {
  min-width: 0;
  height: 23px;
  padding: 0 5px;
  border: 1px solid var(--line-soft);
  border-radius: 3px;
  color: var(--text-primary);
  background: var(--surface-sunken);
  font: var(--ui-type-size-control) var(--ui-type-family-data);
  outline: none;
}
.lane-controls :deep(input:focus) {
  border-color: var(--lane-color);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--lane-color) 22%, transparent);
}
.lane-controls :deep(.ui-select-shell) {
  flex: 1;
  min-width: 0;
}
</style>
