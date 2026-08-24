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

describe_("bundled OpenSpec plugin app.js: change detail modal", () => {
  it("opens the modal on tile click, fetching detail with the project query string preserved, and shows Why text", async () => {
    await load()
    ;(window as unknown as HappyDomWindow).happyDOM.setURL(
      "http://conductor.test/v1/plugins/openspec/ui/?project=%2Fproj%2Fc",
    )
    document.body.innerHTML = '<div id="root"></div>'
    const calls: string[] = []
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url))
      if (String(url).startsWith("../changes")) {
        return new Response(
          JSON.stringify({
            openspec: true,
            active: [{ name: "sample-change", taskProgress: { done: 1, total: 2 } }],
            archived: [],
          }),
          { status: 200 },
        )
      }
      return new Response(
        JSON.stringify({
          name: "sample-change",
          archived: false,
          why: "Because it matters.",
          whatChanges: "- do the thing",
          specs: [
            {
              capability: "capability-a",
              requirements: [{ heading: "Widgets can spin", body: "Widgets SHALL spin." }],
            },
          ],
          tasks: [
            { text: "first task", done: true },
            { text: "second task", done: false },
          ],
        }),
        { status: 200 },
      )
    }) as typeof fetch

    await import(`../../../plugins/openspec/ui/app.js?cachebust=${Date.now()}-${Math.random()}`)
    await flush()

    const tile = document.querySelector(".change") as HTMLElement
    expect(tile).not.toBeNull()
    tile.click()
    await flush()

    expect(calls).toContain("../change?name=sample-change&project=%2Fproj%2Fc")

    const modal = document.querySelector(".modal-overlay")
    expect(modal).not.toBeNull()
    const why = document.querySelector(".modal-why")
    expect(why?.textContent).toContain("Because it matters.")

    const requirementsDetails = Array.from(document.querySelectorAll(".modal-section")).find(
      section => section.querySelector("summary")?.textContent === "Requirements",
    ) as HTMLDetailsElement
    expect(requirementsDetails).not.toBeUndefined()
    expect(requirementsDetails.open).toBe(false)
    requirementsDetails.open = true

    expect(requirementsDetails.textContent).toContain("capability-a")
    expect(requirementsDetails.textContent).toContain("Widgets can spin")
  })

  it("opens the modal for an archived change without a Start work button", async () => {
    await load()
    ;(window as unknown as HappyDomWindow).happyDOM.setURL(
      "http://conductor.test/v1/plugins/openspec/ui/?project=%2Fproj%2Fd",
    )
    document.body.innerHTML = '<div id="root"></div>'
    globalThis.fetch = (async (url: string) => {
      if (String(url).startsWith("../changes")) {
        return new Response(
          JSON.stringify({ openspec: true, active: [], archived: ["old-change"] }),
          { status: 200 },
        )
      }
      return new Response(
        JSON.stringify({ name: "old-change", archived: true, why: "Historical reasons." }),
        { status: 200 },
      )
    }) as typeof fetch

    await import(`../../../plugins/openspec/ui/app.js?cachebust=${Date.now()}-${Math.random()}`)
    await flush()

    const item = document.querySelector(".archived-item") as HTMLElement
    expect(item).not.toBeNull()
    item.click()
    await flush()

    const modal = document.querySelector(".modal-overlay")
    expect(modal).not.toBeNull()
    expect(document.querySelector(".modal-body .start-work")).toBeNull()
  })

  it("closes the modal on Escape", async () => {
    await load()
    ;(window as unknown as HappyDomWindow).happyDOM.setURL(
      "http://conductor.test/v1/plugins/openspec/ui/?project=%2Fproj%2Fe",
    )
    document.body.innerHTML = '<div id="root"></div>'
    globalThis.fetch = (async (url: string) => {
      if (String(url).startsWith("../changes")) {
        return new Response(
          JSON.stringify({ openspec: true, active: [{ name: "sample-change", taskProgress: null }], archived: [] }),
          { status: 200 },
        )
      }
      return new Response(JSON.stringify({ name: "sample-change", archived: false, why: "Why text." }), {
        status: 200,
      })
    }) as typeof fetch

    await import(`../../../plugins/openspec/ui/app.js?cachebust=${Date.now()}-${Math.random()}`)
    await flush()

    const tile = document.querySelector(".change") as HTMLElement
    tile.click()
    await flush()
    expect(document.querySelector(".modal-overlay")).not.toBeNull()

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))
    await flush()

    expect(document.querySelector(".modal-overlay")).toBeNull()
  })

  it("closes the modal on backdrop click but not on clicks inside the panel", async () => {
    await load()
    ;(window as unknown as HappyDomWindow).happyDOM.setURL(
      "http://conductor.test/v1/plugins/openspec/ui/?project=%2Fproj%2Ff",
    )
    document.body.innerHTML = '<div id="root"></div>'
    globalThis.fetch = (async (url: string) => {
      if (String(url).startsWith("../changes")) {
        return new Response(
          JSON.stringify({ openspec: true, active: [{ name: "sample-change", taskProgress: null }], archived: [] }),
          { status: 200 },
        )
      }
      return new Response(JSON.stringify({ name: "sample-change", archived: false, why: "Why text." }), {
        status: 200,
      })
    }) as typeof fetch

    await import(`../../../plugins/openspec/ui/app.js?cachebust=${Date.now()}-${Math.random()}`)
    await flush()
    ;(document.querySelector(".change") as HTMLElement).click()
    await flush()

    const panel = document.querySelector(".modal-panel") as HTMLElement
    panel.click()
    await flush()
    expect(document.querySelector(".modal-overlay")).not.toBeNull()

    const overlay = document.querySelector(".modal-overlay") as HTMLElement
    overlay.click()
    await flush()
    expect(document.querySelector(".modal-overlay")).toBeNull()
  })

  it("starts work from the modal's own button — same flow, then navigate", async () => {
    await load()
    ;(window as unknown as HappyDomWindow).happyDOM.setURL(
      "http://conductor.test/v1/plugins/openspec/ui/?project=%2Fproj%2Fg",
    )
    document.body.innerHTML = '<div id="root"></div>'
    const posts: string[] = []
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const path = String(url)
      if (path.startsWith("../changes")) {
        return new Response(
          JSON.stringify({ openspec: true, active: [{ name: "sample-change", taskProgress: null }], archived: [] }),
          { status: 200 },
        )
      }
      if (path.startsWith("../change?")) {
        return new Response(JSON.stringify({ name: "sample-change", archived: false, why: "Why text." }), {
          status: 200,
        })
      }
      if (path.startsWith("../start-work")) {
        posts.push(String(init?.body ?? ""))
        return new Response(JSON.stringify({ featureId: "feat-77" }), { status: 200 })
      }
      return new Response("{}", { status: 404 })
    }) as typeof fetch

    await import(`../../../plugins/openspec/ui/app.js?cachebust=${Date.now()}-${Math.random()}`)
    await flush()
    ;(document.querySelector(".change") as HTMLElement).click()
    await flush()

    const modalButton = document.querySelector(".modal-panel .start-work") as HTMLButtonElement
    expect(modalButton).not.toBeNull()
    modalButton.click()
    await flush()
    await flush()

    // Same code path as the tile button: the daemon call carries the
    // change name. (The subsequent `navigate` postMessage is untestable
    // here — `postToHost` no-ops when window.parent === window, i.e.
    // outside a real iframe — and is covered by the host-side bridge
    // tests in plugin-rail-mounted.test.tsx.)
    expect(posts).toEqual(['{"change":"sample-change"}'])
  })

  it("opens the modal from the keyboard (Enter on a focused tile)", async () => {
    await load()
    ;(window as unknown as HappyDomWindow).happyDOM.setURL(
      "http://conductor.test/v1/plugins/openspec/ui/?project=%2Fproj%2Fh",
    )
    document.body.innerHTML = '<div id="root"></div>'
    globalThis.fetch = (async (url: string) => {
      if (String(url).startsWith("../changes")) {
        return new Response(
          JSON.stringify({ openspec: true, active: [{ name: "sample-change", taskProgress: null }], archived: [] }),
          { status: 200 },
        )
      }
      return new Response(JSON.stringify({ name: "sample-change", archived: false, why: "Why text." }), {
        status: 200,
      })
    }) as typeof fetch

    await import(`../../../plugins/openspec/ui/app.js?cachebust=${Date.now()}-${Math.random()}`)
    await flush()

    const tile = document.querySelector(".change") as HTMLElement
    expect(tile.getAttribute("tabindex")).toBe("0")
    expect(tile.getAttribute("role")).toBe("button")
    tile.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    await flush()

    expect(document.querySelector(".modal-overlay")).not.toBeNull()
  })
})
