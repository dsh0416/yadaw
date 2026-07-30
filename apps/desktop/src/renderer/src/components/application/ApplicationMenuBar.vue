<script setup lang="ts">
import { APPLICATION_COMMAND_IDS } from "@yadaw/contracts"
import type { ApplicationCommandId } from "@yadaw/contracts"
import { UiMenubar } from "@yadaw/ui"
import type { UiMenubarMenu } from "@yadaw/ui"
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
