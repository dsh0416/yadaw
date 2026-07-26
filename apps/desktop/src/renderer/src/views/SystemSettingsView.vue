<script setup lang="ts">
import { computed, onMounted } from "vue"
import { storeToRefs } from "pinia"
import { useRouter } from "vue-router"
import type { AudioHostRuntimePreferences, AudioPreferences } from "@yadaw/contracts"
import SystemSettingsPage from "../components/system-settings/SystemSettingsPage.vue"
import { useApplicationSettingsStore } from "../stores/applicationSettings"
import { useAudioPreferencesStore } from "../stores/audioPreferences"
import { useAudioRuntimeStore } from "../stores/audioRuntime"
import { useProjectStore } from "../stores/project"

const router = useRouter()
const audioPreferencesStore = useAudioPreferencesStore()
const audioRuntimeStore = useAudioRuntimeStore()
const projectStore = useProjectStore()
const applicationSettingsStore = useApplicationSettingsStore()
const { preferences, applyError, applying } = storeToRefs(audioPreferencesStore)
const { runtime } = storeToRefs(audioRuntimeStore)
const {
  settings: applicationSettings,
  applyingAudioRuntime,
  error: applicationSettingsError,
  resolvedAudioHostRuntime
} = storeToRefs(applicationSettingsStore)

const backLabel = computed(() => (projectStore.session ? "Back to studio" : "Back to welcome"))

function close(): void {
  void router.push({ name: projectStore.session ? "studio" : "welcome" })
}

async function applyAudio(nextPreferences: AudioPreferences): Promise<void> {
  if (await audioPreferencesStore.apply(nextPreferences)) close()
}

async function refreshRuntimeDiagnostics(): Promise<void> {
  await applicationSettingsStore.refreshAudioHostRuntimeDiagnostics()
}

async function configureRuntime(preferences: AudioHostRuntimePreferences): Promise<void> {
  await applicationSettingsStore.configureAudioHostRuntime(preferences)
}

onMounted(async () => {
  if (!applicationSettings.value) await applicationSettingsStore.load()
  await refreshRuntimeDiagnostics()
})
</script>

<template>
  <SystemSettingsPage
    :model-value="preferences"
    :runtime="runtime"
    :apply-error="applyError"
    :applying="applying"
    :audio-host-runtime="
      applicationSettings?.audioHostRuntime ?? {
        workerThreads: 'auto',
        maxBlockingThreads: 'auto',
        egressConcurrency: 'auto'
      }
    "
    :resolved-audio-host-runtime="resolvedAudioHostRuntime"
    :audio-host-runtime-applying="applyingAudioRuntime"
    :audio-host-runtime-error="applicationSettingsError"
    :back-label="backLabel"
    @close="close"
    @apply-audio="applyAudio"
    @configure-runtime="configureRuntime"
  />
</template>
