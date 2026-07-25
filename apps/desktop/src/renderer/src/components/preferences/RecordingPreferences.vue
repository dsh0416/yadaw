<script setup lang="ts">
import { computed, onMounted } from "vue"
import { storeToRefs } from "pinia"
import type { RecordingBitDepth } from "@yadaw/contracts"
import { useApplicationSettingsStore } from "../../stores/applicationSettings"
import { useRecordingStore } from "../../stores/recording"

const settingsStore = useApplicationSettingsStore()
const recordingStore = useRecordingStore()
const { settings, loading, error } = storeToRefs(settingsStore)
const { pending, active } = storeToRefs(recordingStore)
const pendingCount = computed(() => pending.value.filter((recording) => !recording.assetExists).length)

onMounted(async () => {
  if (!settings.value) await settingsStore.load()
  await recordingStore.refreshPending()
})

function setBitDepth(event: Event): void {
  const value = (event.target as HTMLSelectElement).value as RecordingBitDepth
  void settingsStore.update({ recordingBitDepth: value })
}

function openSwapDirectory(): void {
  void settingsStore.openSwapDirectory()
}
</script>

<template>
  <section class="recording-preferences">
    <div class="settings-intro"><span class="section-kicker">Audio <b>/</b> Recording</span><h2>Recording</h2><p>Capture stays in machine-local swap until a successful project archive save.</p></div>
    <div class="recording-setting"><div><h3>Swap directory</h3><p>Half-finished recordings and recoverable source BWF files live here.</p></div><div class="path-control"><code>{{ settings?.swapDirectory ?? "Loading…" }}</code><button :disabled="loading" @click="settingsStore.chooseSwapDirectory">Browse…</button><button :disabled="loading" @click="openSwapDirectory">Open</button></div></div>
    <div class="recording-setting"><div><h3>Final bit depth</h3><p>Swap is always float32. Integer output is dithered once after resampling.</p></div><label>Format<select :value="settings?.recordingBitDepth" @change="setBitDepth"><option value="float32">32-bit float</option><option value="pcm24">24-bit PCM</option><option value="pcm16">16-bit PCM</option></select></label></div>
    <div class="recording-setting"><div><h3>Recovery</h3><p>Files are never removed merely because the project was closed without saving.</p></div><div class="recovery-count"><b>{{ pendingCount }}</b><span>recordings waiting in swap</span></div></div>
    <p v-if="active" class="recording-note">A recording is active. Changes made here apply to the next recording.</p>
    <p v-if="error" role="alert" class="recording-error">{{ error }}</p>
  </section>
</template>

<style scoped>
.recording-preferences{min-width:0;overflow:auto;padding:38px clamp(30px,4.5vw,68px) 60px;background:radial-gradient(circle at 72% 0,#25234b24,transparent 32%),var(--canvas)}.settings-intro{max-width:900px}.section-kicker{color:var(--accent);font:700 7px var(--font-utility);letter-spacing:.17em}.section-kicker b{color:#465267}.settings-intro h2{margin:8px 0 6px;font:560 27px var(--font-display)}.settings-intro p,.recording-setting p{margin:0;color:var(--text-muted);font-size:9px;line-height:1.55}.recording-setting{display:grid;grid-template-columns:minmax(170px,230px) minmax(390px,1fr);max-width:900px;gap:48px;padding:26px 0;border-bottom:1px solid var(--line-soft)}.recording-setting h3{margin:0 0 6px;font:600 11px var(--font-display)}.path-control{display:flex;gap:8px}.path-control code{flex:1;overflow:hidden;padding:11px;border:1px solid var(--line-strong);border-radius:7px;color:var(--text-secondary);background:#101620;font:8px var(--font-utility);text-overflow:ellipsis;white-space:nowrap}.path-control button,.recording-setting select{padding:0 12px;border:1px solid var(--line-strong);border-radius:7px;color:var(--text-secondary);background:var(--surface-3)}.recording-setting label{display:grid;max-width:240px;gap:7px;color:var(--text-muted);font:7px var(--font-utility);text-transform:uppercase}.recording-setting select{height:38px}.recovery-count{display:flex;align-items:baseline;gap:10px}.recovery-count b{color:var(--signal-cyan);font:24px var(--font-utility)}.recovery-count span{color:var(--text-muted);font-size:9px}.recording-note,.recording-error{max-width:900px;padding:11px;border-radius:7px;font-size:9px}.recording-note{color:var(--warning);background:#2a2416}.recording-error{color:#ff9dab;background:#321923}@media(max-width:1120px){.recording-setting{grid-template-columns:1fr;gap:17px}}
</style>
