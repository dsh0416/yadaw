<script setup lang="ts">
import { AudioLines, Cable, CircleDot, Keyboard, Music2, Palette, Plug } from "@lucide/vue"

defineProps<{ activePage: "devices" | "recording" }>()
const emit = defineEmits<{ select: [page: "devices" | "recording"] }>()
const categories = [
  { id: "audio", label: "Audio", icon: AudioLines, disabled: false },
  { id: "midi", label: "MIDI", icon: Music2, disabled: true },
  { id: "plugins", label: "Plugins", icon: Plug, disabled: true },
  { id: "appearance", label: "Appearance", icon: Palette, disabled: true },
  { id: "keyboard", label: "Keyboard", icon: Keyboard, disabled: true }
] as const
</script>

<template>
  <aside class="prefs-primary-nav">
    <div class="sidebar-label">SETTINGS</div>
    <nav class="settings-primary-nav" aria-label="Preference categories">
      <button v-for="category in categories" :key="category.id" :class="['settings-nav-item',{active:category.id==='audio'}]" :disabled="category.disabled" :aria-current="category.id==='audio'?'page':undefined"><component :is="category.icon" :size="15" /><span>{{ category.label }}</span><small v-if="category.disabled">SOON</small></button>
    </nav>
    <div class="sidebar-version">YADAW / BUILD 0.0.0</div>
  </aside>
  <aside class="prefs-secondary-nav">
    <div class="secondary-sidebar-heading"><span>AUDIO</span><strong>Signal path</strong></div>
    <nav aria-label="Audio preference pages">
      <button :class="['settings-page-item',{active:activePage==='devices'}]" :aria-current="activePage==='devices'?'page':undefined" @click="emit('select','devices')"><Cable :size="15" /><span><b>Devices</b><small>Host, hardware I/O & latency</small></span></button>
      <button :class="['settings-page-item',{active:activePage==='recording'}]" :aria-current="activePage==='recording'?'page':undefined" @click="emit('select','recording')"><CircleDot :size="15" /><span><b>Recording</b><small>Swap, format & recovery</small></span></button>
    </nav>
    <div class="signal-route" aria-hidden="true"><span>HOST</span><i /><span>I/O</span><i /><span>DSP</span></div>
  </aside>
</template>

<style scoped>
.prefs-primary-nav{position:relative;min-width:0;padding:24px 11px;border-right:1px solid var(--line-soft);background:#0d131c}.prefs-secondary-nav{min-width:0;padding:24px 11px;border-right:1px solid var(--line-soft);background:#111722}.sidebar-label{margin:0 9px 10px;color:#566278;font:700 7px var(--font-utility);letter-spacing:.16em}.settings-primary-nav{display:grid;gap:3px}.settings-nav-item{display:grid;grid-template-columns:17px 1fr auto;align-items:center;width:100%;gap:8px;padding:9px;border:1px solid transparent;border-radius:6px;color:var(--text-muted);background:transparent;text-align:left;font-size:9px}.settings-nav-item.active{border-color:#6f67c833;color:#d6d2ff;background:linear-gradient(90deg,#24234a,#191d31);box-shadow:2px 0 0 var(--accent) inset}.settings-nav-item:disabled{opacity:.42}.settings-nav-item small{color:#525f73;font:6px var(--font-utility);letter-spacing:.08em}.sidebar-version{position:absolute;right:20px;bottom:18px;left:20px;color:#414c5f;font:6px var(--font-utility);letter-spacing:.06em}.secondary-sidebar-heading{margin:0 9px 17px}.secondary-sidebar-heading span,.secondary-sidebar-heading strong{display:block}.secondary-sidebar-heading span{color:var(--accent);font:700 7px var(--font-utility);letter-spacing:.17em}.secondary-sidebar-heading strong{margin-top:6px;color:var(--text-primary);font-family:var(--font-display);font-size:14px}.settings-page-item{display:grid;grid-template-columns:18px minmax(0,1fr);width:100%;gap:8px;margin-bottom:5px;padding:10px;border:1px solid transparent;border-radius:7px;color:var(--text-muted);background:transparent;text-align:left;cursor:pointer}.settings-page-item.active{border-color:#36405a;color:#d6d2ff;background:#1b2036}.settings-page-item>svg{margin-top:1px;color:var(--accent-soft)}.settings-page-item b,.settings-page-item small{display:block}.settings-page-item b{font-size:9px}.settings-page-item small{margin-top:4px;color:#737e94;font-size:7px;line-height:1.4}.settings-page-item:focus-visible{outline:2px solid var(--focus);outline-offset:1px}.signal-route{display:flex;align-items:center;justify-content:center;gap:5px;margin:24px 8px;color:#4f5b70;font:6px var(--font-utility)}.signal-route i{width:16px;height:1px;background:linear-gradient(90deg,#57517d,#3c7180)}
</style>
