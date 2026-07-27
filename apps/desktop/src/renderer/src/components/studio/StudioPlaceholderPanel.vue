<script setup lang="ts">
import { Boxes, SlidersHorizontal } from "@lucide/vue"

defineProps<{
  side: "left" | "right"
}>()
</script>

<template>
  <aside :class="['placeholder-panel', side]">
    <div class="panel-heading">
      <span>{{ side === "left" ? "LIBRARY" : "INSPECTOR" }}</span>
      <strong>{{ side === "left" ? "Browser" : "Properties" }}</strong>
    </div>
    <div class="placeholder-card">
      <component :is="side === 'left' ? Boxes : SlidersHorizontal" :size="17" />
      <p>
        {{
          side === "left"
            ? "Sounds and devices will live here."
            : "Clip and track controls will live here."
        }}
      </p>
      <small>PLACEHOLDER</small>
    </div>
  </aside>
</template>

<style scoped>
.placeholder-panel {
  min-width: 0;
  padding: 17px 13px;
  background: var(--surface-panel);
}
.placeholder-panel.left {
  border-right: 1px solid var(--line-soft);
}
.placeholder-panel.right {
  border-left: 1px solid var(--line-soft);
}
.panel-heading span,
.panel-heading strong {
  display: block;
}
.panel-heading span {
  color: var(--accent);
  font: var(--ui-type-weight-bold) var(--ui-type-size-caption) var(--ui-type-family-data);
  letter-spacing: var(--ui-type-tracking-widest);
}
.panel-heading strong {
  margin-top: 5px;
  color: var(--text-primary);
  font-family: var(--ui-type-family-display);
  font-size: var(--ui-type-size-panel-title);
}
.placeholder-card {
  display: grid;
  place-items: center;
  margin-top: 16px;
  padding: 25px 14px;
  border: 1px dashed var(--line-strong);
  border-radius: 7px;
  color: var(--text-faint);
  background: var(--surface-sunken);
  text-align: center;
}
.placeholder-card > svg {
  color: var(--text-muted);
}
.placeholder-card p {
  max-width: 150px;
  margin: 10px 0;
  color: var(--text-muted);
  font-size: var(--ui-type-size-control);
  line-height: var(--ui-type-leading-normal);
}
.placeholder-card small {
  color: var(--text-faint);
  font: var(--ui-type-size-micro) var(--ui-type-family-data);
  letter-spacing: var(--ui-type-tracking-widest);
}
</style>
