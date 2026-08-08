import { useIntervalFn } from "@vueuse/core"

export function useMixerMeterPolling(refresh: () => Promise<void>) {
  let active = false
  let refreshing = false
  let pending = false

  async function requestRefresh(): Promise<void> {
    if (refreshing) {
      pending = true
      return
    }
    refreshing = true
    try {
      do {
        pending = false
        await refresh()
      } while (active && pending)
    } finally {
      refreshing = false
    }
  }

  const polling = useIntervalFn(() => void requestRefresh(), 33, { immediate: false })

  function start(): void {
    if (active) return
    active = true
    void requestRefresh()
    polling.resume()
  }

  function stop(): void {
    active = false
    pending = false
    polling.pause()
  }

  return { start, stop }
}
