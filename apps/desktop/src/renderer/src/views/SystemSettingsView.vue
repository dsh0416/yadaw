<script setup lang="ts">
import { computed, onMounted } from "vue"
import { storeToRefs } from "pinia"
import { useRouter } from "vue-router"
import type {
  AudioHostRuntimePreferences,
  AudioPreferences,
  MidiSyncPreferences
} from "@yadaw/contracts"
import SystemSettingsPage from "../components/system-settings/SystemSettingsPage.vue"
import { useApplicationSettingsStore } from "../stores/applicationSettings"
import { useAudioPreferencesStore } from "../stores/audioPreferences"
import { useAudioRuntimeStore } from "../stores/audioRuntime"
import { useMidiInputStore } from "../stores/midiInput"
import { useProjectStore } from "../stores/project"

const router = useRouter()
const audioPreferencesStore = useAudioPreferencesStore()
const audioRuntimeStore = useAudioRuntimeStore()
const projectStore = useProjectStore()
const applicationSettingsStore = useApplicationSettingsStore()
const midiInputStore = useMidiInputStore()
const { preferences, applyError, applying } = storeToRefs(audioPreferencesStore)
const { runtime } = storeToRefs(audioRuntimeStore)
const {
  settings: applicationSettings,
  applyingAudioRuntime,
  error: applicationSettingsError,
  resolvedAudioHostRuntime
} = storeToRefs(applicationSettingsStore)
const {
  snapshot: midiSnapshot,
  applying: midiApplying,
  error: midiError
} = storeToRefs(midiInputStore)

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

async function configureMidi(preferences: MidiSyncPreferences): Promise<void> {
  await midiInputStore.configure(preferences)
}

onMounted(async () => {
  if (!applicationSettings.value) await applicationSettingsStore.load()
  await midiInputStore.load()
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
    :midi-preferences="
      applicationSettings?.midiSync ?? {
        enabled: false,
        sourcePortId: null,
        sourcePortName: null,
        inputOffsetsMs: {}
      }
    "
    :midi-snapshot="midiSnapshot"
    :midi-applying="midiApplying"
    :midi-error="midiError"
    :back-label="backLabel"
    @close="close"
    @apply-audio="applyAudio"
    @configure-runtime="configureRuntime"
    @configure-midi="configureMidi"
  />
</template>
