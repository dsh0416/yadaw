<script setup lang="ts">
import { UiProvider, useLocaleFonts } from "@yadaw/ui"
import { useEventListener } from "@vueuse/core"
import { computed, onMounted, onUnmounted, watch } from "vue"
import { storeToRefs } from "pinia"
import { useTheme } from "./composables/useTheme"
import { setAppLocale } from "./i18n"
import { useApplicationSettingsStore } from "./stores/applicationSettings"
import { useAudioPreferencesStore } from "./stores/audioPreferences"
import { useAudioRuntimeStore } from "./stores/audioRuntime"
import { useSystemPerformanceStore } from "./stores/systemPerformance"
import { useLifecycleStore } from "./stores/lifecycle"
import { useOperationStore } from "./stores/operations"
import { useApplicationWindowStore } from "./stores/applicationWindow"
import { useMidiInputStore } from "./stores/midiInput"
import GlobalOperationHost from "./components/operations/GlobalOperationHost.vue"
import AudioBenchmarkHost from "./components/benchmark/AudioBenchmarkHost.vue"
import CompiledEffectGraphHost from "./components/effect-graph/CompiledEffectGraphHost.vue"
import GlobalDialogHost from "./components/dialog/GlobalDialogHost.vue"
import AppChrome from "./components/application/AppChrome.vue"
import AppRouteView from "./components/application/AppRouteView.vue"
import { DEFAULT_LOCALE, rekaLocale } from "../../shared/i18n"

const audioPreferencesStore = useAudioPreferencesStore()
const audioRuntimeStore = useAudioRuntimeStore()
const systemPerformanceStore = useSystemPerformanceStore()
const applicationSettingsStore = useApplicationSettingsStore()
const lifecycleStore = useLifecycleStore()
const operationStore = useOperationStore()
const applicationWindowStore = useApplicationWindowStore()
const midiInputStore = useMidiInputStore()
const { settings } = storeToRefs(applicationSettingsStore)
const { ready: lifecycleReady } = storeToRefs(lifecycleStore)
const { audioHostRef } = storeToRefs(audioRuntimeStore)
const themePreference = computed(() => settings.value?.theme ?? "system")
const documentLocale = computed(() => settings.value?.locale ?? DEFAULT_LOCALE)
const uiLocale = computed(() => rekaLocale(documentLocale.value))

useLocaleFonts(documentLocale)

const { resolvedTheme } = useTheme(themePreference)

watch(
  resolvedTheme,
  (theme) => {
    void applicationWindowStore.setTheme(theme)
  },
  { immediate: true }
)

watch(
  () => settings.value?.locale,
  (locale) => {
    if (locale) setAppLocale(locale)
  }
)

watch(
  audioHostRef,
  (host) => {
    if (host) void audioPreferencesStore.restore()
  },
  { immediate: true }
)

function stopRuntimePolling(): void {
  audioRuntimeStore.stopPolling()
  systemPerformanceStore.stopPolling()
}

useEventListener(window, "beforeunload", stopRuntimePolling)

onMounted(() => {
  operationStore.startSubscription()
  void lifecycleStore.initialize()
  audioRuntimeStore.startPolling()
  systemPerformanceStore.startPolling()
  void applicationSettingsStore.load()
  void midiInputStore.load()
})

onUnmounted(() => {
  lifecycleStore.dispose()
  operationStore.stopSubscription()
  midiInputStore.dispose()
  stopRuntimePolling()
})
</script>

<template>
  <UiProvider dir="ltr" :locale="uiLocale" :tooltip-delay="350" :tooltip-skip-delay="100">
    <AppChrome v-if="lifecycleReady">
      <AppRouteView />
    </AppChrome>
    <GlobalOperationHost />
    <AudioBenchmarkHost />
    <CompiledEffectGraphHost />
    <GlobalDialogHost />
  </UiProvider>
</template>
