<script setup lang="ts">
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import { UiNumberInput, UiSelect } from "@heron/ui"
import type { BounceNormalization } from "@heron/contracts"

const props = defineProps<{ modelValue: BounceNormalization }>()
const emit = defineEmits<{ "update:modelValue": [value: BounceNormalization] }>()
const { t } = useI18n()
const mode = computed({
  get: () => props.modelValue.mode,
  set: (value: string) =>
    emit(
      "update:modelValue",
      value === "true-peak"
        ? { mode: "true-peak", targetDbtp: -1 }
        : value === "off"
          ? { mode: "off" }
          : { mode: "overload-protection" }
    )
})
</script>

<template>
  <fieldset class="bounce-fieldset">
    <legend>{{ t("bounce.sections.normalization") }}</legend>
    <label
      ><span>{{ t("bounce.fields.normalization") }}</span
      ><UiSelect
        v-model="mode"
        :options="[
          { value: 'off', label: t('bounce.normalization.off') },
          { value: 'overload-protection', label: t('bounce.normalization.overload') },
          { value: 'true-peak', label: t('bounce.normalization.truePeak') }
        ]"
    /></label>
    <label v-if="modelValue.mode === 'true-peak'"
      ><span>{{ t("bounce.fields.truePeakTarget") }}</span
      ><UiNumberInput
        :model-value="modelValue.targetDbtp"
        :min="-12"
        :max="0"
        :step="0.1"
        @update:model-value="
          emit('update:modelValue', { mode: 'true-peak', targetDbtp: $event ?? -1 })
        "
    /></label>
  </fieldset>
</template>
