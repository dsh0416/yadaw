<script setup lang="ts">
import { storeToRefs } from "pinia"
import { onMounted } from "vue"
import { useRouter } from "vue-router"
import type { AudioHostRuntimePreferences, AudioPreferences } from "@yadaw/contracts"
import PreferencesPage from "../components/preferences/PreferencesPage.vue"
import { useAudioPreferencesStore } from "../stores/audioPreferences"
import { useAudioRuntimeStore } from "../stores/audioRuntime"
import { useProjectStore } from "../stores/project"
import { useApplicationSettingsStore } from "../stores/applicationSettings"

const router = useRouter()
const audioPreferencesStore = useAudioPreferencesStore()
const audioRuntimeStore = useAudioRuntimeStore()
const projectStore = useProjectStore()
const applicationSettingsStore = useApplicationSettingsStore()
const { preferences, applyError, applyNotice, applying } = storeToRefs(audioPreferencesStore)
const { runtime } = storeToRefs(audioRuntimeStore)
const {
  settings: applicationSettings,
  applyingAudioRuntime,
  error: applicationSettingsError,
  resolvedAudioHostRuntime
} = storeToRefs(applicationSettingsStore)

function close(): void {
  void router.push({ name: projectStore.session ? "studio" : "welcome" })
}

async function save(nextPreferences: AudioPreferences): Promise<void> {
  if (await audioPreferencesStore.apply(nextPreferences)) {
    close()
  }
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
  <PreferencesPage
    :model-value="preferences"
    :runtime="runtime"
    :apply-error="applyError"
    :apply-notice="applyNotice"
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
    @cancel="close"
    @save="save"
    @configure-runtime="configureRuntime"
  />
</template>
