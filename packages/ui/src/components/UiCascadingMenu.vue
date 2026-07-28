<script setup lang="ts">
import { shallowRef, useTemplateRef, watch } from "vue"
import {
  DropdownMenuContent,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuTrigger
} from "reka-ui"
import type { UiCascadingMenuItem } from "../types"
import UiCascadingMenuBranch from "./UiCascadingMenuBranch.vue"

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

const open = shallowRef(false)
const searchInput = useTemplateRef<HTMLInputElement>("searchInput")

watch(open, (isOpen) => {
  if (!isOpen) search.value = ""
})

function choose(value: string): void {
  emit("select", value)
  open.value = false
}

function focusSearch(event: Event): void {
  event.preventDefault()
  searchInput.value?.focus()
}

function handleSearchKeydown(event: KeyboardEvent): void {
  event.stopPropagation()
  if (event.key === "Escape") open.value = false
}
</script>

<template>
  <DropdownMenuRoot v-model:open="open" :modal="false">
    <DropdownMenuTrigger as-child>
      <slot />
    </DropdownMenuTrigger>
    <DropdownMenuPortal>
      <DropdownMenuContent
        class="ui-cascading-select__content ui-cascading-menu__content"
        align="start"
        :side-offset="4"
        :collision-padding="8"
        :aria-label="props.ariaLabel"
        @open-auto-focus="focusSearch"
      >
        <label class="ui-cascading-menu__search">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" />
            <path d="m10.5 10.5 3 3" />
          </svg>
          <input
            ref="searchInput"
            v-model="search"
            :aria-label="props.searchLabel"
            :placeholder="props.searchPlaceholder"
            @keydown="handleSearchKeydown"
          />
        </label>

        <p v-if="props.items.length === 0" class="ui-cascading-menu__empty" role="status">
          {{ props.emptyMessage }}
        </p>

        <UiCascadingMenuBranch
          v-for="item in props.items"
          :key="item.value ?? item.label"
          :item="item"
          @choose="choose"
        />
      </DropdownMenuContent>
    </DropdownMenuPortal>
  </DropdownMenuRoot>
</template>

<style>
.ui-cascading-menu__content {
  width: 224px;
}

.ui-cascading-menu__search {
  display: grid;
  grid-template-columns: 14px minmax(0, 1fr);
  align-items: center;
  gap: 5px;
  height: 28px;
  margin-bottom: 4px;
  padding: 0 7px;
  border: 1px solid var(--line-strong);
  border-radius: 4px;
  color: var(--text-faint);
  background: var(--daw-control);
}

.ui-cascading-menu__search:focus-within {
  border-color: var(--focus);
}

.ui-cascading-menu__search svg {
  width: 12px;
  height: 12px;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-width: 1.5;
}

.ui-cascading-menu__search input {
  min-width: 0;
  border: 0;
  outline: 0;
  color: var(--text-primary);
  background: transparent;
  font-size: var(--ui-type-size-control);
}

.ui-cascading-select__sub-content.ui-cascading-menu__sub-content--detailed {
  min-width: 260px;
}

.ui-cascading-select__item.ui-cascading-menu__item--detailed {
  grid-template-columns: 34px minmax(0, 1fr) auto;
  gap: 7px;
  min-height: 34px;
  padding: 0 8px;
}

.ui-cascading-select__item.ui-cascading-menu__item--detailed > strong {
  color: var(--accent);
  font: var(--ui-type-weight-bold) var(--ui-type-size-control) var(--ui-type-family-data);
  text-align: center;
  white-space: nowrap;
}

.ui-cascading-select__item.ui-cascading-menu__item--detailed > span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ui-cascading-select__item.ui-cascading-menu__item--detailed > small {
  color: var(--text-faint);
  font: var(--ui-type-size-micro) var(--ui-type-family-data);
  white-space: nowrap;
}

.ui-cascading-select__item.ui-cascading-menu__item--detailed[data-highlighted] > strong,
.ui-cascading-select__item.ui-cascading-menu__item--detailed[data-highlighted] > small {
  color: inherit;
}

.ui-cascading-menu__empty {
  margin: 7px 5px;
  color: var(--text-faint);
  font-size: var(--ui-type-size-control);
  line-height: var(--ui-type-leading-normal);
}
</style>
