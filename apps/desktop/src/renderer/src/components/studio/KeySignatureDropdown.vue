<script setup lang="ts">
import { computed, useAttrs } from "vue"
import { useI18n } from "vue-i18n"
import {
  UiCascadingSelect,
  type UiCascadingSelectAppearance,
  type UiCascadingSelectGroup,
  type UiCascadingSelectHoverTreatment,
  type UiSelectSize
} from "@heron/ui"
import { MAJOR_KEY_SIGNATURE_CHOICES, MINOR_KEY_SIGNATURE_CHOICES } from "../../utils/keySignatures"

defineOptions({ inheritAttrs: false })

const model = defineModel<string>({ required: true })
const props = withDefaults(
  defineProps<{
    size?: UiSelectSize
    appearance?: UiCascadingSelectAppearance
    hoverTreatment?: UiCascadingSelectHoverTreatment
    disabled?: boolean
  }>(),
  {
    size: "compact",
    appearance: "default",
    hoverTreatment: "surface",
    disabled: false
  }
)

const attrs = useAttrs()
const { t } = useI18n()
const groups = computed<readonly UiCascadingSelectGroup[]>(() => [
  {
    label: t("studio.arrangement.majorKeys"),
    options: MAJOR_KEY_SIGNATURE_CHOICES
  },
  {
    label: t("studio.arrangement.minorKeys"),
    options: MINOR_KEY_SIGNATURE_CHOICES
  }
])
</script>

<template>
  <UiCascadingSelect
    v-model="model"
    v-bind="attrs"
    :groups="groups"
    :size="props.size"
    :appearance="props.appearance"
    :hover-treatment="props.hoverTreatment"
    :disabled="props.disabled"
  />
</template>
