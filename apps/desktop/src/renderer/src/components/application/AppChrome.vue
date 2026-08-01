<script setup lang="ts">
import type {
  ApplicationCommandId,
  ApplicationWindowCommandId,
  DesktopPlatform
} from "@yadaw/contracts"
import type { UiMenubarMenu } from "@yadaw/ui"
import { computed } from "vue"
import { storeToRefs } from "pinia"
import AppTitleBar from "./AppTitleBar.vue"
import { useApplicationWindowStore } from "../../stores/applicationWindow"
import { useProjectStore } from "../../stores/project"

defineProps<{
  platform: DesktopPlatform
  menus: UiMenubarMenu[]
}>()

const emit = defineEmits<{
  command: [command: ApplicationCommandId]
}>()

const projectStore = useProjectStore()
const applicationWindowStore = useApplicationWindowStore()
const { hasUnsavedChanges, session } = storeToRefs(projectStore)
const projectName = computed(() => session.value?.configuration.name ?? null)

function executeWindowCommand(command: ApplicationWindowCommandId): void {
  if (command === "window.close") {
    emit("command", command)
    return
  }
  void applicationWindowStore.execute(command)
}
</script>

<template>
  <div class="app-chrome">
    <AppTitleBar
      :platform="platform"
      :menus="menus"
      :project-name="projectName"
      :dirty="hasUnsavedChanges"
      @command="emit('command', $event)"
      @window-command="executeWindowCommand"
    />
    <div class="app-chrome__content">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.app-chrome {
  display: grid;
  grid-template-rows: 38px minmax(0, 1fr);
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: var(--canvas);
}

.app-chrome__content {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
</style>
