<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from "vue"
import { useI18n } from "vue-i18n"
import { UiCascadingSelect, type UiCascadingSelectGroup } from "@heron/ui"
import type {
  ApplicationCaptureTarget,
  MixerChannelPatch,
  MixerInputSource
} from "@heron/contracts"
import { MIXER_BUS_COUNT } from "@heron/contracts"
import ChannelFormatIcon from "../studio/ChannelFormatIcon.vue"
import { useApplicationCaptureStore } from "../../stores/applicationCapture"

const props = withDefaults(
  defineProps<{
    channelName: string
    inputSource: MixerInputSource
    inputFormat: "mono" | "stereo"
    inputChannels: number[]
    applicationCapture?: ApplicationCaptureTarget | null
    hardwareInputCount?: number
    busCount?: number
  }>(),
  {
    hardwareInputCount: 32,
    busCount: MIXER_BUS_COUNT,
    applicationCapture: null
  }
)

const emit = defineEmits<{
  update: [patch: MixerChannelPatch]
}>()

const { t } = useI18n()
const applicationCaptureStore = useApplicationCaptureStore()

const isStereo = computed(() => props.inputFormat === "stereo")
const selectedApplicationTarget = computed(() => {
  if (!props.applicationCapture) return undefined
  return applicationCaptureStore.targetFor(props.applicationCapture)
})
const selectedApplicationSnapshot = computed(() => {
  if (!props.applicationCapture) return undefined
  return applicationCaptureStore.snapshotFor(props.applicationCapture)
})

const captureStatusMessage = computed(() => {
  if (props.inputSource !== "application" || !props.applicationCapture) return null
  const status = selectedApplicationSnapshot.value?.status
  if (!status) {
    return selectedApplicationTarget.value ? null : t("mixer.inputCapsule.status.targetMissing")
  }
  if (status === "permission-denied") return t("mixer.inputCapsule.status.permissionDenied")
  if (status === "target-exited") return t("mixer.inputCapsule.status.targetExited")
  if (status === "target-missing") return t("mixer.inputCapsule.status.targetMissing")
  if (status === "ambiguous-target") return t("mixer.inputCapsule.status.ambiguousTarget")
  if (status === "no-stream") return t("mixer.inputCapsule.status.noStream")
  if (status === "unsupported") return t("mixer.inputCapsule.status.unsupported")
  if (status === "error") return t("mixer.inputCapsule.status.error")
  return null
})

function inputCount(source: MixerInputSource): number {
  if (source === "hardware") return props.hardwareInputCount
  if (source === "bus") return props.busCount
  return 2
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
  if (props.inputSource === "application") {
    const runtimeId = selectedApplicationTarget.value?.runtimeId
    return runtimeId ? `application:${runtimeId}` : "application:missing"
  }
  return `${props.inputSource}:${selected}`
})

function sourceOptions(source: MixerInputSource) {
  const count = inputCount(source)
  const prefix =
    source === "hardware" ? t("mixer.inputCapsule.inPrefix") : t("mixer.inputCapsule.busPrefix")
  if (source === "application") {
    const options = applicationCaptureStore.targets.map((target) => ({
      value: `${source}:${target.runtimeId}`,
      label: `${target.displayName} (${target.channelCount > 1 ? t("mixer.inputCapsule.stereo") : t("mixer.inputCapsule.mono")})`
    }))
    const currentTarget = props.applicationCapture
    if (currentTarget && !selectedApplicationTarget.value) {
      options.push({
        value: `${source}:missing`,
        label: `${currentTarget.executableName} (${t("mixer.inputCapsule.targetMissing")})`
      })
    }
    return options
  }
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
    { label: t("mixer.inputCapsule.buses"), options: sourceOptions("bus") },
    { label: t("mixer.inputCapsule.applications"), options: sourceOptions("application") }
  ]
})

function selectInput(value: string): void {
  const separator = value.indexOf(":")
  const sourceValue = separator === -1 ? value : value.slice(0, separator)
  const channelValue = separator === -1 ? "1" : value.slice(separator + 1)
  if (sourceValue === "application") {
    const target = applicationCaptureStore.targets.find(
      (candidate) => candidate.runtimeId === channelValue
    )
    if (!target) return
    emit("update", {
      inputSource: "application",
      inputFormat: target.channelCount > 1 ? "stereo" : "mono",
      inputChannels: target.channelCount > 1 ? [1, 2] : [1],
      applicationCapture: target.logicalTarget
    })
    return
  }
  const inputSource: MixerInputSource = sourceValue === "bus" ? "bus" : "hardware"
  const channel = clampInput(inputSource, Number(channelValue))
  emit("update", {
    inputSource,
    inputFormat: props.inputFormat,
    inputChannels: isStereo.value ? adjacentPair(inputSource, channel) : [channel],
    ...(props.inputSource === "application" || props.applicationCapture != null
      ? { applicationCapture: null }
      : {})
  })
}

onMounted(() => applicationCaptureStore.startPolling())
onBeforeUnmount(() => applicationCaptureStore.stopPolling())

function toggleStereo(): void {
  const channel = props.inputChannels[0] ?? 1
  const nextIsStereo = !isStereo.value
  emit("update", {
    inputSource: props.inputSource,
    inputFormat: nextIsStereo ? "stereo" : "mono",
    inputChannels: nextIsStereo
      ? adjacentPair(props.inputSource, channel)
      : [clampInput(props.inputSource, channel)],
    ...(props.inputSource === "application"
      ? { applicationCapture: props.applicationCapture ?? null }
      : {})
  })
}
</script>

<template>
  <div class="input-capsule-field">
    <div class="input-capsule">
      <div class="input-capsule__channel">
        <UiCascadingSelect
          :model-value="selectedInput"
          :groups="inputGroups"
          size="compact"
          appearance="embedded"
          hover-treatment="host-tint"
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
    <p v-if="captureStatusMessage" class="input-capsule__status" role="status">
      {{ captureStatusMessage }}
    </p>
  </div>
</template>

<style scoped>
.input-capsule-field {
  display: grid;
  gap: 4px;
  min-width: 0;
}

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

.input-capsule__status {
  margin: 0;
  color: var(--warning);
  font: var(--ui-type-size-caption) var(--ui-type-family-data);
  line-height: var(--ui-type-leading-compact);
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
