<script setup lang="ts">
import { computed } from "vue"
import { storeToRefs } from "pinia"
import { RadioTower } from "@lucide/vue"
import type { MeterPeakHold, MeterReturnRate } from "@yadaw/contracts"
import type {
  MixerChannelMeter,
  MixerChannelPatch,
  MixerChannelState,
  MixerParameterPreview,
  MixerSendState
} from "@yadaw/contracts"
import { usePeakMeterDisplay } from "../../composables/usePeakMeterDisplay"
import { useParameterGesture } from "../../composables/useParameterGesture"
import { useApplicationSettingsStore } from "../../stores/applicationSettings"
import InlineTrackNameEditor from "../InlineTrackNameEditor.vue"
import MixerPanKnob from "./MixerPanKnob.vue"

const props = defineProps<{
  channel: MixerChannelState
  sends: MixerSendState[]
  meter: MixerChannelMeter
  outputs: MixerChannelState[]
  selected: boolean
  density: "full" | "dock"
}>()

const emit = defineEmits<{
  select: [channelId: string]
  preview: [preview: MixerParameterPreview]
  updateChannel: [channelId: string, patch: MixerChannelPatch]
  resetMeterClips: []
}>()

const settingsStore = useApplicationSettingsStore()
const { settings } = storeToRefs(settingsStore)
const meter = computed(() => props.meter)
const peakHold = computed<MeterPeakHold>(() =>
  settings.value?.meterPeakHold ?? "800ms"
)
const returnRate = computed<MeterReturnRate>(() =>
  settings.value?.meterReturnRate ?? "iec-type-i"
)
const meterDisplay = usePeakMeterDisplay({
  meter,
  peakHold,
  returnRate
})

const gainLabel = computed(() =>
  props.channel.gainDb <= -90 ? "−∞" : `${props.channel.gainDb.toFixed(1)} dB`
)
const maximumPeakLabel = computed(() =>
  Number.isFinite(meterDisplay.latchedPeakDb.value)
    ? meterDisplay.latchedPeakDb.value.toFixed(1)
    : "−∞"
)
const maximumPeakState = computed(() => ({
  active: Number.isFinite(meterDisplay.latchedPeakDb.value),
  hot: meterDisplay.latchedPeakDb.value >= -6,
  clipped: meterDisplay.clipped.value
}))
const meterStyle = computed(() => ({
  "--meter-level": `${meterDisplay.meterLevelPercent.value}%`,
  "--held-meter-level": `${meterDisplay.heldMeterLevelPercent.value}%`
}))
const faderStyle = computed(() => ({
  "--fader-level": `${Math.max(0, Math.min(100, (props.channel.gainDb + 90) / 102 * 100))}%`
}))

function preview(parameter: "gainDb" | "pan", value: number): void {
  emit("preview", {
    target: "channel",
    id: props.channel.id,
    parameter,
    value
  })
}

function resetMaximumPeak(): void {
  meterDisplay.resetPeakAndClip()
  emit("resetMeterClips")
}

const gainGesture = useParameterGesture({
  currentValue: () => props.channel.gainDb,
  preview: (value) => preview("gainDb", value),
  commit: (value) => emit("updateChannel", props.channel.id, { gainDb: value })
})

function beginFaderGesture(event: PointerEvent): void {
  if (event.button !== 0) {
    event.preventDefault()
    return
  }

  const input = event.currentTarget as HTMLInputElement
  const bounds = input.getBoundingClientRect()
  const min = Number(input.min)
  const max = Number(input.max)
  const value = Math.max(min, Math.min(max, props.channel.gainDb))
  const ratio = (value - min) / (max - min)
  const thumbInset = Math.min(8, bounds.height / 2)
  const thumbTravel = Math.max(0, bounds.height - thumbInset * 2)
  const thumbCenterY = bounds.top + thumbInset + (1 - ratio) * thumbTravel

  if (Math.abs(event.clientY - thumbCenterY) > 13) {
    event.preventDefault()
    return
  }

  gainGesture.begin()
}
</script>

<template>
  <article
    :class="['channel-strip', density, channel.kind, { selected }]"
    :style="{ '--strip-color': channel.color }"
    :aria-label="`${channel.name} ${channel.kind} channel`"
    @pointerdown="emit('select', channel.id)"
  >
    <div class="routing-summary">
      <span><RadioTower :size="10" />{{ sends.length }} SEND{{ sends.length === 1 ? "" : "S" }}</span>
      <select
        v-if="channel.kind === 'audio' || channel.kind === 'bus'"
        :value="channel.outputChannelId ?? ''"
        :aria-label="`${channel.name} output`"
        @change="emit('updateChannel', channel.id, { outputChannelId: ($event.target as HTMLSelectElement).value })"
      >
        <option v-for="output in outputs" :key="output.id" :value="output.id">{{ output.name }}</option>
      </select>
      <span v-else-if="channel.kind === 'master'">GLOBAL</span>
      <span v-else>HW {{ channel.hardwareOutputChannels.join('–') }}</span>
    </div>

    <MixerPanKnob
      class="pan-control"
      :channel-name="channel.name"
      :value="channel.pan"
      @preview="preview('pan', $event)"
      @commit="emit('updateChannel', channel.id, { pan: $event })"
    />

    <div class="strip-core">
      <input
        class="parameter-value"
        type="number"
        min="-90"
        max="12"
        step="0.1"
        :value="channel.gainDb"
        :aria-label="`${channel.name} volume value in decibels`"
        :title="`Fader: ${gainLabel}`"
        @change="gainGesture.reset(Number(($event.target as HTMLInputElement).value))"
      >
      <button
        type="button"
        :class="['maximum-peak-value', maximumPeakState]"
        :aria-label="`${channel.name} latched maximum post-fader level in decibels`"
        :title="`Maximum post-fader peak: ${maximumPeakLabel} dB · Click to reset peak and clipping`"
        @pointerdown.stop
        @click.stop="resetMaximumPeak"
      >{{ maximumPeakLabel }}</button>
      <label class="fader">
        <input
          class="fader-control"
          type="range"
          min="-90"
          max="12"
          step="0.1"
          :value="channel.gainDb"
          :style="faderStyle"
          :aria-label="`${channel.name} volume`"
          @pointerdown="beginFaderGesture"
          @input="gainGesture.preview"
          @change="gainGesture.commit"
          @keydown="gainGesture.keydown"
          @dblclick="gainGesture.reset(0)"
        >
      </label>
      <div
        class="meter"
        :class="{
          clipped: meterDisplay.clipped.value,
          'has-held-peak': Number.isFinite(meterDisplay.heldPeakDb.value)
        }"
        :style="meterStyle"
        aria-hidden="true"
      >
        <span /><span />
      </div>
    </div>

    <div :class="['channel-actions', { 'has-input': channel.kind === 'audio' }]">
      <div class="input-actions">
        <template v-if="channel.kind === 'audio'">
          <button
            :class="['record', { active: channel.recordArmed }]"
            :aria-pressed="channel.recordArmed"
            :aria-label="`Arm ${channel.name}`"
            title="Record enable"
            @click.stop="emit('updateChannel', channel.id, { recordArmed: !channel.recordArmed })"
          >R</button>
          <button
            class="monitor"
            aria-label="Input monitoring unavailable"
            aria-disabled="true"
            title="Input monitoring is not available yet"
            disabled
          >I</button>
        </template>
      </div>
      <div class="mix-actions">
        <button
          :class="['mute', { active: channel.muted }]"
          :aria-pressed="channel.muted"
          :aria-label="`Mute ${channel.name}`"
          @click.stop="emit('updateChannel', channel.id, { muted: !channel.muted })"
        >M</button>
        <button
          v-if="channel.kind !== 'master'"
          :class="['solo', { active: channel.soloed }]"
          :aria-pressed="channel.soloed"
          :aria-label="`Solo ${channel.name}`"
          @click.stop="emit('updateChannel', channel.id, { soloed: !channel.soloed })"
        >S</button>
      </div>
    </div>

    <div class="channel-name" @click="emit('select', channel.id)">
      <i :style="{ backgroundColor: channel.color }" />
      <InlineTrackNameEditor
        class="channel-name-editor"
        :name="channel.name"
        :label="`${channel.name} channel name; double-click to rename`"
        @rename="emit('updateChannel', channel.id, { name: $event })"
      />
      <small>{{ channel.kind === "audio" ? channel.inputFormat : channel.kind }}</small>
    </div>
  </article>
</template>

<style scoped>
.channel-strip {
  --strip-color: var(--accent);
  position: relative;
  display: grid;
  grid-template-rows: 39px 72px minmax(120px, 1fr) 61px 38px;
  flex: 0 0 116px;
  min-width: 116px;
  height: 100%;
  overflow: hidden;
  border-right: 1px solid var(--line-strong);
  background: var(--daw-mixer-strip);
  box-shadow: 1px 0 0 #ffffff08 inset;
}

.channel-strip::before {
  content: "";
  position: absolute;
  z-index: 2;
  top: 0;
  right: 0;
  left: 0;
  height: 2px;
  background: var(--strip-color);
  opacity: .75;
}

.channel-strip.bus {
  background: var(--daw-mixer-strip-bus);
}

.channel-strip.master {
  position: sticky;
  right: 0;
  z-index: 5;
  border-left: 1px solid var(--line-strong);
  background: var(--daw-mixer-strip-master);
  box-shadow: -12px 0 22px var(--shadow);
}

.channel-strip.selected {
  background: var(--daw-mixer-strip-selected);
  box-shadow: 3px 0 0 var(--strip-color) inset;
}

.routing-summary {
  display: grid;
  align-content: center;
  gap: 5px;
  padding: 5px 8px;
  border-bottom: 1px solid var(--line-soft);
  color: var(--text-muted);
  background: color-mix(in srgb,var(--surface-2) 82%,transparent);
  font: 6px var(--font-utility);
  letter-spacing: .06em;
}

.routing-summary span {
  display: flex;
  align-items: center;
  gap: 4px;
}

.routing-summary select {
  width: 100%;
  min-height: 18px;
  padding: 1px 4px;
  border: 1px solid var(--line-strong);
  border-radius: 2px;
  color: var(--text-secondary);
  background: var(--daw-control);
  font-size: 7px;
}

.pan-control {
  padding: 7px 10px 8px;
  border-bottom: 1px solid var(--line-soft);
}

.strip-core {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 35px;
  grid-template-rows: 20px minmax(0, 1fr);
  column-gap: 6px;
  row-gap: 6px;
  min-height: 0;
  padding: 10px 10px 8px;
}

.meter {
  position: relative;
  display: flex;
  grid-column: 2;
  grid-row: 2;
  align-self: stretch;
  justify-self: center;
  width: 18px;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--line-strong);
  border-radius: 2px;
  background: var(--daw-meter-well);
}

.meter::after {
  content: "";
  position: absolute;
  z-index: 2;
  right: 2px;
  bottom: var(--held-meter-level);
  left: 2px;
  height: 1px;
  background: var(--meter-yellow);
  box-shadow: 0 0 2px color-mix(in srgb,var(--meter-yellow) 65%,transparent);
  opacity: 0;
}

.meter.has-held-peak::after {
  opacity: .9;
}

.meter span {
  position: relative;
  flex: 1;
  overflow: hidden;
  background: linear-gradient(to top,var(--meter-green) 0 68%,var(--meter-yellow) 79%,var(--meter-red) 100%);
  opacity: .26;
}

.meter span::after {
  content: "";
  position: absolute;
  inset: 0 0 var(--meter-level) 0;
  background: var(--daw-meter-well);
  transition: inset 55ms linear;
}

.meter.clipped {
  border-color: var(--mixer-record);
  box-shadow: 0 0 8px color-mix(in srgb,var(--mixer-record) 35%,transparent);
}

.fader {
  display: grid;
  grid-column: 1;
  grid-row: 2;
  justify-items: center;
  min-height: 0;
}

.fader-control {
  --fader-level: 0%;
  width: 100%;
  height: 100%;
  margin: 0;
  appearance: none;
  background: transparent;
  writing-mode: vertical-lr;
  direction: rtl;
  cursor: ns-resize;
}

.fader-control::-webkit-slider-runnable-track {
  width: 4px;
  height: 100%;
  border: 1px solid var(--line-strong);
  border-radius: 0;
  background: linear-gradient(
    to top,
    var(--accent) 0 var(--fader-level),
    var(--daw-meter-well) var(--fader-level) 100%
  );
  box-shadow: 0 0 0 1px #0006 inset;
}

.fader-control::-webkit-slider-thumb {
  width: 28px;
  height: 13px;
  margin-left: -13px;
  border: 1px solid var(--text-muted);
  border-radius: 1px;
  appearance: none;
  background: linear-gradient(
    to bottom,
    var(--daw-control-hover) 0 calc(50% - 1px),
    var(--text-primary) calc(50% - 1px) calc(50% + 1px),
    var(--daw-control-hover) calc(50% + 1px) 100%
  );
  box-shadow: 0 1px 3px #0009, 0 0 0 1px var(--surface-1);
  cursor: ns-resize;
}

.fader-control::-moz-range-track {
  width: 4px;
  height: 100%;
  border: 1px solid var(--line-strong);
  border-radius: 0;
  background: var(--daw-meter-well);
  box-shadow: 0 0 0 1px #0006 inset;
}

.fader-control::-moz-range-progress {
  width: 4px;
  background: var(--accent);
}

.fader-control::-moz-range-thumb {
  width: 28px;
  height: 13px;
  border: 1px solid var(--text-muted);
  border-radius: 1px;
  background: linear-gradient(
    to bottom,
    var(--daw-control-hover) 0 calc(50% - 1px),
    var(--text-primary) calc(50% - 1px) calc(50% + 1px),
    var(--daw-control-hover) calc(50% + 1px) 100%
  );
  box-shadow: 0 1px 3px #0009, 0 0 0 1px var(--surface-1);
  cursor: ns-resize;
}

.fader-control:focus {
  outline: none;
}

.fader-control:focus-visible::-webkit-slider-thumb,
.fader-control:focus-visible::-moz-range-thumb {
  border-color: var(--focus);
  box-shadow: 0 0 0 2px color-mix(in srgb,var(--focus) 50%,transparent);
}

.parameter-value {
  grid-column: 1;
  grid-row: 1;
  justify-self: center;
  width: 38px;
  height: 20px;
  margin: 0;
  padding: 0 2px;
  border: 1px solid var(--line-strong);
  border-radius: 2px;
  color: var(--text-primary);
  background: var(--daw-control);
  font: 8px var(--font-utility);
  text-align: center;
  writing-mode: horizontal-tb;
  direction: ltr;
  appearance: textfield;
}

.parameter-value::-webkit-inner-spin-button,
.parameter-value::-webkit-outer-spin-button {
  margin: 0;
  appearance: none;
}

.maximum-peak-value {
  display: grid;
  grid-column: 2;
  grid-row: 1;
  place-items: center;
  width: 35px;
  height: 20px;
  overflow: hidden;
  border: 1px solid var(--line-strong);
  border-radius: 2px;
  color: var(--text-faint);
  background: var(--daw-meter-well);
  font: 8px var(--font-utility);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  cursor: pointer;
}

.maximum-peak-value.active {
  color: var(--mixer-pan);
}

.maximum-peak-value.hot {
  color: var(--mixer-solo);
}

.maximum-peak-value.clipped {
  border-color: var(--mixer-record);
  color: var(--record);
  background: color-mix(in srgb,var(--record) 14%,var(--daw-meter-well));
}

.maximum-peak-value:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}

.channel-actions {
  display: grid;
  grid-template-rows: 20px 24px;
  align-content: center;
  justify-items: center;
  gap: 4px;
  border-top: 1px solid var(--line-soft);
  background: color-mix(in srgb,var(--daw-mixer-strip) 70%,var(--daw-control));
}

.input-actions,
.mix-actions {
  display: flex;
  align-items: center;
  justify-content: center;
}

.input-actions {
  justify-self: end;
  gap: 0;
  min-height: 20px;
  margin-right: 6px;
}

.mix-actions {
  gap: 5px;
}

.channel-actions button {
  display: grid;
  place-items: center;
  padding: 0;
  border: 1px solid var(--line-strong);
  border-radius: 3px;
  color: var(--text-muted);
  background: var(--daw-control);
  box-shadow: 0 1px 0 #ffffff12 inset,0 1px 2px var(--shadow);
  font: 700 9px var(--font-utility);
  cursor: pointer;
}

.input-actions button {
  width: 21px;
  height: 19px;
  border-radius: 0;
  font-size: 8px;
}

.input-actions button:first-child {
  border-radius: 3px 0 0 3px;
}

.input-actions button:last-child {
  margin-left: -1px;
  border-radius: 0 3px 3px 0;
}

.mix-actions button {
  width: 34px;
  height: 25px;
}

.channel-actions .mute {
  color: color-mix(in srgb,var(--mixer-mute) 76%,var(--text-secondary));
}

.channel-actions .solo {
  color: color-mix(in srgb,var(--mixer-solo) 78%,var(--text-secondary));
}

.channel-actions .record {
  color: color-mix(in srgb,var(--mixer-record) 76%,var(--text-secondary));
}

.channel-actions .monitor {
  color: var(--mixer-input);
}

.channel-actions .mute.active {
  border-color: color-mix(in srgb,var(--mixer-mute) 72%,white);
  color: #fff;
  background: var(--mixer-mute);
  box-shadow: 0 0 8px color-mix(in srgb,var(--mixer-mute) 46%,transparent),0 1px 0 #ffffff40 inset;
}

.channel-actions .solo.active {
  border-color: color-mix(in srgb,var(--mixer-solo) 72%,white);
  color: #221c08;
  background: var(--mixer-solo);
  box-shadow: 0 0 8px color-mix(in srgb,var(--mixer-solo) 40%,transparent),0 1px 0 #ffffff5c inset;
}

.channel-actions .record.active {
  border-color: color-mix(in srgb,var(--mixer-record) 72%,white);
  color: #fff;
  background: var(--mixer-record);
  box-shadow: 0 0 8px color-mix(in srgb,var(--mixer-record) 46%,transparent),0 1px 0 #ffffff40 inset;
}

.channel-actions .monitor:disabled {
  border-color: color-mix(in srgb,var(--mixer-input) 45%,var(--line-strong));
  color: var(--mixer-input);
  background: color-mix(in srgb,var(--mixer-input) 10%,var(--daw-control));
  cursor: not-allowed;
  opacity: .78;
}

.channel-name {
  display: grid;
  grid-template-columns: 4px minmax(0, 1fr) auto;
  align-items: center;
  gap: 7px;
  padding: 0 8px;
  border: 0;
  border-top: 1px solid var(--line-strong);
  color: var(--text-primary);
  background: var(--daw-control);
  text-align: left;
  cursor: pointer;
}

.channel-name i {
  align-self: stretch;
  margin: 6px 0;
  border-radius: 1px;
}

.channel-name-editor {
  min-width: 0;
  font-size: 9px;
  font-weight: 700;
}

.channel-name small {
  color: var(--text-muted);
  font: 6px var(--font-utility);
  text-transform: uppercase;
}

.channel-strip.dock {
  grid-template-rows: 31px 59px minmax(88px, 1fr) 53px 34px;
  flex-basis: 104px;
  min-width: 104px;
}

.dock .routing-summary span {
  display: none;
}

.dock .pan-control {
  padding: 5px 7px;
}

.dock .strip-core {
  grid-template-columns: minmax(0, 1fr) 35px;
  gap: 5px;
  padding: 7px;
}

.dock .channel-actions {
  grid-template-rows: 18px 22px;
  gap: 3px;
}

.dock .input-actions button {
  width: 19px;
  height: 17px;
}

.dock .input-actions {
  margin-right: 7px;
}

.dock .mix-actions button {
  width: 30px;
  height: 22px;
}

.channel-actions button:focus-visible,
.routing-summary select:focus-visible,
.fader .parameter-value:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: -1px;
}
</style>
