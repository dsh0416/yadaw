import { readonly, shallowRef } from "vue"

export type GlobalDialogTone = "default" | "warning" | "danger"
export type GlobalDialogActionKind = "primary" | "secondary" | "danger" | "cancel"

export interface GlobalDialogAction<Value extends string = string> {
  value: Value
  label: string
  kind?: GlobalDialogActionKind
}

export interface GlobalDialogOptions<Value extends string = string> {
  title: string
  description: string
  detail?: string
  eyebrow?: string
  tone?: GlobalDialogTone
  actions: readonly GlobalDialogAction<Value>[]
  cancelValue?: Value | null
}

export interface GlobalAlertOptions {
  title: string
  description: string
  detail?: string
  eyebrow?: string
  tone?: GlobalDialogTone
  actionLabel?: string
}

export interface GlobalConfirmOptions {
  title: string
  description: string
  detail?: string
  eyebrow?: string
  tone?: GlobalDialogTone
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
}

export interface ActiveGlobalDialog {
  id: number
  title: string
  description: string
  detail?: string
  eyebrow: string
  tone: GlobalDialogTone
  actions: readonly GlobalDialogAction[]
  cancelValue: string | null
}

interface PendingGlobalDialog {
  dialog: ActiveGlobalDialog
  resolve: (value: string | null) => void
}

const activeDialog = shallowRef<ActiveGlobalDialog | null>(null)
const queue: PendingGlobalDialog[] = []
let activePending: PendingGlobalDialog | null = null
let nextDialogId = 1

function showNext(): void {
  if (activePending || queue.length === 0) return
  activePending = queue.shift() ?? null
  activeDialog.value = activePending?.dialog ?? null
}

function finish(value: string | null): void {
  const pending = activePending
  if (!pending) return
  activePending = null
  activeDialog.value = null
  pending.resolve(value)
  queueMicrotask(showNext)
}

function showDialog<Value extends string>(
  options: GlobalDialogOptions<Value>
): Promise<Value | null> {
  return new Promise((resolve) => {
    queue.push({
      dialog: {
        id: nextDialogId++,
        title: options.title,
        description: options.description,
        detail: options.detail,
        eyebrow: options.eyebrow ?? "YADAW",
        tone: options.tone ?? "default",
        actions: options.actions,
        cancelValue: options.cancelValue ?? null
      },
      resolve: (value) => resolve(value as Value | null)
    })
    showNext()
  })
}

async function alert(options: GlobalAlertOptions): Promise<void> {
  await showDialog({
    ...options,
    actions: [
      {
        value: "dismiss",
        label: options.actionLabel ?? "OK",
        kind: "cancel"
      }
    ],
    cancelValue: "dismiss"
  })
}

async function confirm(options: GlobalConfirmOptions): Promise<boolean> {
  const result = await showDialog({
    ...options,
    actions: [
      {
        value: "confirm",
        label: options.confirmLabel ?? "Confirm",
        kind: options.destructive ? "danger" : "primary"
      },
      {
        value: "cancel",
        label: options.cancelLabel ?? "Cancel",
        kind: "cancel"
      }
    ],
    cancelValue: "cancel"
  })
  return result === "confirm"
}

function selectDialogAction(value: string): void {
  finish(value)
}

function dismissDialog(): void {
  finish(activePending?.dialog.cancelValue ?? null)
}

export function useGlobalDialog() {
  return {
    activeDialog: readonly(activeDialog),
    showDialog,
    alert,
    confirm,
    selectDialogAction,
    dismissDialog
  }
}
