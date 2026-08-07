<script setup lang="ts">
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import { UiNumberInput, UiSelect } from "@heron/ui"
import type { BounceFormatSettings, BounceSampleRate } from "@heron/contracts"

const props = defineProps<{
  settings: BounceFormatSettings
  sampleRate: BounceSampleRate
  projectSampleRate: number
}>()
const emit = defineEmits<{
  updateSettings: [settings: BounceFormatSettings]
  updateSampleRate: [sampleRate: BounceSampleRate]
}>()
const { t } = useI18n()

const formatValue = computed({
  get: () => props.settings.format,
  set: (value: string) => {
    if (value === "flac") {
      emit("updateSettings", {
        format: "flac",
        bitDepth: "pcm24",
        compressionLevel: 5,
        dither: "tpdf"
      })
    } else if (value === "mp3") {
      emit("updateSettings", { format: "mp3", bitrate: { mode: "cbr", kbps: 320 } })
    } else {
      emit("updateSettings", { format: "wav", bitDepth: "pcm24", dither: "tpdf" })
    }
  }
})
const sampleRateValue = computed({
  get: () => String(props.sampleRate),
  set: (value: string) =>
    emit("updateSampleRate", value === "project" ? "project" : (Number(value) as BounceSampleRate))
})
const sampleRates = computed(() => [
  {
    value: "project",
    label: t("bounce.sampleRate.project", { rate: props.projectSampleRate / 1000 }),
    disabled: props.settings.format === "mp3" && ![44_100, 48_000].includes(props.projectSampleRate)
  },
  ...[44_100, 48_000, 88_200, 96_000].map((rate) => ({
    value: String(rate),
    label: `${rate / 1000} kHz`,
    disabled: props.settings.format === "mp3" && rate > 48_000
  }))
])
const bitDepth = computed({
  get: () => (props.settings.format === "mp3" ? "" : props.settings.bitDepth),
  set: (value: string) => {
    if (props.settings.format === "wav") {
      emit("updateSettings", {
        ...props.settings,
        bitDepth: value as "pcm16" | "pcm24" | "float32",
        dither: value === "float32" ? "off" : props.settings.dither
      })
    } else if (props.settings.format === "flac") {
      emit("updateSettings", { ...props.settings, bitDepth: value as "pcm16" | "pcm24" })
    }
  }
})
const dither = computed({
  get: () => (props.settings.format === "mp3" ? "off" : props.settings.dither),
  set: (value: string) => {
    if (props.settings.format !== "mp3")
      emit("updateSettings", { ...props.settings, dither: value as "off" | "tpdf" })
  }
})
const mp3Mode = computed({
  get: () => (props.settings.format === "mp3" ? props.settings.bitrate.mode : "cbr"),
  set: (value: string) =>
    emit(
      "updateSettings",
      value === "vbr"
        ? { format: "mp3", bitrate: { mode: "vbr", quality: 2 } }
        : { format: "mp3", bitrate: { mode: "cbr", kbps: 320 } }
    )
})
</script>

<template>
  <fieldset class="bounce-fieldset">
    <legend>{{ t("bounce.sections.format") }}</legend>
    <label
      ><span>{{ t("bounce.fields.format") }}</span
      ><UiSelect
        v-model="formatValue"
        :options="[
          { value: 'wav', label: 'WAV' },
          { value: 'flac', label: 'FLAC' },
          { value: 'mp3', label: 'MP3' }
        ]"
    /></label>
    <label
      ><span>{{ t("bounce.fields.sampleRate") }}</span
      ><UiSelect v-model="sampleRateValue" :options="sampleRates"
    /></label>
    <template v-if="settings.format !== 'mp3'">
      <label
        ><span>{{ t("bounce.fields.bitDepth") }}</span
        ><UiSelect
          v-model="bitDepth"
          :options="
            settings.format === 'wav'
              ? [
                  { value: 'pcm16', label: '16-bit PCM' },
                  { value: 'pcm24', label: '24-bit PCM' },
                  { value: 'float32', label: '32-bit Float' }
                ]
              : [
                  { value: 'pcm16', label: '16-bit' },
                  { value: 'pcm24', label: '24-bit' }
                ]
          "
      /></label>
      <label
        ><span>{{ t("bounce.fields.dither") }}</span
        ><UiSelect
          v-model="dither"
          :disabled="settings.format === 'wav' && settings.bitDepth === 'float32'"
          :options="[
            { value: 'off', label: t('bounce.options.off') },
            { value: 'tpdf', label: 'TPDF' }
          ]"
      /></label>
      <label v-if="settings.format === 'flac'"
        ><span>{{ t("bounce.fields.compression") }}</span
        ><UiNumberInput
          :model-value="settings.compressionLevel"
          :min="0"
          :max="8"
          @update:model-value="
            emit('updateSettings', { ...settings, compressionLevel: $event ?? 5 })
          "
      /></label>
    </template>
    <template v-else>
      <label
        ><span>{{ t("bounce.fields.bitrateMode") }}</span
        ><UiSelect
          v-model="mp3Mode"
          :options="[
            { value: 'cbr', label: 'CBR' },
            { value: 'vbr', label: 'VBR' }
          ]"
      /></label>
      <label v-if="settings.bitrate.mode === 'cbr'"
        ><span>{{ t("bounce.fields.bitrate") }}</span
        ><UiSelect
          :model-value="String(settings.bitrate.kbps)"
          :options="
            [128, 192, 256, 320].map((value) => ({ value: String(value), label: `${value} kbps` }))
          "
          @update:model-value="
            emit('updateSettings', {
              format: 'mp3',
              bitrate: { mode: 'cbr', kbps: Number($event) as 128 | 192 | 256 | 320 }
            })
          "
      /></label>
      <label v-else
        ><span>{{ t("bounce.fields.vbrQuality") }}</span
        ><UiNumberInput
          :model-value="settings.bitrate.quality"
          :min="0"
          :max="9"
          @update:model-value="
            emit('updateSettings', {
              format: 'mp3',
              bitrate: { mode: 'vbr', quality: $event ?? 2 }
            })
          "
      /></label>
    </template>
  </fieldset>
</template>
