import { defineStore } from "pinia"
import { onScopeDispose, shallowRef } from "vue"
import type { RpcEvent, StartupProgressSnapshot } from "@heron/contracts"
import { i18n } from "../i18n"
const INITIAL_PROGRESS: StartupProgressSnapshot = {
  phase: "starting",
  progress: 0,
  label: i18n.global.t("startup.starting"),
  detail: i18n.global.t("startup.preparing"),
  completed: null,
  total: null,
  warnings: 0
}

export const useStartupStore = defineStore("startup", () => {
  const progress = shallowRef<StartupProgressSnapshot>(structuredClone(INITIAL_PROGRESS))
  let sourceEpoch: string | null = null
  let lastSequence = 0
  let unsubscribe: (() => void) | null = null

  function receive(next: StartupProgressSnapshot): void {
    if (
      next.phase !== "failed" &&
      next.phase !== "ready" &&
      next.progress < progress.value.progress
    ) {
      return
    }
    progress.value = next
  }
  function receiveEvent(event: RpcEvent<StartupProgressSnapshot>): void {
    if (sourceEpoch === event.sourceEpoch && event.sequence <= lastSequence) {
      return
    }
    sourceEpoch = event.sourceEpoch
    lastSequence = event.sequence
    receive(event.payload)
  }

  function load(): void {
    unsubscribe ??= window.heronSplash.subscribeStartupProgress(receiveEvent)
  }

  function dispose(): void {
    unsubscribe?.()
    unsubscribe = null
    sourceEpoch = null
    lastSequence = 0
  }

  onScopeDispose(dispose)

  return { progress, load, dispose }
})
