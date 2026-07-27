<script setup lang="ts">
import type { UiSelectGroup, UiSelectOption, UiSelectSize } from "../types"

defineOptions({ inheritAttrs: false })

const model = defineModel<string>({ required: true })
const props = withDefaults(
  defineProps<{
    options?: readonly UiSelectOption[]
    groups?: readonly UiSelectGroup[]
    placeholder?: string
    size?: UiSelectSize
    invalid?: boolean
  }>(),
  {
    options: () => [],
    groups: () => [],
    placeholder: undefined,
    size: "md",
    invalid: false
  }
)
</script>

<template>
  <span class="ui-select-shell" :class="`ui-select-shell--${props.size}`">
    <select
      v-model="model"
      v-bind="$attrs"
      class="ui-select"
      :aria-invalid="props.invalid || undefined"
    >
      <option v-if="props.placeholder" value="" disabled>{{ props.placeholder }}</option>
      <option
        v-for="option in props.options"
        :key="option.value"
        :value="option.value"
        :disabled="option.disabled"
      >
        {{ option.label }}
      </option>
      <template v-for="group in props.groups" :key="group.label">
        <option v-if="group.separatorBefore" class="ui-select__separator" disabled>
          ────────────────
        </option>
        <optgroup :label="group.label">
          <option
            v-for="option in group.options"
            :key="option.value"
            :value="option.value"
            :disabled="option.disabled"
          >
            {{ option.label }}
          </option>
        </optgroup>
      </template>
      <slot />
    </select>
    <svg class="ui-select__chevron" viewBox="0 0 12 12" aria-hidden="true">
      <path d="m3 4.5 3 3 3-3" />
    </svg>
  </span>
</template>

<style scoped>
.ui-select-shell {
  position: relative;
  display: inline-grid;
  width: 100%;
  min-width: 0;
  color: var(--ui-color-text-subtle);
  isolation: isolate;
}

.ui-select {
  grid-area: 1 / 1;
  width: 100%;
  min-width: 0;
  appearance: none;
  overflow: hidden;
  border: 1px solid var(--ui-color-border);
  border-radius: var(--ui-radius-md);
  color: var(--ui-color-text);
  background: var(--ui-color-canvas-subtle);
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: default;
  transition:
    border-color var(--ui-motion-fast) var(--ui-ease-standard),
    background-color var(--ui-motion-fast) var(--ui-ease-standard);
}

.ui-select:hover:not(:disabled) {
  border-color: var(--ui-color-border-strong);
  background: var(--ui-color-surface);
}

.ui-select:focus-visible {
  outline: 2px solid var(--ui-color-focus);
  outline-offset: 1px;
  box-shadow: var(--ui-focus-ring);
}

.ui-select:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.ui-select:disabled + .ui-select__chevron {
  opacity: 0.45;
}

.ui-select[aria-invalid="true"] {
  border-color: var(--ui-color-danger);
}

.ui-select__chevron {
  grid-area: 1 / 1;
  align-self: center;
  justify-self: end;
  width: 12px;
  height: 12px;
  margin-right: var(--ui-space-2);
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.5;
  pointer-events: none;
}

.ui-select-shell--compact .ui-select {
  min-height: 24px;
  padding: 0 24px 0 7px;
  border-radius: var(--ui-radius-sm);
  font: var(--ui-type-size-control) var(--ui-type-family-data);
}

.ui-select-shell--compact .ui-select__chevron {
  width: 10px;
  height: 10px;
  margin-right: 6px;
}

.ui-select-shell--sm .ui-select {
  min-height: var(--ui-control-sm);
  padding: 0 calc(var(--ui-space-3) + 12px) 0 var(--ui-space-2);
  font-size: var(--ui-font-size-xs);
}

.ui-select-shell--md .ui-select {
  min-height: var(--ui-control-md);
  padding: 0 calc(var(--ui-space-4) + 12px) 0 var(--ui-space-3);
  font-size: var(--ui-font-size-sm);
}

.ui-select-shell--lg .ui-select {
  min-height: var(--ui-control-lg);
  padding: 0 calc(var(--ui-space-5) + 12px) 0 var(--ui-space-4);
  font-size: var(--ui-font-size-md);
}

.ui-select__separator {
  color: var(--ui-color-border-strong);
}
</style>
