/**
 * `plugins/openspec/ui/app.js` mounted behavior — the bundled plugin's
 * ONLY UI script, loaded directly from its real location (not a copy)
 * so this test exercises the exact file the daemon serves. Covers M7's
 * query-string-preservation fix: the panel's iframe carries
 * `?project=<id>` (see `panel.tsx`), and `app.js`'s own `fetch` calls to
 * `../changes`/`../start-work` must forward that same query string or a
 * daemon hosting the same plugin id for two projects would silently
 * resolve the wrong one for every panel-originated request.
 *
 * `happy-dom`'s `window.happyDOM.setURL` sets the document location
 * `app.js` reads via `window.location.search` — plain DOM registration
 * always starts at `about:blank`, which has no query string to observe.
 */
import { describe, expect, it } from "bun:test"
import { mountedTestsSupported, useDomEnv, flush } from "./dom-env.ts"

const { load } = useDomEnv()
const describe_ = describe.skipIf(!mountedTestsSupported)

interface HappyDomWindow {
  readonly happyDOM: { setURL(url: string): void }
}

describe_("bundled OpenSpec plugin app.js: query-string preservation (M7)", () => {
  it("forwards the panel's ?project= query string on the GET /changes fetch", async () => {
    await load()
    ;(window as unknown as HappyDomWindow).happyDOM.setURL(
      "http://conductor.test/v1/plugins/openspec/ui/?project=%2Fproj%2Fa",
    )
    document.body.innerHTML = '<div id="root"></div>'
    const calls: string[] = []
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url))
      return new Response(JSON.stringify({ openspec: false }), { status: 200 })
    }) as typeof fetch

    // @ts-expect-error — a plain third-party-style JS file, no type
    // declarations; imported dynamically purely for its side effect.
    await import("../../../plugins/openspec/ui/app.js")
    await flush()

    expect(calls).toEqual(["../changes?project=%2Fproj%2Fa"])
  })

  it("forwards the panel's ?project= query string on the POST /start-work fetch", async () => {
    await load()
    ;(window as unknown as HappyDomWindow).happyDOM.setURL(
      "http://conductor.test/v1/plugins/openspec/ui/?project=%2Fproj%2Fb",
    )
    document.body.innerHTML = '<div id="root"></div>'
    const calls: string[] = []
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push(String(url))
      if (String(url).startsWith("../changes")) {
        return new Response(
          JSON.stringify({ openspec: true, active: [{ name: "sample-change", taskProgress: null }], archived: [] }),
          { status: 200 },
        )
      }
      void init
      return new Response(JSON.stringify({ featureId: "f-1" }), { status: 200 })
    }) as typeof fetch

    // Fresh module instance per test — the plugin's IIFE runs its own
    // `load()` on import, and Bun's module cache would otherwise reuse
    // the first test's closures across files in the same process. (No
    // `@ts-expect-error` needed here — the query-string specifier isn't
    // statically resolved against `app.js`'s missing declaration file.)
    await import(`../../../plugins/openspec/ui/app.js?cachebust=${Date.now()}-${Math.random()}`)
    await flush()

    const button = document.querySelector(".start-work") as HTMLButtonElement
    expect(button).not.toBeNull()
    button.click()
    await flush()

    expect(calls).toContain("../start-work?project=%2Fproj%2Fb")
  })
})
