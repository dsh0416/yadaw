<script setup lang="ts">
import { computed, nextTick, shallowRef, useTemplateRef, watch } from "vue"
import { storeToRefs } from "pinia"
import type { MeterPeakHold, MeterReturnRate } from "@yadaw/contracts"
import type {
  MixerBusState,
  MixerChannelMeter,
  MixerChannelPatch,
  MixerChannelState,
  MixerParameterPreview,
  MixerRouteTarget,
  MixerSendPatch,
  MixerSendState
} from "@yadaw/contracts"
import type { PluginDescriptor, PluginInstanceState, PluginRuntimeStatus } from "@yadaw/contracts"
import {
  pluginAudioModeOutputWidth,
  type PluginSelection,
  type PluginSignalWidth
} from "../plugins/plugin-audio-mode"
import { usePeakMeterDisplay } from "../../composables/usePeakMeterDisplay"
import { useParameterGesture } from "../../composables/useParameterGesture"
import { useApplicationSettingsStore } from "../../stores/applicationSettings"
import {
  dbToLevelPercent,
  FADER_MAX_DB,
  FADER_MIN_DB,
  FADER_SCALE_MARKS,
  METER_SCALE_MARKS
} from "../../utils/mixerDbScale"
import InlineTrackNameEditor from "../InlineTrackNameEditor.vue"
import MixerDbScale from "./MixerDbScale.vue"
import MixerChannelMenu from "./MixerChannelMenu.vue"
import MixerInputSection from "./MixerInputSection.vue"
import MixerOutputSection from "./MixerOutputSection.vue"
import MixerPanKnob from "./MixerPanKnob.vue"
import MixerPluginSection from "./MixerPluginSection.vue"
import MixerSendSection from "./MixerSendSection.vue"

const props = defineProps<{
  channel: MixerChannelState
  sends: MixerSendState[]
  meter: MixerChannelMeter
  outputs: MixerChannelState[]
  buses: readonly MixerBusState[]
  outputTargets: MixerRouteTarget[]
  sendTargets: MixerRouteTarget[]
  plugins: PluginInstanceState[]
  pluginRuntime: Record<string, PluginRuntimeStatus>
  effectPlugins: PluginDescriptor[]
  instrumentPlugins: PluginDescriptor[]
  pluginSlotRows: number
  sendSlotRows: number
  selected: boolean
}>()

const emit = defineEmits<{
  select: [channelId: string]
  preview: [preview: MixerParameterPreview]
  updateChannel: [channelId: string, patch: MixerChannelPatch]
  updateSend: [sendId: string, patch: MixerSendPatch]
  addSend: [sourceChannelId: string, target: MixerRouteTarget]
  deleteSend: [sendId: string]
  openPlugin: [instanceId: string]
  togglePlugin: [instanceId: string, enabled: boolean]
  removePlugin: [instanceId: string]
  insertPlugin: [channelId: string, selection: PluginSelection, slotOrder: number]
  movePlugin: [instanceId: string, channelId: string, slotOrder: number]
  assignInstrument: [channelId: string, selection: PluginSelection]
  deleteChannel: [channelId: string]
  resetMeterClips: []
}>()

const settingsStore = useApplicationSettingsStore()
const { settings } = storeToRefs(settingsStore)
const meter = computed(() => props.meter)
const peakHold = computed<MeterPeakHold>(() => settings.value?.meterPeakHold ?? "800ms")
const returnRate = computed<MeterReturnRate>(() => settings.value?.meterReturnRate ?? "iec-type-i")
const meterDisplay = usePeakMeterDisplay({
  meter,
  peakHold,
  returnRate
})
const instrument = computed(
  () => props.plugins.find((plugin) => plugin.role === "instrument") ?? null
)
const inserts = computed(() => props.plugins.filter((plugin) => plugin.role === "insert"))
const insertInitialInputWidth = computed<PluginSignalWidth>(() => {
  if (instrument.value) return pluginAudioModeOutputWidth(instrument.value.audioMode)
  return props.channel.kind !== "instrument" && props.channel.inputChannels.length === 1
    ? "mono"
    : "stereo"
})

const gainLabel = computed(() =>
  props.channel.gainDb <= -90 ? "−∞" : `${props.channel.gainDb.toFixed(1)} dB`
)
const gainReadoutLabel = computed(() =>
  props.channel.gainDb <= -90 ? "−∞" : props.channel.gainDb.toFixed(1)
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
const monitoringAvailable = computed(
  () =>
    settings.value?.softwareMonitoringEnabled === true &&
    props.channel.kind === "audio" &&
    props.channel.inputSource === "hardware"
)
const monitoringActive = computed(() => monitoringAvailable.value && props.channel.inputMonitoring)
const meterStyle = computed(() => ({
  "--meter-level": `${meterDisplay.meterLevelPercent.value}%`,
  "--held-meter-level": `${meterDisplay.heldMeterLevelPercent.value}%`
}))
const faderStyle = computed(() => ({
  "--fader-level": `${dbToLevelPercent(props.channel.gainDb, FADER_MIN_DB, FADER_MAX_DB)}%`
}))
const gainInputValue = shallowRef(String(props.channel.gainDb))
const gainInputEditing = shallowRef(false)
const faderTooltipVisible = shallowRef(false)
const gainInput = useTemplateRef<HTMLInputElement>("gainInput")

watch(
  () => props.channel.gainDb,
  (value) => {
    if (!gainInputEditing.value) gainInputValue.value = String(value)
  }
)

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

async function beginGainInputEdit(): Promise<void> {
  gainInputEditing.value = true
  gainInputValue.value = String(props.channel.gainDb)
  await nextTick()
  gainInput.value?.focus()
  gainInput.value?.select()
}

function updateGainInputValue(event: Event): void {
  gainInputEditing.value = true
  gainInputValue.value = (event.currentTarget as HTMLInputElement).value
}

function finishGainInputEdit(): void {
  if (!gainInputEditing.value) return
  gainInputEditing.value = false
  gainInputValue.value = String(props.channel.gainDb)
}

function commitGainInputValue(event: Event): void {
  const input = event.currentTarget as HTMLInputElement
  const value = Number(input.value)

  if (input.value.trim() === "" || !Number.isFinite(value)) {
    finishGainInputEdit()
    input.value = gainInputValue.value
    return
  }

  const clampedValue = Math.max(FADER_MIN_DB, Math.min(FADER_MAX_DB, value))
  gainInputValue.value = String(clampedValue)
  preview("gainDb", clampedValue)
  gainInputEditing.value = false
  gainGesture.reset(clampedValue)
}

function cancelGainInputEdit(event: KeyboardEvent): void {
  if (event.key !== "Escape") return
  event.preventDefault()
  event.stopPropagation()
  const input = event.currentTarget as HTMLInputElement
  gainInputValue.value = String(props.channel.gainDb)
  gainInputEditing.value = false
  input.value = gainInputValue.value
  input.blur()
}

function submitGainInput(event: KeyboardEvent): void {
  if (event.key !== "Enter") return
  event.preventDefault()
  ;(event.currentTarget as HTMLInputElement).blur()
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
  faderTooltipVisible.value = true
}

function previewFaderGesture(event: Event): void {
  faderTooltipVisible.value = true
  gainGesture.preview(event)
}

function commitFaderGesture(event: Event): void {
  gainGesture.commit(event)
  faderTooltipVisible.value = false
}

function handleFaderKeydown(event: KeyboardEvent): void {
  gainGesture.keydown(event)
  if (event.key === "Escape") faderTooltipVisible.value = false
}
</script>

<template>
  <article
    :class="['channel-strip', channel.kind, { selected }]"
    :style="{ '--strip-color': channel.color }"
    :aria-label="`${channel.name} ${channel.kind} channel`"
    @pointerdown="emit('select', channel.id)"
  >
    <MixerInputSection
      :channel="channel"
      :instrument="instrument"
      :plugin-runtime="pluginRuntime"
      :instrument-plugins="instrumentPlugins"
      @update-channel="emit('updateChannel', channel.id, $event)"
      @open-plugin="emit('openPlugin', $event)"
      @remove-plugin="emit('removePlugin', $event)"
      @assign-instrument="emit('assignInstrument', channel.id, $event)"
    />

    <MixerPluginSection
      :channel="channel"
      :inserts="inserts"
      :runtime="pluginRuntime"
      :effect-plugins="effectPlugins"
      :slot-rows="pluginSlotRows"
      :initial-input-width="insertInitialInputWidth"
      @open="emit('openPlugin', $event)"
      @toggle="(id, enabled) => emit('togglePlugin', id, enabled)"
      @remove="emit('removePlugin', $event)"
      @insert="(selection, slotOrder) => emit('insertPlugin', channel.id, selection, slotOrder)"
      @move="(instanceId, slotOrder) => emit('movePlugin', instanceId, channel.id, slotOrder)"
    />

    <MixerSendSection
      :channel="channel"
      :sends="sends"
      :buses="buses"
      :outputs="outputs"
      :send-targets="sendTargets"
      :slot-rows="sendSlotRows"
      @preview="emit('preview', $event)"
      @update-send="(sendId, patch) => emit('updateSend', sendId, patch)"
      @add-send="emit('addSend', channel.id, $event)"
      @delete-send="emit('deleteSend', $event)"
    />

    <MixerOutputSection
      :channel="channel"
      :buses="buses"
      :outputs="outputs"
      :targets="outputTargets"
      @update-channel="emit('updateChannel', channel.id, $event)"
    />

    <section class="placeholder-section" data-section="group">
      <button disabled aria-disabled="true">No Group</button>
    </section>

    <section class="placeholder-section automation-section" data-section="automation">
      <button disabled aria-disabled="true">Read</button>
    </section>

    <MixerPanKnob
      class="pan-control"
      data-section="pan"
      :channel-name="channel.name"
      :value="channel.pan"
      @preview="preview('pan', $event)"
      @commit="emit('updateChannel', channel.id, { pan: $event })"
    />

    <section class="volume-section" data-section="volume">
      <div class="strip-core">
        <button
          v-if="!gainInputEditing"
          type="button"
          class="parameter-value parameter-value-button"
          :aria-label="`${channel.name} volume value in decibels`"
          :title="`Fader: ${gainLabel} · Double-click to edit`"
          @pointerdown.stop
          @dblclick.stop.prevent="beginGainInputEdit"
        >
          {{ gainReadoutLabel }}
        </button>
        <input
          v-else
          ref="gainInput"
          class="parameter-value"
          type="number"
          :min="FADER_MIN_DB"
          :max="FADER_MAX_DB"
          step="0.1"
          :value="gainInputValue"
          :aria-label="`${channel.name} volume value in decibels`"
          :title="`Fader: ${gainLabel}`"
          @input="updateGainInputValue"
          @change="commitGainInputValue"
          @blur="finishGainInputEdit"
          @keydown="cancelGainInputEdit"
          @keydown.enter="submitGainInput"
        />
        <button
          type="button"
          :class="['maximum-peak-value', maximumPeakState]"
          :aria-label="`${channel.name} latched maximum post-fader level in decibels`"
          :title="`Maximum post-fader peak: ${maximumPeakLabel} dB · Click to reset peak and clipping`"
          @pointerdown.stop
          @click.stop="resetMaximumPeak"
        >
          {{ maximumPeakLabel }}
        </button>
        <label class="fader" :style="faderStyle">
          <MixerDbScale class="fader-scale" :marks="FADER_SCALE_MARKS" side="left" />
          <input
            class="fader-control"
            type="range"
            :min="FADER_MIN_DB"
            :max="FADER_MAX_DB"
            step="0.1"
            :value="channel.gainDb"
            :aria-label="`${channel.name} volume`"
            @pointerdown="beginFaderGesture"
            @input="previewFaderGesture"
            @change="commitFaderGesture"
            @blur="faderTooltipVisible = false"
            @keydown="handleFaderKeydown"
            @dblclick.prevent="gainGesture.reset(0)"
          />
          <output v-if="faderTooltipVisible" class="fader-tooltip" aria-hidden="true">
            {{ gainLabel }}
          </output>
        </label>
        <div class="meter-rack">
          <MixerDbScale class="meter-scale" :marks="METER_SCALE_MARKS" side="left" />
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
            >
              R
            </button>
            <button
              :class="['monitor', { active: monitoringActive }]"
              :aria-label="`Monitor ${channel.name}`"
              :aria-pressed="channel.inputMonitoring"
              :title="
                monitoringAvailable
                  ? 'Input monitoring'
                  : 'Enable software monitoring and select a hardware input first'
              "
              :disabled="!monitoringAvailable"
              @click.stop="
                emit('updateChannel', channel.id, {
                  inputMonitoring: !channel.inputMonitoring
                })
              "
            >
              I
            </button>
          </template>
        </div>
        <div class="mix-actions">
          <button
            :class="['mute', { active: channel.muted }]"
            :aria-pressed="channel.muted"
            :aria-label="`Mute ${channel.name}`"
            @click.stop="emit('updateChannel', channel.id, { muted: !channel.muted })"
          >
            M
          </button>
          <button
            v-if="channel.kind !== 'master'"
            :class="['solo', { active: channel.soloed }]"
            :aria-pressed="channel.soloed"
            :aria-label="`Solo ${channel.name}`"
            @click.stop="emit('updateChannel', channel.id, { soloed: !channel.soloed })"
          >
            S
          </button>
        </div>
      </div>
    </section>

    <div class="channel-name" data-section="name" @click="emit('select', channel.id)">
      <i :style="{ backgroundColor: channel.color }" />
      <InlineTrackNameEditor
        class="channel-name-editor"
        :name="channel.name"
        :label="`${channel.name} channel name; double-click to rename`"
        @rename="emit('updateChannel', channel.id, { name: $event })"
      />
      <MixerChannelMenu
        :channel-name="channel.name"
        :color="channel.color"
        :deletable="channel.kind !== 'master' && channel.systemRole === null"
        @update-color="emit('updateChannel', channel.id, { color: $event })"
        @delete="emit('deleteChannel', channel.id)"
      />
    </div>
  </article>
</template>

<style scoped>
.channel-strip {
  --strip-color: var(--accent);
  position: relative;
  display: grid;
  grid-template-rows:
    54px var(--plugin-section-height) var(--send-section-height) 44px 34px 34px 78px
    282px 40px;
  flex: 0 0 136px;
  min-width: 136px;
  height: max-content;
  overflow: hidden;
  border-right: 1px solid var(--ui-domain-color-303030);
  background: var(--ui-domain-color-575757);
  box-shadow: 1px 0 0 var(--ui-domain-color-ffffff0c) inset;
}

.channel-strip::before {
  content: "";
  position: absolute;
  z-index: var(--ui-z-local-raised);
  top: 0;
  right: 0;
  left: 0;
  height: 2px;
  background: var(--strip-color);
  opacity: 0.75;
}

.channel-strip.aux {
  background: var(--ui-domain-color-53575a);
}

.channel-strip.master {
  position: sticky;
  right: 0;
  z-index: var(--ui-z-local-sticky);
  border-left: 1px solid var(--ui-domain-color-2e2e2e);
  background: var(--ui-domain-color-505050);
  box-shadow: -12px 0 22px var(--ui-domain-color-0000005c);
}

.channel-strip.selected {
  background: var(--ui-domain-color-626262);
  box-shadow: 3px 0 0 var(--strip-color) inset;
}

.placeholder-section {
  display: grid;
  align-items: center;
  padding: 4px 7px;
  border-bottom: 1px solid var(--ui-domain-color-444);
  background: var(--ui-domain-color-575757);
}

.placeholder-section button {
  width: 100%;
  height: 25px;
  border: 1px solid var(--ui-domain-color-6b6b6b);
  border-radius: 4px;
  color: var(--ui-domain-color-bcbcbc);
  background: linear-gradient(var(--ui-domain-color-666), var(--ui-domain-color-595959));
  font-size: var(--ui-type-size-control);
}

.automation-section button {
  color: var(--ui-domain-color-81ed8b);
  text-shadow: 0 0 5px var(--ui-domain-color-5fe66b5c);
}

.pan-control {
  padding: 8px 12px;
  border-bottom: 1px solid var(--ui-domain-color-444);
  background: var(--ui-domain-color-565656);
}

.volume-section {
  display: grid;
  grid-template-rows: 221px 61px;
  min-height: 0;
  border-bottom: 1px solid var(--ui-domain-color-444);
  background: var(--ui-domain-color-555);
}

.strip-core {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 39px;
  grid-template-rows: 20px minmax(0, 1fr);
  column-gap: 4px;
  row-gap: 6px;
  min-height: 0;
  padding: 9px 10px 7px;
}

.meter-rack {
  display: grid;
  grid-column: 2;
  grid-row: 2;
  grid-template-columns: 18px 18px;
  align-self: stretch;
  justify-self: center;
  gap: 2px;
  margin-block: 8px;
  min-height: 0;
}

.meter {
  position: relative;
  display: flex;
  align-self: stretch;
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
  z-index: var(--ui-z-local-raised);
  right: 2px;
  bottom: var(--held-meter-level);
  left: 2px;
  height: 1px;
  background: var(--meter-yellow);
  box-shadow: 0 0 2px color-mix(in srgb, var(--meter-yellow) 65%, transparent);
  opacity: 0;
}

.meter.has-held-peak::after {
  opacity: 0.9;
}

.meter span {
  position: relative;
  flex: 1;
  overflow: hidden;
  background: linear-gradient(
    to top,
    var(--meter-green) 0 68%,
    var(--meter-yellow) 79%,
    var(--meter-red) 100%
  );
  opacity: 0.26;
}

.meter span::after {
  content: "";
  position: absolute;
  inset: 0 0 var(--meter-level) 0;
  background: var(--daw-meter-well);
}

.meter.clipped {
  border-color: var(--mixer-record);
  box-shadow: 0 0 8px color-mix(in srgb, var(--mixer-record) 35%, transparent);
}

.fader {
  --fader-level: 0%;
  position: relative;
  display: grid;
  grid-column: 1;
  grid-row: 2;
  grid-template-columns: 18px minmax(0, 1fr);
  gap: 1px;
  margin-block: 8px;
  min-height: 0;
}

.fader::after {
  position: absolute;
  z-index: var(--ui-z-local-base);
  top: 0;
  bottom: 0;
  left: calc(50% + 9.5px);
  width: 4px;
  border: 1px solid var(--line-strong);
  background: linear-gradient(
    to top,
    var(--accent) 0 var(--fader-level),
    var(--daw-meter-well) var(--fader-level) 100%
  );
  box-shadow: 0 0 0 1px var(--ui-domain-color-0006) inset;
  content: "";
  transform: translateX(-50%);
}

.fader-control {
  position: relative;
  z-index: var(--ui-z-local-content);
  width: 100%;
  height: calc(100% + 16px);
  margin: -8px 0;
  appearance: none;
  background: transparent;
  writing-mode: vertical-lr;
  direction: rtl;
  cursor: ns-resize;
}

.fader-control::-webkit-slider-runnable-track {
  width: 4px;
  height: 100%;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
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
  box-shadow:
    0 1px 3px var(--ui-domain-color-0009),
    0 0 0 1px var(--surface-1);
  cursor: ns-resize;
}

.fader-control::-moz-range-track {
  width: 4px;
  height: 100%;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}

.fader-control::-moz-range-progress {
  width: 4px;
  background: transparent;
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
  box-shadow:
    0 1px 3px var(--ui-domain-color-0009),
    0 0 0 1px var(--surface-1);
  cursor: ns-resize;
}

.fader-control:focus {
  outline: none;
}

.fader-control:focus-visible::-webkit-slider-thumb,
.fader-control:focus-visible::-moz-range-thumb {
  border-color: var(--focus);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--focus) 50%, transparent);
}

.fader-tooltip {
  position: absolute;
  z-index: var(--ui-z-local-controls);
  bottom: -5px;
  left: calc(50% + 9.5px);
  min-width: 38px;
  padding: 3px 5px;
  border: 1px solid var(--line-strong);
  border-radius: 3px;
  color: var(--text-primary);
  background: var(--surface-3);
  box-shadow: 0 4px 10px var(--shadow);
  font: var(--ui-type-size-caption) var(--ui-type-family-data);
  text-align: center;
  transform: translate(-50%, 100%);
  white-space: nowrap;
}

.fader-tooltip::before {
  position: absolute;
  bottom: 100%;
  left: 50%;
  border: 3px solid transparent;
  border-bottom-color: var(--line-strong);
  content: "";
  transform: translateX(-50%);
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
  font: var(--ui-type-size-control) var(--ui-type-family-data);
  text-align: center;
  writing-mode: horizontal-tb;
  direction: ltr;
  appearance: textfield;
}

.parameter-value-button {
  cursor: text;
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
  width: 39px;
  height: 20px;
  overflow: hidden;
  border: 1px solid var(--line-strong);
  border-radius: 2px;
  color: var(--text-faint);
  background: var(--daw-meter-well);
  font: var(--ui-type-size-control) var(--ui-type-family-data);
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
  background: color-mix(in srgb, var(--record) 14%, var(--daw-meter-well));
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
  border-top: 1px solid var(--ui-domain-color-444);
  background: var(--ui-domain-color-525252);
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
  box-shadow:
    0 1px 0 var(--ui-domain-color-ffffff12) inset,
    0 1px 2px var(--shadow);
  font: var(--ui-type-weight-bold) var(--ui-type-size-body-compact) var(--ui-type-family-data);
  cursor: pointer;
}

.input-actions button {
  width: 21px;
  height: 19px;
  border-radius: 0;
  font-size: var(--ui-type-size-control);
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
  color: color-mix(in srgb, var(--mixer-mute) 76%, var(--text-secondary));
}

.channel-actions .solo {
  color: color-mix(in srgb, var(--mixer-solo) 78%, var(--text-secondary));
}

.channel-actions .record {
  color: color-mix(in srgb, var(--mixer-record) 76%, var(--text-secondary));
}

.channel-actions .monitor {
  color: var(--mixer-input);
}

.channel-actions .mute.active {
  border-color: color-mix(in srgb, var(--mixer-mute) 72%, white);
  color: var(--ui-domain-color-fff);
  background: var(--mixer-mute);
  box-shadow:
    0 0 8px color-mix(in srgb, var(--mixer-mute) 46%, transparent),
    0 1px 0 var(--ui-domain-color-ffffff40) inset;
}

.channel-actions .solo.active {
  border-color: color-mix(in srgb, var(--mixer-solo) 72%, white);
  color: var(--ui-domain-color-221c08);
  background: var(--mixer-solo);
  box-shadow:
    0 0 8px color-mix(in srgb, var(--mixer-solo) 40%, transparent),
    0 1px 0 var(--ui-domain-color-ffffff5c) inset;
}

.channel-actions .record.active {
  border-color: color-mix(in srgb, var(--mixer-record) 72%, white);
  color: var(--ui-domain-color-fff);
  background: var(--mixer-record);
  box-shadow:
    0 0 8px color-mix(in srgb, var(--mixer-record) 46%, transparent),
    0 1px 0 var(--ui-domain-color-ffffff40) inset;
}

.channel-actions .monitor.active {
  border-color: color-mix(in srgb, var(--mixer-input) 72%, white);
  color: var(--ui-domain-color-221c08);
  background: var(--mixer-input);
  box-shadow:
    0 0 8px color-mix(in srgb, var(--mixer-input) 44%, transparent),
    0 1px 0 var(--ui-domain-color-ffffff5c) inset;
}

.channel-actions .monitor:disabled {
  border-color: color-mix(in srgb, var(--mixer-input) 45%, var(--line-strong));
  color: var(--mixer-input);
  background: color-mix(in srgb, var(--mixer-input) 10%, var(--daw-control));
  cursor: not-allowed;
  opacity: 0.78;
}

.channel-name {
  display: grid;
  grid-template-columns: 4px minmax(0, 1fr) auto;
  align-items: center;
  gap: 7px;
  padding: 0 6px;
  border: 0;
  border-top: 1px solid var(--line-strong);
  color: var(--text-primary);
  background: color-mix(in srgb, var(--strip-color) 72%, var(--ui-domain-color-484848));
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
  font-size: var(--ui-type-size-body-compact);
  font-weight: var(--ui-type-weight-bold);
}

.channel-actions button:focus-visible,
.parameter-value:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: -1px;
}
</style>
