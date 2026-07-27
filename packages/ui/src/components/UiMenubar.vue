<script setup lang="ts">
import {
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarPortal,
  MenubarRoot,
  MenubarSeparator,
  MenubarTrigger
} from "reka-ui"
import type { UiMenubarMenu } from "../types"

defineProps<{
  menus: UiMenubarMenu[]
  ariaLabel?: string
}>()

const emit = defineEmits<{
  select: [value: string]
}>()
</script>

<template>
  <MenubarRoot class="ui-menubar" loop :aria-label="ariaLabel">
    <MenubarMenu v-for="menu in menus" :key="menu.value" :value="menu.value">
      <MenubarTrigger class="ui-menubar__trigger">
        {{ menu.label }}
      </MenubarTrigger>
      <MenubarPortal>
        <MenubarContent
          class="ui-menubar__content"
          align="start"
          :side-offset="4"
          :collision-padding="8"
        >
          <template v-for="item in menu.items" :key="item.value">
            <MenubarSeparator v-if="item.separatorBefore" class="ui-menubar__separator" />
            <MenubarItem
              class="ui-menubar__item"
              :disabled="item.disabled"
              @select="emit('select', item.value)"
            >
              <span>{{ item.label }}</span>
              <kbd v-if="item.shortcut" class="ui-menubar__shortcut">
                {{ item.shortcut }}
              </kbd>
            </MenubarItem>
          </template>
        </MenubarContent>
      </MenubarPortal>
    </MenubarMenu>
  </MenubarRoot>
</template>

<style>
.ui-menubar {
  display: flex;
  align-items: center;
  gap: 1px;
}

.ui-menubar__trigger {
  min-height: 25px;
  padding: 0 8px;
  border: 1px solid transparent;
  border-radius: 4px;
  color: var(--text-muted);
  background: transparent;
  font: 500 9px var(--font-sans);
  cursor: default;
  outline: none;
}

.ui-menubar__trigger[data-highlighted],
.ui-menubar__trigger[data-state="open"] {
  border-color: color-mix(in srgb, var(--line-strong) 74%, transparent);
  color: var(--text-primary);
  background: var(--surface-active);
}

.ui-menubar__trigger:focus-visible {
  box-shadow: var(--focus-ring);
}

.ui-menubar__content {
  z-index: var(--ui-z-dropdown);
  min-width: 218px;
  padding: 5px;
  border: 1px solid var(--line-strong);
  border-radius: 7px;
  color: var(--text-secondary);
  background: var(--surface-2);
  box-shadow:
    var(--ui-shadow-md),
    0 1px 0 color-mix(in srgb, var(--text-primary) 5%, transparent) inset;
  animation: ui-menubar-in var(--ui-motion-fast) var(--ui-ease-standard);
}

.ui-menubar__item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  min-height: 29px;
  gap: 24px;
  padding: 0 9px;
  border-radius: 4px;
  outline: none;
  font-size: 9px;
  cursor: default;
}

.ui-menubar__item[data-highlighted] {
  color: var(--button-primary-text);
  background: var(--button-primary);
}

.ui-menubar__item[data-disabled] {
  color: var(--text-faint);
  opacity: 0.64;
}

.ui-menubar__shortcut {
  color: var(--text-faint);
  background: transparent;
  font: 7px var(--font-utility);
}

.ui-menubar__item[data-highlighted] .ui-menubar__shortcut {
  color: color-mix(in srgb, var(--button-primary-text) 72%, transparent);
}

.ui-menubar__separator {
  height: 1px;
  margin: 4px 6px;
  background: var(--line-soft);
}

@keyframes ui-menubar-in {
  from {
    opacity: 0;
    transform: translateY(-2px) scale(0.985);
  }
}
</style>
