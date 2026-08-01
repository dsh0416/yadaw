<script setup lang="ts">
import { computed } from "vue"
import type { UiMenuEntry } from "../menu"
import type { UiCascadingMenuItem } from "../types"
import UiDropdownMenu from "./UiDropdownMenu.vue"

const search = defineModel<string>("search", { default: "" })
const props = withDefaults(
  defineProps<{
    items: readonly UiCascadingMenuItem[]
    searchLabel: string
    searchPlaceholder?: string
    emptyMessage: string
    ariaLabel?: string
  }>(),
  {
    searchPlaceholder: "Search",
    ariaLabel: "Choose an option"
  }
)

const emit = defineEmits<{
  select: [value: string]
}>()

const entries = computed<readonly UiMenuEntry[]>(() => convertItems(props.items))

function convertItems(
  items: readonly UiCascadingMenuItem[],
  parentId = "legacy"
): readonly UiMenuEntry[] {
  return items.map((item, index) => {
    const id = item.value ?? `${parentId}:${index}:${item.label}`
    if (item.children) {
      return {
        kind: "submenu",
        id,
        label: item.label,
        ariaLabel: item.ariaLabel,
        title: item.title,
        disabled: item.disabled,
        children: convertItems(item.children, id)
      }
    }

    return {
      kind: "item",
      id,
      label: item.label,
      ariaLabel: item.ariaLabel,
      title: item.title,
      leading: item.leading,
      metadata: item.trailing,
      disabled: item.disabled || item.value === undefined
    }
  })
}
</script>

<template>
  <UiDropdownMenu
    v-model:search="search"
    :entries="entries"
    :menu-label="props.ariaLabel"
    :empty-message="props.emptyMessage"
    :search-options="{
      label: props.searchLabel,
      placeholder: props.searchPlaceholder,
      emptyMessage: props.emptyMessage
    }"
    @select="emit('select', $event)"
  >
    <slot />
  </UiDropdownMenu>
</template>
