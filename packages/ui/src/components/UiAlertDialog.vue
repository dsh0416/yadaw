<script setup lang="ts">
import {
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogRoot,
  AlertDialogTitle,
  AlertDialogTrigger
} from "reka-ui"

import type { UiAlertAction, UiNoticeTone } from "../types"

const open = defineModel<boolean>({ default: false })
const props = withDefaults(
  defineProps<{
    eyebrow?: string
    title: string
    description: string
    confirmLabel?: string
    cancelLabel?: string
    tone?: Extract<UiNoticeTone, "neutral" | "warning" | "danger">
    busy?: boolean
    actions?: readonly UiAlertAction[]
  }>(),
  {
    eyebrow: undefined,
    confirmLabel: "Continue",
    cancelLabel: "Cancel",
    tone: "neutral",
    busy: false,
    actions: undefined
  }
)

const emit = defineEmits<{
  confirm: []
  cancel: []
  action: [value: string]
}>()
</script>

<template>
  <AlertDialogRoot v-model:open="open">
    <AlertDialogTrigger v-if="$slots.trigger" as-child>
      <slot name="trigger" />
    </AlertDialogTrigger>
    <AlertDialogPortal>
      <AlertDialogOverlay class="ui-dialog__overlay" />
      <AlertDialogContent
        class="ui-alert-dialog"
        :data-tone="props.tone"
        @escape-key-down="props.busy ? $event.preventDefault() : undefined"
        @pointer-down-outside="props.busy ? $event.preventDefault() : undefined"
      >
        <div class="ui-alert-dialog__marker" aria-hidden="true">!</div>
        <div class="ui-alert-dialog__copy">
          <span v-if="props.eyebrow" class="ui-alert-dialog__eyebrow">
            {{ props.eyebrow }}
          </span>
          <AlertDialogTitle class="ui-alert-dialog__title">
            {{ props.title }}
          </AlertDialogTitle>
          <AlertDialogDescription class="ui-alert-dialog__description">
            {{ props.description }}
          </AlertDialogDescription>
          <div v-if="$slots.default" class="ui-alert-dialog__detail">
            <slot />
          </div>
        </div>
        <div class="ui-alert-dialog__actions">
          <template v-if="props.actions">
            <template v-for="action in props.actions" :key="action.value">
              <AlertDialogCancel
                v-if="action.cancel"
                class="ui-alert-dialog__button ui-alert-dialog__button--secondary"
                :disabled="props.busy"
                @click.capture="emit('action', action.value)"
              >
                {{ action.label }}
              </AlertDialogCancel>
              <AlertDialogAction
                v-else
                class="ui-alert-dialog__button"
                :class="`ui-alert-dialog__button--${action.variant ?? 'primary'}`"
                :disabled="props.busy"
                @click.capture="emit('action', action.value)"
              >
                {{ action.label }}
              </AlertDialogAction>
            </template>
          </template>
          <template v-else>
            <AlertDialogCancel
              class="ui-alert-dialog__button ui-alert-dialog__button--secondary"
              :disabled="props.busy"
              @click="emit('cancel')"
            >
              {{ props.cancelLabel }}
            </AlertDialogCancel>
            <AlertDialogAction
              class="ui-alert-dialog__button"
              :class="`ui-alert-dialog__button--${props.tone}`"
              :disabled="props.busy"
              @click="emit('confirm')"
            >
              {{ props.confirmLabel }}
            </AlertDialogAction>
          </template>
        </div>
      </AlertDialogContent>
    </AlertDialogPortal>
  </AlertDialogRoot>
</template>

<style>
.ui-alert-dialog {
  position: fixed;
  z-index: var(--ui-z-dialog);
  top: 50%;
  left: 50%;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  width: calc(100vw - 2rem);
  max-width: 32rem;
  max-height: calc(100dvh - 2rem);
  overflow: auto;
  gap: var(--ui-space-4);
  padding: var(--ui-space-6);
  color: var(--ui-color-text);
  background: var(--ui-color-surface);
  border: 1px solid var(--ui-color-border);
  border-radius: var(--ui-radius-lg);
  box-shadow: var(--ui-shadow-lg);
  transform: translate(-50%, -50%);
}

.ui-alert-dialog__marker {
  display: grid;
  width: 2rem;
  height: 2rem;
  place-items: center;
  color: var(--ui-color-action-text);
  background: var(--ui-color-info);
  border-radius: 50%;
  font-weight: var(--ui-type-weight-semibold);
}

.ui-alert-dialog[data-tone="warning"] .ui-alert-dialog__marker {
  color: var(--ui-color-text-inverse);
  background: var(--ui-color-warning);
}

.ui-alert-dialog[data-tone="danger"] .ui-alert-dialog__marker {
  color: var(--ui-color-danger-text);
  background: var(--ui-color-danger);
}

.ui-alert-dialog__copy {
  display: grid;
  min-width: 0;
  gap: var(--ui-space-2);
}

.ui-alert-dialog__eyebrow {
  color: var(--ui-color-text-subtle);
  font: var(--ui-type-weight-semibold) var(--ui-font-size-xs) var(--ui-type-family-data);
  letter-spacing: var(--ui-type-tracking-wider);
  text-transform: uppercase;
}

.ui-alert-dialog__title {
  margin: 0;
  font-size: var(--ui-font-size-lg);
  font-weight: var(--ui-type-weight-semibold);
  line-height: var(--ui-type-leading-tight);
}

.ui-alert-dialog__description,
.ui-alert-dialog__detail {
  margin: 0;
  color: var(--ui-color-text-muted);
  font-size: var(--ui-font-size-sm);
  line-height: var(--ui-type-leading-normal);
}

.ui-alert-dialog__actions {
  display: flex;
  grid-column: 1 / -1;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--ui-space-3);
  margin-top: var(--ui-space-2);
}

.ui-alert-dialog__button {
  min-height: var(--ui-control-md);
  padding: 0 var(--ui-space-4);
  color: var(--ui-color-action-text);
  background: var(--ui-color-action);
  border: 1px solid transparent;
  border-radius: var(--ui-radius-md);
  font-weight: var(--ui-type-weight-semibold);
  cursor: pointer;
}

.ui-alert-dialog__button--secondary {
  color: var(--ui-color-text);
  background: var(--ui-color-surface-raised);
  border-color: var(--ui-color-border);
}

.ui-alert-dialog__button--danger {
  color: var(--ui-color-danger-text);
  background: var(--ui-color-danger);
}

.ui-alert-dialog__button--ghost {
  color: var(--ui-color-text-muted);
  background: transparent;
}

.ui-alert-dialog__button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

@media (max-width: 24rem) {
  .ui-alert-dialog {
    grid-template-columns: 1fr;
    width: calc(100vw - 1rem);
    padding: var(--ui-space-4);
  }

  .ui-alert-dialog__actions {
    grid-column: auto;
  }

  .ui-alert-dialog__button {
    flex: 1 1 auto;
  }
}
</style>
