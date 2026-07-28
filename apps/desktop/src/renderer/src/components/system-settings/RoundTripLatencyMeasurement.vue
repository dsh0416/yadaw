<script setup lang="ts">
import { computed, onBeforeUnmount, shallowRef, watch } from "vue"
import { useIntervalFn } from "@vueuse/core"
import { storeToRefs } from "pinia"
import { Cable } from "@lucide/vue"
import { UiButton, UiSelect, UiStatusNotice } from "@yadaw/ui"
import type { UiNoticeTone, UiSelectOption } from "@yadaw/ui"
import type { AudioEngineState } from "@yadaw/contracts"
import { useAudioRuntimeStore } from "../../stores/audioRuntime"

const props = defineProps<{
  runtimeState: AudioEngineState
  inputChannelCount: number
  outputChannelCount: number
  estimatedLatencyMs: number | null
}>()

const audioRuntimeStore = useAudioRuntimeStore()
const { roundTripLatencyMeasurement: measurement } = storeToRefs(audioRuntimeStore)
const inputChannel = shallowRef("1")
const outputChannel = shallowRef("1")
const requestError = shallowRef("")

const inputChannelOptions = computed<readonly UiSelectOption[]>(() =>
  Array.from({ length: props.inputChannelCount }, (_, index) => ({
    value: String(index + 1),
    label: `Input ${index + 1}`
  }))
)
const outputChannelOptions = computed<readonly UiSelectOption[]>(() =>
  Array.from({ length: props.outputChannelCount }, (_, index) => ({
    value: String(index + 1),
    label: `Output ${index + 1}`
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
  if (requestError.value) return "Measurement could not start"
  switch (measurement.value.status) {
    case "preparing":
      return "Checking the input"
    case "measuring":
      return "Listening for the probe"
    case "complete":
      return "Physical loopback measured"
    case "failed":
      return "Measurement failed"
    default:
      return "Ready to measure"
  }
})
const resultMessage = computed(() => {
  if (requestError.value) return requestError.value
  if (measurement.value.failure === "input-too-loud") {
    return "The selected input was not quiet. Disconnect other sources, lower their gain, and try again."
  }
  if (measurement.value.failure === "signal-not-detected") {
    return "No matching probe returned within three seconds. Check the cable and selected channels."
  }
  if (
    measurement.value.status === "complete" &&
    measurement.value.measuredRoundTripLatencyMs !== null
  ) {
    const measured = measurement.value.measuredRoundTripLatencyMs.toFixed(2)
    const comparison =
      props.estimatedLatencyMs === null
        ? ""
        : ` The callback estimate is ${props.estimatedLatencyMs.toFixed(2)} ms.`
    return `Measured ${measured} ms through output ${measurement.value.outputChannel} and input ${measurement.value.inputChannel}.${comparison}`
  }
  if (measurement.value.status === "preparing") {
    return "Keep the selected input quiet while YADAW checks its noise floor."
  }
  if (measurement.value.status === "measuring") {
    return "A short probe has been sent. Keep the loopback cable connected."
  }
  if (props.runtimeState !== "running") {
    return "Start the audio engine before running a physical loopback measurement."
  }
  return "Connect the selected hardware output directly to the selected hardware input. Lower monitor volume first—the test emits a short probe."
})

async function refreshMeasurement(): Promise<void> {
  try {
    const next = await audioRuntimeStore.refreshRoundTripLatencyMeasurement()
    if (next.status === "complete" || next.status === "failed" || next.status === "idle") {
      polling.pause()
    }
  } catch (error) {
    requestError.value =
      error instanceof Error ? error.message : "Unable to read the measurement result."
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
      error instanceof Error ? error.message : "Unable to start the loopback measurement."
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
      <p>
        This measures the real converter, driver, and cable path. Stop transport and connect one
        output directly to one input.
      </p>
    </div>
    <div class="loopback-controls">
      <label class="loopback-field">
        <span>Output channel</span>
        <UiSelect
          v-model="outputChannel"
          :options="outputChannelOptions"
          size="sm"
          aria-label="Loopback output channel"
          :disabled="isActive || outputChannelCount === 0"
        />
      </label>
      <label class="loopback-field">
        <span>Input channel</span>
        <UiSelect
          v-model="inputChannel"
          :options="inputChannelOptions"
          size="sm"
          aria-label="Loopback input channel"
          :disabled="isActive || inputChannelCount === 0"
        />
      </label>
      <UiButton
        class="measure-button"
        size="sm"
        :loading="isActive"
        loading-label="Measuring"
        :disabled="!canMeasure"
        @click="startMeasurement"
      >
        {{ isActive ? "Measuring…" : "Measure round trip" }}
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
