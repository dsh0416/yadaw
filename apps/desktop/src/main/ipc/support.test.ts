import type { IpcMainInvokeEvent } from "electron"
import { basename, dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { rendererDirectory } from "../runtime-paths"
import { assertTrustedSender } from "./support"

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "") }
}))

function eventFrom(url: string): IpcMainInvokeEvent {
  return { senderFrame: { url } } as unknown as IpcMainInvokeEvent
}

describe("assertTrustedSender", () => {
  beforeEach(() => {
    vi.stubEnv("YADAW_RENDERER_URL", "")
  })

  it("accepts a packaged renderer loaded from the shared runtime directory", () => {
    const rendererUrl = pathToFileURL(join(rendererDirectory, "index.html")).href

    expect(() => assertTrustedSender(eventFrom(rendererUrl))).not.toThrow()
  })

  it("rejects a file from a sibling directory with the same path prefix", () => {
    const siblingUrl = pathToFileURL(
      join(dirname(rendererDirectory), `${basename(rendererDirectory)}-spoof`, "index.html")
    ).href

    expect(() => assertTrustedSender(eventFrom(siblingUrl))).toThrow(
      "Rejected IPC call from an untrusted renderer"
    )
  })
})
