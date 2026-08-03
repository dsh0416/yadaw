<script setup lang="ts">
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import { UiTooltip } from "@heron/ui"

const { t } = useI18n()

const props = withDefaults(
  defineProps<{
    label: string
    tooltip?: string
    pressed?: boolean
    unavailable?: boolean
    disabled?: boolean
    compactHidden?: boolean
    tone?: "default" | "play" | "record" | "accent"
  }>(),
  {
    tooltip: undefined,
    pressed: undefined,
    unavailable: false,
    disabled: false,
    compactHidden: false,
    tone: "default"
  }
)
const emit = defineEmits<{
  activate: []
}>()

const tooltipText = computed(() =>
  props.unavailable
    ? `${props.label} · ${t("studio.common.comingSoon")}`
    : (props.tooltip ?? props.label)
)

function activate(event: MouseEvent): void {
  if (props.unavailable || props.disabled) {
    event.preventDefault()
    event.stopPropagation()
    return
  }
  emit("activate")
}
</script>

<template>
  <UiTooltip :text="tooltipText" side="bottom">
    <button
      type="button"
      :class="[
        'studio-control-button',
        `tone-${tone}`,
        {
          unavailable,
          'compact-hidden': compactHidden
        }
      ]"
      :disabled="disabled"
      :aria-disabled="unavailable || disabled ? 'true' : undefined"
      :aria-pressed="pressed"
      :aria-label="label"
      :data-placeholder="unavailable ? '' : undefined"
      @click="activate"
    >
      <slot />
    </button>
  </UiTooltip>
</template>

<style scoped>
.studio-control-button {
  display: grid;
  place-items: center;
  flex: none;
  width: 26px;
  height: 28px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 6px;
  color: var(--text-muted);
  background: transparent;
  cursor: pointer;
  -webkit-app-region: no-drag;
}
.studio-control-button:hover {
  border-color: var(--line-strong);
  color: var(--text-primary);
  background: var(--daw-control-hover);
}
.studio-control-button:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}
.studio-control-button[aria-pressed="true"] {
  border-color: color-mix(in srgb, var(--accent) 55%, var(--line-strong));
  color: var(--text-primary);
  background: var(--surface-active);
  box-shadow: 0 -2px 0 var(--accent) inset;
}
.studio-control-button.tone-play {
  color: var(--signal-cyan);
}
.studio-control-button.tone-record {
  color: var(--record);
}
.studio-control-button.tone-accent {
  color: var(--accent-soft);
}
.studio-control-button.tone-play[aria-pressed="true"] {
  color: var(--ui-domain-color-081116);
  background: var(--signal-cyan);
  box-shadow: 0 0 12px color-mix(in srgb, var(--signal-cyan) 38%, transparent);
}
.studio-control-button.tone-record[aria-pressed="true"] {
  color: var(--ui-domain-color-fff);
  background: var(--record);
  box-shadow: 0 0 12px color-mix(in srgb, var(--record) 45%, transparent);
}
.studio-control-button.unavailable {
  opacity: 0.48;
  cursor: help;
}
.studio-control-button.unavailable:hover {
  border-color: transparent;
  color: var(--text-muted);
  background: transparent;
}
.studio-control-button:disabled {
  opacity: 0.32;
  cursor: not-allowed;
}
@media (max-width: 1279px) {
  .studio-control-button.compact-hidden {
    display: none;
  }
}
</style>
