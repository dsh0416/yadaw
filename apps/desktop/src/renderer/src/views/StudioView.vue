<script setup lang="ts">
import { onMounted, ref } from "vue"
import { storeToRefs } from "pinia"
import { useRouter } from "vue-router"
import ArrangementWorkspace from "../components/studio/ArrangementWorkspace.vue"
import EngineInspector from "../components/studio/EngineInspector.vue"
import SoundBrowser from "../components/studio/SoundBrowser.vue"
import StudioStatusbar from "../components/studio/StudioStatusbar.vue"
import StudioTopbar from "../components/studio/StudioTopbar.vue"
import { useEngineStore } from "../stores/engine"
import { useAudioRuntimeStore } from "../stores/audioRuntime"
import { useProjectStore } from "../stores/project"
import { useRecordingStore } from "../stores/recording"

const router = useRouter()
const engineStore = useEngineStore()
const { nativeInfo, peak, error } = storeToRefs(engineStore)
const audioRuntimeStore = useAudioRuntimeStore()
const {
  runtime: audioRuntime,
  statistics: audioStatistics,
  warnings: audioWarnings
} = storeToRefs(audioRuntimeStore)
const gainValues = ref([0.5])
const projectStore = useProjectStore()
const recordingStore = useRecordingStore()
const { session, projectAssets } = storeToRefs(projectStore)
const { active: activeRecording } = storeToRefs(recordingStore)

onMounted(() => {
  if (!session.value) void router.replace({ name: "welcome" })
  void engineStore.initialize()
})
function openPreferences(): void { void router.push({ name: "preferences" }) }
function openProjectSettings(): void { void router.push({ name: "project-settings" }) }
function runNativePreview(): void { void engineStore.runPreview(gainValues.value[0] ?? 0.5) }
async function closeProject(): Promise<void> {
  if (await projectStore.close()) void router.push({ name: "welcome" })
}
</script>

<template>
  <main v-if="session" class="studio-shell">
    <StudioTopbar :native-info="nativeInfo" :engine-running="audioRuntime.state === 'running'" :project="session.configuration" :recording="Boolean(activeRecording)" :dirty="session.dirty" @open-preferences="openPreferences" @toggle-recording="recordingStore.toggle" @save="projectStore.save" @close="closeProject" @open-project-settings="openProjectSettings" />
    <SoundBrowser :assets="projectAssets" />
    <ArrangementWorkspace />
    <EngineInspector v-model="gainValues" :runtime="audioRuntime" :peak="peak" :error="error" @run-preview="runNativePreview" />
    <StudioStatusbar :runtime="audioRuntime" :statistics="audioStatistics" :audio-warnings="audioWarnings" />
  </main>
</template>

<style scoped>
.studio-shell{display:grid;grid-template:56px minmax(0,1fr) 25px/214px minmax(0,1fr) 258px;width:100vw;height:100vh;color:var(--text-primary);background:var(--canvas)}
@media(max-width:1100px){.studio-shell{grid-template-columns:184px minmax(0,1fr) 228px}}
</style>
