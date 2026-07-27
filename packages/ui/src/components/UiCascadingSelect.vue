<script setup lang="ts">
import { computed, shallowRef } from "vue"
import {
  DropdownMenuContent,
  DropdownMenuItemIndicator,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuRoot,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from "reka-ui"
import type { UiCascadingSelectGroup, UiSelectOption, UiSelectSize } from "../types"

defineOptions({ inheritAttrs: false })

const model = defineModel<string>({ required: true })
const props = withDefaults(
  defineProps<{
    groups?: readonly UiCascadingSelectGroup[]
    options?: readonly UiSelectOption[]
    placeholder?: string
    size?: UiSelectSize
    appearance?: "default" | "embedded"
    invalid?: boolean
    disabled?: boolean
  }>(),
  {
    groups: () => [],
    options: () => [],
    placeholder: "Choose…",
    size: "md",
    appearance: "default",
    invalid: false,
    disabled: false
  }
)

const open = shallowRef(false)
const selectedOption = computed(() =>
  [...props.options, ...props.groups.flatMap((group) => group.options)].find(
    (option) => option.value === model.value
  )
)
const selectableGroups = computed(() =>
  props.groups.filter((group) => group.options.length > 0 && !group.disabled)
)
const hasSelectableOptions = computed(
  () => props.options.some((option) => !option.disabled) || selectableGroups.value.length > 0
)

function choose(value: unknown): void {
  if (typeof value !== "string") return
  model.value = value
  open.value = false
}
</script>

<template>
  <DropdownMenuRoot v-model:open="open" :modal="false">
    <DropdownMenuTrigger as-child>
      <button
        v-bind="$attrs"
        type="button"
        class="ui-cascading-select"
        :class="[`ui-cascading-select--${props.size}`, `ui-cascading-select--${props.appearance}`]"
        :aria-invalid="props.invalid || undefined"
        :disabled="!hasSelectableOptions || props.disabled"
      >
        <span class="ui-cascading-select__value">
          {{ selectedOption?.label ?? props.placeholder }}
        </span>
        <svg class="ui-cascading-select__chevron" viewBox="0 0 12 12" aria-hidden="true">
          <path d="m3 4.5 3 3 3-3" />
        </svg>
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuPortal>
      <DropdownMenuContent
        class="ui-cascading-select__content"
        align="start"
        :side-offset="4"
        :collision-padding="8"
      >
        <DropdownMenuRadioGroup
          v-if="props.options.length > 0"
          :model-value="model"
          @update:model-value="choose"
        >
          <DropdownMenuRadioItem
            v-for="option in props.options"
            :key="option.value"
            class="ui-cascading-select__item"
            :value="option.value"
            :disabled="option.disabled"
          >
            <span class="ui-cascading-select__indicator-slot" aria-hidden="true">
              <DropdownMenuItemIndicator class="ui-cascading-select__indicator">
                <svg viewBox="0 0 12 12">
                  <path d="m2.5 6.2 2.1 2.1 4.9-5" />
                </svg>
              </DropdownMenuItemIndicator>
            </span>
            <span>{{ option.label }}</span>
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSub v-for="group in props.groups" :key="group.label">
          <DropdownMenuSubTrigger
            class="ui-cascading-select__sub-trigger"
            :disabled="group.disabled || group.options.length === 0"
          >
            <span>{{ group.label }}</span>
            <svg
              class="ui-cascading-select__submenu-chevron"
              viewBox="0 0 12 12"
              aria-hidden="true"
            >
              <path d="m4.5 3 3 3-3 3" />
            </svg>
          </DropdownMenuSubTrigger>
          <DropdownMenuPortal v-if="group.options.length > 0 && !group.disabled">
            <DropdownMenuSubContent
              class="ui-cascading-select__sub-content"
              :side-offset="4"
              :align-offset="-5"
              :collision-padding="8"
            >
              <DropdownMenuRadioGroup :model-value="model" @update:model-value="choose">
                <DropdownMenuRadioItem
                  v-for="option in group.options"
                  :key="option.value"
                  class="ui-cascading-select__item"
                  :value="option.value"
                  :disabled="option.disabled"
                >
                  <span class="ui-cascading-select__indicator-slot" aria-hidden="true">
                    <DropdownMenuItemIndicator class="ui-cascading-select__indicator">
                      <svg viewBox="0 0 12 12">
                        <path d="m2.5 6.2 2.1 2.1 4.9-5" />
                      </svg>
                    </DropdownMenuItemIndicator>
                  </span>
                  <span>{{ option.label }}</span>
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuPortal>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenuPortal>
  </DropdownMenuRoot>
</template>

<style>
.ui-cascading-select {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 12px;
  align-items: center;
  width: 100%;
  min-width: 0;
  border: 1px solid var(--ui-color-border);
  border-radius: var(--ui-radius-md);
  color: var(--ui-color-text);
  background: var(--ui-color-canvas-subtle);
  text-align: left;
  cursor: default;
  transition:
    border-color var(--ui-motion-fast) var(--ui-ease-standard),
    background-color var(--ui-motion-fast) var(--ui-ease-standard);
}

.ui-cascading-select:hover:not(:disabled),
.ui-cascading-select[data-state="open"] {
  border-color: var(--ui-color-border-strong);
  background: var(--ui-color-surface);
}

.ui-cascading-select:focus-visible {
  outline: 2px solid var(--ui-color-focus);
  outline-offset: 1px;
  box-shadow: var(--ui-focus-ring);
}

.ui-cascading-select:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.ui-cascading-select[aria-invalid="true"] {
  border-color: var(--ui-color-danger);
}

.ui-cascading-select__value {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ui-cascading-select__chevron,
.ui-cascading-select__submenu-chevron {
  width: 12px;
  height: 12px;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.5;
}

.ui-cascading-select__chevron {
  color: var(--ui-color-text-subtle);
}

.ui-cascading-select--compact {
  min-height: 24px;
  padding: 0 6px 0 7px;
  border-radius: var(--ui-radius-sm);
  font: var(--ui-type-size-control) var(--ui-type-family-data);
}

.ui-cascading-select--compact .ui-cascading-select__chevron {
  width: 10px;
  height: 10px;
}

.ui-cascading-select--embedded {
  height: 26px;
  min-height: 26px;
  padding: 0 6px 0 7px;
  border: 0;
  border-radius: 0;
  color: inherit;
  background: transparent;
  box-shadow: none;
}

.ui-cascading-select--embedded:hover:not(:disabled),
.ui-cascading-select--embedded[data-state="open"] {
  border-color: transparent;
  background: var(--ui-domain-color-ffffff22);
}

.ui-cascading-select--embedded:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: -2px;
  box-shadow: none;
}

.ui-cascading-select--embedded .ui-cascading-select__chevron {
  color: inherit;
}

.ui-cascading-select--sm {
  min-height: var(--ui-control-sm);
  padding: 0 var(--ui-space-2);
  font-size: var(--ui-font-size-xs);
}

.ui-cascading-select--md {
  min-height: var(--ui-control-md);
  padding: 0 var(--ui-space-3);
  font-size: var(--ui-font-size-sm);
}

.ui-cascading-select--lg {
  min-height: var(--ui-control-lg);
  padding: 0 var(--ui-space-4);
  font-size: var(--ui-font-size-md);
}

.ui-cascading-select__content,
.ui-cascading-select__sub-content {
  z-index: var(--ui-z-dropdown);
  min-width: 164px;
  max-width: min(280px, calc(100vw - 16px));
  padding: 5px;
  overflow-y: auto;
  border: 1px solid var(--line-strong);
  border-radius: 7px;
  color: var(--text-secondary);
  background: var(--surface-2);
  box-shadow:
    var(--ui-shadow-md),
    0 1px 0 color-mix(in srgb, var(--text-primary) 5%, transparent) inset;
  animation: ui-cascading-select-in var(--ui-motion-fast) var(--ui-ease-standard);
}

.ui-cascading-select__sub-content {
  min-width: 190px;
}

.ui-cascading-select__content,
.ui-cascading-select__sub-content {
  max-height: min(420px, calc(100dvh - 16px));
}

.ui-cascading-select__sub-trigger,
.ui-cascading-select__item {
  position: relative;
  display: grid;
  align-items: center;
  min-height: 29px;
  border-radius: 4px;
  outline: none;
  font-size: var(--ui-type-size-body-compact);
  cursor: default;
  user-select: none;
}

.ui-cascading-select__sub-trigger {
  grid-template-columns: minmax(0, 1fr) 12px;
  gap: 20px;
  padding: 0 8px;
}

.ui-cascading-select__item {
  grid-template-columns: 16px minmax(0, 1fr);
  padding: 0 9px 0 5px;
}

.ui-cascading-select__sub-trigger[data-highlighted],
.ui-cascading-select__sub-trigger[data-state="open"],
.ui-cascading-select__item[data-highlighted] {
  color: var(--button-primary-text);
  background: var(--button-primary);
}

.ui-cascading-select__sub-trigger[data-disabled],
.ui-cascading-select__item[data-disabled] {
  color: var(--text-faint);
  opacity: 0.64;
}

.ui-cascading-select__indicator-slot,
.ui-cascading-select__indicator {
  display: grid;
  place-items: center;
  width: 14px;
  height: 14px;
}

.ui-cascading-select__indicator {
  color: var(--accent-soft);
}

.ui-cascading-select__indicator svg {
  width: 12px;
  height: 12px;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.7;
}

.ui-cascading-select__item[data-highlighted] .ui-cascading-select__indicator {
  color: var(--button-primary-text);
}

@keyframes ui-cascading-select-in {
  from {
    opacity: 0;
    transform: translateY(-2px) scale(0.985);
  }
}
</style>
