<script setup lang="ts">
import { Minus, Square, X } from "@lucide/vue"
import type { ApplicationWindowCommandId } from "@heron/contracts"
import { useI18n } from "vue-i18n"

const emit = defineEmits<{
  command: [command: ApplicationWindowCommandId]
}>()

const { t } = useI18n()
</script>

<template>
  <div class="window-controls" role="group" :aria-label="t('chrome.windowControls')">
    <button
      class="window-control"
      type="button"
      :title="t('chrome.minimize')"
      :aria-label="t('chrome.minimize')"
      @click="emit('command', 'window.minimize')"
    >
      <Minus :size="13" :stroke-width="1.6" />
    </button>
    <button
      class="window-control"
      type="button"
      :title="t('chrome.maximizeOrRestore')"
      :aria-label="t('chrome.maximizeOrRestore')"
      @click="emit('command', 'window.toggle-maximize')"
    >
      <Square :size="10" :stroke-width="1.6" />
    </button>
    <button
      class="window-control window-control--close"
      type="button"
      :title="t('chrome.close')"
      :aria-label="t('chrome.close')"
      @click="emit('command', 'window.close')"
    >
      <X :size="13" :stroke-width="1.6" />
    </button>
  </div>
</template>

<style scoped>
.window-controls {
  display: flex;
  align-items: center;
  flex: none;
  gap: 2px;
  app-region: no-drag;
  -webkit-app-region: no-drag;
}

.window-control {
  display: grid;
  place-items: center;
  width: 32px;
  height: 27px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 4px;
  color: var(--text-muted);
  background: transparent;
  cursor: default;
  outline: none;
  transition:
    color var(--ui-motion-fast) var(--ui-ease-standard),
    background var(--ui-motion-fast) var(--ui-ease-standard),
    border-color var(--ui-motion-fast) var(--ui-ease-standard);
}

.window-control:hover {
  border-color: color-mix(in srgb, var(--line-strong) 72%, transparent);
  color: var(--text-primary);
  background: var(--surface-active);
}

.window-control:active {
  color: var(--accent-soft);
  background: var(--surface-sunken);
}

.window-control:focus-visible {
  border-color: var(--focus);
  box-shadow: var(--ui-focus-ring);
}

.window-control--close:hover,
.window-control--close:active {
  border-color: color-mix(in srgb, var(--record) 76%, var(--line-strong));
  color: var(--button-primary-text);
  background: color-mix(in srgb, var(--record) 82%, var(--surface-2));
}
</style>
