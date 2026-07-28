import { useIntervalFn } from "@vueuse/core"

export function useMixerMeterPolling(refresh: () => Promise<void>) {
  const polling = useIntervalFn(() => void refresh(), 33, { immediate: false })

  function start(): void {
    void refresh()
    polling.resume()
  }

  function stop(): void {
    polling.pause()
  }

  return { start, stop }
}
