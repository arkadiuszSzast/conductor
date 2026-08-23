/**
 * Hardened static-file serving shared by the SPA static mount (`api.ts`)
 * and the plugin proxy's `ui/` serving (`plugin-proxy.ts`): path-traversal
 * rejection (decode, null-byte check, containment under `root`), Bun-
 * compiled-binary `/$bunfs/` fallback. No SPA index.html fallback here —
 * that behaviour is `api.ts`-specific; callers needing it apply it
 * themselves on top of a null result.
 */

import { statSync } from "node:fs"
import { extname, resolve, sep } from "node:path"

export const STATIC_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
}

export function safeDecode(path: string): string | null {
  try {
    const decoded = decodeURIComponent(path)
    if (decoded.includes("\0")) return null
    return decoded
  } catch {
    return null
  }
}

/** Joins `decodedPath` under `root`, rejecting any traversal outside it. */
export function safeJoin(root: string, decodedPath: string): string | null {
  const candidate = resolve(root, `.${decodedPath}`)
  if (candidate !== root && !candidate.startsWith(root + sep)) return null
  return candidate
}

export function pickStaticFile(path: string): string | null {
  try {
    return statSync(path).isFile() ? path : null
  } catch {
    return null
  }
}

/** Bun-compiled binaries: `/$bunfs/` paths are invisible to `statSync` but `Bun.file()` can read them. */
export function serveEmbeddedFile(path: string, requestId: string): Response | null {
  if (!path.includes("/$bunfs/")) return null
  try {
    const f = Bun.file(path)
    return new Response(f, {
      status: 200,
      headers: {
        "content-type": STATIC_CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream",
        "x-request-id": requestId,
      },
    })
  } catch {
    return null
  }
}

/**
 * Resolve `path` under `root` and serve it if it exists — traversal-safe,
 * no directory index, no SPA fallback. `null` means "nothing to serve
 * here", not an error; callers decide what that means (404, or a
 * fallback file).
 */
export function serveStaticFile(root: string, path: string, requestId: string): Response | null {
  const decoded = safeDecode(path)
  if (decoded === null) return null
  const candidate = safeJoin(root, decoded)
  if (candidate === null) return null
  const file = pickStaticFile(candidate)
  if (file !== null) {
    const contentType = STATIC_CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream"
    return new Response(Bun.file(file), {
      status: 200,
      headers: { "content-type": contentType, "x-request-id": requestId },
    })
  }
  return serveEmbeddedFile(candidate, requestId)
}
