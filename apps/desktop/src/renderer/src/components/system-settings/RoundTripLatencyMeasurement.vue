<script setup lang="ts">
import { computed, onBeforeUnmount, shallowRef, watch } from "vue"
import { useI18n } from "vue-i18n"
import { useIntervalFn } from "@vueuse/core"
import { storeToRefs } from "pinia"
import { Cable } from "@lucide/vue"
import { UiButton, UiSelect, UiStatusNotice } from "@heron/ui"
import type { UiNoticeTone, UiSelectOption } from "@heron/ui"
import type { AudioEngineState } from "@heron/contracts"
import { useAudioRuntimeStore } from "../../stores/audioRuntime"

const props = defineProps<{
  runtimeState: AudioEngineState
  inputChannelCount: number
  outputChannelCount: number
  estimatedLatencyMs: number | null
}>()

const { t } = useI18n()
const audioRuntimeStore = useAudioRuntimeStore()
const { roundTripLatencyMeasurement: measurement } = storeToRefs(audioRuntimeStore)
const inputChannel = shallowRef("1")
const outputChannel = shallowRef("1")
const requestError = shallowRef("")

const inputChannelOptions = computed<readonly UiSelectOption[]>(() =>
  Array.from({ length: props.inputChannelCount }, (_, index) => ({
    value: String(index + 1),
    label: t("settings.audio.loopback.inputChannelOption", { number: index + 1 })
  }))
)
const outputChannelOptions = computed<readonly UiSelectOption[]>(() =>
  Array.from({ length: props.outputChannelCount }, (_, index) => ({
    value: String(index + 1),
    label: t("settings.audio.loopback.outputChannelOption", { number: index + 1 })
  }))
)
const isActive = computed(
  () => measurement.value.status === "preparing" || measurement.value.status === "measuring"
)
const canMeasure = computed(
  () =>
    props.runtimeState === "running" &&
    props.inputChannelCount > 0 &&
    props.outputChannelCount > 0 &&
    !isActive.value
)
const resultTone = computed<UiNoticeTone>(() => {
  if (requestError.value || measurement.value.status === "failed") return "danger"
  if (measurement.value.status === "complete") return "success"
  if (isActive.value) return "info"
  return "neutral"
})
const resultTitle = computed(() => {
  if (requestError.value) return t("settings.audio.loopback.status.startFailed")
  switch (measurement.value.status) {
    case "preparing":
      return t("settings.audio.loopback.status.preparing")
    case "measuring":
      return t("settings.audio.loopback.status.measuring")
    case "complete":
      return t("settings.audio.loopback.status.complete")
    case "failed":
      return t("settings.audio.loopback.status.failed")
    default:
      return t("settings.audio.loopback.status.ready")
  }
})
const resultMessage = computed(() => {
  if (requestError.value) return requestError.value
  if (measurement.value.failure === "input-too-loud") {
    return t("settings.audio.loopback.messages.inputTooLoud")
  }
  if (measurement.value.failure === "signal-not-detected") {
    return t("settings.audio.loopback.messages.signalNotDetected")
  }
  if (
    measurement.value.status === "complete" &&
    measurement.value.measuredRoundTripLatencyMs !== null
  ) {
    const measured = measurement.value.measuredRoundTripLatencyMs.toFixed(2)
    const comparison =
      props.estimatedLatencyMs === null
        ? ""
        : t("settings.audio.loopback.messages.comparison", {
            estimate: props.estimatedLatencyMs.toFixed(2)
          })
    return t("settings.audio.loopback.messages.complete", {
      measured,
      outputChannel: measurement.value.outputChannel,
      inputChannel: measurement.value.inputChannel,
      comparison
    })
  }
  if (measurement.value.status === "preparing") {
    return t("settings.audio.loopback.messages.preparing")
  }
  if (measurement.value.status === "measuring") {
    return t("settings.audio.loopback.messages.measuring")
  }
  if (props.runtimeState !== "running") {
    return t("settings.audio.loopback.messages.engineNotRunning")
  }
  return t("settings.audio.loopback.messages.ready")
})

async function refreshMeasurement(): Promise<void> {
  try {
    const next = await audioRuntimeStore.refreshRoundTripLatencyMeasurement()
    if (next.status === "complete" || next.status === "failed" || next.status === "idle") {
      polling.pause()
    }
  } catch (error) {
    requestError.value =
      error instanceof Error ? error.message : t("settings.audio.loopback.messages.readFailed")
    polling.pause()
  }
}

const polling = useIntervalFn(
  () => {
    void refreshMeasurement()
  },
  100,
  { immediate: false }
)

async function startMeasurement(): Promise<void> {
  requestError.value = ""
  try {
    await audioRuntimeStore.startRoundTripLatencyMeasurement({
      inputChannel: Number(inputChannel.value),
      outputChannel: Number(outputChannel.value)
    })
    polling.resume()
  } catch (error) {
    requestError.value =
      error instanceof Error ? error.message : t("settings.audio.loopback.messages.startFailed")
  }
}

watch(
  () => props.inputChannelCount,
  (count) => {
    if (Number(inputChannel.value) > count) inputChannel.value = count > 0 ? String(count) : "1"
  }
)
watch(
  () => props.outputChannelCount,
  (count) => {
    if (Number(outputChannel.value) > count) outputChannel.value = count > 0 ? String(count) : "1"
  }
)

onBeforeUnmount(() => polling.pause())
</script>

<template>
  <div class="loopback-measurement">
    <div class="loopback-copy">
      <Cable :size="18" aria-hidden="true" />
      <p>{{ t("settings.audio.loopback.intro") }}</p>
    </div>
    <div class="loopback-controls">
      <label class="loopback-field">
        <span>{{ t("settings.audio.loopback.outputChannel") }}</span>
        <UiSelect
          v-model="outputChannel"
          :options="outputChannelOptions"
          size="sm"
          :aria-label="t('settings.audio.loopback.outputChannelAria')"
          :disabled="isActive || outputChannelCount === 0"
        />
      </label>
      <label class="loopback-field">
        <span>{{ t("settings.audio.loopback.inputChannel") }}</span>
        <UiSelect
          v-model="inputChannel"
          :options="inputChannelOptions"
          size="sm"
          :aria-label="t('settings.audio.loopback.inputChannelAria')"
          :disabled="isActive || inputChannelCount === 0"
        />
      </label>
      <UiButton
        class="measure-button"
        size="sm"
        :loading="isActive"
        :loading-label="t('settings.audio.loopback.measuring')"
        :disabled="!canMeasure"
        @click="startMeasurement"
      >
        {{
          isActive
            ? t("settings.audio.loopback.measuringAction")
            : t("settings.audio.loopback.measure")
        }}
      </UiButton>
    </div>
    <UiStatusNotice :title="resultTitle" :tone="resultTone" live="polite">
      {{ resultMessage }}
    </UiStatusNotice>
  </div>
</template>

<style scoped>
.loopback-measurement {
  display: grid;
  gap: var(--ui-space-4);
}

.loopback-copy {
  display: flex;
  align-items: flex-start;
  gap: var(--ui-space-3);
  color: var(--text-secondary);
}

.loopback-copy p {
  margin: 0;
  font-size: var(--ui-font-size-sm);
  line-height: var(--ui-type-leading-normal);
}

.loopback-controls {
  display: grid;
  grid-template-columns: repeat(2, minmax(120px, 1fr)) auto;
  align-items: end;
  gap: var(--ui-space-3);
}

.loopback-field {
  display: grid;
  gap: var(--ui-space-2);
  color: var(--text-secondary);
  font-size: var(--ui-font-size-xs);
}

.measure-button {
  white-space: nowrap;
}

@media (max-width: 720px) {
  .loopback-controls {
    grid-template-columns: 1fr;
  }

  .measure-button {
    width: 100%;
  }
}
</style>
