<script setup lang="ts">
import { computed } from "vue"
import { storeToRefs } from "pinia"
import { useI18n } from "vue-i18n"
import { UiDialog } from "@yadaw/ui"
import { useCompiledEffectGraphStore } from "../../stores/compiledEffectGraph"
import CompiledEffectGraphPanel from "./CompiledEffectGraphPanel.vue"

const { t } = useI18n()
const graphStore = useCompiledEffectGraphStore()
const { isOpen, status, snapshot, errorMessage } = storeToRefs(graphStore)
const open = computed({
  get: () => isOpen.value,
  set: (value: boolean) => {
    if (!value) graphStore.close()
  }
})
</script>

<template>
  <UiDialog
    v-if="isOpen"
    v-model="open"
    :title="t('effectGraph.title')"
    :description="t('effectGraph.description')"
    size="lg"
  >
    <CompiledEffectGraphPanel
      :status="status"
      :snapshot="snapshot"
      :error-message="errorMessage"
      @retry="graphStore.refresh"
    />
  </UiDialog>
</template>
