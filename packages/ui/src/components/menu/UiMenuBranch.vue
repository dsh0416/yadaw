<script setup lang="ts">
import { computed } from "vue"
import {
  ContextMenuCheckboxItem,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuItemIndicator,
  ContextMenuLabel,
  ContextMenuPortal,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  DropdownMenuCheckboxItem,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuItemIndicator,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from "reka-ui"
import type { UiMenuEntry } from "../../menu"
import { menuHasDetails } from "../../menu"

const props = withDefaults(
  defineProps<{
    entries: readonly UiMenuEntry[]
    variant: "context" | "dropdown"
    depth?: number
  }>(),
  {
    depth: 0
  }
)

const emit = defineEmits<{
  select: [id: string]
}>()

const primitives = computed(() =>
  props.variant === "context"
    ? {
        checkboxItem: ContextMenuCheckboxItem,
        group: ContextMenuGroup,
        item: ContextMenuItem,
        indicator: ContextMenuItemIndicator,
        label: ContextMenuLabel,
        portal: ContextMenuPortal,
        radioGroup: ContextMenuRadioGroup,
        radioItem: ContextMenuRadioItem,
        separator: ContextMenuSeparator,
        sub: ContextMenuSub,
        subContent: ContextMenuSubContent,
        subTrigger: ContextMenuSubTrigger
      }
    : {
        checkboxItem: DropdownMenuCheckboxItem,
        group: DropdownMenuGroup,
        item: DropdownMenuItem,
        indicator: DropdownMenuItemIndicator,
        label: DropdownMenuLabel,
        portal: DropdownMenuPortal,
        radioGroup: DropdownMenuRadioGroup,
        radioItem: DropdownMenuRadioItem,
        separator: DropdownMenuSeparator,
        sub: DropdownMenuSub,
        subContent: DropdownMenuSubContent,
        subTrigger: DropdownMenuSubTrigger
      }
)

function entryClasses(entry: UiMenuEntry): Record<string, boolean> {
  if (entry.kind === "separator" || entry.kind === "group" || entry.kind === "radio-group") {
    return {}
  }

  return {
    "ui-menu__item--leading": Boolean(entry.leading),
    "ui-menu__item--detailed": Boolean(entry.metadata || entry.shortcut),
    "ui-menu__item--danger": entry.kind === "item" && entry.tone === "danger"
  }
}

function radioValue(value: unknown): void {
  if (typeof value === "string") emit("select", value)
}
</script>

<template>
  <template v-for="entry in props.entries" :key="entry.id">
    <component
      :is="primitives.separator"
      v-if="entry.kind === 'separator'"
      class="ui-menu__separator"
    />

    <component :is="primitives.group" v-else-if="entry.kind === 'group'">
      <component :is="primitives.label" v-if="entry.label" class="ui-menu__group-label">
        {{ entry.label }}
      </component>
      <UiMenuBranch
        :entries="entry.children"
        :variant="props.variant"
        :depth="props.depth"
        @select="emit('select', $event)"
      />
    </component>

    <component
      :is="primitives.radioGroup"
      v-else-if="entry.kind === 'radio-group'"
      :model-value="entry.value"
      @update:model-value="radioValue"
    >
      <component :is="primitives.label" v-if="entry.label" class="ui-menu__group-label">
        {{ entry.label }}
      </component>
      <component
        :is="primitives.radioItem"
        v-for="option in entry.options"
        :key="option.id"
        :value="option.id"
        :disabled="option.disabled"
        :aria-label="option.ariaLabel"
        :aria-description="option.disabledReason"
        :title="option.title"
        class="ui-menu__item ui-menu__item--select ui-cascading-select__item"
        :class="entryClasses({ ...option, kind: 'item' })"
      >
        <span
          class="ui-menu__leading ui-menu__indicator-slot ui-cascading-select__indicator-slot"
          aria-hidden="true"
        >
          <component :is="primitives.indicator" class="ui-menu__indicator">
            <svg viewBox="0 0 12 12">
              <path d="m2.5 6.2 2.1 2.1 4.9-5" />
            </svg>
          </component>
        </span>
        <span class="ui-menu__label">{{ option.label }}</span>
        <span v-if="option.metadata" class="ui-menu__metadata">{{ option.metadata }}</span>
        <kbd v-else-if="option.shortcut" class="ui-menu__shortcut">{{ option.shortcut }}</kbd>
      </component>
    </component>

    <component :is="primitives.sub" v-else-if="entry.kind === 'submenu'">
      <component
        :is="primitives.subTrigger"
        class="ui-menu__item ui-menu__sub-trigger ui-cascading-select__sub-trigger"
        :class="entryClasses(entry)"
        :aria-label="entry.ariaLabel"
        :aria-description="entry.disabledReason"
        :title="entry.title"
        :disabled="entry.disabled || entry.children.length === 0"
      >
        <strong v-if="entry.leading" class="ui-menu__leading">{{ entry.leading }}</strong>
        <span class="ui-menu__label">{{ entry.label }}</span>
        <span v-if="entry.metadata" class="ui-menu__metadata">{{ entry.metadata }}</span>
        <kbd v-else-if="entry.shortcut" class="ui-menu__shortcut">{{ entry.shortcut }}</kbd>
        <svg class="ui-menu__submenu-chevron" viewBox="0 0 12 12" aria-hidden="true">
          <path d="m4.5 3 3 3-3 3" />
        </svg>
      </component>
      <component :is="primitives.portal" v-if="entry.children.length > 0 && !entry.disabled">
        <component
          :is="primitives.subContent"
          class="ui-menu__content ui-menu__sub-content ui-cascading-select__sub-content"
          :class="{
            'ui-menu__content--detailed': menuHasDetails(entry.children),
            'ui-cascading-menu__sub-content--detailed': menuHasDetails(entry.children)
          }"
          :side-offset="4"
          :align-offset="-5"
          :collision-padding="8"
        >
          <UiMenuBranch
            :entries="entry.children"
            :variant="props.variant"
            :depth="props.depth + 1"
            @select="emit('select', $event)"
          />
        </component>
      </component>
    </component>

    <component
      :is="primitives.checkboxItem"
      v-else-if="entry.kind === 'checkbox'"
      class="ui-menu__item ui-menu__item--select"
      :class="entryClasses(entry)"
      :model-value="entry.checked"
      :disabled="entry.disabled"
      :aria-label="entry.ariaLabel"
      :aria-description="entry.disabledReason"
      :title="entry.title"
      @select="emit('select', entry.id)"
    >
      <span class="ui-menu__leading ui-menu__indicator-slot" aria-hidden="true">
        <component :is="primitives.indicator" class="ui-menu__indicator">
          <svg viewBox="0 0 12 12">
            <path d="m2.5 6.2 2.1 2.1 4.9-5" />
          </svg>
        </component>
      </span>
      <span class="ui-menu__label">{{ entry.label }}</span>
      <span v-if="entry.metadata" class="ui-menu__metadata">{{ entry.metadata }}</span>
      <kbd v-else-if="entry.shortcut" class="ui-menu__shortcut">{{ entry.shortcut }}</kbd>
    </component>

    <component
      :is="primitives.item"
      v-else
      class="ui-menu__item ui-cascading-select__item ui-cascading-menu__item"
      :class="[
        entryClasses(entry),
        {
          'ui-cascading-menu__item--detailed': entry.leading || entry.metadata || entry.shortcut
        }
      ]"
      :disabled="entry.disabled"
      :aria-label="entry.ariaLabel"
      :aria-description="entry.disabledReason"
      :title="entry.title"
      @select="emit('select', entry.id)"
    >
      <strong v-if="entry.leading" class="ui-menu__leading">{{ entry.leading }}</strong>
      <span class="ui-menu__label">{{ entry.label }}</span>
      <span v-if="entry.metadata" class="ui-menu__metadata">{{ entry.metadata }}</span>
      <kbd v-else-if="entry.shortcut" class="ui-menu__shortcut">{{ entry.shortcut }}</kbd>
    </component>
  </template>
</template>
