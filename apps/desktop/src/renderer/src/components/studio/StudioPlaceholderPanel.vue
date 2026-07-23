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
      <p>{{ side === "left" ? "Sounds and devices will live here." : "Clip and track controls will live here." }}</p>
      <small>PLACEHOLDER</small>
    </div>
  </aside>
</template>

<style scoped>
.placeholder-panel{min-width:0;padding:17px 13px;background:var(--surface-panel)}.placeholder-panel.left{border-right:1px solid var(--line-soft)}.placeholder-panel.right{border-left:1px solid var(--line-soft)}.panel-heading span,.panel-heading strong{display:block}.panel-heading span{color:var(--accent);font:700 7px var(--font-utility);letter-spacing:.18em}.panel-heading strong{margin-top:5px;color:var(--text-primary);font-family:var(--font-display);font-size:13px}.placeholder-card{display:grid;place-items:center;margin-top:16px;padding:25px 14px;border:1px dashed #2d3748;border-radius:7px;color:#536176;background:#0b1019;text-align:center}.placeholder-card>svg{color:#65758d}.placeholder-card p{max-width:150px;margin:10px 0;color:#637086;font-size:8px;line-height:1.55}.placeholder-card small{color:#444f62;font:6px var(--font-utility);letter-spacing:.16em}
</style>
