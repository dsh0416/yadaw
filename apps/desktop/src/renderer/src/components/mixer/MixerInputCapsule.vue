<script setup lang="ts">
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import { UiCascadingSelect, type UiCascadingSelectGroup } from "@yadaw/ui"
import type { MixerChannelPatch, MixerInputSource } from "@yadaw/contracts"
import { MIXER_BUS_COUNT } from "@yadaw/contracts"
import ChannelFormatIcon from "../studio/ChannelFormatIcon.vue"

const props = withDefaults(
  defineProps<{
    channelName: string
    inputSource: MixerInputSource
    inputFormat: "mono" | "stereo"
    inputChannels: number[]
    hardwareInputCount?: number
    busCount?: number
  }>(),
  {
    hardwareInputCount: 32,
    busCount: MIXER_BUS_COUNT
  }
)

const emit = defineEmits<{
  update: [patch: MixerChannelPatch]
}>()

const { t } = useI18n()

const isStereo = computed(() => props.inputFormat === "stereo")

function inputCount(source: MixerInputSource): number {
  return source === "hardware" ? props.hardwareInputCount : props.busCount
}

function clampInput(source: MixerInputSource, channel: number): number {
  return Math.min(Math.max(channel, 1), inputCount(source))
}

function adjacentPair(source: MixerInputSource, channel: number): [number, number] {
  const count = inputCount(source)
  const clampedChannel = clampInput(source, channel)
  const pairStart = clampedChannel % 2 === 0 ? clampedChannel - 1 : clampedChannel
  const boundedPairStart = Math.min(pairStart, Math.max(count - 1, 1))
  return [boundedPairStart, Math.min(boundedPairStart + 1, count)]
}

const selectedInput = computed(() => {
  const channel = props.inputChannels[0] ?? 1
  const selected = isStereo.value
    ? adjacentPair(props.inputSource, channel)[0]
    : clampInput(props.inputSource, channel)
  return `${props.inputSource}:${selected}`
})

function sourceOptions(source: MixerInputSource) {
  const count = inputCount(source)
  const prefix =
    source === "hardware" ? t("mixer.inputCapsule.inPrefix") : t("mixer.inputCapsule.busPrefix")
  if (isStereo.value) {
    return Array.from({ length: Math.floor(count / 2) }, (_, index) => {
      const first = index * 2 + 1
      return {
        value: `${source}:${first}`,
        label: `${prefix} ${first}–${first + 1}`
      }
    })
  }

  return Array.from({ length: count }, (_, index) => {
    const channel = index + 1
    return {
      value: `${source}:${channel}`,
      label: `${prefix} ${channel}`
    }
  })
}

const inputGroups = computed<readonly UiCascadingSelectGroup[]>(() => {
  return [
    { label: t("mixer.inputCapsule.hardwareInputs"), options: sourceOptions("hardware") },
    { label: t("mixer.inputCapsule.buses"), options: sourceOptions("bus") }
  ]
})

function selectInput(value: string): void {
  const [sourceValue, channelValue] = value.split(":")
  const inputSource: MixerInputSource = sourceValue === "bus" ? "bus" : "hardware"
  const channel = clampInput(inputSource, Number(channelValue))
  emit("update", {
    inputSource,
    inputFormat: props.inputFormat,
    inputChannels: isStereo.value ? adjacentPair(inputSource, channel) : [channel]
  })
}

function toggleStereo(): void {
  const channel = props.inputChannels[0] ?? 1
  const nextIsStereo = !isStereo.value
  emit("update", {
    inputSource: props.inputSource,
    inputFormat: nextIsStereo ? "stereo" : "mono",
    inputChannels: nextIsStereo
      ? adjacentPair(props.inputSource, channel)
      : [clampInput(props.inputSource, channel)]
  })
}
</script>

<template>
  <div class="input-capsule">
    <div class="input-capsule__channel">
      <UiCascadingSelect
        :model-value="selectedInput"
        :groups="inputGroups"
        size="compact"
        appearance="embedded"
        :aria-label="t('mixer.inputCapsule.inputChannel', { name: channelName })"
        @update:model-value="selectInput"
      />
    </div>

    <button
      class="input-capsule__stereo"
      type="button"
      :aria-label="
        isStereo
          ? t('mixer.inputCapsule.useMono', { name: channelName })
          : t('mixer.inputCapsule.linkStereo', { name: channelName })
      "
      :aria-pressed="isStereo"
      :title="
        isStereo ? t('mixer.inputCapsule.stereoLinked') : t('mixer.inputCapsule.linkStereoTitle')
      "
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
