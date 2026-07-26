<script setup lang="ts">
import { computed } from "vue"
import { storeToRefs } from "pinia"
import { UiDialog } from "@yadaw/ui"
import OperationProgressDialog from "./OperationProgressDialog.vue"
import { useOperationStore } from "../../stores/operations"

const store = useOperationStore()
const { active } = storeToRefs(store)

const open = computed({
  get: () => Boolean(active.value),
  set: (value: boolean) => {
    const operation = active.value
    if (!value && operation && operation.state !== "running") store.dismiss(operation.id)
  }
})
</script>

<template>
  <UiDialog
    v-if="active"
    v-model="open"
    eyebrow="Background operation"
    :title="active.title"
    :description="active.description ?? undefined"
    size="md"
    :dismissible="active.state !== 'running'"
  >
    <OperationProgressDialog :operation="active" @cancel="store.cancel(active.id)" />
  </UiDialog>
</template>
