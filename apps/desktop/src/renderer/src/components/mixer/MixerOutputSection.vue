<script setup lang="ts">
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import { UiCascadingSelect, UiPopover, UiSelect } from "@yadaw/ui"
import type {
  MixerBusState,
  MixerChannelPatch,
  MixerChannelState,
  MixerRouteTarget
} from "@yadaw/contracts"
import { mixerRouteGroups } from "./mixer-route-groups"

const props = defineProps<{
  channel: MixerChannelState
  buses: readonly MixerBusState[]
  outputs: MixerChannelState[]
  targets: MixerRouteTarget[]
}>()

const emit = defineEmits<{
  updateChannel: [patch: MixerChannelPatch]
}>()

const { t } = useI18n()

const hardwareOptions = Array.from({ length: 32 }, (_, index) => index + 1)
const hardwareSummary = computed(
  () => `HW ${props.channel.hardwareOutputChannels.join("–") || "—"}`
)
const routeGroups = computed(() => mixerRouteGroups(props.targets, props.buses, props.outputs, t))
const routeValue = computed(() =>
  props.channel.outputChannelId
    ? `output:${props.channel.outputChannelId}`
    : props.channel.outputBus
      ? `bus:${props.channel.outputBus}`
      : ""
)

function updateRoute(value: string): void {
  const separator = value.indexOf(":")
  const kind = value.slice(0, separator)
  const target = value.slice(separator + 1)
  emit("updateChannel", {
    outputChannelId: kind === "output" ? target : null,
    outputBus: kind === "bus" ? Number(target) : null
  })
}

function updateHardwareOutput(index: number, value: string): void {
  const hardwareOutputChannels = [...props.channel.hardwareOutputChannels]
  hardwareOutputChannels[index] = Number(value)
  emit("updateChannel", { hardwareOutputChannels })
}
</script>

<template>
  <section class="output-section" data-section="output">
    <UiCascadingSelect
      v-if="channel.kind === 'audio' || channel.kind === 'instrument' || channel.kind === 'aux'"
      :model-value="routeValue"
      :groups="routeGroups"
      :placeholder="t('mixer.outputSection.noRoute')"
      size="compact"
      :aria-label="t('mixer.outputSection.outputAria', { name: channel.name })"
      @update:model-value="updateRoute"
    />
    <UiPopover v-else-if="channel.kind === 'output'" side="top" :side-offset="7">
      <template #trigger>
        <button
          class="output-control"
          :aria-label="t('mixer.outputSection.hardwareRouting', { name: channel.name })"
        >
          {{ hardwareSummary }}
        </button>
      </template>
      <div class="mixer-popover output-popover">
        <header>
          <span>{{ t("mixer.outputSection.hardwareOutput") }}</span>
          <strong>{{ channel.name }}</strong>
        </header>
        <label v-for="(_, index) in channel.hardwareOutputChannels" :key="index">
          <span>{{
            index === 0 ? t("mixer.outputSection.left") : t("mixer.outputSection.right")
          }}</span>
          <UiSelect
            :model-value="String(channel.hardwareOutputChannels[index])"
            size="compact"
            :aria-label="
              t('mixer.outputSection.hardwareOutputN', { name: channel.name, n: index + 1 })
            "
            @update:model-value="updateHardwareOutput(index, $event)"
          >
            <option v-for="output in hardwareOptions" :key="output" :value="String(output)">
              {{ t("mixer.outputSection.outputN", { n: output }) }}
            </option>
          </UiSelect>
        </label>
      </div>
    </UiPopover>
    <button v-else class="output-control" disabled aria-disabled="true">
      {{ t("mixer.outputSection.global") }}
    </button>
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
