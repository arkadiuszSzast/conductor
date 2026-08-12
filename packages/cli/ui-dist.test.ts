/**
 * Staleness detection for the checkout SPA — the contract that decides
 * whether `git pull` requires a rebuild before the daemon serves dist.
 */
import { describe, expect, it } from "bun:test"
import { uiDistStale, type UiDistFs } from "./src/ui-dist.ts"

interface Node {
  readonly mtime: number
  readonly children?: Record<string, Node>
}

function fakeFs(tree: Record<string, Node>): UiDistFs {
  const lookup = (path: string): Node | undefined => {
    const parts = path.split("/").filter(p => p !== "")
    let nodes: Record<string, Node> | undefined = tree
    let node: Node | undefined
    for (const part of parts) {
      node = nodes?.[part]
      if (node === undefined) return undefined
      nodes = node.children
    }
    return node
  }
  return {
    exists: path => lookup(path) !== undefined,
    mtimeMs: path => {
      const node = lookup(path)
      if (node === undefined) throw new Error(`ENOENT: ${path}`)
      return node.mtime
    },
    isDirectory: path => lookup(path)?.children !== undefined,
    readdir: path => Object.keys(lookup(path)?.children ?? {}),
    join: (...parts) => parts.join("/"),
  }
}

const WEB = "web"
const DIST = "web/dist"

describe("uiDistStale", () => {
  it("fresh dist: nothing newer than the built index.html", () => {
    const fs = fakeFs({
      web: {
        mtime: 0,
        children: {
          "index.html": { mtime: 50 },
          "vite.config.ts": { mtime: 40 },
          src: { mtime: 0, children: { "app.tsx": { mtime: 80 }, api: { mtime: 0, children: { "store.ts": { mtime: 90 } } } } },
          dist: { mtime: 0, children: { "index.html": { mtime: 100 } } },
        },
      },
    })
    expect(uiDistStale(fs, WEB, DIST)).toBe(false)
  })

  it("stale: a nested source file is newer than dist", () => {
    const fs = fakeFs({
      web: {
        mtime: 0,
        children: {
          src: { mtime: 0, children: { api: { mtime: 0, children: { "store.ts": { mtime: 150 } } } } },
          dist: { mtime: 0, children: { "index.html": { mtime: 100 } } },
        },
      },
    })
    expect(uiDistStale(fs, WEB, DIST)).toBe(true)
  })

  it("stale: the top-level index.html probe is newer", () => {
    const fs = fakeFs({
      web: {
        mtime: 0,
        children: {
          "index.html": { mtime: 200 },
          dist: { mtime: 0, children: { "index.html": { mtime: 100 } } },
        },
      },
    })
    expect(uiDistStale(fs, WEB, DIST)).toBe(true)
  })

  it("missing probes are skipped, not errors", () => {
    const fs = fakeFs({
      web: {
        mtime: 0,
        children: {
          dist: { mtime: 0, children: { "index.html": { mtime: 100 } } },
        },
      },
    })
    expect(uiDistStale(fs, WEB, DIST)).toBe(false)
  })

  it("missing dist/index.html fails open as not-stale and reports the error", () => {
    // The call site guards on dist existing, so in practice this path only
    // fires for a race; the contract stays fail-open + report.
    const errors: unknown[] = []
    const fs = fakeFs({ web: { mtime: 0, children: { src: { mtime: 0, children: { "a.ts": { mtime: 1 } } } } } })
    expect(uiDistStale(fs, WEB, DIST, e => errors.push(e))).toBe(false)
    expect(errors.length).toBe(1)
  })

  it("a walk error fails open and reports instead of throwing", () => {
    const errors: unknown[] = []
    const base = fakeFs({
      web: {
        mtime: 0,
        children: {
          src: { mtime: 0, children: { "a.ts": { mtime: 1 } } },
          dist: { mtime: 0, children: { "index.html": { mtime: 100 } } },
        },
      },
    })
    const failing: UiDistFs = { ...base, readdir: () => { throw new Error("EACCES") } }
    expect(uiDistStale(failing, WEB, DIST, e => errors.push(e))).toBe(false)
    expect(String(errors[0])).toContain("EACCES")
  })
})
