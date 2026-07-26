<script setup lang="ts">
import { computed } from "vue"
import { UiPopover } from "@yadaw/ui"
import type {
  MixerChannelPatch,
  MixerChannelState,
  PluginDescriptor,
  PluginInstanceState,
  PluginRuntimeStatus
} from "@yadaw/contracts"
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
  togglePlugin: [instanceId: string, enabled: boolean]
  removePlugin: [instanceId: string]
  assignInstrument: [descriptor: PluginDescriptor]
}>()

const inputOptions = Array.from({ length: 32 }, (_, index) => index + 1)
const inputSummary = computed(() => {
  if (props.channel.kind === "audio") {
    const inputs = props.channel.inputChannels.join("–")
    return `${props.channel.inputFormat === "mono" ? "MONO" : "ST"} ${inputs}`
  }
  if (props.channel.kind === "bus") return "BUS RETURN"
  if (props.channel.kind === "master") return "GLOBAL"
  return "MIX BUS"
})

function numberValue(event: Event): number {
  return Number((event.currentTarget as HTMLSelectElement).value)
}

function changeInputFormat(event: Event): void {
  const inputFormat = (event.currentTarget as HTMLSelectElement).value as "mono" | "stereo"
  emit("updateChannel", {
    inputFormat,
    inputChannels:
      inputFormat === "mono"
        ? [props.channel.inputChannels[0] ?? 1]
        : [props.channel.inputChannels[0] ?? 1, props.channel.inputChannels[1] ?? 2]
  })
}

function updateInput(index: number, event: Event): void {
  const inputChannels = [...props.channel.inputChannels]
  inputChannels[index] = numberValue(event)
  emit("updateChannel", { inputChannels })
}
</script>

<template>
  <section class="strip-section input-section" data-section="input">
    <MixerInstrumentInput
      v-if="channel.kind === 'instrument'"
      :instrument="instrument"
      :runtime="pluginRuntime"
      :plugins="instrumentPlugins"
      @open="emit('openPlugin', $event)"
      @toggle="(id, enabled) => emit('togglePlugin', id, enabled)"
      @remove="emit('removePlugin', $event)"
      @assign="emit('assignInstrument', $event)"
    />
    <UiPopover v-else-if="channel.kind === 'audio'" side="top" :side-offset="7">
      <template #trigger>
        <button class="section-control input-trigger" :aria-label="`${channel.name} input routing`">
          <i aria-hidden="true" />
          <span>{{ inputSummary }}</span>
        </button>
      </template>
      <div class="mixer-popover input-popover">
        <header>
          <span>INPUT ROUTING</span>
          <strong>{{ channel.name }}</strong>
        </header>
        <label>
          <span>Format</span>
          <select
            :value="channel.inputFormat ?? 'stereo'"
            aria-label="Input format"
            @change="changeInputFormat"
          >
            <option value="mono">Mono</option>
            <option value="stereo">Stereo</option>
          </select>
        </label>
        <label v-for="(_, index) in channel.inputChannels" :key="index">
          <span>{{
            channel.inputFormat === "mono" ? "Input" : index === 0 ? "Left" : "Right"
          }}</span>
          <select
            :value="channel.inputChannels[index]"
            :aria-label="`${channel.name} input channel ${index + 1}`"
            @change="updateInput(index, $event)"
          >
            <option v-for="input in inputOptions" :key="input" :value="input">
              Input {{ input }}
            </option>
          </select>
        </label>
      </div>
    </UiPopover>
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
  font: 8px var(--font-utility);
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}
.section-control:disabled {
  color: var(--ui-domain-color-b8b8b8);
  cursor: default;
  opacity: 0.78;
}
.input-trigger i {
  flex: none;
  width: 7px;
  height: 7px;
  border: 1px solid var(--ui-domain-color-dedede);
  border-radius: 50%;
}
.section-control:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}
.mixer-popover {
  display: grid;
  width: 210px;
  gap: 9px;
  padding: 11px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  color: var(--text-primary);
  background: var(--surface-1);
  box-shadow: 0 14px 36px var(--ui-domain-color-00000075);
}
.mixer-popover header span,
.mixer-popover header strong {
  display: block;
}
.mixer-popover header span {
  color: var(--accent);
  font: 700 7px var(--font-utility);
  letter-spacing: 0.14em;
}
.mixer-popover header strong {
  margin-top: 3px;
  font-size: 10px;
}
.input-popover label {
  display: grid;
  grid-template-columns: 48px minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  color: var(--text-muted);
  font-size: 8px;
}
.mixer-popover select {
  min-width: 0;
  height: 25px;
  border: 1px solid var(--line-strong);
  border-radius: 3px;
  color: var(--text-primary);
  background: var(--daw-control);
  font-size: 8px;
}
</style>
