<script setup lang="ts">
import { computed } from "vue"
import { UiCascadingSelect, type UiSelectOption } from "@yadaw/ui"
import type { MixerChannelPatch } from "@yadaw/contracts"
import ChannelFormatIcon from "../studio/ChannelFormatIcon.vue"

const props = withDefaults(
  defineProps<{
    channelName: string
    inputFormat: "mono" | "stereo"
    inputChannels: number[]
    inputCount?: number
  }>(),
  {
    inputCount: 32
  }
)

const emit = defineEmits<{
  update: [patch: MixerChannelPatch]
}>()

const isStereo = computed(() => props.inputFormat === "stereo")

function clampInput(channel: number): number {
  return Math.min(Math.max(channel, 1), props.inputCount)
}

function adjacentPair(channel: number): [number, number] {
  const clampedChannel = clampInput(channel)
  const pairStart = clampedChannel % 2 === 0 ? clampedChannel - 1 : clampedChannel
  const boundedPairStart = Math.min(pairStart, Math.max(props.inputCount - 1, 1))
  return [boundedPairStart, Math.min(boundedPairStart + 1, props.inputCount)]
}

const selectedInput = computed(() => {
  const channel = props.inputChannels[0] ?? 1
  return String(isStereo.value ? adjacentPair(channel)[0] : clampInput(channel))
})

const channelOptions = computed<readonly UiSelectOption[]>(() => {
  if (isStereo.value) {
    return Array.from({ length: Math.floor(props.inputCount / 2) }, (_, index) => {
      const first = index * 2 + 1
      return {
        value: String(first),
        label: `IN ${first}–${first + 1}`
      }
    })
  }

  return Array.from({ length: props.inputCount }, (_, index) => {
    const channel = index + 1
    return {
      value: String(channel),
      label: `IN ${channel}`
    }
  })
})

function selectInput(value: string): void {
  const channel = clampInput(Number(value))
  emit("update", {
    inputFormat: props.inputFormat,
    inputChannels: isStereo.value ? adjacentPair(channel) : [channel]
  })
}

function toggleStereo(): void {
  const channel = props.inputChannels[0] ?? 1
  const nextIsStereo = !isStereo.value
  emit("update", {
    inputFormat: nextIsStereo ? "stereo" : "mono",
    inputChannels: nextIsStereo ? adjacentPair(channel) : [clampInput(channel)]
  })
}
</script>

<template>
  <div class="input-capsule">
    <div class="input-capsule__channel">
      <UiCascadingSelect
        :model-value="selectedInput"
        :options="channelOptions"
        size="compact"
        appearance="embedded"
        :aria-label="`${channelName} input channel`"
        @update:model-value="selectInput"
      />
    </div>

    <button
      class="input-capsule__stereo"
      type="button"
      :aria-label="
        isStereo
          ? `Use mono input for ${channelName}`
          : `Link adjacent input as stereo for ${channelName}`
      "
      :aria-pressed="isStereo"
      :title="isStereo ? 'Stereo linked' : 'Link adjacent input as stereo'"
      @click="toggleStereo"
    >
      <ChannelFormatIcon :channels="isStereo ? 2 : 1" />
    </button>
  </div>
</template>

<style scoped>
.input-capsule {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 22px;
  align-items: center;
  width: 100%;
  height: 28px;
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--ui-domain-color-2e5d86);
  border-radius: 4px;
  color: var(--ui-domain-color-fff);
  background: linear-gradient(var(--ui-domain-color-3f91d4), var(--ui-domain-color-2871ae));
  box-shadow: 0 1px 0 var(--ui-domain-color-ffffff28) inset;
}

.input-capsule__channel {
  min-width: 0;
}

.input-capsule__stereo {
  display: grid;
  place-items: center;
  width: 22px;
  height: 26px;
  min-width: 0;
  padding: 0;
  border: 0;
  color: color-mix(in srgb, currentColor 58%, transparent);
  background: transparent;
  cursor: pointer;
}

.input-capsule__stereo:hover {
  color: inherit;
  background: var(--ui-domain-color-ffffff22);
}

.input-capsule__stereo:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: -2px;
}
</style>
