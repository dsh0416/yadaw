<script setup lang="ts">
import { useData } from "vitepress"
import { computed, shallowRef, watchEffect } from "vue"
import { useI18n } from "vue-i18n"
import type {
  MixerBusState,
  MixerChannelMeter,
  MixerChannelPatch,
  MixerChannelState,
  MixerParameterPreview,
  MixerRouteTarget,
  MixerSendPatch,
  MixerSendState,
  PluginDescriptor,
  PluginInstanceState
} from "@heron/contracts"
import MixerChannelStrip from "../../../../../apps/desktop/src/renderer/src/components/mixer/MixerChannelStrip.vue"

const props = defineProps<{
  channel: MixerChannelState
  sends: MixerSendState[]
}>()

const emit = defineEmits<{
  preview: [preview: MixerParameterPreview]
  updateChannel: [patch: MixerChannelPatch]
  updateSend: [sendId: string, patch: MixerSendPatch]
  addSend: [target: MixerRouteTarget]
  deleteSend: [sendId: string]
}>()

const buses: readonly MixerBusState[] = [
  { channel: 1, name: "BUS 1 · Reverb" },
  { channel: 2, name: "BUS 2 · Music" }
]

const output: MixerChannelState = {
  id: "manual-output-1-2",
  kind: "output",
  systemRole: null,
  name: "Output 1–2",
  color: "#72c3c7",
  sortOrder: 0,
  inputSource: null,
  inputFormat: null,
  gainDb: 0,
  pan: 0,
  muted: false,
  soloed: false,
  outputChannelId: null,
  outputBus: null,
  recordArmed: false,
  inputMonitoring: false,
  inputChannels: [],
  hardwareOutputChannels: [1, 2]
}

const compressorDescriptor: PluginDescriptor = {
  source: { kind: "builtin", id: "manual-compressor" },
  classId: "manual-compressor",
  modulePath: "",
  name: "Compressor",
  vendor: "Heron",
  version: "1.0",
  categories: ["Fx", "Dynamics"],
  kind: "effect",
  supportedAudioModes: ["mono", "mono-to-stereo", "stereo"],
  architecture: "portable",
  buses: [],
  hasEditor: false,
  compatibility: "compatible",
  compatibilityReason: null
}

const plugins = shallowRef<PluginInstanceState[]>([
  {
    id: "manual-compressor-instance",
    channelId: props.channel.id,
    role: "insert",
    slotOrder: 0,
    classId: compressorDescriptor.classId,
    descriptor: compressorDescriptor,
    audioMode: "stereo",
    enabled: true,
    componentState: new Uint8Array(),
    controllerState: new Uint8Array()
  }
])

const meter = computed<MixerChannelMeter>(() => {
  const gain = Math.max(0.08, Math.min(0.82, 0.62 * 10 ** (props.channel.gainDb / 20)))
  const panLeft = props.channel.pan > 0 ? 1 - props.channel.pan * 0.45 : 1
  const panRight = props.channel.pan < 0 ? 1 + props.channel.pan * 0.45 : 1
  return {
    channelId: props.channel.id,
    preFaderPeak: [0.62, 0.58],
    postFaderPeak: [gain * panLeft, gain * panRight],
    heldPeak: [Math.min(0.9, gain * panLeft * 1.08), Math.min(0.9, gain * panRight * 1.08)],
    clipped: false
  }
})

const outputs = [output]
const outputTargets: MixerRouteTarget[] = [
  { kind: "output", channelId: output.id },
  { kind: "bus", bus: 1 },
  { kind: "bus", bus: 2 }
]
const sendTargets = computed<MixerRouteTarget[]>(() => outputTargets)

const { localeIndex } = useData()
const { locale: mixerLocale } = useI18n({ useScope: "global" })

watchEffect(() => {
  mixerLocale.value = localeIndex.value === "zh" ? "zh-cmn-Hans-CN" : "en-US"
})

function togglePlugin(instanceId: string, enabled: boolean): void {
  plugins.value = plugins.value.map((plugin) =>
    plugin.id === instanceId ? { ...plugin, enabled } : plugin
  )
}

function removePlugin(instanceId: string): void {
  plugins.value = plugins.value.filter((plugin) => plugin.id !== instanceId)
}
</script>

<template>
  <div
    class="manual-mixer-strip"
    data-theme="dark"
    :style="{
      '--plugin-section-height': '36px',
      '--send-section-height': '38px'
    }"
  >
    <MixerChannelStrip
      :channel="props.channel"
      :sends="props.sends"
      :meter="meter"
      :outputs="outputs"
      :buses="buses"
      :output-targets="outputTargets"
      :send-targets="sendTargets"
      :plugins="plugins"
      :plugin-runtime="{}"
      :effect-plugins="[]"
      :instrument-plugins="[]"
      :plugin-slot-rows="1"
      :send-slot-rows="1"
      :display-options="{
        meterPeakHold: '800ms',
        meterReturnRate: 'iec-type-i',
        softwareMonitoringEnabled: false
      }"
      selected
      @preview="emit('preview', $event)"
      @update-channel="(_, patch) => emit('updateChannel', patch)"
      @update-send="(sendId, patch) => emit('updateSend', sendId, patch)"
      @add-send="(_, target) => emit('addSend', target)"
      @delete-send="emit('deleteSend', $event)"
      @toggle-plugin="togglePlugin"
      @remove-plugin="removePlugin"
    />
  </div>
</template>

<style scoped>
.manual-mixer-strip {
  width: 136px;
  min-width: 136px;
  color: var(--text-primary);
  font-family: var(--ui-type-family-interface);
  font-size: var(--ui-type-size-body-compact);
  line-height: var(--ui-type-leading-normal);
}

.manual-mixer-strip :deep(*),
.manual-mixer-strip :deep(*::before),
.manual-mixer-strip :deep(*::after) {
  box-sizing: border-box;
}

.manual-mixer-strip :deep(button),
.manual-mixer-strip :deep(input),
.manual-mixer-strip :deep(select) {
  font: inherit;
}
</style>
