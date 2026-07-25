<script setup lang="ts">
import { computed } from "vue"
import { RadioTower } from "@lucide/vue"
import type {
  MixerChannelMeter,
  MixerChannelPatch,
  MixerChannelState,
  MixerParameterPreview,
  MixerSendState
} from "@yadaw/contracts"
import { useParameterGesture } from "../../composables/useParameterGesture"
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
}>()

const gainLabel = computed(() =>
  props.channel.gainDb <= -90 ? "−∞" : `${props.channel.gainDb.toFixed(1)} dB`
)
const livePeakDb = computed(() => {
  const peak = Math.max(...props.meter.postFaderPeak)
  return peak > 0 ? 20 * Math.log10(peak) : Number.NEGATIVE_INFINITY
})
const livePeakLabel = computed(() =>
  Number.isFinite(livePeakDb.value) ? livePeakDb.value.toFixed(1) : "−∞"
)
const livePeakState = computed(() => ({
  active: Number.isFinite(livePeakDb.value),
  hot: livePeakDb.value >= -6,
  clipped: props.meter.clipped
}))
const meterStyle = computed(() => {
  const value = Math.max(
    ...props.meter.preFaderPeak,
    ...props.meter.postFaderPeak
  )
  const db = value > 0 ? 20 * Math.log10(value) : -60
  return { "--meter-level": `${Math.min(100, Math.max(0, (db + 60) / 60 * 100))}%` }
})

function preview(parameter: "gainDb" | "pan", value: number): void {
  emit("preview", {
    target: "channel",
    id: props.channel.id,
    parameter,
    value
  })
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
    :aria-label="`${channel.name} ${channel.kind} channel`"
    @pointerdown="emit('select', channel.id)"
  >
    <div class="routing-summary">
      <span><RadioTower :size="10" />{{ sends.length }} SEND{{ sends.length === 1 ? "" : "S" }}</span>
      <select
        v-if="channel.kind !== 'master'"
        :value="channel.outputChannelId ?? ''"
        :aria-label="`${channel.name} output`"
        @change="emit('updateChannel', channel.id, { outputChannelId: ($event.target as HTMLSelectElement).value })"
      >
        <option v-for="output in outputs" :key="output.id" :value="output.id">{{ output.name }}</option>
      </select>
      <span v-else>DEVICE OUT</span>
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
      <output
        :class="['live-meter-value', livePeakState]"
        :aria-label="`${channel.name} live post-fader level in decibels`"
        :title="`Live post-fader peak: ${livePeakLabel} dB`"
      >{{ livePeakLabel }}</output>
      <label class="fader">
        <input
          type="range"
          min="-90"
          max="12"
          step="0.1"
          :value="channel.gainDb"
          :aria-label="`${channel.name} volume`"
          @pointerdown="beginFaderGesture"
          @input="gainGesture.preview"
          @change="gainGesture.commit"
          @keydown="gainGesture.keydown"
          @dblclick="gainGesture.reset(0)"
        >
      </label>
      <div class="meter" :class="{ clipped: meter.clipped }" :style="meterStyle" aria-hidden="true">
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
      <small>{{ channel.channelFormat }}</small>
    </div>
  </article>
</template>

<style scoped>
.channel-strip {
  --strip-color: #8c83ff;
  position: relative;
  display: grid;
  grid-template-rows: 39px 72px minmax(120px, 1fr) 61px 38px;
  flex: 0 0 116px;
  min-width: 116px;
  height: 100%;
  overflow: hidden;
  border-right: 1px solid #20252d;
  background: linear-gradient(180deg, #242a32, #171b21 70%, #13171c);
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
  --strip-color: #d7a84f;
  background: linear-gradient(180deg, #29282b, #19191d 70%, #151519);
}

.channel-strip.master {
  --strip-color: #67d9e7;
  position: sticky;
  right: 0;
  z-index: 5;
  border-left: 1px solid #36404a;
  background: linear-gradient(180deg, #273034, #182125 70%, #141b1e);
  box-shadow: -12px 0 22px #04070db8;
}

.channel-strip.selected {
  background: linear-gradient(180deg, #303740, #20262d 72%, #191e24);
  box-shadow: 3px 0 0 var(--strip-color) inset;
}

.routing-summary {
  display: grid;
  align-content: center;
  gap: 5px;
  padding: 5px 8px;
  border-bottom: 1px solid #171b20;
  color: #7d8691;
  background: #1a1f25a8;
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
  border: 1px solid #343b43;
  border-radius: 2px;
  color: #b6bdc5;
  background: #171b20;
  font-size: 7px;
}

.pan-control {
  padding: 7px 10px 8px;
  border-bottom: 1px solid #171b20;
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
  display: flex;
  grid-column: 2;
  grid-row: 2;
  align-self: stretch;
  justify-self: center;
  width: 18px;
  gap: 2px;
  padding: 2px;
  border: 1px solid #303741;
  border-radius: 2px;
  background: #0b0e11;
}

.meter span {
  position: relative;
  flex: 1;
  overflow: hidden;
  background: linear-gradient(to top, #50b86d 0 68%, #e4b93f 79%, #e54b58 100%);
  opacity: .26;
}

.meter span::after {
  content: "";
  position: absolute;
  inset: 0 0 var(--meter-level) 0;
  background: #0b0e11;
  transition: inset 55ms linear;
}

.meter.clipped {
  border-color: var(--mixer-record);
  box-shadow: 0 0 8px #e54b584d;
}

.fader {
  display: grid;
  grid-column: 1;
  grid-row: 2;
  justify-items: center;
  min-height: 0;
}

.fader > input:first-child {
  width: 100%;
  height: 100%;
  margin: 0;
  writing-mode: vertical-lr;
  direction: rtl;
  accent-color: #aeb4bb;
}

.fader > input:first-child:focus {
  outline: none;
}

.fader > input:first-child:focus-visible::-webkit-slider-thumb {
  box-shadow: 0 0 0 2px #9c94ff80;
}

.parameter-value {
  grid-column: 1;
  grid-row: 1;
  justify-self: center;
  width: 38px;
  height: 20px;
  margin: 0;
  padding: 0 2px;
  border: 1px solid #343b43;
  border-radius: 2px;
  color: #c8cdd3;
  background: #171b20;
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

.live-meter-value {
  display: grid;
  grid-column: 2;
  grid-row: 1;
  place-items: center;
  width: 35px;
  height: 20px;
  overflow: hidden;
  border: 1px solid #2e353d;
  border-radius: 2px;
  color: #626c76;
  background: #101419;
  font: 8px var(--font-utility);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.live-meter-value.active {
  color: #72d28a;
}

.live-meter-value.hot {
  color: var(--mixer-solo);
}

.live-meter-value.clipped {
  border-color: var(--mixer-record);
  color: #ff7c87;
  background: #2a1519;
}

.channel-actions {
  display: grid;
  grid-template-rows: 20px 24px;
  align-content: center;
  justify-items: center;
  gap: 4px;
  border-top: 1px solid #171b20;
  background: #181c22;
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
  border: 1px solid #3a414a;
  border-radius: 3px;
  color: #8d969f;
  background: linear-gradient(#30363d, #24292f);
  box-shadow: 0 1px 0 #ffffff12 inset, 0 1px 2px #0008;
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
  color: #77bfe2;
}

.channel-actions .solo {
  color: #e7c66c;
}

.channel-actions .record {
  color: #e88791;
}

.channel-actions .monitor {
  color: var(--mixer-input);
}

.channel-actions .mute.active {
  border-color: #66bce5;
  color: #fff;
  background: linear-gradient(#38a9dc, var(--mixer-mute));
  box-shadow: 0 0 8px #2f9ed077, 0 1px 0 #ffffff40 inset;
}

.channel-actions .solo.active {
  border-color: #f1cf66;
  color: #221c08;
  background: linear-gradient(#f0c957, var(--mixer-solo));
  box-shadow: 0 0 8px #e4b93f66, 0 1px 0 #ffffff5c inset;
}

.channel-actions .record.active {
  border-color: #f07a83;
  color: #fff;
  background: linear-gradient(#ef6470, var(--mixer-record));
  box-shadow: 0 0 8px #e54b5877, 0 1px 0 #ffffff40 inset;
}

.channel-actions .monitor:disabled {
  border-color: #684328;
  color: var(--mixer-input);
  background: linear-gradient(#34291f, #282018);
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
  border-top: 1px solid #303740;
  color: #eef1f4;
  background: #20262d;
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
  color: #818a94;
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
