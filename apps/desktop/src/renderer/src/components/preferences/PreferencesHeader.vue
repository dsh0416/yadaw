<script setup lang="ts">
import { ArrowLeft } from "@lucide/vue"
defineProps<{ applying: boolean; canSave: boolean }>()
const emit = defineEmits<{ cancel: []; save: [] }>()
</script>

<template>
  <header class="preferences-topbar">
    <button class="back-button" aria-label="Back to session" @click="emit('cancel')"><ArrowLeft :size="16" /></button>
    <div class="header-title"><span>YADAW / SYSTEM</span><h1>Preferences</h1></div>
    <div class="preferences-actions"><button class="secondary-button" @click="emit('cancel')">Cancel</button><button class="save-button" :disabled="applying || !canSave" @click="emit('save')">{{ applying ? "Starting engine…" : "Apply audio" }}</button></div>
  </header>
</template>

<style scoped>
.preferences-header{grid-column:1/-1;display:grid;grid-template-columns:36px 1fr auto;align-items:center;gap:13px;padding:0 18px;border-bottom:1px solid var(--line-strong);background:#101620;box-shadow:0 10px 28px #02040a42;-webkit-app-region:drag}.preferences-header button{-webkit-app-region:no-drag}.back-button{display:grid;place-items:center;width:32px;height:32px;padding:0;border:1px solid var(--line-strong);border-radius:7px;color:var(--text-secondary);background:#171f2c;cursor:pointer}.back-button:hover{color:#fff;background:#1d2635}.back-button:focus-visible,.secondary-button:focus-visible,.save-button:focus-visible{outline:2px solid var(--focus);outline-offset:2px}.header-title span{color:var(--accent);font:700 7px var(--font-utility);letter-spacing:.17em}.header-title h1{margin:3px 0 0;font-family:var(--font-display);font-size:14px;font-weight:600;letter-spacing:.02em}.preferences-actions{display:flex;gap:7px}.secondary-button,.save-button{padding:8px 13px;border-radius:7px;cursor:pointer;font-size:9px}.secondary-button{border:1px solid var(--line-strong);color:var(--text-secondary);background:#171e2a}.save-button{border:1px solid #8078df;color:#f1f0ff;background:linear-gradient(180deg,#514ba0,#3b387a);box-shadow:0 1px 0 #ffffff24 inset}.save-button:disabled{opacity:.4;cursor:not-allowed}
.preferences-topbar{grid-column:1/-1;display:grid;grid-template-columns:36px 1fr auto;align-items:center;gap:13px;padding:0 18px;border-bottom:1px solid var(--line-strong);background:#101620;box-shadow:0 10px 28px #02040a42;-webkit-app-region:drag}.preferences-topbar button{-webkit-app-region:no-drag}
</style>
