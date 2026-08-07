<script setup lang="ts">
import { useI18n } from "vue-i18n"
import { UiCheckbox, UiNumberInput } from "@heron/ui"

defineProps<{ startBar: number; endBar: number; maximumBar: number; includeTail: boolean }>()
const emit = defineEmits<{
  updateStartBar: [value: number]
  updateEndBar: [value: number]
  updateIncludeTail: [value: boolean]
}>()
const { t } = useI18n()
</script>

<template>
  <fieldset class="bounce-fieldset">
    <legend>{{ t("bounce.sections.range") }}</legend>
    <label
      ><span>{{ t("bounce.fields.startBar") }}</span
      ><UiNumberInput
        :model-value="startBar"
        :min="1"
        :max="maximumBar"
        :invalid="startBar < 1 || startBar > endBar"
        @update:model-value="emit('updateStartBar', $event ?? 1)"
    /></label>
    <label
      ><span>{{ t("bounce.fields.endBar") }}</span
      ><UiNumberInput
        :model-value="endBar"
        :min="startBar"
        :max="maximumBar"
        :invalid="endBar < startBar || endBar > maximumBar"
        @update:model-value="emit('updateEndBar', $event ?? maximumBar)"
    /></label>
    <p>{{ t("bounce.rangeHelp", { maximum: maximumBar }) }}</p>
    <div class="bounce-tail-option">
      <UiCheckbox
        :model-value="includeTail"
        :label="t('bounce.fields.includeTail')"
        :description="t('bounce.tailHelp')"
        @update:model-value="emit('updateIncludeTail', $event)"
      />
    </div>
  </fieldset>
</template>
