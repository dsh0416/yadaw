<script setup lang="ts">
import { APPLICATION_COMMAND_IDS } from "@heron/contracts"
import type { ApplicationCommandId } from "@heron/contracts"
import { UiMenubar } from "@heron/ui"
import type { UiMenubarMenu } from "@heron/ui"
import { useI18n } from "vue-i18n"

defineProps<{
  menus: UiMenubarMenu[]
}>()

const emit = defineEmits<{
  command: [command: ApplicationCommandId]
}>()

const { t } = useI18n()

function select(value: string): void {
  if (!APPLICATION_COMMAND_IDS.includes(value as ApplicationCommandId)) return
  emit("command", value as ApplicationCommandId)
}
</script>

<template>
  <UiMenubar
    class="application-menu-bar"
    :menus="menus"
    :aria-label="t('chrome.applicationMenu')"
    @select="select"
  />
</template>

<style scoped>
.application-menu-bar {
  app-region: no-drag;
  -webkit-app-region: no-drag;
}
</style>
