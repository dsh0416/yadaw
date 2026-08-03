<script setup lang="ts">
import { computed } from "vue"
import { UiAlertDialog } from "@heron/ui"
import type { UiAlertAction } from "@heron/ui"
import { useGlobalDialog } from "../../composables/useGlobalDialog"

const { activeDialog, selectDialogAction, dismissDialog } = useGlobalDialog()

const open = computed({
  get: () => Boolean(activeDialog.value),
  set: (value: boolean) => {
    if (!value) dismissDialog()
  }
})

const tone = computed(() => {
  if (activeDialog.value?.tone === "danger") return "danger" as const
  if (activeDialog.value?.tone === "warning") return "warning" as const
  return "neutral" as const
})

const actions = computed<readonly UiAlertAction[]>(() =>
  (activeDialog.value?.actions ?? []).map((action) => ({
    value: action.value,
    label: action.label,
    cancel: action.kind === "cancel",
    variant:
      action.kind === "danger" ? "danger" : action.kind === "primary" ? "primary" : "secondary"
  }))
)
</script>

<template>
  <UiAlertDialog
    v-if="activeDialog"
    v-model="open"
    :eyebrow="activeDialog.eyebrow"
    :title="activeDialog.title"
    :description="activeDialog.description"
    :tone="tone"
    :actions="actions"
    @action="selectDialogAction"
  >
    <p v-if="activeDialog.detail" class="global-dialog-detail">
      {{ activeDialog.detail }}
    </p>
  </UiAlertDialog>
</template>

<style scoped>
.global-dialog-detail {
  margin: 0;
}
</style>
