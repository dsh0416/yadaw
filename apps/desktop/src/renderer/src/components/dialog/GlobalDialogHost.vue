<script setup lang="ts">
import { computed } from "vue"
import { UiAlertDialog } from "@yadaw/ui"
import type { UiAlertAction } from "@yadaw/ui"
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
    :title="activeDialog.title"
    :description="activeDialog.description"
    :tone="tone"
    :actions="actions"
    @action="selectDialogAction"
  >
    <p v-if="activeDialog.eyebrow" class="global-dialog-eyebrow">
      {{ activeDialog.eyebrow }}
    </p>
    <p v-if="activeDialog.detail" class="global-dialog-detail">
      {{ activeDialog.detail }}
    </p>
  </UiAlertDialog>
</template>

<style scoped>
.global-dialog-eyebrow {
  margin: 0 0 var(--ui-space-2);
  color: var(--ui-color-text-subtle);
  font: var(--ui-weight-semibold) var(--ui-font-size-xs) var(--ui-font-mono);
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.global-dialog-detail {
  margin: 0;
}
</style>
