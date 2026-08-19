/**
 * Shared mounted-DOM test harness — `happy-dom`'s `GlobalRegistrator`
 * plus dynamically-imported React modules.
 *
 * This repo has no prior mounted-render test harness (every earlier
 * component test uses `renderToStaticMarkup`, which cannot exercise
 * focus, portals, or controlled-input `onChange`). Two DOM/module-load-
 * order pitfalls make this harder than "just register happy-dom in
 * `beforeAll`":
 *
 *  1. **`react-dom` detects DOM support once, at module import time**
 *     (`canUseDOM`/`isInputEventSupported`, checked by reading `window`/
 *     `document` the moment the module body runs) — a statically
 *     `import`ed `react-dom/client` at the top of a test file is
 *     evaluated before `beforeAll` runs, so `document` does not exist
 *     yet and React silently decides the environment cannot fire
 *     `input`/`change` events. Every field in a mounted controlled
 *     component then keeps updating the raw DOM value while React's own
 *     state never advances — a false-positive trap where
 *     `input.value` looks right but the component's actual state (and
 *     everything derived from it, like a submit button's `disabled`)
 *     never changes. `useDomEnv()` therefore returns an async `load()`
 *     that `import()`s `react`/`react-dom/client` (and, per test file,
 *     whatever component under test) AFTER `GlobalRegistrator.register()`
 *     has run — never statically import those at module top level in a
 *     mounted test file.
 *  2. **DOM registration is a GLOBAL, not per-file, mutation** — it
 *     replaces `globalThis.window`/`document`/`fetch` for the whole
 *     `bun test` process. A `bunfig.toml` preload was tried and
 *     rejected: it broke unrelated integration tests that call the
 *     platform's real `fetch` (happy-dom's `fetch` enforces a same-
 *     origin policy real Node `fetch` does not). Registration therefore
 *     stays scoped to `beforeAll`/`afterAll` in files that opt in via
 *     `useDomEnv()`, and callers must dynamically import.
 *
 * IMPORTANT: run with `NODE_ENV=development` (`bun run test:mounted` —
 * see `apps/web/package.json`). Only React's development build exports
 * `act`; the production build throws `React.act is not a function`.
 * Without it, `mountedTestsSupported` is `false` and callers must wrap
 * their `describe` in `describe.skipIf(!mountedTestsSupported)` so the
 * plain repo-root `bun test` (which does not set `NODE_ENV`) skips these
 * files cleanly instead of failing — the suites they cover (target
 * markup, form validation, error mapping, store mutation) are already
 * covered without a mounted DOM elsewhere, per the repo's `bun test`
 * being expected to pass standalone.
 */

import { afterAll, beforeAll } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import type * as ReactType from "react"
import type * as ReactDOMClientType from "react-dom/client"

export interface DomEnv {
  readonly React: typeof ReactType
  readonly act: typeof ReactType.act
  readonly createRoot: typeof ReactDOMClientType.createRoot
}

/** `NODE_ENV=development` is required for React's `act` export and for
 *  `input`/`change` events to actually fire `onChange` (see module doc).
 *  Check this BEFORE calling `useDomEnv()` and skip the whole
 *  `describe` block when false. */
export const mountedTestsSupported = process.env["NODE_ENV"] === "development"

/**
 * Registers the DOM (`beforeAll`/`afterAll`) and returns a `load()` that
 * dynamically imports `react` + `react-dom/client` — call `load()` at
 * the START of each `it()` body (not at module top level) so the import
 * happens after registration. A no-op (never registers, `load()` never
 * called) when `mountedTestsSupported` is false and the caller correctly
 * skipped its `describe` block.
 */
export function useDomEnv(): { load: () => Promise<DomEnv> } {
  if (!mountedTestsSupported) {
    return {
      load(): Promise<DomEnv> {
        throw new Error("useDomEnv().load() called without NODE_ENV=development — guard with describe.skipIf(!mountedTestsSupported)")
      },
    }
  }
  beforeAll(async () => {
    await GlobalRegistrator.register()
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })
  afterAll(async () => {
    await GlobalRegistrator.unregister()
  })

  return {
    async load(): Promise<DomEnv> {
      const React = await import("react")
      const { createRoot } = await import("react-dom/client")
      return { React, act: React.act, createRoot }
    },
  }
}

/** Flush pending microtasks/timers — use inside `act(async () => {...})`
 *  when waiting on a promise chain (e.g. a store mutation) that does not
 *  itself resolve before the next synchronous assertion. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
}
