export const HERON_RENDERER_SCHEME = "heron-app"
export const HERON_RENDERER_HOST = "bundle"
export const HERON_DEVELOPMENT_RENDERER_URL = "http://127.0.0.1:5173/"

export const HERON_MAIN_RENDERER_URL = `${HERON_RENDERER_SCHEME}://${HERON_RENDERER_HOST}/index.html`
export const HERON_SPLASH_RENDERER_URL = `${HERON_RENDERER_SCHEME}://${HERON_RENDERER_HOST}/splash.html`

export interface RendererEntrypoints {
  main: string
  splash: string
  mode: "bundle" | "development"
}

export type RendererEntrypointKind = "main" | "splash" | null

export function classifyRendererEntrypoint(url: string): RendererEntrypointKind {
  try {
    const candidate = new URL(url)
    if (candidate.search !== "" || candidate.username !== "" || candidate.password !== "") {
      return null
    }
    const identity = `${candidate.protocol}//${candidate.host}${candidate.pathname}`
    if (identity === HERON_MAIN_RENDERER_URL || identity === HERON_DEVELOPMENT_RENDERER_URL) {
      return "main"
    }
    if (
      identity === HERON_SPLASH_RENDERER_URL ||
      identity === new URL("splash.html", HERON_DEVELOPMENT_RENDERER_URL).toString()
    ) {
      return "splash"
    }
    return null
  } catch {
    return null
  }
}

export function resolveRendererEntrypoints(
  isPackaged: boolean,
  environmentUrl: string | undefined
): RendererEntrypoints {
  if (isPackaged || environmentUrl === undefined) {
    return {
      main: HERON_MAIN_RENDERER_URL,
      splash: HERON_SPLASH_RENDERER_URL,
      mode: "bundle"
    }
  }

  if (environmentUrl !== HERON_DEVELOPMENT_RENDERER_URL) {
    throw new Error(
      `HERON_RENDERER_URL must be exactly ${HERON_DEVELOPMENT_RENDERER_URL} in development`
    )
  }

  return {
    main: HERON_DEVELOPMENT_RENDERER_URL,
    splash: new URL("splash.html", HERON_DEVELOPMENT_RENDERER_URL).toString(),
    mode: "development"
  }
}

export function isTrustedMainRendererUrl(
  senderUrl: string,
  isPackaged: boolean,
  environmentUrl: string | undefined
): boolean {
  let entrypoints: RendererEntrypoints
  try {
    entrypoints = resolveRendererEntrypoints(isPackaged, environmentUrl)
  } catch {
    return false
  }

  try {
    const sender = new URL(senderUrl)
    const main = new URL(entrypoints.main)
    return classifyRendererEntrypoint(senderUrl) === "main" && sender.origin === main.origin
  } catch {
    return false
  }
}
