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

describe_("bundled OpenSpec plugin app.js: change detail inline expansion", () => {
  it("expands the detail inline on tile click, fetching with the project query string preserved, and shows Why text", async () => {
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

    const detail = document.querySelector(".change-detail")
    expect(detail).not.toBeNull()
    expect((detail as HTMLElement).hidden).toBe(false)
    const why = document.querySelector(".detail-why")
    expect(why?.textContent).toContain("Because it matters.")

    const requirementsDetails = Array.from(document.querySelectorAll(".detail-section")).find(
      section => section.querySelector("summary")?.textContent === "Requirements",
    ) as HTMLDetailsElement
    expect(requirementsDetails).not.toBeUndefined()
    expect(requirementsDetails.open).toBe(false)
    requirementsDetails.open = true

    expect(requirementsDetails.textContent).toContain("capability-a")
    expect(requirementsDetails.textContent).toContain("Widgets can spin")
  })

  it("collapses on a second click of the same tile", async () => {
    await load()
    ;(window as unknown as HappyDomWindow).happyDOM.setURL(
      "http://conductor.test/v1/plugins/openspec/ui/?project=%2Fproj%2Fd",
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
    expect((document.querySelector(".change-detail") as HTMLElement).hidden).toBe(false)
    expect(tile.getAttribute("aria-expanded")).toBe("true")

    tile.click()
    await flush()
    expect((document.querySelector(".change-detail") as HTMLElement).hidden).toBe(true)
    expect(tile.getAttribute("aria-expanded")).toBe("false")
  })

  it("expanding another change collapses the first (accordion)", async () => {
    await load()
    ;(window as unknown as HappyDomWindow).happyDOM.setURL(
      "http://conductor.test/v1/plugins/openspec/ui/?project=%2Fproj%2Fe",
    )
    document.body.innerHTML = '<div id="root"></div>'
    globalThis.fetch = (async (url: string) => {
      if (String(url).startsWith("../changes")) {
        return new Response(
          JSON.stringify({
            openspec: true,
            active: [
              { name: "change-one", taskProgress: null },
              { name: "change-two", taskProgress: null },
            ],
            archived: [],
          }),
          { status: 200 },
        )
      }
      const name = new URL(url, "http://conductor.test").searchParams.get("name")
      return new Response(JSON.stringify({ name, archived: false, why: "Why text." }), { status: 200 })
    }) as typeof fetch

    await import(`../../../plugins/openspec/ui/app.js?cachebust=${Date.now()}-${Math.random()}`)
    await flush()

    const tiles = Array.from(document.querySelectorAll(".change")) as HTMLElement[]
    expect(tiles.length).toBe(2)
    const first = tiles[0] as HTMLElement
    const second = tiles[1] as HTMLElement

    first.click()
    await flush()
    expect(first.getAttribute("aria-expanded")).toBe("true")
    const firstDetail = first.nextElementSibling as HTMLElement
    expect(firstDetail.hidden).toBe(false)

    second.click()
    await flush()
    expect(first.getAttribute("aria-expanded")).toBe("false")
    expect(firstDetail.hidden).toBe(true)
    expect(second.getAttribute("aria-expanded")).toBe("true")
    const secondDetail = second.nextElementSibling as HTMLElement
    expect(secondDetail.hidden).toBe(false)
  })

  it("expands an archived change without a Start work button", async () => {
    await load()
    ;(window as unknown as HappyDomWindow).happyDOM.setURL(
      "http://conductor.test/v1/plugins/openspec/ui/?project=%2Fproj%2Ff",
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

    const detail = item.nextElementSibling as HTMLElement
    expect(detail).not.toBeNull()
    expect(detail.classList.contains("change-detail")).toBe(true)
    expect(detail.hidden).toBe(false)
    expect(detail.querySelector(".start-work")).toBeNull()
  })

  it("starts work from the expanded area — same flow, then navigate", async () => {
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

    const detailButton = document.querySelector(".change-detail .start-work") as HTMLButtonElement
    expect(detailButton).not.toBeNull()
    detailButton.click()
    await flush()
    await flush()

    // Same code path as the tile button: the daemon call carries the
    // change name. (The subsequent `navigate` postMessage is untestable
    // here — `postToHost` no-ops when window.parent === window, i.e.
    // outside a real iframe — and is covered by the host-side bridge
    // tests in plugin-rail-mounted.test.tsx.)
    expect(posts).toEqual(['{"change":"sample-change"}'])
  })

  it("toggles expansion from the keyboard (Enter on a focused tile)", async () => {
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
    expect(tile.getAttribute("aria-expanded")).toBe("false")

    tile.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    await flush()

    expect(tile.getAttribute("aria-expanded")).toBe("true")
    expect((document.querySelector(".change-detail") as HTMLElement).hidden).toBe(false)

    tile.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    await flush()

    expect(tile.getAttribute("aria-expanded")).toBe("false")
    expect((document.querySelector(".change-detail") as HTMLElement).hidden).toBe(true)
  })
})
