<script setup lang="ts">
import { computed, watch } from "vue"
import { ArrowLeft } from "@lucide/vue"
import type { SettingsCategory, SettingsPageDefinition } from "./settings"

const props = defineProps<{
  title: string
  scopeLabel: string
  backLabel: string
  categories: readonly SettingsCategory[]
  activePage: string
}>()

const emit = defineEmits<{
  back: []
  "update:activePage": [page: string]
}>()

defineSlots<{
  actions(): unknown
  default(): unknown
}>()

function firstEnabledPage(category: SettingsCategory): SettingsPageDefinition | undefined {
  return category.pages.find((page) => !page.disabled)
}

function categoryIsDisabled(category: SettingsCategory): boolean {
  return category.disabled === true || firstEnabledPage(category) === undefined
}

const firstAvailablePage = computed(() => {
  for (const category of props.categories) {
    if (categoryIsDisabled(category)) continue
    const page = firstEnabledPage(category)
    if (page) return page
  }
  return undefined
})

const activeCategory = computed(
  () =>
    props.categories.find(
      (category) =>
        !categoryIsDisabled(category) &&
        category.pages.some((page) => page.id === props.activePage && !page.disabled)
    ) ??
    props.categories.find(
      (category) =>
        firstAvailablePage.value !== undefined &&
        category.pages.some((page) => page.id === firstAvailablePage.value?.id)
    )
)

function selectCategory(category: SettingsCategory): void {
  if (categoryIsDisabled(category)) return
  const page = firstEnabledPage(category)
  if (page) emit("update:activePage", page.id)
}

function selectPage(page: SettingsPageDefinition): void {
  if (!page.disabled) emit("update:activePage", page.id)
}

watch(
  () => [props.activePage, props.categories] as const,
  () => {
    const valid = props.categories.some(
      (category) =>
        !categoryIsDisabled(category) &&
        category.pages.some((page) => page.id === props.activePage && !page.disabled)
    )
    if (!valid && firstAvailablePage.value) {
      emit("update:activePage", firstAvailablePage.value.id)
    }
  },
  { immediate: true }
)
</script>

<template>
  <main class="settings-container">
    <header class="settings-topbar">
      <button
        class="settings-back-button"
        type="button"
        :aria-label="backLabel"
        @click="emit('back')"
      >
        <ArrowLeft :size="16" />
      </button>
      <div class="settings-title">
        <span>{{ scopeLabel }}</span>
        <h1>{{ title }}</h1>
      </div>
      <div v-if="$slots.actions" class="settings-actions">
        <slot name="actions" />
      </div>
    </header>

    <aside class="settings-primary-sidebar">
      <div class="settings-sidebar-label">Settings</div>
      <nav class="settings-primary-navigation" :aria-label="`${title} categories`">
        <button
          v-for="category in categories"
          :key="category.id"
          class="settings-category"
          :class="{ active: category.id === activeCategory?.id }"
          type="button"
          :disabled="categoryIsDisabled(category)"
          :aria-current="category.id === activeCategory?.id ? 'page' : undefined"
          @click="selectCategory(category)"
        >
          <component :is="category.icon" :size="15" />
          <span>{{ category.label }}</span>
          <small v-if="category.badge">{{ category.badge }}</small>
        </button>
      </nav>
      <div class="settings-build-label">Yadaw / build 0.0.0</div>
    </aside>

    <aside class="settings-secondary-sidebar">
      <template v-if="activeCategory">
        <div class="settings-category-heading">
          <span>{{ activeCategory.label }}</span>
          <strong>{{ activeCategory.description }}</strong>
        </div>
        <nav :aria-label="`${activeCategory.label} settings pages`">
          <button
            v-for="page in activeCategory.pages"
            :key="page.id"
            class="settings-page-link"
            :class="{ active: page.id === activePage }"
            type="button"
            :disabled="page.disabled"
            :aria-current="page.id === activePage ? 'page' : undefined"
            @click="selectPage(page)"
          >
            <component :is="page.icon" :size="15" />
            <span>
              <b>{{ page.label }}</b>
              <small>{{ page.description }}</small>
            </span>
            <em v-if="page.badge">{{ page.badge }}</em>
          </button>
        </nav>
      </template>
    </aside>

    <slot />
  </main>
</template>

<style scoped>
.settings-container {
  display: grid;
  grid-template: 60px minmax(0, 1fr) / 174px 194px minmax(0, 1fr);
  width: 100%;
  height: 100%;
  color: var(--text-primary);
  background: var(--canvas);
}

.settings-topbar {
  grid-column: 1 / -1;
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr) auto;
  align-items: center;
  gap: 13px;
  padding: 0 18px;
  border-bottom: 1px solid var(--line-strong);
  background: var(--surface-1);
  box-shadow: var(--ui-shadow-md);
}

.settings-back-button {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 1px solid var(--line-strong);
  border-radius: 7px;
  color: var(--text-secondary);
  background: var(--surface-2);
  cursor: pointer;
}

.settings-back-button:hover {
  color: var(--text-primary);
  background: var(--surface-3);
}

.settings-back-button:focus-visible,
.settings-category:focus-visible,
.settings-page-link:focus-visible,
.settings-actions :deep(.settings-action:focus-visible) {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}

.settings-title span {
  color: var(--accent);
  font: var(--ui-type-weight-bold) var(--ui-type-size-caption) var(--ui-type-family-data);
  letter-spacing: var(--ui-type-tracking-widest);
  text-transform: uppercase;
}

.settings-title h1 {
  margin: 3px 0 0;
  font-family: var(--ui-type-family-display);
  font-size: var(--ui-font-size-sm);
  font-weight: var(--ui-type-weight-semibold);
  letter-spacing: var(--ui-type-tracking-wide);
}

.settings-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.settings-actions :deep(.settings-action) {
  min-height: 32px;
  padding: 0 13px;
  border: 1px solid var(--line-strong);
  border-radius: 7px;
  color: var(--text-secondary);
  background: var(--surface-2);
  cursor: pointer;
  font-size: var(--ui-type-size-body-compact);
}

.settings-actions :deep(.settings-action-primary) {
  border-color: var(--accent-strong);
  color: var(--button-primary-text);
  background: var(--button-primary);
  box-shadow: var(--ui-shadow-highlight-inset);
}

.settings-actions :deep(.settings-action:disabled) {
  opacity: 0.4;
  cursor: not-allowed;
}

.settings-primary-sidebar,
.settings-secondary-sidebar {
  min-width: 0;
  padding: 24px 11px;
  border-right: 1px solid var(--line-soft);
}

.settings-primary-sidebar {
  position: relative;
  background: var(--surface-panel);
}

.settings-secondary-sidebar {
  background: var(--surface-1);
}

.settings-sidebar-label {
  margin: 0 9px 10px;
  color: var(--text-faint);
  font: var(--ui-type-weight-bold) var(--ui-type-size-caption) var(--ui-type-family-data);
  letter-spacing: var(--ui-type-tracking-widest);
  text-transform: uppercase;
}

.settings-primary-navigation {
  display: grid;
  gap: 3px;
}

.settings-category {
  display: grid;
  grid-template-columns: 17px minmax(0, 1fr) auto;
  align-items: center;
  width: 100%;
  gap: 8px;
  padding: 9px;
  border: 1px solid transparent;
  border-radius: 6px;
  color: var(--text-muted);
  background: transparent;
  text-align: left;
  font-size: var(--ui-type-size-body-compact);
  cursor: pointer;
}

.settings-category.active {
  border-color: color-mix(in srgb, var(--accent) 28%, transparent);
  color: var(--text-primary);
  background: var(--surface-active);
  box-shadow: var(--ui-shadow-selected-edge);
}

.settings-category:disabled,
.settings-page-link:disabled {
  opacity: 0.42;
  cursor: default;
}

.settings-category small,
.settings-page-link em {
  color: var(--text-faint);
  font: var(--ui-type-size-micro) var(--ui-type-family-data);
  font-style: normal;
  letter-spacing: var(--ui-type-tracking-wide);
  text-transform: uppercase;
}

.settings-build-label {
  position: absolute;
  right: 20px;
  bottom: 18px;
  left: 20px;
  color: var(--text-faint);
  font: var(--ui-type-size-micro) var(--ui-type-family-data);
  letter-spacing: var(--ui-type-tracking-wide);
  text-transform: uppercase;
}

.settings-category-heading {
  margin: 0 9px 17px;
}

.settings-category-heading span,
.settings-category-heading strong {
  display: block;
}

.settings-category-heading span {
  color: var(--accent);
  font: var(--ui-type-weight-bold) var(--ui-type-size-caption) var(--ui-type-family-data);
  letter-spacing: var(--ui-type-tracking-widest);
  text-transform: uppercase;
}

.settings-category-heading strong {
  margin-top: 6px;
  color: var(--text-primary);
  font-family: var(--ui-type-family-display);
  font-size: var(--ui-font-size-sm);
}

.settings-page-link {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr) auto;
  width: 100%;
  gap: 8px;
  margin-bottom: 5px;
  padding: 10px;
  border: 1px solid transparent;
  border-radius: 7px;
  color: var(--text-muted);
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.settings-page-link.active {
  border-color: var(--line-strong);
  color: var(--text-primary);
  background: var(--surface-active);
}

.settings-page-link > svg {
  margin-top: 1px;
  color: var(--accent);
}

.settings-page-link b,
.settings-page-link small {
  display: block;
}

.settings-page-link b {
  font-size: var(--ui-type-size-body-compact);
}

.settings-page-link small {
  margin-top: 4px;
  color: var(--text-faint);
  font-size: var(--ui-type-size-caption);
  line-height: var(--ui-type-leading-compact);
}

@media (max-width: 1120px) {
  .settings-container {
    grid-template-columns: 150px 174px minmax(0, 1fr);
  }
}
</style>
