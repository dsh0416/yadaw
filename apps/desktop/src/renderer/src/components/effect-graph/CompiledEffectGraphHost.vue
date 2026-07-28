<script setup lang="ts">
import { computed } from "vue"
import { storeToRefs } from "pinia"
import { UiDialog } from "@yadaw/ui"
import { useCompiledEffectGraphStore } from "../../stores/compiledEffectGraph"
import CompiledEffectGraphPanel from "./CompiledEffectGraphPanel.vue"

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
    title="Effect chain graph"
    description="The currently published native audio topology, including adapters and latency compensation."
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
