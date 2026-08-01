<script setup lang="ts">
import { nextTick, useTemplateRef, watch } from "vue"
import {
  DropdownMenuContent,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuTrigger
} from "reka-ui"
import type { UiMenuDensity, UiMenuEntry, UiMenuSearchOptions } from "../menu"
import UiMenuPanel from "./menu/UiMenuPanel.vue"

interface UiMenuPanelExposed {
  focusSearch(): void
}

const open = defineModel<boolean>("open", { default: false })
const search = defineModel<string>("search", { default: "" })
const props = withDefaults(
  defineProps<{
    entries: readonly UiMenuEntry[]
    menuLabel: string
    searchOptions?: UiMenuSearchOptions
    emptyMessage?: string
    density?: UiMenuDensity
    modal?: boolean
  }>(),
  {
    searchOptions: undefined,
    emptyMessage: "No commands available.",
    density: "compact",
    modal: false
  }
)

const emit = defineEmits<{
  select: [id: string]
}>()

const panel = useTemplateRef<UiMenuPanelExposed>("panel")

watch(open, (isOpen) => {
  if (isOpen) return
  search.value = ""
})

function choose(id: string): void {
  emit("select", id)
  open.value = false
}

function handleOpenAutoFocus(event: Event): void {
  if (!props.searchOptions) return
  event.preventDefault()
  void nextTick(() => {
    panel.value?.focusSearch()
  })
}
</script>

<template>
  <DropdownMenuRoot v-model:open="open" :modal="props.modal">
    <DropdownMenuTrigger as-child>
      <slot />
    </DropdownMenuTrigger>
    <DropdownMenuPortal>
      <DropdownMenuContent
        class="ui-menu__content ui-menu__root-content"
        align="start"
        :side-offset="4"
        :collision-padding="8"
        :aria-label="props.menuLabel"
        @open-auto-focus="handleOpenAutoFocus"
      >
        <UiMenuPanel
          ref="panel"
          :entries="props.entries"
          variant="dropdown"
          :query="search"
          :search="props.searchOptions"
          :empty-message="props.emptyMessage"
          :density="props.density"
          @update:query="search = $event"
          @select="choose"
          @close="open = false"
        />
      </DropdownMenuContent>
    </DropdownMenuPortal>
  </DropdownMenuRoot>
</template>
