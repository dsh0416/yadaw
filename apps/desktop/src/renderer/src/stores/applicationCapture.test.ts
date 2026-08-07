import { beforeEach, describe, expect, it } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import type { ApplicationCaptureLogicalTarget } from "@heron/contracts"
import { useApplicationCaptureStore } from "./applicationCapture"

describe("application capture store", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
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
})
