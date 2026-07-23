<script setup lang="ts">
import { storeToRefs } from "pinia"
import { useRouter } from "vue-router"
import type { AudioPreferences } from "@yadaw/contracts"
import PreferencesPage from "../components/preferences/PreferencesPage.vue"
import { useAudioPreferencesStore } from "../stores/audioPreferences"
import { useAudioRuntimeStore } from "../stores/audioRuntime"
import { useProjectStore } from "../stores/project"

const router = useRouter()
const audioPreferencesStore = useAudioPreferencesStore()
const audioRuntimeStore = useAudioRuntimeStore()
const projectStore = useProjectStore()
const { preferences, applyError, applyNotice, applying } = storeToRefs(audioPreferencesStore)
const { runtime } = storeToRefs(audioRuntimeStore)

function close(): void {
  void router.push({ name: projectStore.session ? "studio" : "welcome" })
}

async function save(nextPreferences: AudioPreferences): Promise<void> {
  if (await audioPreferencesStore.apply(nextPreferences)) {
    close()
  }
}
</script>

<template>
  <PreferencesPage
    :model-value="preferences"
    :runtime="runtime"
    :apply-error="applyError"
    :apply-notice="applyNotice"
    :applying="applying"
    @cancel="close"
    @save="save"
  />
</template>
