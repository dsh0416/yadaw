<script setup lang="ts">
import { computed } from "vue"
import { storeToRefs } from "pinia"
import { useI18n } from "vue-i18n"
import { UiDialog } from "@heron/ui"
import { useAboutStore } from "../../stores/about"
import { useApplicationWindowStore } from "../../stores/applicationWindow"
import AboutHeronPanel from "./AboutHeronPanel.vue"

const { t } = useI18n()
const aboutStore = useAboutStore()
const applicationWindowStore = useApplicationWindowStore()
const { isOpen } = storeToRefs(aboutStore)
const appVersion = __APP_VERSION__
const open = computed({
  get: () => isOpen.value,
  set: (value: boolean) => {
    if (!value) aboutStore.close()
  }
})
</script>

<template>
  <UiDialog
    v-if="isOpen"
    v-model="open"
    :title="t('app.about')"
    :close-label="t('about.close')"
    size="sm"
  >
    <AboutHeronPanel :version="appVersion" :platform="applicationWindowStore.platform" />
  </UiDialog>
</template>
