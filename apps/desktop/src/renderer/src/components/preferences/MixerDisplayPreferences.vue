<script setup lang="ts">
import { onMounted } from "vue"
import { storeToRefs } from "pinia"
import type { MeterPeakHold, MeterReturnRate } from "@yadaw/contracts"
import { useApplicationSettingsStore } from "../../stores/applicationSettings"

const settingsStore = useApplicationSettingsStore()
const { settings, loading, error } = storeToRefs(settingsStore)

const peakHoldOptions: ReadonlyArray<{ value: MeterPeakHold; label: string }> = [
  { value: "800ms", label: "800 ms" },
  { value: "2s", label: "2 seconds" },
  { value: "4s", label: "4 seconds" },
  { value: "infinite", label: "Infinite" }
]

const returnRateOptions: ReadonlyArray<{ value: MeterReturnRate; label: string }> = [
  { value: "iec-type-i", label: "IEC Type I (11.8 dB/s)" }
]

function selectPeakHold(event: Event): void {
  void settingsStore.setMeterPeakHold(
    (event.target as HTMLSelectElement).value as MeterPeakHold
  )
}

function selectReturnRate(event: Event): void {
  void settingsStore.setMeterReturnRate(
    (event.target as HTMLSelectElement).value as MeterReturnRate
  )
}

onMounted(() => {
  if (!settings.value) void settingsStore.load()
})
</script>

<template>
  <section class="mixer-display-preferences">
    <div class="settings-intro">
      <span class="section-kicker">Display <b>/</b> Mixer</span>
      <h2>Mixer meters</h2>
      <p>Control how channel peaks remain visible and return after transients.</p>
    </div>

    <div class="display-setting">
      <div class="settings-copy">
        <h3>Peak hold time</h3>
        <p>Keeps the highest level visible long enough to identify short transients.</p>
      </div>
      <label class="setting-field">
        <span>Duration</span>
        <select
          :value="settings?.meterPeakHold ?? '800ms'"
          :disabled="loading"
          aria-label="Mixer meter peak hold time"
          @change="selectPeakHold"
        >
          <option
            v-for="option in peakHoldOptions"
            :key="option.value"
            :value="option.value"
          >{{ option.label }}</option>
        </select>
      </label>
    </div>

    <div class="display-setting">
      <div class="settings-copy">
        <h3>Return time</h3>
        <p>Sets how quickly the displayed level falls after the signal peak.</p>
      </div>
      <label class="setting-field">
        <span>Response</span>
        <select
          :value="settings?.meterReturnRate ?? 'iec-type-i'"
          :disabled="loading"
          aria-label="Mixer meter return time"
          @change="selectReturnRate"
        >
          <option
            v-for="option in returnRateOptions"
            :key="option.value"
            :value="option.value"
          >{{ option.label }}</option>
        </select>
      </label>
    </div>

    <div class="meter-note">
      <span>CLIP RESET</span>
      <p>Click a channel meter’s numeric peak readout to clear latched clipping indicators.</p>
    </div>
    <p v-if="error" class="display-error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.mixer-display-preferences{min-width:0;overflow:auto;padding:38px clamp(30px,4.5vw,68px) 60px;background:var(--canvas)}
.settings-intro{max-width:900px}.section-kicker{color:var(--accent);font:700 7px var(--font-utility);letter-spacing:.17em}.section-kicker b{color:var(--text-faint)}.settings-intro h2{margin:8px 0 6px;font:560 27px var(--font-display)}.settings-intro p,.settings-copy p{margin:0;color:var(--text-muted);font-size:9px;line-height:1.55}
.display-setting{display:grid;grid-template-columns:minmax(170px,230px) minmax(260px,420px);max-width:900px;gap:48px;padding:26px 0;border-bottom:1px solid var(--line-soft)}.settings-copy h3{margin:0 0 6px;font:600 11px var(--font-display)}
.setting-field{display:grid;align-content:start;gap:7px;color:var(--text-muted);font:7px var(--font-utility);letter-spacing:.06em}.setting-field select{width:100%;height:34px;padding:0 10px;border:1px solid var(--line-strong);border-radius:5px;color:var(--text-primary);background:var(--surface-1);font-size:9px}.setting-field select:focus-visible{outline:2px solid var(--focus);outline-offset:2px}.setting-field select:disabled{cursor:wait;opacity:.6}
.meter-note{max-width:900px;margin-top:26px;padding:14px;border-left:2px solid var(--accent);color:var(--text-muted);background:var(--surface-1)}.meter-note span{color:var(--accent);font:700 7px var(--font-utility);letter-spacing:.14em}.meter-note p{max-width:620px;margin:7px 0 0;font-size:8px;line-height:1.6}.display-error{max-width:900px;color:var(--record);font-size:9px}
@media(max-width:900px){.display-setting{grid-template-columns:1fr;gap:17px}}
</style>
