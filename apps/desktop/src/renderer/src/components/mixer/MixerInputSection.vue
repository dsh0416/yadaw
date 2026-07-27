<script setup lang="ts">
import { computed } from "vue"
import type {
  MixerChannelPatch,
  MixerChannelState,
  PluginDescriptor,
  PluginInstanceState,
  PluginRuntimeStatus
} from "@yadaw/contracts"
import MixerInputCapsule from "./MixerInputCapsule.vue"
import MixerInstrumentInput from "./MixerInstrumentInput.vue"

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
  assignInstrument: [descriptor: PluginDescriptor]
}>()

const inputSummary = computed(() => {
  if (props.channel.kind === "master") return "GLOBAL"
  return "MIX BUS"
})
</script>

<template>
  <section class="strip-section input-section" data-section="input">
    <MixerInstrumentInput
      v-if="channel.kind === 'instrument'"
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
