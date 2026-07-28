<script setup lang="ts">
import { computed, onMounted, useTemplateRef, watch } from "vue"
import type { PluginAudioMode, PluginDescriptor } from "@yadaw/contracts"
import { pluginAudioModeOptions, type PluginSignalWidth } from "./plugin-audio-mode"

const props = defineProps<{
  descriptor: PluginDescriptor
  inputWidth?: PluginSignalWidth
}>()

const emit = defineEmits<{
  select: [mode: PluginAudioMode]
  cancel: []
}>()
const modeList = useTemplateRef<HTMLDivElement>("modeList")
const visibleOptions = computed(() =>
  pluginAudioModeOptions(props.descriptor.kind, props.inputWidth)
)

function isSupported(mode: PluginAudioMode): boolean {
  return props.descriptor.supportedAudioModes.includes(mode)
}

function focusFirstMode(): void {
  modeList.value?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus()
}

function navigateModes(event: KeyboardEvent): void {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return
  const buttons = [
    ...(modeList.value?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])
  ]
  if (buttons.length === 0) return
  event.preventDefault()
  const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? buttons.length - 1
        : event.key === "ArrowUp"
          ? (current - 1 + buttons.length) % buttons.length
          : (current + 1) % buttons.length
  buttons[next]?.focus()
}

onMounted(focusFirstMode)
watch(() => [props.descriptor, props.inputWidth], focusFirstMode, { flush: "post" })
</script>

<template>
  <section class="mode-menu" aria-label="Choose plugin audio mode">
    <header>
      <button type="button" aria-label="Back to plugin list" @click="emit('cancel')">‹</button>
      <span
        ><b>{{ descriptor.name }}</b
        ><small>Choose audio mode</small></span
      >
    </header>
    <div ref="modeList" class="mode-list" @keydown="navigateModes">
      <button
        v-for="option in visibleOptions"
        :key="option.value"
        type="button"
        :disabled="!isSupported(option.value)"
        :title="
          isSupported(option.value)
            ? `${option.label}: ${option.detail}`
            : `${option.label} is not supported by this plug-in`
        "
        @click="emit('select', option.value)"
      >
        <strong>{{ option.badge }}</strong>
        <span
          ><b>{{ option.label }}</b
          ><small>{{ option.detail }}</small></span
        >
        <em v-if="!isSupported(option.value)">Unavailable</em>
      </button>
    </div>
  </section>
</template>

<style scoped>
.mode-menu {
  display: grid;
  gap: 9px;
}
.mode-menu header {
  display: grid;
  grid-template-columns: 25px minmax(0, 1fr);
  align-items: center;
  gap: 7px;
}
.mode-menu header button {
  height: 25px;
  border: 1px solid var(--line-strong);
  border-radius: 4px;
  color: var(--text-secondary);
  background: var(--daw-control);
  cursor: pointer;
}
.mode-menu header span,
.mode-menu header b,
.mode-menu header small {
  display: block;
  min-width: 0;
}
.mode-menu header b {
  overflow: hidden;
  font-size: var(--ui-type-size-label);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mode-menu header small {
  margin-top: 2px;
  color: var(--text-faint);
  font: var(--ui-type-size-caption) var(--ui-type-family-data);
}
.mode-list {
  display: grid;
  gap: 4px;
}
.mode-list > button {
  display: grid;
  grid-template-columns: 42px minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  min-height: 42px;
  padding: 5px 8px;
  border: 1px solid var(--line-soft);
  border-radius: 5px;
  color: var(--text-secondary);
  background: var(--daw-control);
  text-align: left;
  cursor: pointer;
}
.mode-list > button:hover:not(:disabled),
.mode-list > button:focus-visible {
  border-color: var(--focus);
  color: var(--text-primary);
  outline: none;
}
.mode-list > button:disabled {
  opacity: 0.42;
  cursor: not-allowed;
}
.mode-list > button > strong {
  color: var(--accent);
  font: var(--ui-type-weight-bold) var(--ui-type-size-control) var(--ui-type-family-data);
  text-align: center;
}
.mode-list span,
.mode-list b,
.mode-list small {
  display: block;
}
.mode-list b {
  font-size: var(--ui-type-size-control);
}
.mode-list small,
.mode-list em {
  margin-top: 2px;
  color: var(--text-faint);
  font: var(--ui-type-size-micro) var(--ui-type-family-data);
  font-style: normal;
}
</style>
