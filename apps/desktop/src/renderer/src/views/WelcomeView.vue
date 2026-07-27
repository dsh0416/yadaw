<script setup lang="ts">
import { onMounted } from "vue"
import { storeToRefs } from "pinia"
import { useRouter } from "vue-router"
import ProjectWelcome from "../components/project/ProjectWelcome.vue"
import { useApplicationSettingsStore } from "../stores/applicationSettings"
import { useMixerStore } from "../stores/mixer"
import { useProjectStore } from "../stores/project"
import type { CreateProjectRequest } from "@yadaw/contracts"

const router = useRouter()
const settingsStore = useApplicationSettingsStore()
const mixerStore = useMixerStore()
const projectStore = useProjectStore()
const { settings } = storeToRefs(settingsStore)
const { busy, error } = storeToRefs(projectStore)

onMounted(() => void settingsStore.load())

async function create(request: CreateProjectRequest): Promise<void> {
  const workspace = await projectStore.create(request)
  if (!workspace) return
  mixerStore.hydrate(workspace.graph)
  void router.push({ name: "studio" })
}
async function open(path?: string): Promise<void> {
  const workspace = await projectStore.open(path)
  if (!workspace) return
  mixerStore.hydrate(workspace.graph)
  void router.push({ name: "studio" })
}
</script>

<template>
  <ProjectWelcome :settings="settings" :busy="busy" :error="error" @create="create" @open="open" />
</template>
