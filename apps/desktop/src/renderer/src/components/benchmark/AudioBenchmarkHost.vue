<script setup lang="ts">
import { computed } from "vue"
import { storeToRefs } from "pinia"
import { useI18n } from "vue-i18n"
import { UiDialog } from "@yadaw/ui"
import AudioBenchmarkDialog from "./AudioBenchmarkDialog.vue"
import { useAudioBenchmarkStore } from "../../stores/audioBenchmark"

const { t } = useI18n()
const benchmark = useAudioBenchmarkStore()
const { isOpen, status, report, errorMessage } = storeToRefs(benchmark)
const open = computed({
  get: () => isOpen.value,
  set: (value: boolean) => {
    if (!value) benchmark.close()
  }
})
</script>

<template>
  <UiDialog
    v-if="isOpen"
    v-model="open"
    :title="t('benchmark.title')"
    :description="t('benchmark.description')"
    size="lg"
    :dismissible="status !== 'running'"
  >
    <AudioBenchmarkDialog
      :status="status"
      :report="report"
      :error-message="errorMessage"
      @close="benchmark.close"
      @run="benchmark.run"
    />
  </UiDialog>
</template>
