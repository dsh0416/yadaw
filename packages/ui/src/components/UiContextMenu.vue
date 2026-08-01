<script setup lang="ts">
import { useTemplateRef, watch } from "vue"
import { ContextMenuContent, ContextMenuPortal, ContextMenuRoot, ContextMenuTrigger } from "reka-ui"
import type { UiMenuDensity, UiMenuEntry, UiMenuSearchOptions } from "../menu"
import UiMenuPanel from "./menu/UiMenuPanel.vue"

interface UiMenuPanelExposed {
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
    disabled?: boolean
    modal?: boolean
  }>(),
  {
    searchOptions: undefined,
    emptyMessage: "No commands available.",
    density: "compact",
    disabled: false,
    modal: false
  }
)

const emit = defineEmits<{
  select: [id: string]
  openContext: [event: MouseEvent]
}>()

const panel = useTemplateRef<UiMenuPanelExposed>("panel")

watch(open, (isOpen) => {
  if (!isOpen) search.value = ""
})

function choose(id: string): void {
  emit("select", id)
  open.value = false
}
</script>

<template>
  <ContextMenuRoot v-model:open="open" :modal="props.modal">
    <ContextMenuTrigger
      as-child
      :disabled="props.disabled"
      @contextmenu="emit('openContext', $event)"
    >
      <slot />
    </ContextMenuTrigger>
    <ContextMenuPortal>
      <ContextMenuContent
        class="ui-menu__content ui-menu__root-content"
        :collision-padding="8"
        :aria-label="props.menuLabel"
      >
        <UiMenuPanel
          ref="panel"
          :entries="props.entries"
          variant="context"
          :query="search"
          :search="props.searchOptions"
          :empty-message="props.emptyMessage"
          :density="props.density"
          @update:query="search = $event"
          @select="choose"
          @close="open = false"
        />
      </ContextMenuContent>
    </ContextMenuPortal>
  </ContextMenuRoot>
</template>
