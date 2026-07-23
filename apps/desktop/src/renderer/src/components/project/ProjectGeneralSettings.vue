<script setup lang="ts">
import { PROJECT_SAMPLE_RATES } from "@yadaw/contracts"
import type { ProjectConfiguration } from "@yadaw/contracts"

const configuration = defineModel<ProjectConfiguration>({ required: true })

function update(patch: Partial<ProjectConfiguration>): void {
  configuration.value = { ...configuration.value, ...patch }
}

function textValue(event: Event): string {
  return (event.target as HTMLInputElement).value
}

function numberValue(event: Event): number {
  return Number((event.target as HTMLInputElement | HTMLSelectElement).value)
}
</script>

<template>
  <div class="settings-sections">
    <section class="settings-section">
      <header class="section-header">
        <span>IDENTITY</span>
        <div><h2>Project identity</h2><p>The name shown throughout the workspace and recent project list.</p></div>
      </header>
      <div class="field-grid single">
        <label class="field">
          <span>Project name</span>
          <input :value="configuration.name" required @input="update({ name: textValue($event) })" />
        </label>
      </div>
    </section>

    <section class="settings-section">
      <header class="section-header">
        <span>SESSION FORMAT</span>
        <div><h2>Timing and audio basis</h2><p>These values define new media and the musical grid for this project.</p></div>
      </header>
      <div class="field-grid">
        <label class="field wide">
          <span>Sample rate</span>
          <select :value="configuration.sampleRate" @change="update({ sampleRate: numberValue($event) as ProjectConfiguration['sampleRate'] })">
            <option v-for="rate in PROJECT_SAMPLE_RATES" :key="rate" :value="rate">{{ rate.toLocaleString() }} Hz</option>
          </select>
          <small>Existing assets remain unchanged.</small>
        </label>
        <label class="field">
          <span>Tempo</span>
          <input :value="configuration.tempo" type="number" min="1" max="999" step="0.01" @input="update({ tempo: numberValue($event) })" />
          <small>Beats per minute</small>
        </label>
        <label class="field">
          <span>Meter numerator</span>
          <input :value="configuration.timeSignatureNumerator" type="number" min="1" max="32" @input="update({ timeSignatureNumerator: numberValue($event) })" />
        </label>
        <label class="field">
          <span>Meter denominator</span>
          <select :value="configuration.timeSignatureDenominator" @change="update({ timeSignatureDenominator: numberValue($event) })">
            <option v-for="value in [1, 2, 4, 8, 16, 32]" :key="value" :value="value">{{ value }}</option>
          </select>
        </label>
      </div>
    </section>
  </div>
</template>

<style scoped>
.settings-sections{display:grid;gap:18px}
.settings-section{border:1px solid var(--line-soft);border-radius:11px;background:#101720;box-shadow:0 1px 0 #ffffff05 inset;overflow:hidden}
.section-header{display:grid;grid-template-columns:126px minmax(0,1fr);gap:20px;padding:22px 24px;border-bottom:1px solid var(--line-soft);background:linear-gradient(90deg,#151c29,#101720)}
.section-header>span{padding-top:3px;color:var(--accent);font:700 7px var(--font-utility);letter-spacing:.16em}
.section-header h2{margin:0;font:560 15px var(--font-display)}
.section-header p{margin:6px 0 0;color:var(--text-muted);font-size:8px;line-height:1.5}
.field-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px;padding:24px}
.field-grid.single{grid-template-columns:minmax(260px,560px)}
.field.wide{grid-column:1/-1}
.field{display:grid;align-content:start;gap:7px;color:var(--text-muted);font:700 7px var(--font-utility);letter-spacing:.08em;text-transform:uppercase}
.field input,.field select{width:100%;height:40px;padding:0 11px;border:1px solid var(--line-strong);border-radius:7px;color:var(--text-primary);background:#090f17;outline:none;text-transform:none}
.field input:focus,.field select:focus{border-color:var(--focus);box-shadow:0 0 0 2px #867eff1f}
.field small{color:var(--text-faint);font:normal 7px var(--font-utility);letter-spacing:0;text-transform:none}
@media(max-width:760px){.section-header{grid-template-columns:1fr;gap:8px}.field-grid{grid-template-columns:1fr}.field.wide{grid-column:auto}}
</style>
