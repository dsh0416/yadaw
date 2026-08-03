<script setup lang="ts">
import { onMounted, shallowRef } from "vue"
import { storeToRefs } from "pinia"
import { useRouter } from "vue-router"
import type { ProjectConfiguration } from "@heron/contracts"
import ProjectSettingsPage from "../components/project-settings/ProjectSettingsPage.vue"
import { useProjectStore } from "../stores/project"

const router = useRouter()
const projectStore = useProjectStore()
const { session } = storeToRefs(projectStore)
const saving = shallowRef(false)
const error = shallowRef("")
const saved = shallowRef(false)

onMounted(() => {
  if (!session.value) void router.replace({ name: "welcome" })
})

function close(): void {
  void router.push({ name: "studio" })
}

async function save(configuration: ProjectConfiguration): Promise<void> {
  saving.value = true
  error.value = ""
  saved.value = false
  try {
    await projectStore.updateConfiguration(configuration)
    saved.value = true
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "Unable to save project settings."
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <ProjectSettingsPage
    v-if="session"
    :configuration="session.configuration"
    :saving="saving"
    :error="error"
    :saved="saved"
    @save="save"
    @close="close"
  />
</template>
