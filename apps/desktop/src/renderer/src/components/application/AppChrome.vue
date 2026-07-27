<script setup lang="ts">
import { computed } from "vue"
import { storeToRefs } from "pinia"
import AppTitleBar from "./AppTitleBar.vue"
import { useApplicationCommands } from "../../composables/useApplicationCommands"
import { useApplicationWindowStore } from "../../stores/applicationWindow"
import { useProjectStore } from "../../stores/project"

const projectStore = useProjectStore()
const applicationWindowStore = useApplicationWindowStore()
const { session } = storeToRefs(projectStore)
const { platform, menus, execute } = useApplicationCommands()
const projectName = computed(() => session.value?.configuration.name ?? null)
const dirty = computed(() => session.value?.dirty ?? false)
</script>

<template>
  <div class="app-chrome">
    <AppTitleBar
      :platform="platform"
      :menus="menus"
      :project-name="projectName"
      :dirty="dirty"
      @command="execute"
      @window-command="applicationWindowStore.execute"
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
