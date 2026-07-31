import { acceptHMRUpdate, defineStore } from "pinia"
import { computed, ref } from "vue"
import type { OperationEvent, OperationSnapshot, RpcEvent } from "@yadaw/contracts"
import { mutationMeta } from "../rpc"
import { useProjectStore } from "./project"

export const useOperationStore = defineStore("operations", () => {
  const operations = ref<OperationSnapshot[]>([])
  const projectStore = useProjectStore()
  const completionTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const active = computed(
    () =>
      operations.value.find((operation) => operation.state === "running") ??
      operations.value[0] ??
      null
  )
  let unsubscribe: (() => void) | null = null

  let sourceEpoch: string | null = null
  let lastSequence = 0
  function startSubscription(): void {
    unsubscribe ??= window.yadaw.subscribeOperations(receive)
  }

  function stopSubscription(): void {
    unsubscribe?.()
    unsubscribe = null
    sourceEpoch = null
    lastSequence = 0
  }

  function apply(event: OperationEvent): void {
    const index = operations.value.findIndex((operation) => operation.id === event.operation.id)
    if (event.type === "remove") {
      clearCompletionTimer(event.operation.id)
      if (index >= 0) operations.value.splice(index, 1)
      return
    }
    if (index >= 0) operations.value[index] = event.operation
    else operations.value.push(event.operation)
    scheduleCompletionCleanup(event.operation)
  }

  function receive(event: RpcEvent<OperationEvent>): void {
    if (
      sourceEpoch !== null &&
      (event.sourceEpoch !== sourceEpoch || event.sequence !== lastSequence + 1)
    ) {
      for (const operation of operations.value) clearCompletionTimer(operation.id)
      operations.value = []
    }
    sourceEpoch = event.sourceEpoch
    lastSequence = event.sequence
    apply(event.payload)
  }

  function clearCompletionTimer(id: string): void {
    const timer = completionTimers.get(id)
    if (timer !== undefined) clearTimeout(timer)
    completionTimers.delete(id)
  }

  function scheduleCompletionCleanup(operation: OperationSnapshot): void {
    clearCompletionTimer(operation.id)
    if (operation.state !== "completed" || operation.message || operation.dropoutFrames > 0) return
    completionTimers.set(
      operation.id,
      setTimeout(() => {
        completionTimers.delete(operation.id)
        const index = operations.value.findIndex((item) => item.id === operation.id)
        if (index >= 0 && operations.value[index]?.state === "completed") {
          operations.value.splice(index, 1)
        }
        void acknowledge(operation.id)
      }, 750)
    )
  }

  async function cancel(id: string): Promise<void> {
    const target = projectStore.desktopSession
    if (!target) return
    await window.yadaw.cancelOperation(mutationMeta(target, "operation-cancel"), id)
  }

  async function acknowledge(id: string): Promise<void> {
    const target = projectStore.desktopSession
    if (!target) return
    await window.yadaw.acknowledgeOperation(mutationMeta(target, "operation-acknowledge"), id)
  }

  function dismiss(id: string): void {
    clearCompletionTimer(id)
    const index = operations.value.findIndex((operation) => operation.id === id)
    if (index >= 0 && operations.value[index]?.state !== "running")
      operations.value.splice(index, 1)
    void acknowledge(id)
  }

  return {
    operations,
    active,
    apply,
    cancel,
    dismiss,
    startSubscription,
    stopSubscription
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useOperationStore, import.meta.hot))
}
