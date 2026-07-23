<script setup lang="ts">
import { ArrowLeft, Clock3, FileAudio, FolderCog, Music2 } from "@lucide/vue"

defineProps<{ activePage: "general" }>()
const emit = defineEmits<{ close: [] }>()

const categories = [
  { id: "general", label: "General", detail: "Identity and session format", icon: FolderCog, disabled: false },
  { id: "timing", label: "Timing", detail: "Tempo maps and clock", icon: Clock3, disabled: true },
  { id: "media", label: "Media", detail: "Import and render defaults", icon: FileAudio, disabled: true },
  { id: "musical", label: "Musical", detail: "Tuning and notation", icon: Music2, disabled: true }
] as const
</script>

<template>
  <aside class="project-settings-nav">
    <button class="back-button" type="button" @click="emit('close')">
      <ArrowLeft :size="15" />
      <span>Back to studio</span>
    </button>
    <div class="nav-heading">
      <span>PROJECT SETTINGS</span>
      <strong>Session definition</strong>
    </div>
    <nav aria-label="Project setting categories">
      <button
        v-for="category in categories"
        :key="category.id"
        :class="['nav-item', { active: category.id === activePage }]"
        :disabled="category.disabled"
        :aria-current="category.id === activePage ? 'page' : undefined"
      >
        <component :is="category.icon" :size="16" />
        <span><b>{{ category.label }}</b><small>{{ category.detail }}</small></span>
        <em v-if="category.disabled">SOON</em>
      </button>
    </nav>
    <div class="format-rail" aria-hidden="true">
      <span>PROJECT</span><i /><span>MEDIA</span><i /><span>ENGINE</span>
    </div>
  </aside>
</template>

<style scoped>
.project-settings-nav{position:relative;min-width:0;padding:20px 14px;border-right:1px solid var(--line-soft);background:linear-gradient(180deg,#111725,#0b111a)}
.back-button{display:flex;align-items:center;width:100%;gap:8px;padding:9px;border:1px solid transparent;border-radius:7px;color:var(--text-muted);background:transparent;font-size:9px;cursor:pointer}
.back-button:hover{border-color:var(--line-strong);color:var(--text-primary);background:#171e2a}
.back-button:focus-visible,.nav-item:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.nav-heading{margin:34px 9px 17px}
.nav-heading span,.nav-heading strong{display:block}
.nav-heading span{color:var(--accent);font:700 7px var(--font-utility);letter-spacing:.18em}
.nav-heading strong{margin-top:7px;font:560 16px var(--font-display)}
.project-settings-nav nav{display:grid;gap:5px}
.nav-item{display:grid;grid-template-columns:20px minmax(0,1fr) auto;align-items:start;width:100%;gap:9px;padding:11px 10px;border:1px solid transparent;border-radius:8px;color:var(--text-muted);background:transparent;text-align:left}
.nav-item.active{border-color:#484771;color:#e0ddff;background:linear-gradient(90deg,#242442,#1a2030);box-shadow:2px 0 0 var(--accent) inset}
.nav-item:disabled{opacity:.4}
.nav-item svg{margin-top:1px;color:var(--accent-soft)}
.nav-item b,.nav-item small{display:block}
.nav-item b{font-size:9px}
.nav-item small{margin-top:4px;color:#737e94;font-size:7px;line-height:1.35}
.nav-item em{color:#515d71;font:normal 6px var(--font-utility);letter-spacing:.08em}
.format-rail{position:absolute;right:22px;bottom:20px;left:22px;display:flex;align-items:center;justify-content:center;gap:6px;color:#485469;font:6px var(--font-utility)}
.format-rail i{width:20px;height:1px;background:linear-gradient(90deg,#5a5483,#3b7181)}
</style>
