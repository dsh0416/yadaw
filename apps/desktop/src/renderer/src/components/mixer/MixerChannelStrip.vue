<script setup lang="ts">
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import type {
  MixerBusState,
  MixerChannelMeter,
  MixerChannelPatch,
  MixerChannelState,
  MixerParameterPreview,
  MixerRouteTarget,
  MixerSendPatch,
  MixerSendState
} from "@heron/contracts"
import type { PluginDescriptor, PluginInstanceState, PluginRuntimeStatus } from "@heron/contracts"
import {
  pluginAudioModeOutputWidth,
  type PluginSelection,
  type PluginSignalWidth
} from "../plugins/plugin-audio-mode"
import InlineTrackNameEditor from "../InlineTrackNameEditor.vue"
import MixerChannelMenu from "./MixerChannelMenu.vue"
import MixerFaderSection from "./MixerFaderSection.vue"
import MixerInputSection from "./MixerInputSection.vue"
import MixerOutputSection from "./MixerOutputSection.vue"
import MixerPanKnob from "./MixerPanKnob.vue"
import MixerPluginSection from "./MixerPluginSection.vue"
import MixerSendSection from "./MixerSendSection.vue"
import type { MixerStripDisplayOptions } from "./mixer-strip-display-options"

const props = defineProps<{
  channel: MixerChannelState
  sends: MixerSendState[]
  meter?: MixerChannelMeter
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
  lowLatencyTarget?: boolean
  lowLatencyTargetDisabled?: boolean
  displayOptions?: MixerStripDisplayOptions
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
  selectLowLatencyOutput: [channelId: string]
  bounceOutput: [channel: MixerChannelState]
}>()

const { t } = useI18n()

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

function preview(parameter: "gainDb" | "pan", value: number): void {
  emit("preview", {
    target: "channel",
    id: props.channel.id,
    parameter,
    value
  })
}
</script>

<template>
  <article
    :class="['channel-strip', channel.kind, { selected }]"
    :style="{ '--strip-color': channel.color }"
    :aria-label="
      t('mixer.channelStrip.ariaLabel', {
        name: channel.name,
        kind: t(`mixer.channelKind.${channel.kind}`)
      })
    "
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
      :low-latency-target="lowLatencyTarget"
      :low-latency-target-disabled="lowLatencyTargetDisabled"
      @update-channel="emit('updateChannel', channel.id, $event)"
      @select-low-latency-output="emit('selectLowLatencyOutput', channel.id)"
    />

    <section class="placeholder-section" data-section="group">
      <button disabled aria-disabled="true">{{ t("mixer.channelStrip.noGroup") }}</button>
    </section>

    <section class="placeholder-section automation-section" data-section="automation">
      <button disabled aria-disabled="true">{{ t("mixer.channelStrip.read") }}</button>
    </section>

    <MixerPanKnob
      class="pan-control"
      data-section="pan"
      :channel-name="channel.name"
      :value="channel.pan"
      @preview="preview('pan', $event)"
      @commit="emit('updateChannel', channel.id, { pan: $event })"
    />

    <MixerFaderSection
      :channel="channel"
      :meter="meter"
      :display-options="displayOptions"
      @preview="emit('preview', $event)"
      @update-channel="emit('updateChannel', channel.id, $event)"
      @reset-meter-clips="emit('resetMeterClips')"
      @bounce-output="emit('bounceOutput', channel)"
    />

    <div class="channel-name" data-section="name" @click="emit('select', channel.id)">
      <i :style="{ backgroundColor: channel.color }" />
      <InlineTrackNameEditor
        class="channel-name-editor"
        :name="channel.name"
        :label="t('mixer.channelStrip.channelNameLabel', { name: channel.name })"
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
  flex: 0 0 112px;
  min-width: 112px;
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
</style>
