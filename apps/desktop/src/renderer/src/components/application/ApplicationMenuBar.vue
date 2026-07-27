<script setup lang="ts">
import { APPLICATION_COMMAND_IDS } from "@yadaw/contracts"
import type { ApplicationCommandId } from "@yadaw/contracts"
import { UiMenubar } from "@yadaw/ui"
import type { UiMenubarMenu } from "@yadaw/ui"

defineProps<{
  menus: UiMenubarMenu[]
}>()

const emit = defineEmits<{
  command: [command: ApplicationCommandId]
}>()

function select(value: string): void {
  if (!APPLICATION_COMMAND_IDS.includes(value as ApplicationCommandId)) return
  emit("command", value as ApplicationCommandId)
}
</script>

<template>
  <UiMenubar
    class="application-menu-bar"
    :menus="menus"
    aria-label="Application menu"
    @select="select"
  />
</template>

<style scoped>
.application-menu-bar {
  app-region: no-drag;
  -webkit-app-region: no-drag;
}
</style>
