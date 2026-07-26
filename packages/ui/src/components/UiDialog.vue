<script setup lang="ts">
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
  DialogTrigger
} from "reka-ui"

const open = defineModel<boolean>({ default: false })
const props = withDefaults(
  defineProps<{
    title: string
    description?: string
    size?: "sm" | "md" | "lg"
    modal?: boolean
    closeLabel?: string
    dismissible?: boolean
  }>(),
  {
    description: undefined,
    size: "md",
    modal: true,
    closeLabel: "Close dialog",
    dismissible: true
  }
)

defineSlots<{
  default(): unknown
  header(): unknown
  actions(): unknown
  trigger(): unknown
}>()
</script>

<template>
  <DialogRoot v-model:open="open" :modal="props.modal">
    <DialogTrigger v-if="$slots.trigger" as-child>
      <slot name="trigger" />
    </DialogTrigger>
    <DialogPortal>
      <DialogOverlay class="ui-dialog__overlay" />
      <DialogContent
        class="ui-dialog"
        :class="`ui-dialog--${props.size}`"
        @escape-key-down="props.dismissible ? undefined : $event.preventDefault()"
        @pointer-down-outside="props.dismissible ? undefined : $event.preventDefault()"
        @interact-outside="props.dismissible ? undefined : $event.preventDefault()"
      >
        <header class="ui-dialog__header">
          <slot name="header">
            <div class="ui-dialog__heading">
              <DialogTitle class="ui-dialog__title">{{ props.title }}</DialogTitle>
              <DialogDescription v-if="props.description" class="ui-dialog__description">
                {{ props.description }}
              </DialogDescription>
            </div>
          </slot>
          <DialogClose
            v-if="props.dismissible"
            class="ui-dialog__close"
            :aria-label="props.closeLabel"
          >
            <span aria-hidden="true">×</span>
          </DialogClose>
        </header>
        <div class="ui-dialog__body" tabindex="0">
          <slot />
        </div>
        <footer v-if="$slots.actions" class="ui-dialog__actions">
          <slot name="actions" />
        </footer>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<style>
.ui-dialog__overlay {
  position: fixed;
  z-index: var(--ui-z-overlay);
  inset: 0;
  background: var(--ui-color-overlay);
  backdrop-filter: blur(3px);
}

.ui-dialog {
  position: fixed;
  z-index: var(--ui-z-dialog);
  top: 50%;
  left: 50%;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  width: calc(100vw - 2rem);
  max-height: min(46rem, calc(100dvh - 2rem));
  overflow: hidden;
  color: var(--ui-color-text);
  background: var(--ui-color-surface);
  border: 1px solid var(--ui-color-border);
  border-radius: var(--ui-radius-lg);
  box-shadow: var(--ui-shadow-lg);
  transform: translate(-50%, -50%);
}

.ui-dialog--sm {
  max-width: 28rem;
}

.ui-dialog--md {
  max-width: 38rem;
}

.ui-dialog--lg {
  max-width: 56rem;
}

.ui-dialog__header {
  display: flex;
  min-width: 0;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--ui-space-4);
  padding: var(--ui-space-5) var(--ui-space-6);
  border-bottom: 1px solid var(--ui-color-border);
}

.ui-dialog__heading {
  display: grid;
  min-width: 0;
  gap: var(--ui-space-2);
}

.ui-dialog__title {
  margin: 0;
  font-size: var(--ui-font-size-xl);
  font-weight: var(--ui-weight-semibold);
  line-height: var(--ui-line-tight);
}

.ui-dialog__description {
  margin: 0;
  color: var(--ui-color-text-muted);
  font-size: var(--ui-font-size-sm);
  line-height: var(--ui-line-normal);
}

.ui-dialog__close {
  display: inline-grid;
  width: var(--ui-control-sm);
  min-width: var(--ui-control-sm);
  height: var(--ui-control-sm);
  padding: 0;
  place-items: center;
  color: var(--ui-color-text-muted);
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--ui-radius-md);
  font-size: var(--ui-font-size-xl);
  cursor: pointer;
}

.ui-dialog__close:hover {
  color: var(--ui-color-text);
  background: var(--ui-color-surface-hover);
}

.ui-dialog__body {
  min-width: 0;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  padding: var(--ui-space-6);
}

.ui-dialog__body:focus-visible {
  outline: var(--ui-focus-width) solid var(--ui-color-focus);
  outline-offset: calc(var(--ui-focus-width) * -1);
}

.ui-dialog__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--ui-space-3);
  padding: var(--ui-space-4) var(--ui-space-6);
  border-top: 1px solid var(--ui-color-border);
}

@media (max-width: 30rem) {
  .ui-dialog {
    width: calc(100vw - 1rem);
    max-height: calc(100dvh - 1rem);
  }

  .ui-dialog__header,
  .ui-dialog__body,
  .ui-dialog__actions {
    padding-right: var(--ui-space-4);
    padding-left: var(--ui-space-4);
  }

  .ui-dialog__actions > * {
    flex: 1 1 auto;
  }
}
</style>
