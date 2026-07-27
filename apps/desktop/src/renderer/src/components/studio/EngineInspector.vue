<script setup lang="ts">
import { computed } from "vue"
import { Activity, Cpu, Zap } from "@lucide/vue"
import { UiButton, UiSlider } from "@yadaw/ui"
import type { AudioRuntimeSnapshot } from "@yadaw/contracts"

const props = defineProps<{ runtime: AudioRuntimeSnapshot; peak?: number; error?: string }>()
const emit = defineEmits<{ runPreview: [] }>()
const gainValues = defineModel<number[]>({ required: true })
const gain = computed(() => gainValues.value[0] ?? 0.5)
const gainValue = computed({
  get: () => gain.value,
  set: (value: number) => {
    gainValues.value = [value]
  }
})
const meterLevel = computed(() =>
  Math.max(1, Math.min(12, Math.round((props.peak ?? gain.value / 2) * 12)))
)
const meterSegments = Array.from({ length: 12 }, (_, index) => index)
</script>

<template>
  <aside class="inspector-panel">
    <div class="panel-heading">
      <div><span>SIGNAL LAB</span><strong>Engine probe</strong></div>
      <Activity :size="15" aria-hidden="true" />
    </div>
    <p class="panel-description">
      Trace a test signal through Vue, Electron, N-API, and the Rust DSP core.
    </p>
    <div class="signal-card">
      <div class="signal-card-header">
        <span>Output peak</span><output>{{ peak === undefined ? "—" : peak.toFixed(3) }}</output>
      </div>
      <div class="meter" aria-label="Output peak meter">
        <span
          v-for="segment in meterSegments"
          :key="segment"
          :class="{ active: segment < meterLevel, hot: segment > 9 }"
        />
      </div>
      <div class="meter-scale"><span>−∞</span><span>−12</span><span>−6</span><span>0 dB</span></div>
    </div>
    <label class="gain-label" for="gain"
      >Offline gain <output>{{ gain.toFixed(2) }}</output></label
    >
    <UiSlider
      id="gain"
      v-model="gainValue"
      class="gain-slider"
      label="Offline gain"
      :value-text="gain.toFixed(2)"
      :min="0"
      :max="2"
      :step="0.01"
    />
    <UiButton class="primary-action" variant="primary" @click="emit('runPreview')">
      <Zap :size="13" />Run signal check
    </UiButton>
    <hr class="panel-separator" />
    <div class="telemetry-heading"><Cpu :size="12" /><span>Native telemetry</span></div>
    <dl>
      <div>
        <dt>Input</dt>
        <dd>−0.50 · 0.25 · 1.00</dd>
      </div>
      <div>
        <dt>Audio I/O</dt>
        <dd>Rust · CPAL</dd>
      </div>
      <div>
        <dt>Sample rate</dt>
        <dd>{{ runtime.sampleRate ? `${runtime.sampleRate.toLocaleString()} Hz` : "—" }}</dd>
      </div>
      <div>
        <dt>Clock sync</dt>
        <dd>{{ runtime.clockSync.replace("-", " ") }}</dd>
      </div>
    </dl>
    <div v-if="error" class="error-message">{{ error }}</div>
  </aside>
</template>

<style scoped>
.inspector-panel {
  min-width: 0;
  padding: 17px 14px;
  border-left: 1px solid var(--line-soft);
  background: var(--surface-panel);
  overflow: auto;
}
.panel-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.panel-heading > div span,
.panel-heading > div strong {
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
.panel-heading > svg {
  color: var(--signal-cyan);
  filter: drop-shadow(0 0 5px color-mix(in srgb, var(--signal-cyan) 53%, transparent));
}
.panel-description {
  margin: 14px 0 17px;
  color: var(--text-muted);
  font-size: var(--ui-type-size-body-compact);
  line-height: var(--ui-type-leading-normal);
}
.signal-card {
  padding: 11px;
  border: 1px solid var(--line-soft);
  border-radius: 7px;
  background: var(--surface-sunken);
  box-shadow: 0 1px 0 var(--ui-domain-color-ffffff05) inset;
}
.signal-card-header,
.gain-label {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.signal-card-header span,
.gain-label {
  color: var(--text-muted);
  font-size: var(--ui-type-size-control);
}
.signal-card-header output,
.gain-label output {
  color: var(--signal-cyan);
  font: var(--ui-type-size-body-compact) var(--ui-type-family-data);
}
.meter {
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  height: 38px;
  align-items: end;
  gap: 3px;
  margin-top: 9px;
}
.meter span {
  height: 28%;
  border-radius: 2px 2px 1px 1px;
  background: var(--daw-control);
  transition:
    height 160ms ease,
    background 160ms ease;
}
.meter span:nth-child(3n + 2) {
  height: 42%;
}
.meter span:nth-child(3n) {
  height: 62%;
}
.meter span.active {
  height: 100%;
  background: linear-gradient(var(--signal-cyan), var(--accent-strong));
  box-shadow: 0 0 6px color-mix(in srgb, var(--signal-cyan) 27%, transparent);
}
.meter span.active.hot {
  background: linear-gradient(var(--record), var(--meter-red));
  box-shadow: 0 0 6px color-mix(in srgb, var(--record) 33%, transparent);
}
.meter-scale {
  display: flex;
  justify-content: space-between;
  margin-top: 5px;
  color: var(--text-faint);
  font: var(--ui-type-size-micro) var(--ui-type-family-data);
}
.gain-label {
  margin-top: 17px;
}
.gain-slider {
  margin: 5px 0 12px;
}
.primary-action {
  width: 100%;
}
.panel-separator {
  border: 0;
  width: 100%;
  height: 1px;
  margin: 18px 0 12px;
  background: var(--line-soft);
}
.telemetry-heading {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-muted);
  font: var(--ui-type-weight-bold) var(--ui-type-size-caption) var(--ui-type-family-data);
  letter-spacing: var(--ui-type-tracking-wider);
  text-transform: uppercase;
}
.inspector-panel dl {
  margin: 9px 0 0;
}
.inspector-panel dl div {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 0;
  border-bottom: 1px solid var(--line-soft);
  font-size: var(--ui-type-size-control);
}
.inspector-panel dt {
  color: var(--text-faint);
}
.inspector-panel dd {
  margin: 0;
  overflow: hidden;
  color: var(--text-secondary);
  font: var(--ui-type-size-caption) var(--ui-type-family-data);
  text-align: right;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.error-message {
  margin-top: 12px;
  padding: 9px;
  border: 1px solid color-mix(in srgb, var(--record) 55%, var(--line-strong));
  border-radius: 6px;
  color: var(--record);
  background: color-mix(in srgb, var(--record) 12%, var(--surface-1));
  font-size: var(--ui-type-size-control);
  line-height: var(--ui-type-leading-normal);
}
</style>
