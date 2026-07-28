<script setup lang="ts">
import { computed } from "vue"
import {
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from "reka-ui"
import type { UiCascadingMenuItem } from "../types"

const props = defineProps<{
  item: UiCascadingMenuItem
}>()

const emit = defineEmits<{
  choose: [value: string]
}>()

const hasDetailedChildren = computed(
  () => props.item.children?.some((child) => child.leading || child.trailing) ?? false
)

function choose(): void {
  if (props.item.value !== undefined) emit("choose", props.item.value)
}
</script>

<template>
  <DropdownMenuSub v-if="item.children">
    <DropdownMenuSubTrigger
      class="ui-cascading-select__sub-trigger"
      :aria-label="item.ariaLabel"
      :title="item.title"
      :disabled="item.disabled || item.children.length === 0"
    >
      <span>{{ item.label }}</span>
      <svg class="ui-cascading-select__submenu-chevron" viewBox="0 0 12 12" aria-hidden="true">
        <path d="m4.5 3 3 3-3 3" />
      </svg>
    </DropdownMenuSubTrigger>
    <DropdownMenuPortal v-if="item.children.length > 0 && !item.disabled">
      <DropdownMenuSubContent
        class="ui-cascading-select__sub-content"
        :class="{
          'ui-cascading-menu__sub-content--detailed': hasDetailedChildren
        }"
        :side-offset="4"
        :align-offset="-5"
        :collision-padding="8"
      >
        <UiCascadingMenuBranch
          v-for="child in item.children"
          :key="child.value ?? child.label"
          :item="child"
          @choose="emit('choose', $event)"
        />
      </DropdownMenuSubContent>
    </DropdownMenuPortal>
  </DropdownMenuSub>

  <DropdownMenuItem
    v-else
    class="ui-cascading-select__item ui-cascading-menu__item"
    :class="{ 'ui-cascading-menu__item--detailed': item.leading || item.trailing }"
    :aria-label="item.ariaLabel"
    :title="item.title"
    :disabled="item.disabled || item.value === undefined"
    @select="choose"
  >
    <strong v-if="item.leading">{{ item.leading }}</strong>
    <span>{{ item.label }}</span>
    <small v-if="item.trailing">{{ item.trailing }}</small>
  </DropdownMenuItem>
</template>
