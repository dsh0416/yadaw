import { net, protocol, session, type Protocol, type Session } from "electron"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"
import { HERON_RENDERER_HOST, HERON_RENDERER_SCHEME } from "../../shared/renderer-security"
import { rendererDirectory } from "./runtime-paths"

interface RendererProtocolRequest {
  method: string
  url: string
}

type RendererResourceFetcher = (url: string) => Promise<Response>

function errorResponse(status: number): Response {
  return new Response(null, { status })
}

export function registerRendererScheme(
  target: Pick<Protocol, "registerSchemesAsPrivileged"> = protocol
): void {
  target.registerSchemesAsPrivileged([
    {
      scheme: HERON_RENDERER_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        codeCache: true
      }
    }
  ])
}

export function resolveRendererResourcePath(requestUrl: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(requestUrl)
  } catch {
    return null
  }
  if (parsed.protocol !== `${HERON_RENDERER_SCHEME}:` || parsed.host !== HERON_RENDERER_HOST) {
    return null
  }

  const rawPath = requestUrl.match(/^[^:]+:\/\/[^/?#]+([^?#]*)/)?.[1] ?? ""
  let decodedPath: string
  try {
    decodedPath = decodeURIComponent(rawPath)
  } catch {
    return null
  }
  if (
    !decodedPath.startsWith("/") ||
    decodedPath.includes("\\") ||
    decodedPath.includes("\0") ||
    decodedPath.split("/").some((segment) => segment === ".." || segment === ".")
  ) {
    return null
  }

  const resourcePath = decodedPath.slice(1)
  if (!resourcePath || isAbsolute(resourcePath)) return null

  const absolutePath = resolve(rendererDirectory, resourcePath)
  const relativePath = relative(rendererDirectory, absolutePath)
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    return null
  }
  return absolutePath
}

export async function handleRendererProtocolRequest(
  request: RendererProtocolRequest,
  fetchResource: RendererResourceFetcher = (url) => net.fetch(url)
): Promise<Response> {
  if (request.method !== "GET") return errorResponse(405)
  const resourcePath = resolveRendererResourcePath(request.url)
  if (!resourcePath) return errorResponse(400)

  try {
    const response = await fetchResource(pathToFileURL(resourcePath).toString())
    return response.ok ? response : errorResponse(404)
  } catch {
    return errorResponse(404)
  }
}

export function installRendererProtocol(target: Pick<Protocol, "handle"> = protocol): void {
  target.handle(HERON_RENDERER_SCHEME, (request) => handleRendererProtocolRequest(request))
}

export function denyChromiumPermissions(target: Session = session.defaultSession): void {
  target.setPermissionCheckHandler(() => false)
  target.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
}
