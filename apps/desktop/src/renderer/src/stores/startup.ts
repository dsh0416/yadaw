import { defineStore } from "pinia"
import { onScopeDispose, shallowRef } from "vue"
import type { StartupProgressSnapshot } from "@yadaw/contracts"
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

  async function load(): Promise<void> {
    unsubscribe ??= window.yadaw.subscribeStartupProgress(receive)
    receive(await window.yadaw.startupProgressSnapshot())
  }

  function dispose(): void {
    unsubscribe?.()
    unsubscribe = null
  }

  onScopeDispose(dispose)

  return { progress, load, dispose }
})
