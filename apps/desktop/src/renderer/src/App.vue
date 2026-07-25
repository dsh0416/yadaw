<script setup lang="ts">
import { ConfigProvider, TooltipProvider } from "reka-ui"
import { computed, onMounted, onUnmounted } from "vue"
import { storeToRefs } from "pinia"
import { RouterView } from "vue-router"
import { useTheme } from "./composables/useTheme"
import { useApplicationSettingsStore } from "./stores/applicationSettings"
import { useAudioPreferencesStore } from "./stores/audioPreferences"
import { useAudioRuntimeStore } from "./stores/audioRuntime"
import { useSystemPerformanceStore } from "./stores/systemPerformance"
import GlobalOperationHost from "./components/operations/GlobalOperationHost.vue"
import PendingRecordingHost from "./components/recording/PendingRecordingHost.vue"
import AudioBenchmarkHost from "./components/benchmark/AudioBenchmarkHost.vue"

const audioPreferencesStore = useAudioPreferencesStore()
const audioRuntimeStore = useAudioRuntimeStore()
const systemPerformanceStore = useSystemPerformanceStore()
const applicationSettingsStore = useApplicationSettingsStore()
const { settings } = storeToRefs(applicationSettingsStore)
const themePreference = computed(() => settings.value?.theme ?? "system")

useTheme(themePreference)

onMounted(() => {
  audioRuntimeStore.startPolling()
  systemPerformanceStore.startPolling()
  void audioPreferencesStore.restore()
  void applicationSettingsStore.load()
})

onUnmounted(() => {
  audioRuntimeStore.stopPolling()
  systemPerformanceStore.stopPolling()
})
</script>

<template>
  <ConfigProvider dir="ltr">
    <TooltipProvider :delay-duration="350" :skip-delay-duration="100">
      <RouterView />
      <PendingRecordingHost />
      <GlobalOperationHost />
      <AudioBenchmarkHost />
    </TooltipProvider>
  </ConfigProvider>
</template>
