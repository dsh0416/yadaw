<script setup lang="ts">
import { computed } from "vue"
import { Activity, Cpu, Zap } from "@lucide/vue"
import { Separator, SliderRange, SliderRoot, SliderThumb, SliderTrack } from "reka-ui"
import type { AudioRuntimeSnapshot } from "@yadaw/contracts"

const props = defineProps<{ runtime: AudioRuntimeSnapshot; peak?: number; error?: string }>()
const emit = defineEmits<{ runPreview: [] }>()
const gainValues = defineModel<number[]>({ required: true })
const gain = computed(() => gainValues.value[0] ?? 0.5)
const meterLevel = computed(() => Math.max(1, Math.min(12, Math.round((props.peak ?? gain.value / 2) * 12))))
const meterSegments = Array.from({ length: 12 }, (_, index) => index)
</script>

<template>
  <aside class="inspector-panel">
    <div class="panel-heading"><div><span>SIGNAL LAB</span><strong>Engine probe</strong></div><Activity :size="15" aria-hidden="true" /></div>
    <p class="panel-description">Trace a test signal through Vue, Electron, N-API, and the Rust DSP core.</p>
    <div class="signal-card">
      <div class="signal-card-header"><span>Output peak</span><output>{{ peak === undefined ? "—" : peak.toFixed(3) }}</output></div>
      <div class="meter" aria-label="Output peak meter"><span v-for="segment in meterSegments" :key="segment" :class="{ active: segment < meterLevel, hot: segment > 9 }" /></div>
      <div class="meter-scale"><span>−∞</span><span>−12</span><span>−6</span><span>0 dB</span></div>
    </div>
    <label class="gain-label" for="gain">Offline gain <output>{{ gain.toFixed(2) }}</output></label>
    <SliderRoot id="gain" v-model="gainValues" class="gain-slider" :min="0" :max="2" :step="0.01"><SliderTrack class="gain-slider-track"><SliderRange class="gain-slider-range" /></SliderTrack><SliderThumb class="gain-slider-thumb" aria-label="Offline gain" /></SliderRoot>
    <button class="primary-action" @click="emit('runPreview')"><Zap :size="13" />Run signal check</button>
    <Separator class="panel-separator" orientation="horizontal" />
    <div class="telemetry-heading"><Cpu :size="12" /><span>Native telemetry</span></div>
    <dl><div><dt>Input</dt><dd>−0.50 · 0.25 · 1.00</dd></div><div><dt>Audio I/O</dt><dd>Rust · CPAL</dd></div><div><dt>Sample rate</dt><dd>{{ runtime.sampleRate ? `${runtime.sampleRate.toLocaleString()} Hz` : "—" }}</dd></div><div><dt>Clock sync</dt><dd>{{ runtime.clockSync.replace("-", " ") }}</dd></div></dl>
    <div v-if="error" class="error-message">{{ error }}</div>
  </aside>
</template>

<style scoped>
.inspector-panel{min-width:0;padding:17px 14px;border-left:1px solid var(--line-soft);background:var(--surface-panel);overflow:auto}.panel-heading{display:flex;align-items:center;justify-content:space-between}.panel-heading>div span,.panel-heading>div strong{display:block}.panel-heading span{color:var(--accent);font:700 7px var(--font-utility);letter-spacing:.18em}.panel-heading strong{margin-top:5px;color:var(--text-primary);font-family:var(--font-display);font-size:13px}.panel-heading>svg{color:var(--signal-cyan);filter:drop-shadow(0 0 5px color-mix(in srgb,var(--signal-cyan) 53%,transparent))}.panel-description{margin:14px 0 17px;color:var(--text-muted);font-size:9px;line-height:1.55}.signal-card{padding:11px;border:1px solid var(--line-soft);border-radius:7px;background:var(--surface-sunken);box-shadow:0 1px 0 #ffffff05 inset}.signal-card-header,.gain-label{display:flex;justify-content:space-between;align-items:center}.signal-card-header span,.gain-label{color:var(--text-muted);font-size:8px}.signal-card-header output,.gain-label output{color:var(--signal-cyan);font:9px var(--font-utility)}.meter{display:grid;grid-template-columns:repeat(12,1fr);height:38px;align-items:end;gap:3px;margin-top:9px}.meter span{height:28%;border-radius:2px 2px 1px 1px;background:var(--daw-control);transition:height 160ms ease,background 160ms ease}.meter span:nth-child(3n+2){height:42%}.meter span:nth-child(3n){height:62%}.meter span.active{height:100%;background:linear-gradient(var(--signal-cyan),var(--accent-strong));box-shadow:0 0 6px color-mix(in srgb,var(--signal-cyan) 27%,transparent)}.meter span.active.hot{background:linear-gradient(var(--record),var(--meter-red));box-shadow:0 0 6px color-mix(in srgb,var(--record) 33%,transparent)}.meter-scale{display:flex;justify-content:space-between;margin-top:5px;color:var(--text-faint);font:6px var(--font-utility)}.gain-label{margin-top:17px}.gain-slider{position:relative;display:flex;align-items:center;width:100%;height:25px;margin:5px 0 12px;touch-action:none;user-select:none}.gain-slider-track{position:relative;flex:1;height:3px;overflow:hidden;border-radius:999px;background:var(--daw-control)}.gain-slider-range{position:absolute;height:100%;background:linear-gradient(90deg,var(--accent),var(--signal-cyan))}.gain-slider-thumb{display:block;width:13px;height:13px;border:2px solid var(--accent-soft);border-radius:50%;background:var(--daw-control);box-shadow:0 2px 8px var(--shadow);cursor:grab}.gain-slider-thumb:focus-visible{outline:2px solid var(--focus);outline-offset:3px}.primary-action{display:flex;align-items:center;justify-content:center;width:100%;gap:7px;padding:9px;border:1px solid var(--accent-strong);border-radius:7px;color:var(--button-primary-text);background:var(--button-primary);box-shadow:0 1px 0 #ffffff24 inset,0 7px 18px var(--shadow);cursor:pointer;font-size:9px;font-weight:650}.primary-action:hover{filter:brightness(1.08)}.primary-action:focus-visible{outline:2px solid var(--focus);outline-offset:2px}.panel-separator{width:100%;height:1px;margin:18px 0 12px;background:var(--line-soft)}.telemetry-heading{display:flex;align-items:center;gap:6px;color:var(--text-muted);font:700 7px var(--font-utility);letter-spacing:.12em;text-transform:uppercase}.inspector-panel dl{margin:9px 0 0}.inspector-panel dl div{display:flex;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid var(--line-soft);font-size:8px}.inspector-panel dt{color:var(--text-faint)}.inspector-panel dd{margin:0;overflow:hidden;color:var(--text-secondary);font:7px var(--font-utility);text-align:right;text-overflow:ellipsis;white-space:nowrap}.error-message{margin-top:12px;padding:9px;border:1px solid color-mix(in srgb,var(--record) 55%,var(--line-strong));border-radius:6px;color:var(--record);background:color-mix(in srgb,var(--record) 12%,var(--surface-1));font-size:8px;line-height:1.5}
</style>
