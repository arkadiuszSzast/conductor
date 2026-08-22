/**
 * `ActionSheet` mounted focus/keyboard behavior — the one primitive
 * every start-work/gate/recovery/confirm sheet composes. Covers the
 * focus-trap contract `renderToStaticMarkup` cannot exercise (no real
 * DOM, no focus, no portal): focus enters on open, Tab is trapped even
 * when the dialog holds EVERY focusable descendant disabled (a pending
 * request), Escape/backdrop are blocked while `closeDisabled`, and focus
 * restores to the trigger on close (spec: "Fix pending ActionSheet focus
 * behavior").
 *
 * All of `react`, `react-dom/client`, and `../src/ui/action-sheet.tsx`
 * are imported dynamically INSIDE each test (never statically at module
 * top level) — see `test/dom-env.ts`'s module doc for why a static
 * import breaks React's DOM-support detection here. `React.createElement`
 * (not JSX) is used for the same reason: JSX for `.tsx` desugars to a
 * `jsx`/`jsxDEV` runtime import resolved at module top level.
 *
 * Requires `NODE_ENV=development` (`bun run test:mounted`) — skipped
 * entirely otherwise, see `test/dom-env.ts`.
 */
import { describe, expect, it } from "bun:test"
import { mountedTestsSupported, useDomEnv } from "./dom-env.ts"

const { load } = useDomEnv()

describe.skipIf(!mountedTestsSupported)("ActionSheet: focus management", () => {
  it("moves focus to the first focusable control on open (the dialog's close button, first in DOM order) and restores the trigger's focus on unmount", async () => {
    const { React, act, createRoot } = await load()
    const { ActionSheet } = await import("../src/ui/action-sheet.tsx")
    const h = React.createElement

    const trigger = document.createElement("button")
    trigger.textContent = "open"
    document.body.appendChild(trigger)
    trigger.focus()
    expect(document.activeElement).toBe(trigger)

    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(
        h(ActionSheet, {
          title: "Start work",
          onClose: () => {},
          actions: h("button", { type: "button" }, "submit"),
          children: h("input", { type: "text", placeholder: "title" }),
        }),
      )
    })
    // The close (✕) button precedes the body content in DOM order, so it
    // is the first focusable element the trap moves focus to — the key
    // contract under test is that focus left the trigger and landed
    // somewhere INSIDE the dialog, not on any particular control.
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement
    expect(dialog.contains(document.activeElement)).toBe(true)
    expect(document.activeElement).not.toBe(trigger)

    await act(async () => {
      root.unmount()
    })
    container.remove()
    expect(document.activeElement).toBe(trigger)
    trigger.remove()
  })

  it("remains a valid focus trap (focus stays on the dialog container) when every descendant control is disabled", async () => {
    const { React, act, createRoot } = await load()
    const { ActionSheet } = await import("../src/ui/action-sheet.tsx")
    const h = React.createElement

    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(
        h(ActionSheet, {
          title: "Start work",
          onClose: () => {},
          closeDisabled: true,
          actions: h("button", { type: "button", disabled: true }, "submit"),
          children: h("input", { type: "text", disabled: true }),
        }),
      )
    })
    // No enabled descendant exists (close button, submit, and the sole
    // input are all disabled) — the dialog container itself must hold
    // focus rather than leaking to <body> or the page behind it.
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement | null
    expect(dialog).not.toBeNull()
    expect(document.activeElement).toBe(dialog)

    // Tab must not escape the trap even with nothing to cycle between.
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }))
    })
    expect(document.activeElement).toBe(dialog)

    await act(async () => {
      root.unmount()
    })
    container.remove()
  })

  it("re-anchors focus to the dialog when the focused control becomes disabled mid-session (pending transition)", async () => {
    const { React, act, createRoot } = await load()
    const { ActionSheet } = await import("../src/ui/action-sheet.tsx")
    const h = React.createElement

    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(
        h(ActionSheet, {
          title: "Start work",
          onClose: () => {},
          actions: h("button", { type: "button" }, "submit"),
          children: h("input", { type: "text", placeholder: "title" }),
        }),
      )
    })
    const input = document.querySelector("input") as HTMLInputElement
    input.focus()
    expect(document.activeElement).toBe(input)

    // Simulate the pending transition: every control (including the
    // just-focused input) becomes disabled in the same render as
    // `closeDisabled` flips true.
    await act(async () => {
      root.render(
        h(ActionSheet, {
          title: "Start work",
          onClose: () => {},
          closeDisabled: true,
          actions: h("button", { type: "button", disabled: true }, "submit"),
          children: h("input", { type: "text", placeholder: "title", disabled: true }),
        }),
      )
    })
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement | null
    expect(document.activeElement).toBe(dialog)

    await act(async () => {
      root.unmount()
    })
    container.remove()
  })

  it("announces the pending state via aria-busy and a live status region", async () => {
    const { React, act, createRoot } = await load()
    const { ActionSheet } = await import("../src/ui/action-sheet.tsx")
    const h = React.createElement

    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(
        h(ActionSheet, {
          title: "Start work",
          onClose: () => {},
          closeDisabled: true,
          actions: h("button", { type: "button", disabled: true }, "submit"),
          children: h("input", { type: "text", disabled: true }),
        }),
      )
    })
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement
    expect(dialog.getAttribute("aria-busy")).toBe("true")
    const status = document.querySelector('[role="status"]')
    expect(status).not.toBeNull()
    expect(status?.textContent).toContain("in progress")

    await act(async () => {
      root.unmount()
    })
    container.remove()
  })

  it("does not set aria-busy or a status message while idle", async () => {
    const { React, act, createRoot } = await load()
    const { ActionSheet } = await import("../src/ui/action-sheet.tsx")
    const h = React.createElement

    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(
        h(ActionSheet, {
          title: "Start work",
          onClose: () => {},
          actions: h("button", { type: "button" }, "submit"),
          children: h("input", { type: "text" }),
        }),
      )
    })
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement
    expect(dialog.getAttribute("aria-busy")).toBeNull()

    await act(async () => {
      root.unmount()
    })
    container.remove()
  })

  it("Escape closes when idle", async () => {
    const { React, act, createRoot } = await load()
    const { ActionSheet } = await import("../src/ui/action-sheet.tsx")
    const h = React.createElement

    let closed = 0
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(
        h(ActionSheet, {
          title: "Start work",
          onClose: () => closed++,
          actions: h("button", { type: "button" }, "submit"),
          children: h("input", { type: "text" }),
        }),
      )
    })
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    })
    expect(closed).toBe(1)

    await act(async () => {
      root.unmount()
    })
    container.remove()
  })

  it("blocks Escape and backdrop dismissal while closeDisabled (a pending request)", async () => {
    const { React, act, createRoot } = await load()
    const { ActionSheet } = await import("../src/ui/action-sheet.tsx")
    const h = React.createElement

    let closed = 0
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(
        h(ActionSheet, {
          title: "Start work",
          onClose: () => closed++,
          closeDisabled: true,
          actions: h("button", { type: "button", disabled: true }, "submit"),
          children: h("input", { type: "text", disabled: true }),
        }),
      )
    })
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    })
    expect(closed).toBe(0)

    const backdrop = document.querySelector('[role="dialog"]')?.parentElement as HTMLElement
    await act(async () => {
      backdrop.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))
    })
    expect(closed).toBe(0)

    // The close (✕) button is also disabled while pending.
    const closeBtn = document.querySelector('button[aria-label="Close"]') as HTMLButtonElement
    expect(closeBtn.disabled).toBe(true)

    await act(async () => {
      root.unmount()
    })
    container.remove()
  })

  it("traps Tab between the first and last focusable controls when idle", async () => {
    const { React, act, createRoot } = await load()
    const { ActionSheet } = await import("../src/ui/action-sheet.tsx")
    const h = React.createElement

    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(
        h(ActionSheet, {
          title: "Start work",
          onClose: () => {},
          actions: h("button", { type: "button" }, "submit"),
          children: h("input", { type: "text", placeholder: "title" }),
        }),
      )
    })
    const closeBtn = document.querySelector('button[aria-label="Close"]') as HTMLButtonElement
    const submitBtn = [...document.querySelectorAll("button")].find(b => b.textContent === "submit") as HTMLButtonElement

    // Shift+Tab from the first focusable (close button) wraps to the last.
    closeBtn.focus()
    expect(document.activeElement).toBe(closeBtn)
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }))
    })
    expect(document.activeElement).toBe(submitBtn)

    // Tab from the last focusable (submit) wraps back to the first.
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }))
    })
    expect(document.activeElement).toBe(closeBtn)

    await act(async () => {
      root.unmount()
    })
    container.remove()
  })
})
