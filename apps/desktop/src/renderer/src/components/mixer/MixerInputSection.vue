<script setup lang="ts">
import { computed, onMounted, shallowRef, watchEffect } from "vue"
import { storeToRefs } from "pinia"
import { useI18n } from "vue-i18n"
import type {
  MixerChannelPatch,
  MixerChannelState,
  MidiInputPort,
  PluginDescriptor,
  PluginInstanceState,
  PluginRuntimeStatus
} from "@heron/contracts"
import type { PluginSelection } from "../plugins/plugin-audio-mode"
import MixerInputCapsule from "./MixerInputCapsule.vue"
import MixerInstrumentInput from "./MixerInstrumentInput.vue"
import MixerMidiInputCapsule from "./MixerMidiInputCapsule.vue"
import { useMidiInputStore } from "../../stores/midiInput"

const props = defineProps<{
  channel: MixerChannelState
  instrument: PluginInstanceState | null
  pluginRuntime: Record<string, PluginRuntimeStatus>
  instrumentPlugins: PluginDescriptor[]
}>()

const emit = defineEmits<{
  updateChannel: [patch: MixerChannelPatch]
  openPlugin: [instanceId: string]
  removePlugin: [instanceId: string]
  assignInstrument: [selection: PluginSelection]
}>()

const { t } = useI18n()
const midiPorts = shallowRef<MidiInputPort[]>([])
if (props.channel.kind === "instrument" && props.channel.systemRole === null) {
  const midiInputStore = useMidiInputStore()
  const { snapshot } = storeToRefs(midiInputStore)
  watchEffect(() => {
    midiPorts.value = snapshot.value.ports
  })
  onMounted(() => void midiInputStore.load())
}

const inputSummary = computed(() => {
  if (props.channel.kind === "master") return t("mixer.inputSection.global")
  return t("mixer.inputSection.mixBus")
})
</script>

<template>
  <section class="strip-section input-section" data-section="input">
    <div
      v-if="channel.kind === 'instrument' && channel.systemRole === null"
      class="instrument-stack"
    >
      <MixerMidiInputCapsule
        :route="channel.midiInput ?? { portId: null, portName: null, channel: null }"
        :ports="midiPorts"
        @update="emit('updateChannel', { midiInput: $event })"
      />
      <MixerInstrumentInput
        :instrument="instrument"
        :runtime="pluginRuntime"
        :plugins="instrumentPlugins"
        @open="emit('openPlugin', $event)"
        @remove="emit('removePlugin', $event)"
        @assign="emit('assignInstrument', $event)"
      />
    </div>
    <MixerInstrumentInput
      v-else-if="channel.kind === 'instrument'"
      :instrument="instrument"
      :runtime="pluginRuntime"
      :plugins="instrumentPlugins"
      @open="emit('openPlugin', $event)"
      @remove="emit('removePlugin', $event)"
      @assign="emit('assignInstrument', $event)"
    />
    <MixerInputCapsule
      v-else-if="channel.kind === 'audio' || channel.kind === 'aux'"
      :channel-name="channel.name"
      :input-source="channel.inputSource ?? 'hardware'"
      :input-format="channel.inputFormat ?? 'stereo'"
      :input-channels="channel.inputChannels"
      @update="emit('updateChannel', $event)"
    />
    <button v-else class="section-control" disabled aria-disabled="true">
      {{ inputSummary }}
    </button>
  </section>
</template>

<style scoped>
.strip-section {
  display: grid;
  align-items: center;
  min-width: 0;
  padding: 7px;
  border-bottom: 1px solid var(--ui-domain-color-444);
  background: var(--ui-domain-color-595959);
}
.instrument-stack {
  display: grid;
  gap: 4px;
}
.section-control {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  height: 28px;
  min-width: 0;
  padding: 0 7px;
  overflow: hidden;
  border: 1px solid var(--ui-domain-color-777);
  border-radius: 4px;
  color: var(--ui-domain-color-ededed);
  background: linear-gradient(var(--ui-domain-color-707070), var(--ui-domain-color-606060));
  font: var(--ui-type-size-control) var(--ui-type-family-data);
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}
.section-control:disabled {
  color: var(--ui-domain-color-b8b8b8);
  cursor: default;
  opacity: 0.78;
}
.section-control:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}
</style>
