import { acceptHMRUpdate, defineStore } from "pinia"
import { computed, ref } from "vue"
import type { OperationEvent, OperationSnapshot } from "@yadaw/contracts"

export const useOperationStore = defineStore("operations", () => {
  const operations = ref<OperationSnapshot[]>([])
  const completionTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const active = computed(() =>
    operations.value.find((operation) => operation.state === "running") ?? operations.value[0] ?? null
  )
  let unsubscribe: (() => void) | null = null

  function startSubscription(): void {
    unsubscribe ??= window.yadaw.subscribeOperations(apply)
  }

  function stopSubscription(): void {
    unsubscribe?.()
    unsubscribe = null
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

  function clearCompletionTimer(id: string): void {
    const timer = completionTimers.get(id)
    if (timer !== undefined) clearTimeout(timer)
    completionTimers.delete(id)
  }

  function scheduleCompletionCleanup(operation: OperationSnapshot): void {
    clearCompletionTimer(operation.id)
    if (operation.state !== "completed" || operation.message || operation.dropoutFrames > 0) return
    completionTimers.set(operation.id, setTimeout(() => {
      completionTimers.delete(operation.id)
      const index = operations.value.findIndex((item) => item.id === operation.id)
      if (index >= 0 && operations.value[index]?.state === "completed") {
        operations.value.splice(index, 1)
      }
    }, 750))
  }

  async function cancel(id: string): Promise<void> {
    await window.yadaw.cancelOperation(id)
  }

  function dismiss(id: string): void {
    clearCompletionTimer(id)
    const index = operations.value.findIndex((operation) => operation.id === id)
    if (index >= 0 && operations.value[index]?.state !== "running") operations.value.splice(index, 1)
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
