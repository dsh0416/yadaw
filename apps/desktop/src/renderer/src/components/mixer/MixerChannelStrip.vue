<script setup lang="ts">
import { computed } from "vue"
import { CircleDot, RadioTower } from "@lucide/vue"
import type {
  MixerChannelMeter,
  MixerChannelPatch,
  MixerChannelState,
  MixerParameterPreview,
  MixerSendState
} from "@yadaw/contracts"
import { useParameterGesture } from "../../composables/useParameterGesture"

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

const panGesture = useParameterGesture({
  currentValue: () => props.channel.pan,
  preview: (value) => preview("pan", value),
  commit: (value) => emit("updateChannel", props.channel.id, { pan: value })
})
const gainGesture = useParameterGesture({
  currentValue: () => props.channel.gainDb,
  preview: (value) => preview("gainDb", value),
  commit: (value) => emit("updateChannel", props.channel.id, { gainDb: value })
})
</script>

<template>
  <article
    :class="['channel-strip', density, channel.kind, { selected }]"
    :aria-label="`${channel.name} ${channel.kind} channel`"
    @pointerdown="emit('select', channel.id)"
  >
    <button class="channel-name" :title="channel.name" @click="emit('select', channel.id)">
      <i :style="{ backgroundColor: channel.color }" />
      <span>{{ channel.name }}</span>
      <small>{{ channel.channelFormat }}</small>
    </button>

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

    <label class="pan-control">
      <span>
        PAN
        <input
          class="parameter-value"
          type="number"
          min="-1"
          max="1"
          step="0.01"
          :value="channel.pan"
          :aria-label="`${channel.name} pan value`"
          @change="panGesture.reset(Number(($event.target as HTMLInputElement).value))"
        >
      </span>
      <input
        type="range"
        min="-1"
        max="1"
        step="0.01"
        :value="channel.pan"
        :aria-label="`${channel.name} pan`"
        @pointerdown="panGesture.begin"
        @input="panGesture.preview"
        @change="panGesture.commit"
        @keydown="panGesture.keydown"
        @dblclick="panGesture.reset(0)"
      >
    </label>

    <div class="strip-core">
      <div class="meter" :class="{ clipped: meter.clipped }" :style="meterStyle" aria-hidden="true">
        <span /><span />
      </div>
      <label class="fader">
        <input
          type="range"
          min="-90"
          max="12"
          step="0.1"
          :value="channel.gainDb"
          :aria-label="`${channel.name} volume`"
          @pointerdown="gainGesture.begin"
          @input="gainGesture.preview"
          @change="gainGesture.commit"
          @keydown="gainGesture.keydown"
          @dblclick="gainGesture.reset(0)"
        >
        <input
          class="parameter-value"
          type="number"
          min="-90"
          max="12"
          step="0.1"
          :value="channel.gainDb"
          :aria-label="`${channel.name} volume value in decibels`"
          :title="gainLabel"
          @change="gainGesture.reset(Number(($event.target as HTMLInputElement).value))"
        >
      </label>
    </div>

    <div class="channel-actions">
      <button
        :class="{ active: channel.muted }"
        :aria-pressed="channel.muted"
        :aria-label="`Mute ${channel.name}`"
        @click.stop="emit('updateChannel', channel.id, { muted: !channel.muted })"
      >M</button>
      <button
        :class="{ active: channel.soloed }"
        :aria-pressed="channel.soloed"
        :aria-label="`Solo ${channel.name}`"
        @click.stop="emit('updateChannel', channel.id, { soloed: !channel.soloed })"
      >S</button>
      <button
        v-if="channel.kind === 'audio'"
        :class="['arm', { active: channel.recordArmed }]"
        :aria-pressed="channel.recordArmed"
        :aria-label="`Arm ${channel.name}`"
        @click.stop="emit('updateChannel', channel.id, { recordArmed: !channel.recordArmed })"
      ><CircleDot :size="12" /></button>
    </div>
  </article>
</template>

<style scoped>
.channel-strip{position:relative;display:grid;grid-template-rows:39px 39px 52px minmax(120px,1fr) 38px;flex:0 0 112px;min-width:112px;height:100%;border-right:1px solid #263043;background:linear-gradient(180deg,#151c29,#0d131d);box-shadow:1px 0 0 #ffffff05 inset;overflow:hidden}.channel-strip::before{content:"";position:absolute;z-index:2;top:0;right:0;left:0;height:2px;background:var(--strip-color,#8c83ff);opacity:.8}.channel-strip.bus{--strip-color:#e8b85f;background:linear-gradient(180deg,#1d1b21,#11141b)}.channel-strip.master{--strip-color:#67d9e7;position:sticky;right:0;z-index:5;border-left:1px solid #34415a;background:linear-gradient(180deg,#12232a,#0c171d);box-shadow:-12px 0 22px #04070db8}.channel-strip.selected{background:linear-gradient(180deg,#1d2636,#111827);box-shadow:3px 0 0 var(--strip-color,#8c83ff) inset}.channel-name{display:grid;grid-template-columns:3px minmax(0,1fr) auto;align-items:center;gap:7px;padding:0 8px;border:0;border-bottom:1px solid #242d3d;color:#dfe4ee;background:transparent;text-align:left;cursor:pointer}.channel-name i{align-self:stretch;margin:7px 0;border-radius:2px}.channel-name span{overflow:hidden;font-size:9px;font-weight:700;text-overflow:ellipsis;white-space:nowrap}.channel-name small{color:#68758a;font:6px var(--font-utility);text-transform:uppercase}.routing-summary{display:grid;align-content:center;gap:5px;padding:5px 8px;border-bottom:1px solid #222b39;color:#606d81;font:6px var(--font-utility);letter-spacing:.06em}.routing-summary span{display:flex;align-items:center;gap:4px}.routing-summary select{width:100%;min-height:18px;padding:1px 4px;border:1px solid #303b4e;border-radius:3px;color:#aab5c7;background:#0c111a;font-size:7px}.pan-control{display:grid;align-content:center;gap:5px;padding:6px 8px;border-bottom:1px solid #222b39;color:#657287;font:6px var(--font-utility)}.pan-control span{display:flex;justify-content:space-between}.pan-control b{color:#b9c5d8;font-weight:500}.pan-control input{width:100%;height:3px;accent-color:var(--strip-color,#8c83ff)}.strip-core{display:grid;grid-template-columns:18px minmax(0,1fr);gap:7px;min-height:0;padding:10px 9px}.meter{display:flex;align-self:stretch;gap:2px;padding:2px;border:1px solid #263142;border-radius:3px;background:#070b10}.meter span{position:relative;flex:1;background:linear-gradient(to top,#66d8e7 0 66%,#e8b85f 78%,#ff6577 100%);opacity:.18;overflow:hidden}.meter span::after{content:"";position:absolute;inset:0 0 var(--meter-level) 0;background:#070b10;transition:inset 55ms linear}.meter.clipped{border-color:#ff6577;box-shadow:0 0 8px #ff65774d}.fader{display:grid;grid-template-rows:minmax(0,1fr) 18px;justify-items:center;min-height:0}.fader input{width:100%;height:100%;margin:0;appearance:slider-vertical;writing-mode:vertical-lr;direction:rtl;accent-color:var(--strip-color,#8c83ff)}.fader span{align-self:end;color:#aab5c7;font:7px var(--font-utility)}.channel-actions{display:flex;align-items:center;justify-content:center;gap:4px;border-top:1px solid #242d3d}.channel-actions button{display:grid;place-items:center;width:27px;height:22px;padding:0;border:1px solid #303a4d;border-radius:3px;color:#6f7c91;background:#121925;font:700 8px var(--font-utility);cursor:pointer}.channel-actions button.active{border-color:#8d84ef;color:#fff;background:#4b468e}.channel-actions .arm.active{border-color:#ff6577;background:#752b3b;box-shadow:0 0 8px #ff65774d}.channel-strip.dock{grid-template-rows:35px 31px 40px minmax(88px,1fr) 34px;flex-basis:98px;min-width:98px}.dock .routing-summary span{display:none}.dock .strip-core{padding:7px}.channel-name:focus-visible,.channel-actions button:focus-visible,.routing-summary select:focus-visible,.pan-control input:focus-visible,.fader input:focus-visible{outline:2px solid var(--focus);outline-offset:-1px}
</style>

<style scoped>
.parameter-value{border:1px solid #303b4e;border-radius:3px;color:#b9c5d8;background:#0c111a;font:7px var(--font-utility);text-align:right}
.pan-control .parameter-value{width:43px;height:18px;padding:0 3px}
.fader .parameter-value{width:49px;height:18px;margin:0;padding:0 3px;writing-mode:horizontal-tb;direction:ltr;accent-color:auto}
</style>
