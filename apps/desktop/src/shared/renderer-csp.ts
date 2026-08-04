export const HERON_CSP_PLACEHOLDER = "__HERON_CONTENT_SECURITY_POLICY__"

const COMMON_DIRECTIVES = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "object-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'"
]

export function rendererContentSecurityPolicy(production: boolean): string {
  const connectSource = production ? "connect-src 'none'" : "connect-src 'self' ws://127.0.0.1:5173"
  return [...COMMON_DIRECTIVES.slice(0, 5), connectSource, ...COMMON_DIRECTIVES.slice(5)].join("; ")
}

export function injectRendererContentSecurityPolicy(html: string, production: boolean): string {
  if (!html.includes(HERON_CSP_PLACEHOLDER)) {
    throw new Error("Renderer HTML is missing the CSP placeholder")
  }
  return html.replaceAll(HERON_CSP_PLACEHOLDER, rendererContentSecurityPolicy(production))
}
