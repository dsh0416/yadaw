<script setup lang="ts">
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import { UiField, UiSelect, type UiSelectOption } from "@heron/ui"
import type { MidiInputPort, MidiInputRoute } from "@heron/contracts"

const props = defineProps<{
  route: MidiInputRoute
  ports: MidiInputPort[]
}>()

const emit = defineEmits<{
  update: [route: MidiInputRoute]
}>()

const { t } = useI18n()
const selectedMissing = computed(
  () =>
    props.route.portId !== null &&
    !props.ports.some((port) => port.id === props.route.portId && port.connected)
)
const portOptions = computed<readonly UiSelectOption[]>(() => {
  const ports = props.ports.map((port) => ({
    value: port.id,
    label: `${port.name}${port.connected ? "" : ` — ${t("studio.trackInspector.midi.missing")}`}`
  }))
  if (props.route.portId && !props.ports.some((port) => port.id === props.route.portId)) {
    ports.push({
      value: props.route.portId,
      label: `${props.route.portName ?? t("studio.trackInspector.midi.unknownPort")} — ${t(
        "studio.trackInspector.midi.missing"
      )}`
    })
  }
  return [{ value: "", label: t("studio.trackInspector.midi.allInputs") }, ...ports]
})
const channelValue = computed(() =>
  props.route.channel === null ? "" : String(props.route.channel)
)
const channelOptions = computed<readonly UiSelectOption[]>(() => [
  { value: "", label: t("studio.trackInspector.midi.omni") },
  ...Array.from({ length: 16 }, (_, index) => ({
    value: String(index),
    label: t("studio.trackInspector.midi.channelOption", { channel: index + 1 })
  }))
])

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
  <div class="midi-input-fields">
    <UiField
      :label="t('studio.trackInspector.midi.port')"
      :description="
        selectedMissing ? t('studio.trackInspector.midi.missingDescription') : undefined
      "
    >
      <template #default="{ controlId, descriptionId }">
        <div :class="['midi-port-control', { missing: selectedMissing }]">
          <UiSelect
            :id="controlId"
            :aria-label="t('studio.trackInspector.midi.portAria')"
            :aria-describedby="descriptionId"
            :model-value="route.portId ?? ''"
            :options="portOptions"
            size="compact"
            @update:model-value="updatePort"
          />
        </div>
      </template>
    </UiField>
    <UiField :label="t('studio.trackInspector.midi.channel')" layout="inline">
      <template #default="{ controlId }">
        <UiSelect
          :id="controlId"
          :aria-label="t('studio.trackInspector.midi.channelAria')"
          :model-value="channelValue"
          :options="channelOptions"
          size="compact"
          @update:model-value="updateChannel"
        />
      </template>
    </UiField>
  </div>
</template>

<style scoped>
.midi-input-fields {
  display: grid;
  gap: 11px;
}

.midi-port-control.missing {
  padding: 2px;
  border: 1px solid var(--mixer-record);
  border-radius: 5px;
}
</style>
