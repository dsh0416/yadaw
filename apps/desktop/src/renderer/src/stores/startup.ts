import { defineStore } from "pinia"
import { onScopeDispose, shallowRef } from "vue"
import type { RpcEvent, StartupProgressSnapshot } from "@yadaw/contracts"
import { i18n } from "../i18n"
import { readMeta, rpcErrorMessage } from "../rpc"

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
    if (
      sourceEpoch !== null &&
      (event.sourceEpoch !== sourceEpoch || event.sequence !== lastSequence + 1)
    ) {
      void refreshSnapshot()
      return
    }
    sourceEpoch = event.sourceEpoch
    lastSequence = event.sequence
    receive(event.payload)
  }

  async function load(): Promise<void> {
    unsubscribe ??= window.yadaw.subscribeStartupProgress(receiveEvent)
    await refreshSnapshot()
  }

  async function refreshSnapshot(): Promise<void> {
    const result = await window.yadaw.startupProgressSnapshot(readMeta())
    if (result.ok) receive(result.value)
    else {
      receive({
        ...progress.value,
        phase: "failed",
        detail: rpcErrorMessage(result.error)
      })
    }
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
