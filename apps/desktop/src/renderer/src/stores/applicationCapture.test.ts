import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import type { ApplicationCaptureLogicalTarget } from "@heron/contracts"
import { rpcFailure, rpcSuccess, testBootstrap } from "../test/ipc"
import { useAudioRuntimeStore } from "./audioRuntime"
import { useApplicationCaptureStore } from "./applicationCapture"

describe("application capture store", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("matches a legacy macOS path target to a live target that now has a bundle id", () => {
    const store = useApplicationCaptureStore()
    const savedTarget: ApplicationCaptureLogicalTarget = {
      platform: "macos",
      bundleIdentifier: null,
      executablePath: "/Applications/Player.app/Contents/MacOS/Player",
      executableName: "Player",
      includeProcessTree: true
    }
    const liveTarget: ApplicationCaptureLogicalTarget = {
      ...savedTarget,
      bundleIdentifier: "com.example.player",
      executablePath: "/applications/player.app/contents/macos/player"
    }
    store.targets = [
      {
        runtimeId: "macos-process-42",
        processId: 42,
        displayName: "Player",
        executablePath: liveTarget.executablePath,
        logicalTarget: liveTarget,
        channelCount: 2,
        status: "inactive"
      }
    ]
    store.snapshots = [
      {
        ...store.targets[0]!,
        status: "capturing",
        dropoutFrames: 0,
        overflowFrames: 0,
        underflowFrames: 0
      }
    ]

    expect(store.targetFor(savedTarget)?.runtimeId).toBe("macos-process-42")
    expect(store.snapshotFor(savedTarget)?.status).toBe("capturing")
  })

  it("rejects targets from another platform and normalizes Windows paths", () => {
    const requested: ApplicationCaptureLogicalTarget = {
      platform: "windows",
      executablePath: " C:\\Program Files\\Player\\PLAYER.EXE ",
      executableName: "player.exe",
      includeProcessTree: true
    }
    const store = useApplicationCaptureStore()
    store.targets = [
      {
        runtimeId: "windows-process-42",
        processId: 42,
        displayName: "Player",
        executablePath: "c:/program files/player/player.exe",
        logicalTarget: {
          ...requested,
          executablePath: "c:/program files/player/player.exe"
        },
        channelCount: 2,
        status: "inactive"
      }
    ]

    expect(store.targetFor(requested)?.runtimeId).toBe("windows-process-42")
    expect(
      store.targetFor({
        platform: "macos",
        bundleIdentifier: null,
        executablePath: requested.executablePath,
        executableName: "Player",
        includeProcessTree: true
      })
    ).toBeUndefined()
  })

  it("refreshes targets and snapshots and exposes active captures", async () => {
    const resources = testBootstrap().audioResources
    useAudioRuntimeStore().audioHostRef = resources.host
    const target = {
      runtimeId: "windows-process-42",
      processId: 42,
      displayName: "Player",
      executablePath: "C:/Player/player.exe",
      logicalTarget: {
        platform: "windows" as const,
        executablePath: "C:/Player/player.exe",
        executableName: "player.exe",
        includeProcessTree: true
      },
      channelCount: 2,
      status: "inactive" as const
    }
    window.heron.listApplicationCaptureTargets = vi.fn().mockResolvedValue(rpcSuccess([target]))
    window.heron.applicationCaptureSnapshot = vi.fn().mockResolvedValue(
      rpcSuccess([
        {
          ...target,
          status: "capturing" as const,
          dropoutFrames: 1,
          overflowFrames: 2,
          underflowFrames: 3
        }
      ])
    )
    const store = useApplicationCaptureStore()

    await store.refresh()

    expect(store.targets).toEqual([target])
    expect(store.capturing).toHaveLength(1)
    expect(store.error).toBeNull()
    expect(store.loading).toBe(false)
  })

  it("records RPC failures and ignores overlapping or hostless refreshes", async () => {
    const runtime = useAudioRuntimeStore()
    const store = useApplicationCaptureStore()
    window.heron.listApplicationCaptureTargets = vi.fn()

    await store.refresh()
    expect(window.heron.listApplicationCaptureTargets).not.toHaveBeenCalled()

    runtime.audioHostRef = testBootstrap().audioResources.host
    window.heron.listApplicationCaptureTargets = vi
      .fn()
      .mockResolvedValue(rpcFailure("audio-host-unavailable"))
    window.heron.applicationCaptureSnapshot = vi.fn().mockResolvedValue(rpcSuccess([]))
    await store.refresh()

    expect(store.error).toBe("resource-unavailable")
    store.loading = true
    await store.refresh()
    expect(window.heron.listApplicationCaptureTargets).toHaveBeenCalledOnce()
  })

  it("shares one polling timer across consumers and stops after the last consumer leaves", async () => {
    vi.useFakeTimers()
    useAudioRuntimeStore().audioHostRef = testBootstrap().audioResources.host
    window.heron.listApplicationCaptureTargets = vi.fn().mockResolvedValue(rpcSuccess([]))
    window.heron.applicationCaptureSnapshot = vi.fn().mockResolvedValue(rpcSuccess([]))
    const store = useApplicationCaptureStore()

    store.startPolling()
    store.startPolling()
    await vi.runOnlyPendingTimersAsync()
    store.stopPolling()
    await vi.advanceTimersByTimeAsync(1_000)
    const callsWhileShared = vi.mocked(window.heron.listApplicationCaptureTargets).mock.calls.length
    store.stopPolling()
    await vi.advanceTimersByTimeAsync(2_000)

    expect(callsWhileShared).toBeGreaterThan(0)
    expect(window.heron.listApplicationCaptureTargets).toHaveBeenCalledTimes(callsWhileShared)
    store.stopPolling()
  })
})
