import { describe, expect, it } from "vitest"
import {
  HERON_CSP_PLACEHOLDER,
  injectRendererContentSecurityPolicy,
  rendererContentSecurityPolicy
} from "./renderer-csp"

describe("rendererContentSecurityPolicy", () => {
  it("blocks production network access and dangerous embedding capabilities", () => {
    const policy = rendererContentSecurityPolicy(true)

    expect(policy).toContain("default-src 'none'")
    expect(policy).toContain("connect-src 'none'")
    expect(policy).toContain("object-src 'none'")
    expect(policy).toContain("frame-src 'none'")
    expect(policy).toContain("form-action 'none'")
    expect(policy).toContain("base-uri 'none'")
    expect(policy).not.toContain("ws:")
    expect(policy).not.toContain("localhost")
    expect(policy).not.toContain("'unsafe-eval'")
  })

  it("allows only the fixed Vite websocket during development", () => {
    const policy = rendererContentSecurityPolicy(false)

    expect(policy).toContain("connect-src 'self' ws://127.0.0.1:5173")
    expect(policy).not.toMatch(/\sws:(?:\s|;|$)/)
    expect(policy).not.toContain("localhost")
  })

  it("replaces every HTML placeholder and rejects unprotected HTML", () => {
    const html = `<meta content="${HERON_CSP_PLACEHOLDER}"><p>${HERON_CSP_PLACEHOLDER}</p>`
    const transformed = injectRendererContentSecurityPolicy(html, true)

    expect(transformed).not.toContain(HERON_CSP_PLACEHOLDER)
    expect(() => injectRendererContentSecurityPolicy("<html></html>", true)).toThrow(
      "missing the CSP placeholder"
    )
  })
})
