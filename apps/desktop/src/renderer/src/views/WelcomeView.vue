<script setup lang="ts">
import { onMounted } from "vue"
import { storeToRefs } from "pinia"
import { useRouter } from "vue-router"
import ProjectWelcome from "../components/project/ProjectWelcome.vue"
import { useApplicationSettingsStore } from "../stores/applicationSettings"
import { useProjectStore } from "../stores/project"
import type { CreateProjectRequest } from "@yadaw/contracts"

const router = useRouter()
const settingsStore = useApplicationSettingsStore()
const projectStore = useProjectStore()
const { settings } = storeToRefs(settingsStore)
const { busy, error } = storeToRefs(projectStore)

onMounted(() => void settingsStore.load())

async function create(request: CreateProjectRequest): Promise<void> {
  if (await projectStore.create(request)) void router.push({ name: "studio" })
}
async function open(path?: string): Promise<void> {
  if (await projectStore.open(path)) void router.push({ name: "studio" })
}
</script>

<template>
  <ProjectWelcome :settings="settings" :busy="busy" :error="error" @create="create" @open="open" />
</template>
