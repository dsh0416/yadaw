<script setup lang="ts">
import { computed } from "vue"
import { UiCascadingSelect, UiPopover, UiSelect } from "@yadaw/ui"
import type { UiCascadingSelectGroup } from "@yadaw/ui"
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
const routeGroups = computed<readonly UiCascadingSelectGroup[]>(() => [
  {
    label: "Outputs",
    options: props.outputs
      .filter((output) => output.kind === "output")
      .map((output) => ({ value: output.id, label: output.name }))
  },
  {
    label: "Buses",
    options: props.outputs
      .filter((output) => output.kind === "bus")
      .map((output) => ({ value: output.id, label: output.name }))
  }
])

function updateHardwareOutput(index: number, value: string): void {
  const hardwareOutputChannels = [...props.channel.hardwareOutputChannels]
  hardwareOutputChannels[index] = Number(value)
  emit("updateChannel", { hardwareOutputChannels })
}
</script>

<template>
  <section class="output-section" data-section="output">
    <UiCascadingSelect
      v-if="channel.kind === 'audio' || channel.kind === 'instrument' || channel.kind === 'bus'"
      :model-value="channel.outputChannelId ?? ''"
      :groups="routeGroups"
      placeholder="No route"
      size="compact"
      :aria-label="`${channel.name} output`"
      @update:model-value="emit('updateChannel', { outputChannelId: $event })"
    />
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
          <UiSelect
            :model-value="String(channel.hardwareOutputChannels[index])"
            size="compact"
            :aria-label="`${channel.name} hardware output ${index + 1}`"
            @update:model-value="updateHardwareOutput(index, $event)"
          >
            <option v-for="output in hardwareOptions" :key="output" :value="String(output)">
              Output {{ output }}
            </option>
          </UiSelect>
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
  font-size: var(--ui-type-size-control);
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
  font: var(--ui-type-weight-bold) var(--ui-type-size-caption) var(--ui-type-family-data);
  letter-spacing: var(--ui-type-tracking-wider);
}
.mixer-popover header strong {
  margin-top: 3px;
  font-size: var(--ui-type-size-label);
}
.output-popover label {
  display: grid;
  grid-template-columns: 40px minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  color: var(--text-muted);
  font-size: var(--ui-type-size-control);
}
</style>
