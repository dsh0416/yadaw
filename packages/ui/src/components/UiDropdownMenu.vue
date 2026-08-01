<script setup lang="ts">
import { nextTick, shallowRef, useTemplateRef, watch } from "vue"
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
  handlePanelKeydown(event: KeyboardEvent): void
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
const pendingSearchFocus = shallowRef(false)

watch(open, (isOpen) => {
  if (isOpen) return
  search.value = ""
  pendingSearchFocus.value = false
})

function choose(id: string): void {
  emit("select", id)
  open.value = false
}

function handleOpenAutoFocus(event: Event): void {
  if (!props.searchOptions) return
  event.preventDefault()
  pendingSearchFocus.value = true
  void nextTick(() => {
    panel.value?.focusSearch()
    pendingSearchFocus.value = false
  })
}

function handleContentKeydown(event: KeyboardEvent): void {
  if (pendingSearchFocus.value) return
  panel.value?.handlePanelKeydown(event)
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
        @keydown.capture="handleContentKeydown"
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
