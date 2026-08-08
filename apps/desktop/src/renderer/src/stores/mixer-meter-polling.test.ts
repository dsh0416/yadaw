import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useMixerMeterPolling } from "./mixer-meter-polling"

describe("useMixerMeterPolling", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("refreshes immediately when polling starts and then on the interval", async () => {
    const refresh = vi.fn(async () => {})
    const polling = useMixerMeterPolling(refresh)

    polling.start()
    await Promise.resolve()
    expect(refresh).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(33)
    expect(refresh).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(33)
    expect(refresh).toHaveBeenCalledTimes(3)
  })

  it("stops interval callbacks after stop is called", async () => {
    const refresh = vi.fn(async () => {})
    const polling = useMixerMeterPolling(refresh)

    polling.start()
    await Promise.resolve()
    polling.stop()

    await vi.advanceTimersByTimeAsync(100)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it("does not start the interval until start is called", async () => {
    const refresh = vi.fn(async () => {})
    useMixerMeterPolling(refresh)

    await vi.advanceTimersByTimeAsync(100)
    expect(refresh).not.toHaveBeenCalled()
  })

  it("coalesces overlapping intervals into one trailing refresh", async () => {
    let resolveRefresh!: () => void
    const refresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRefresh = resolve
        })
    )
    const polling = useMixerMeterPolling(refresh)

    polling.start()
    await vi.advanceTimersByTimeAsync(99)
    expect(refresh).toHaveBeenCalledTimes(1)

    resolveRefresh()
    await Promise.resolve()
    expect(refresh).toHaveBeenCalledTimes(2)

    polling.stop()
    resolveRefresh()
  })

  it("does not schedule a trailing refresh after polling stops", async () => {
    let resolveRefresh!: () => void
    const refresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRefresh = resolve
        })
    )
    const polling = useMixerMeterPolling(refresh)

    polling.start()
    await vi.advanceTimersByTimeAsync(33)
    polling.stop()
    resolveRefresh()
    await Promise.resolve()

    expect(refresh).toHaveBeenCalledTimes(1)
  })
})
