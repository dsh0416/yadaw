<script setup lang="ts">
import { computed, useAttrs } from "vue"
import type { UiMenuEntry, UiMenuRadioOption, UiMenuSearchOptions } from "../menu"
import type {
  UiCascadingSelectAppearance,
  UiCascadingSelectGroup,
  UiCascadingSelectHoverTreatment,
  UiSelectOption,
  UiSelectSize
} from "../types"
import UiDropdownMenu from "./UiDropdownMenu.vue"

defineOptions({ inheritAttrs: false })

const model = defineModel<string>({ required: true })
const props = withDefaults(
  defineProps<{
    groups?: readonly UiCascadingSelectGroup[]
    options?: readonly UiSelectOption[]
    placeholder?: string
    size?: UiSelectSize
    appearance?: UiCascadingSelectAppearance
    hoverTreatment?: UiCascadingSelectHoverTreatment
    invalid?: boolean
    disabled?: boolean
    searchOptions?: UiMenuSearchOptions
  }>(),
  {
    searchOptions: undefined,
    groups: () => [],
    options: () => [],
    placeholder: "Choose…",
    size: "md",
    appearance: "default",
    hoverTreatment: "surface",
    invalid: false,
    disabled: false
  }
)

const attrs = useAttrs()
const selectedOption = computed(() =>
  [...props.options, ...props.groups.flatMap((group) => group.options)].find(
    (option) => option.value === model.value
  )
)
const hasSelectableOptions = computed(
  () =>
    props.options.some((option) => !option.disabled) ||
    props.groups.some(
      (group) => !group.disabled && group.options.some((option) => !option.disabled)
    )
)
const entries = computed<readonly UiMenuEntry[]>(() => {
  const result: UiMenuEntry[] = []

  if (props.options.length > 0) {
    result.push({
      kind: "radio-group",
      id: "direct-options",
      value: model.value,
      options: props.options.map(toRadioOption)
    })
  }

  props.groups.forEach((group, index) => {
    result.push({
      kind: "submenu",
      id: `group:${index}:${group.label}`,
      label: group.label,
      disabled: group.disabled,
      children: [
        {
          kind: "radio-group",
          id: `group:${index}:options`,
          value: model.value,
          options: group.options.map(toRadioOption)
        }
      ]
    })
  })

  return result
})
const menuAriaLabel = computed(() => {
  const label = attrs["aria-label"]
  return typeof label === "string" ? label : props.placeholder
})

function toRadioOption(option: UiSelectOption): UiMenuRadioOption {
  return {
    id: option.value,
    label: option.label,
    disabled: option.disabled
  }
}

function choose(value: string): void {
  model.value = value
}
</script>

<template>
  <UiDropdownMenu
    :entries="entries"
    :menu-label="menuAriaLabel"
    :search-options="props.searchOptions"
    @select="choose"
  >
    <button
      v-bind="attrs"
      type="button"
      class="ui-cascading-select"
      :class="[
        `ui-cascading-select--${props.size}`,
        `ui-cascading-select--${props.appearance}`,
        `ui-cascading-select--hover-${props.hoverTreatment}`
      ]"
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
  </UiDropdownMenu>
</template>

<style scoped>
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

.ui-cascading-select--hover-surface:hover:not(:disabled),
.ui-cascading-select--hover-surface[data-state="open"] {
  border-color: var(--ui-color-border-strong);
  background: var(--ui-color-surface);
}

.ui-cascading-select:focus-visible {
  outline: var(--ui-focus-width) solid var(--ui-color-focus);
  outline-offset: 1px;
  box-shadow: var(--ui-focus-ring);
}

.ui-cascading-select:disabled {
  cursor: not-allowed;
  opacity: var(--ui-opacity-disabled);
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

.ui-cascading-select__chevron {
  width: 12px;
  height: 12px;
  color: var(--ui-color-text-subtle);
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.5;
}

.ui-cascading-select--compact {
  min-height: var(--ui-control-compact);
  padding: 0 6px 0 7px;
  border-radius: var(--ui-radius-sm);
  font: var(--ui-type-size-control) var(--ui-type-family-data);
}

.ui-cascading-select--compact .ui-cascading-select__chevron {
  width: 10px;
  height: 10px;
}

.ui-cascading-select--workspace {
  border-color: var(--ui-domain-color-747474);
  color: var(--ui-domain-color-f2f2f2);
  background: linear-gradient(var(--ui-domain-color-6d6d6d), var(--ui-domain-color-5d5d5d));
}

.ui-cascading-select--workspace.ui-cascading-select--hover-surface:hover:not(:disabled),
.ui-cascading-select--workspace.ui-cascading-select--hover-surface[data-state="open"] {
  border-color: var(--ui-domain-color-929292);
  background: linear-gradient(var(--ui-domain-color-747474), var(--ui-domain-color-626262));
}

.ui-cascading-select--workspace:focus-visible {
  outline-color: var(--focus);
  box-shadow: none;
}

.ui-cascading-select--workspace .ui-cascading-select__chevron {
  color: var(--ui-domain-color-b8b8b8);
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

.ui-cascading-select--embedded.ui-cascading-select--hover-surface:hover:not(:disabled),
.ui-cascading-select--embedded.ui-cascading-select--hover-surface[data-state="open"] {
  border-color: transparent;
  background: var(--ui-color-surface-hover);
}

.ui-cascading-select--embedded.ui-cascading-select--hover-host-tint:hover:not(:disabled),
.ui-cascading-select--embedded.ui-cascading-select--hover-host-tint[data-state="open"] {
  border-color: transparent;
  background: var(--ui-domain-color-ffffff22);
}

.ui-cascading-select--embedded:focus-visible {
  outline: var(--ui-focus-width) solid var(--ui-color-focus);
  outline-offset: calc(var(--ui-focus-width) * -1);
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
</style>
