<script setup lang="ts">
import {
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogRoot,
  AlertDialogTitle
} from "reka-ui"
import { AlertTriangle, CircleAlert, Info, X } from "@lucide/vue"
import { computed } from "vue"
import { useGlobalDialog } from "../../composables/useGlobalDialog"

const {
  activeDialog,
  selectDialogAction,
  dismissDialog
} = useGlobalDialog()

const toneIcon = computed(() => {
  if (activeDialog.value?.tone === "danger") return CircleAlert
  if (activeDialog.value?.tone === "warning") return AlertTriangle
  return Info
})

function handleOpenChange(open: boolean): void {
  if (!open) dismissDialog()
}
</script>

<template>
  <AlertDialogRoot :open="Boolean(activeDialog)" @update:open="handleOpenChange">
    <AlertDialogPortal>
      <AlertDialogOverlay class="global-dialog-overlay" />
      <AlertDialogContent
        v-if="activeDialog"
        class="global-dialog"
        :data-tone="activeDialog.tone"
        @escape-key-down="dismissDialog"
      >
        <div class="global-dialog-signal" aria-hidden="true">
          <component :is="toneIcon" :size="18" :stroke-width="1.6" />
          <span />
        </div>

        <div class="global-dialog-body">
          <header class="global-dialog-header">
            <span>{{ activeDialog.eyebrow }}</span>
            <AlertDialogCancel
              class="global-dialog-close"
              aria-label="Close dialog"
              @click="dismissDialog"
            >
              <X :size="15" />
            </AlertDialogCancel>
          </header>

          <AlertDialogTitle class="global-dialog-title">
            {{ activeDialog.title }}
          </AlertDialogTitle>
          <AlertDialogDescription class="global-dialog-description">
            {{ activeDialog.description }}
          </AlertDialogDescription>
          <p v-if="activeDialog.detail" class="global-dialog-detail">
            {{ activeDialog.detail }}
          </p>

          <footer class="global-dialog-actions">
            <template v-for="action in activeDialog.actions" :key="action.value">
              <AlertDialogCancel
                v-if="action.kind === 'cancel'"
                class="global-dialog-button"
                :data-kind="action.kind"
                @click="selectDialogAction(action.value)"
              >
                {{ action.label }}
              </AlertDialogCancel>
              <button
                v-else
                type="button"
                class="global-dialog-button"
                :data-kind="action.kind ?? 'secondary'"
                @click="selectDialogAction(action.value)"
              >
                {{ action.label }}
              </button>
            </template>
          </footer>
        </div>
      </AlertDialogContent>
    </AlertDialogPortal>
  </AlertDialogRoot>
</template>

<style scoped>
.global-dialog-overlay {
  position: fixed;
  z-index: 400;
  inset: 0;
  background: color-mix(in srgb, var(--surface-sunken) 82%, transparent);
  backdrop-filter: blur(3px);
  animation: global-dialog-overlay-in 120ms ease-out;
}

.global-dialog {
  position: fixed;
  z-index: 401;
  top: 50%;
  left: 50%;
  display: grid;
  grid-template-columns: 42px minmax(0, 1fr);
  width: min(470px, calc(100vw - 48px));
  border: 1px solid var(--line-strong);
  border-radius: 10px;
  color: var(--text-primary);
  background: var(--surface-1);
  box-shadow: 0 28px 90px var(--shadow);
  overflow: hidden;
  transform: translate(-50%, -50%);
  animation: global-dialog-content-in 140ms cubic-bezier(.2, .8, .2, 1);
}

.global-dialog-signal {
  display: flex;
  align-items: center;
  flex-direction: column;
  gap: 10px;
  padding: 19px 0;
  border-right: 1px solid var(--line-soft);
  color: var(--accent);
  background: var(--surface-sunken);
}

.global-dialog-signal span {
  width: 2px;
  min-height: 46px;
  border-radius: 999px;
  background: currentColor;
  opacity: .48;
}

.global-dialog[data-tone="warning"] .global-dialog-signal {
  color: var(--warning);
}

.global-dialog[data-tone="danger"] .global-dialog-signal {
  color: var(--record);
}

.global-dialog-body {
  min-width: 0;
  padding: 18px 20px 20px;
}

.global-dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 20px;
}

.global-dialog-header > span {
  color: var(--text-faint);
  font: 700 7px var(--font-utility);
  letter-spacing: .18em;
  text-transform: uppercase;
}

.global-dialog-close {
  display: grid;
  place-items: center;
  width: 27px;
  height: 27px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 6px;
  color: var(--text-muted);
  background: transparent;
  cursor: pointer;
}

.global-dialog-close:hover {
  color: var(--text-primary);
  background: var(--surface-3);
}

.global-dialog-title {
  margin: 11px 0 7px;
  font: 560 20px/1.15 var(--font-display);
  letter-spacing: -.01em;
}

.global-dialog-description,
.global-dialog-detail {
  margin: 0;
  color: var(--text-secondary);
  font-size: 10px;
  line-height: 1.6;
}

.global-dialog-detail {
  margin-top: 8px;
  color: var(--text-muted);
}

.global-dialog-actions {
  display: flex;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 22px;
}

.global-dialog-button {
  min-width: 76px;
  padding: 8px 12px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  color: var(--text-secondary);
  background: var(--surface-3);
  font-size: 9px;
  cursor: pointer;
}

.global-dialog-button:hover {
  color: var(--text-primary);
  background: var(--surface-active);
}

.global-dialog-button[data-kind="primary"] {
  border-color: var(--accent-strong);
  color: var(--button-primary-text);
  background: var(--button-primary);
}

.global-dialog-button[data-kind="danger"] {
  border-color: color-mix(in srgb, var(--record) 68%, var(--line-strong));
  color: var(--button-primary-text);
  background: color-mix(in srgb, var(--record) 64%, var(--surface-3));
}

.global-dialog-button:focus-visible,
.global-dialog-close:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}

@keyframes global-dialog-overlay-in {
  from { opacity: 0; }
}

@keyframes global-dialog-content-in {
  from { opacity: 0; transform: translate(-50%, calc(-50% + 8px)) scale(.985); }
}
</style>
