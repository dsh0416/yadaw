<script setup lang="ts">
import { computed } from "vue"
import { UiSelect } from "@heron/ui"
import type { MidiInputPort, MidiInputRoute } from "@heron/contracts"

const props = defineProps<{
  route: MidiInputRoute
  ports: MidiInputPort[]
}>()

const emit = defineEmits<{
  update: [route: MidiInputRoute]
}>()

const selectedMissing = computed(
  () =>
    props.route.portId !== null &&
    !props.ports.some((port) => port.id === props.route.portId && port.connected)
)

const portOptions = computed(() => {
  if (props.route.portId && !props.ports.some((port) => port.id === props.route.portId)) {
    return [
      ...props.ports,
      {
        id: props.route.portId,
        name: props.route.portName ?? "Unknown MIDI input",
        connected: false
      }
    ]
  }
  return props.ports
})

function updatePort(portId: string): void {
  const port = props.ports.find((candidate) => candidate.id === portId)
  emit("update", {
    ...props.route,
    portId: port?.id ?? null,
    portName: port?.name ?? null
  })
}

function updateChannel(value: string): void {
  emit("update", {
    ...props.route,
    channel: value === "" ? null : Number(value)
  })
}
</script>

<template>
  <div :class="['midi-input-capsule', { missing: selectedMissing }]">
    <UiSelect
      aria-label="MIDI input port"
      :model-value="route.portId ?? ''"
      size="sm"
      @update:model-value="updatePort"
    >
      <option value="">All Inputs</option>
      <option v-for="port in portOptions" :key="port.id" :value="port.id">
        {{ port.name }}{{ port.connected ? "" : " — Missing" }}
      </option>
    </UiSelect>
    <UiSelect
      aria-label="MIDI input channel"
      :model-value="route.channel === null ? '' : String(route.channel)"
      size="sm"
      @update:model-value="updateChannel"
    >
      <option value="">Omni</option>
      <option v-for="channel in 16" :key="channel" :value="String(channel - 1)">
        Ch {{ channel }}
      </option>
    </UiSelect>
  </div>
</template>

<style scoped>
.midi-input-capsule {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 76px;
  gap: 4px;
}
.midi-input-capsule.missing {
  padding: 2px;
  border: 1px solid var(--mixer-record);
  border-radius: 5px;
}
</style>
