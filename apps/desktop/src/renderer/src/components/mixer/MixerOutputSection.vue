<script setup lang="ts">
import { computed } from "vue"
import { UiPopover } from "@yadaw/ui"
import type { MixerChannelPatch, MixerChannelState } from "@yadaw/contracts"

const props = defineProps<{
  channel: MixerChannelState
  outputs: MixerChannelState[]
}>()

const emit = defineEmits<{
  updateChannel: [patch: MixerChannelPatch]
}>()

const hardwareOptions = Array.from({ length: 32 }, (_, index) => index + 1)
const hardwareSummary = computed(
  () => `HW ${props.channel.hardwareOutputChannels.join("–") || "—"}`
)

function updateHardwareOutput(index: number, event: Event): void {
  const hardwareOutputChannels = [...props.channel.hardwareOutputChannels]
  hardwareOutputChannels[index] = Number((event.currentTarget as HTMLSelectElement).value)
  emit("updateChannel", { hardwareOutputChannels })
}
</script>

<template>
  <section class="output-section" data-section="output">
    <select
      v-if="channel.kind === 'audio' || channel.kind === 'instrument' || channel.kind === 'bus'"
      class="output-select"
      :value="channel.outputChannelId ?? ''"
      :aria-label="`${channel.name} output`"
      @change="
        emit('updateChannel', {
          outputChannelId: ($event.currentTarget as HTMLSelectElement).value
        })
      "
    >
      <option v-for="output in outputs" :key="output.id" :value="output.id">
        {{ output.name }}
      </option>
    </select>
    <UiPopover v-else-if="channel.kind === 'output'" side="top" :side-offset="7">
      <template #trigger>
        <button class="output-control" :aria-label="`${channel.name} hardware output routing`">
          {{ hardwareSummary }}
        </button>
      </template>
      <div class="mixer-popover output-popover">
        <header>
          <span>HARDWARE OUTPUT</span>
          <strong>{{ channel.name }}</strong>
        </header>
        <label v-for="(_, index) in channel.hardwareOutputChannels" :key="index">
          <span>{{ index === 0 ? "Left" : "Right" }}</span>
          <select
            :value="channel.hardwareOutputChannels[index]"
            :aria-label="`${channel.name} hardware output ${index + 1}`"
            @change="updateHardwareOutput(index, $event)"
          >
            <option v-for="output in hardwareOptions" :key="output" :value="output">
              Output {{ output }}
            </option>
          </select>
        </label>
      </div>
    </UiPopover>
    <button v-else class="output-control" disabled aria-disabled="true">GLOBAL</button>
  </section>
</template>

<style scoped>
.output-section {
  display: grid;
  align-items: center;
  min-width: 0;
  padding: 6px 7px;
  border-bottom: 1px solid var(--ui-domain-color-444);
  background: var(--ui-domain-color-555);
}
.output-select,
.output-control {
  width: 100%;
  height: 28px;
  min-width: 0;
  padding: 0 7px;
  overflow: hidden;
  border: 1px solid var(--ui-domain-color-747474);
  border-radius: 4px;
  color: var(--ui-domain-color-f2f2f2);
  background: linear-gradient(var(--ui-domain-color-6d6d6d), var(--ui-domain-color-5d5d5d));
  font-size: 8px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.output-control {
  cursor: pointer;
}
.output-control:disabled {
  color: var(--ui-domain-color-b8b8b8);
  cursor: default;
}
.output-select:focus-visible,
.output-control:focus-visible {
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
.output-popover label {
  display: grid;
  grid-template-columns: 40px minmax(0, 1fr);
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
