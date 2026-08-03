<script setup lang="ts">
import { computed } from "vue"
import { storeToRefs } from "pinia"
import { UiDialog } from "@heron/ui"
import { useI18n } from "vue-i18n"
import OperationProgressDialog from "./OperationProgressDialog.vue"
import { useOperationStore } from "../../stores/operations"

const store = useOperationStore()
const { active } = storeToRefs(store)
const { t } = useI18n()

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
    :title="t('operation.eyebrow')"
    size="sm"
    :dismissible="active.state !== 'running'"
  >
    <OperationProgressDialog :operation="active" @cancel="store.cancel(active.id)" />
  </UiDialog>
</template>
