/**
 * Staleness check for a checkout's built SPA. Pure logic over injected
 * filesystem ports so it is testable without a real filesystem —
 * main.ts binds the node:fs implementations.
 *
 * A dist is stale when any UI source input (src/**, index.html,
 * vite.config.ts) is newer than the built dist/index.html: `git pull`
 * touches sources, never dist, so mtime comparison is what detects
 * "the user pulled a fix but the daemon would serve the old bundle".
 */

export interface UiDistFs {
  readonly exists: (path: string) => boolean
  readonly mtimeMs: (path: string) => number
  readonly isDirectory: (path: string) => boolean
  readonly readdir: (path: string) => readonly string[]
  readonly join: (...parts: string[]) => string
}

const SOURCE_PROBES = ["src", "index.html", "vite.config.ts"] as const

export function uiDistStale(
  fs: UiDistFs,
  webRoot: string,
  dist: string,
  onError?: (error: unknown) => void,
): boolean {
  try {
    const builtAt = fs.mtimeMs(fs.join(dist, "index.html"))
    const newerThanBuild = (path: string): boolean => {
      if (fs.isDirectory(path)) {
        for (const entry of fs.readdir(path)) {
          if (newerThanBuild(fs.join(path, entry))) return true
        }
        return false
      }
      return fs.mtimeMs(path) > builtAt
    }
    for (const probe of SOURCE_PROBES) {
      const path = fs.join(webRoot, probe)
      if (!fs.exists(path)) continue
      if (newerThanBuild(path)) return true
    }
    return false
  } catch (error) {
    onError?.(error)
    return false
  }
}
