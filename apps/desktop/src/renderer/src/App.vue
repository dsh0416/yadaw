<script setup lang="ts">
import { UiProvider } from "@yadaw/ui"
import { computed, onMounted, onUnmounted, watch } from "vue"
import { storeToRefs } from "pinia"
import { useTheme } from "./composables/useTheme"
import { useApplicationSettingsStore } from "./stores/applicationSettings"
import { useAudioPreferencesStore } from "./stores/audioPreferences"
import { useAudioRuntimeStore } from "./stores/audioRuntime"
import { useSystemPerformanceStore } from "./stores/systemPerformance"
import { useLifecycleStore } from "./stores/lifecycle"
import { useOperationStore } from "./stores/operations"
import { useApplicationWindowStore } from "./stores/applicationWindow"
import GlobalOperationHost from "./components/operations/GlobalOperationHost.vue"
import AudioBenchmarkHost from "./components/benchmark/AudioBenchmarkHost.vue"
import GlobalDialogHost from "./components/dialog/GlobalDialogHost.vue"
import AppChrome from "./components/application/AppChrome.vue"
import AppRouteView from "./components/application/AppRouteView.vue"

const audioPreferencesStore = useAudioPreferencesStore()
const audioRuntimeStore = useAudioRuntimeStore()
const systemPerformanceStore = useSystemPerformanceStore()
const applicationSettingsStore = useApplicationSettingsStore()
const lifecycleStore = useLifecycleStore()
const operationStore = useOperationStore()
const applicationWindowStore = useApplicationWindowStore()
const { settings } = storeToRefs(applicationSettingsStore)
const { ready: lifecycleReady } = storeToRefs(lifecycleStore)
const themePreference = computed(() => settings.value?.theme ?? "system")

const { resolvedTheme } = useTheme(themePreference)

watch(
  resolvedTheme,
  (theme) => {
    void applicationWindowStore.setTheme(theme)
  },
  { immediate: true }
)

function stopRuntimePolling(): void {
  audioRuntimeStore.stopPolling()
  systemPerformanceStore.stopPolling()
}

onMounted(() => {
  operationStore.startSubscription()
  void lifecycleStore.initialize()
  audioRuntimeStore.startPolling()
  systemPerformanceStore.startPolling()
  void audioPreferencesStore.restore()
  void applicationSettingsStore.load()
  window.addEventListener("beforeunload", stopRuntimePolling)
})

onUnmounted(() => {
  window.removeEventListener("beforeunload", stopRuntimePolling)
  lifecycleStore.dispose()
  operationStore.stopSubscription()
  stopRuntimePolling()
})
</script>

<template>
  <UiProvider dir="ltr" :tooltip-delay="350" :tooltip-skip-delay="100">
    <AppChrome v-if="lifecycleReady">
      <AppRouteView />
    </AppChrome>
    <GlobalOperationHost />
    <AudioBenchmarkHost />
    <GlobalDialogHost />
  </UiProvider>
</template>
