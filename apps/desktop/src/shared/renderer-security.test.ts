import { describe, expect, it } from "vitest"
import {
  HERON_DEVELOPMENT_RENDERER_URL,
  HERON_MAIN_RENDERER_URL,
  HERON_SPLASH_RENDERER_URL,
  classifyRendererEntrypoint,
  isTrustedMainRendererUrl,
  resolveRendererEntrypoints
} from "./renderer-security"

describe("resolveRendererEntrypoints", () => {
  it("ignores renderer environment injection in packaged applications", () => {
    expect(resolveRendererEntrypoints(true, "https://evil.example/")).toEqual({
      main: HERON_MAIN_RENDERER_URL,
      splash: HERON_SPLASH_RENDERER_URL,
      mode: "bundle"
    })
  })

  it("uses the bundled protocol for unbundled E2E runs without a dev URL", () => {
    expect(resolveRendererEntrypoints(false, undefined).mode).toBe("bundle")
  })

  it("accepts only the exact fixed loopback development URL", () => {
    expect(resolveRendererEntrypoints(false, HERON_DEVELOPMENT_RENDERER_URL).mode).toBe(
      "development"
    )
    for (const invalid of [
      "http://localhost:5173/",
      "http://127.0.0.1:5174/",
      "http://127.0.0.1:5173/path",
      "https://127.0.0.1:5173/"
    ]) {
      expect(() => resolveRendererEntrypoints(false, invalid)).toThrow(
        "HERON_RENDERER_URL must be exactly"
      )
    }
  })
})

describe("isTrustedMainRendererUrl", () => {
  it("requires the exact main entry and rejects splash, query, and forged hosts", () => {
    expect(isTrustedMainRendererUrl(HERON_MAIN_RENDERER_URL, true, undefined)).toBe(true)
    expect(isTrustedMainRendererUrl(HERON_SPLASH_RENDERER_URL, true, undefined)).toBe(false)
    expect(isTrustedMainRendererUrl(`${HERON_MAIN_RENDERER_URL}?rpc=1`, true, undefined)).toBe(
      false
    )
    expect(isTrustedMainRendererUrl("heron-app://bundle.evil/index.html", true, undefined)).toBe(
      false
    )
  })
})

describe("classifyRendererEntrypoint", () => {
  it("classifies only fixed bundle and development entrypoints", () => {
    expect(classifyRendererEntrypoint(`${HERON_MAIN_RENDERER_URL}#/settings`)).toBe("main")
    expect(classifyRendererEntrypoint(HERON_SPLASH_RENDERER_URL)).toBe("splash")
    expect(classifyRendererEntrypoint(HERON_DEVELOPMENT_RENDERER_URL)).toBe("main")
    expect(classifyRendererEntrypoint("http://127.0.0.1:5173/splash.html")).toBe("splash")
    expect(classifyRendererEntrypoint("https://evil.example/index.html")).toBeNull()
    expect(classifyRendererEntrypoint(`${HERON_MAIN_RENDERER_URL}?spoof=1`)).toBeNull()
  })
})
