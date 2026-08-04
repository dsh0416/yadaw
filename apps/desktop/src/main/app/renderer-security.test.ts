import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it, vi } from "vitest"
import {
  denyChromiumPermissions,
  handleRendererProtocolRequest,
  registerRendererScheme,
  resolveRendererResourcePath
} from "./renderer-security"
import { rendererDirectory } from "./runtime-paths"

describe("renderer protocol", () => {
  it("registers only the required privileges before app readiness", () => {
    const registerSchemesAsPrivileged = vi.fn()
    registerRendererScheme({ registerSchemesAsPrivileged })

    expect(registerSchemesAsPrivileged).toHaveBeenCalledWith([
      {
        scheme: "heron-app",
        privileges: {
          standard: true,
          secure: true,
          supportFetchAPI: true,
          codeCache: true
        }
      }
    ])
  })

  it("maps valid bundle resources to the renderer output directory", () => {
    const path = resolveRendererResourcePath("heron-app://bundle/assets/main.js")

    expect(path).not.toBeNull()
    expect(path).toBe(join(rendererDirectory, "assets", "main.js"))
  })

  it.each([
    "heron-app://unknown/index.html",
    "heron-app://bundle/../secret.txt",
    "heron-app://bundle/%2e%2e/secret.txt",
    "heron-app://bundle/assets%5csecret.txt",
    "heron-app://bundle/%E0%A4%A"
  ])("rejects unsafe resource URL %s", (url) => {
    expect(resolveRendererResourcePath(url)).toBeNull()
  })

  it("serves files through net.fetch and maps failures to 404", async () => {
    const fetchResource = vi.fn(async (_url: string) => new Response("ok"))
    const response = await handleRendererProtocolRequest(
      { method: "GET", url: "heron-app://bundle/index.html" },
      fetchResource
    )

    expect(response.status).toBe(200)
    expect(fileURLToPath(fetchResource.mock.calls[0]![0])).toMatch(/renderer[\\/]index\.html$/)

    const missing = await handleRendererProtocolRequest(
      { method: "GET", url: "heron-app://bundle/missing.js" },
      async () => new Response(null, { status: 404 })
    )
    expect(missing.status).toBe(404)
  })

  it("rejects non-GET requests before fetching", async () => {
    const fetchResource = vi.fn(async (_url: string) => new Response("ok"))
    const response = await handleRendererProtocolRequest(
      { method: "POST", url: "heron-app://bundle/index.html" },
      fetchResource
    )

    expect(response.status).toBe(405)
    expect(fetchResource).not.toHaveBeenCalled()
  })
})

describe("denyChromiumPermissions", () => {
  it("denies permission checks and requests", () => {
    let checkHandler: (() => boolean) | undefined
    let requestHandler:
      | ((webContents: unknown, permission: string, callback: (allowed: boolean) => void) => void)
      | undefined
    const target = {
      setPermissionCheckHandler: vi.fn((handler) => {
        checkHandler = handler
      }),
      setPermissionRequestHandler: vi.fn((handler) => {
        requestHandler = handler
      })
    }
    denyChromiumPermissions(target as never)

    expect(checkHandler?.()).toBe(false)
    const callback = vi.fn()
    requestHandler?.({}, "media", callback)
    expect(callback).toHaveBeenCalledWith(false)
  })
})
