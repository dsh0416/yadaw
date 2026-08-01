<script setup lang="ts">
import { computed, nextTick, useTemplateRef } from "vue"
import type { UiMenuDensity, UiMenuEntry, UiMenuSearchOptions } from "../../menu"
import { menuHasDetails, searchMenuEntries } from "../../menu"
import UiMenuBranch from "./UiMenuBranch.vue"

const props = withDefaults(
  defineProps<{
    entries: readonly UiMenuEntry[]
    variant: "context" | "dropdown"
    query: string
    density?: UiMenuDensity
    search?: UiMenuSearchOptions
    emptyMessage?: string
  }>(),
  {
    search: undefined,
    density: "compact",
    emptyMessage: "No commands available."
  }
)

const emit = defineEmits<{
  select: [id: string]
  "update:query": [value: string]
  close: []
}>()

const searchInput = useTemplateRef<HTMLInputElement>("searchInput")
const panel = useTemplateRef<HTMLElement>("panel")
const normalizedQuery = computed(() => props.query.trim())
const searchResults = computed(() =>
  searchMenuEntries(props.entries, props.query, props.search?.maxResults)
)
const visibleEntries = computed(() =>
  normalizedQuery.value ? searchResults.value.entries : props.entries
)
const isEmpty = computed(() => visibleEntries.value.length === 0)
const emptyCopy = computed(() =>
  normalizedQuery.value ? props.search?.emptyMessage : props.emptyMessage
)
const resultCountCopy = computed(() => {
  if (!normalizedQuery.value) return ""
  const template = props.search?.resultCountLabel ?? "{count} results"
  return template.replace("{count}", String(searchResults.value.total))
})
const panelClasses = computed(() => ({
  [`ui-menu__panel--${props.density}`]: true,
  "ui-menu__panel--searchable": Boolean(props.search),
  "ui-menu__panel--detailed": Boolean(normalizedQuery.value) || menuHasDetails(visibleEntries.value)
}))

function focusSearch(): void {
  searchInput.value?.focus()
}

function handleSearchKeydown(event: KeyboardEvent): void {
  event.stopPropagation()
  if (event.isComposing) return

  if (event.key === "ArrowDown") {
    event.preventDefault()
    focusFirstItem()
    return
  }

  if (event.key !== "Escape") return
  event.preventDefault()
  if (props.query) emit("update:query", "")
  else emit("close")
}

function handlePanelKeydown(event: KeyboardEvent): void {
  if (!props.search || event.isComposing) return

  const firstItem = panel.value?.querySelector<HTMLElement>(".ui-menu__item:not([data-disabled])")
  if (event.key === "ArrowUp" && event.target === firstItem) {
    event.preventDefault()
    event.stopPropagation()
    focusSearch()
    return
  }

  const isSearchInput = event.target === searchInput.value
  const isSearchShortcut =
    !isSearchInput &&
    (((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "f") ||
      event.key === "/")
  if (isSearchShortcut) {
    event.preventDefault()
    event.stopPropagation()
    focusSearch()
    return
  }

  if (isSearchInput || event.ctrlKey || event.metaKey || event.altKey || event.key.length !== 1) {
    return
  }

  event.preventDefault()
  event.stopPropagation()
  emit("update:query", props.query + event.key)
  void nextTick(focusSearch)
}

function focusFirstItem(): void {
  panel.value?.querySelector<HTMLElement>(".ui-menu__item:not([data-disabled])")?.focus()
}

defineExpose({
  focusSearch,
  handlePanelKeydown
})
</script>

<template>
  <div
    ref="panel"
    class="ui-menu__panel"
    :class="panelClasses"
    @keydown.capture="handlePanelKeydown"
  >
    <label v-if="props.search" class="ui-menu__search">
      <svg class="ui-menu__search-icon" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="7" cy="7" r="4.5" />
        <path d="m10.5 10.5 3 3" />
      </svg>
      <input
        ref="searchInput"
        class="ui-menu__search-input"
        :value="props.query"
        :aria-label="props.search.label"
        :placeholder="props.search.placeholder ?? 'Search'"
        @input="emit('update:query', ($event.target as HTMLInputElement).value)"
        @keydown="handleSearchKeydown"
      />
      <button
        v-if="props.query"
        type="button"
        class="ui-menu__search-clear"
        :aria-label="props.search.clearLabel ?? 'Clear search'"
        tabindex="-1"
        @click="emit('update:query', '')"
      >
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <path d="m3 3 6 6m0-6-6 6" />
        </svg>
      </button>
    </label>

    <span v-if="normalizedQuery" class="ui-menu__search-status" role="status" aria-live="polite">
      {{ resultCountCopy }}
    </span>

    <p v-if="isEmpty" class="ui-menu__empty" role="status">
      {{ emptyCopy }}
    </p>
    <UiMenuBranch
      v-else
      :entries="visibleEntries"
      :variant="props.variant"
      @select="emit('select', $event)"
    />
  </div>
</template>

<style>
.ui-menu__content {
  z-index: var(--ui-z-dropdown);
  min-width: 180px;
  max-width: min(320px, calc(100vw - 16px));
  max-height: min(420px, calc(100dvh - 16px));
  padding: 5px;
  overflow-x: hidden;
  overflow-y: auto;
  border: 1px solid var(--ui-color-menu-border);
  border-radius: 7px;
  color: var(--ui-color-menu-text-muted);
  background: var(--ui-color-menu-surface);
  box-shadow: var(--ui-shadow-md);
  animation: ui-menu-in var(--ui-motion-fast) var(--ui-ease-standard);
}

.ui-menu__content::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

.ui-menu__content::-webkit-scrollbar-button {
  display: none;
  width: 0;
  height: 0;
}

.ui-menu__content::-webkit-scrollbar-track,
.ui-menu__content::-webkit-scrollbar-corner {
  background: transparent;
}

.ui-menu__content::-webkit-scrollbar-thumb {
  min-height: 24px;
  border: 2px solid transparent;
  border-radius: 999px;
  background: color-mix(in srgb, var(--ui-color-menu-text-subtle) 72%, transparent);
  background-clip: padding-box;
}

.ui-menu__content::-webkit-scrollbar-thumb:hover {
  background: var(--ui-color-menu-text-muted);
  background-clip: padding-box;
}

.ui-menu__content::-webkit-scrollbar-thumb:active {
  background: var(--ui-color-menu-accent);
  background-clip: padding-box;
}

@supports not selector(::-webkit-scrollbar) {
  .ui-menu__content {
    scrollbar-color: color-mix(in srgb, var(--ui-color-menu-text-subtle) 72%, transparent)
      transparent;
    scrollbar-width: thin;
  }
}

.ui-menu__root-content {
  width: 220px;
}

.ui-menu__root-content:has(.ui-menu__panel--standard) {
  width: 240px;
  padding: 6px;
  border-radius: var(--ui-radius-md);
}

.ui-menu__root-content:has(.ui-menu__panel--detailed),
.ui-menu__root-content:has(.ui-menu__panel--searchable) {
  width: min(260px, calc(100vw - 16px));
}

.ui-menu__root-content:has(.ui-menu__panel--standard.ui-menu__panel--detailed),
.ui-menu__root-content:has(.ui-menu__panel--standard.ui-menu__panel--searchable) {
  width: min(280px, calc(100vw - 16px));
}

.ui-menu__sub-content {
  min-width: 190px;
}

.ui-menu__content--detailed {
  min-width: 260px;
}

.ui-menu__panel {
  display: contents;
}

.ui-menu__item {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  min-height: 28px;
  padding: 0 8px;
  border-radius: var(--ui-radius-sm);
  outline: none;
  font: var(--ui-type-weight-regular) var(--ui-type-size-body-compact)
    var(--ui-type-family-interface);
  cursor: default;
  user-select: none;
}

.ui-menu__panel--standard .ui-menu__item {
  min-height: var(--ui-control-sm);
  padding-inline: 10px;
  font-size: var(--ui-font-size-xs);
}

.ui-menu__item--leading,
.ui-menu__item--select {
  grid-template-columns: 16px minmax(0, 1fr) auto;
  column-gap: 7px;
}

.ui-menu__sub-trigger {
  grid-template-columns: minmax(0, 1fr) auto 12px;
  column-gap: 12px;
}

.ui-menu__sub-trigger.ui-menu__item--leading {
  grid-template-columns: 16px minmax(0, 1fr) auto 12px;
  column-gap: 7px;
}

.ui-menu__item[data-highlighted],
.ui-menu__sub-trigger[data-state="open"] {
  color: var(--ui-color-menu-text);
  background: var(--ui-color-menu-highlight);
  box-shadow: var(--ui-shadow-menu-highlight);
}

.ui-menu__item--danger:not([data-highlighted]) {
  color: var(--ui-color-danger);
}

.ui-menu__item[data-disabled] {
  opacity: var(--ui-opacity-disabled);
  color: var(--ui-color-menu-text-subtle);
  pointer-events: none;
}

.ui-menu__label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ui-menu__leading {
  min-width: 0;
  color: var(--ui-color-menu-accent);
  font: var(--ui-type-weight-semibold) var(--ui-type-size-control) var(--ui-type-family-data);
  text-align: center;
  white-space: nowrap;
}

.ui-menu__metadata,
.ui-menu__shortcut {
  color: var(--ui-color-menu-text-subtle);
  font: var(--ui-type-size-micro) var(--ui-type-family-data);
  white-space: nowrap;
}

.ui-menu__shortcut {
  border: 0;
  background: transparent;
}

.ui-menu__item[data-highlighted] :is(.ui-menu__leading, .ui-menu__metadata, .ui-menu__shortcut),
.ui-menu__sub-trigger[data-state="open"]
  :is(.ui-menu__leading, .ui-menu__metadata, .ui-menu__shortcut) {
  color: inherit;
}

.ui-menu__submenu-chevron {
  width: 12px;
  height: 12px;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.5;
}

[dir="rtl"] .ui-menu__submenu-chevron {
  transform: scaleX(-1);
}

.ui-menu__indicator-slot,
.ui-menu__indicator {
  display: grid;
  place-items: center;
  width: 14px;
  height: 14px;
}

.ui-menu__indicator {
  color: var(--ui-color-menu-accent);
}

.ui-menu__indicator svg {
  width: 12px;
  height: 12px;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.7;
}

.ui-menu__item[data-highlighted] .ui-menu__indicator {
  color: inherit;
}

.ui-menu__group-label {
  display: flex;
  align-items: end;
  min-height: 22px;
  padding: 6px 8px 3px;
  color: var(--ui-color-menu-text-subtle);
  font: var(--ui-type-weight-semibold) var(--ui-type-size-control) var(--ui-type-family-interface);
}

.ui-menu__separator {
  height: 1px;
  margin: 4px 6px;
  background: var(--ui-color-menu-divider);
}

.ui-menu__search {
  display: grid;
  grid-template-columns: 14px minmax(0, 1fr) 18px;
  align-items: center;
  gap: 5px;
  min-height: 28px;
  margin-bottom: 4px;
  padding: 0 5px 0 7px;
  border: 1px solid var(--ui-color-menu-border);
  border-radius: var(--ui-radius-sm);
  color: var(--ui-color-menu-text-subtle);
  background: var(--ui-color-menu-control);
}

.ui-menu__panel--standard .ui-menu__search {
  min-height: var(--ui-control-sm);
}

.ui-menu__search:focus-within {
  border-color: var(--ui-color-menu-accent);
  box-shadow: var(--ui-shadow-menu-focus-ring);
}

.ui-menu__search-icon,
.ui-menu__search-clear svg {
  width: 12px;
  height: 12px;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-width: 1.5;
}

.ui-menu__search-input {
  min-width: 0;
  border: 0;
  outline: 0;
  color: var(--ui-color-menu-text);
  background: transparent;
  font: var(--ui-type-size-control) var(--ui-type-family-interface);
}

.ui-menu__panel--standard .ui-menu__search-input {
  font-size: var(--ui-font-size-xs);
}

.ui-menu__search-input:focus,
.ui-menu__search-input:focus-visible {
  outline: none;
  box-shadow: none;
}

.ui-menu__search-input::placeholder {
  color: var(--ui-color-menu-text-subtle);
}

.ui-menu__search-clear {
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 0;
  border-radius: var(--ui-radius-sm);
  color: var(--ui-color-menu-text-subtle);
  background: transparent;
}

.ui-menu__search-clear:hover {
  color: var(--ui-color-menu-text);
  background: var(--ui-color-menu-control-hover);
}

.ui-menu__empty {
  margin: 8px;
  color: var(--ui-color-menu-text-subtle);
  font-size: var(--ui-type-size-body-compact);
  line-height: var(--ui-type-leading-normal);
}

.ui-menu__search-status {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}

@keyframes ui-menu-in {
  from {
    opacity: 0;
    transform: translateY(-2px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .ui-menu__content {
    animation: none;
  }
}

@media (forced-colors: active) {
  .ui-menu__content {
    scrollbar-color: auto;
  }

  .ui-menu__content::-webkit-scrollbar-thumb {
    background: CanvasText;
    background-clip: padding-box;
  }

  .ui-menu__item[data-highlighted],
  .ui-menu__sub-trigger[data-state="open"] {
    outline: 1px solid Highlight;
    color: HighlightText;
    background: Highlight;
  }
}
</style>
