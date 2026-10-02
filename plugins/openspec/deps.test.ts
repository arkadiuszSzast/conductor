import { describe, expect, it } from "bun:test"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const { changeReadiness, dependencyState } = require("./ui/deps.js") as {
  dependencyState: (dep: string, context: Context) => { name: string; state: string; label: string }
  changeReadiness: (change: { dependsOn?: string[] }, context: Context) => { readiness: string; summary: string; dependencies: { name: string; state: string }[] }
}

interface Context {
  archived?: string[]
  active?: { name: string }[]
  queueEntries?: { change: string; status: string }[]
}

const context: Context = {
  archived: ["2026-10-01-unify-content-gates", "2026-10-02-quest-outcomes"],
  active: [{ name: "add-standings" }, { name: "authoring-condition-editor" }, { name: "quest-deadlines" }],
  queueEntries: [
    { change: "authoring-condition-editor", status: "running" },
    { change: "quest-deadlines", status: "escalated" },
    { change: "add-standings", status: "waiting" },
    { change: "old-change", status: "merged" },
  ],
}

describe("dependencyState", () => {
  it.each([
    ["unify-content-gates", "merged"],
    ["old-change", "merged"],
    ["authoring-condition-editor", "in_progress"],
    ["quest-deadlines", "stuck"],
    ["add-standings", "queued"],
    ["missing-change", "unknown"],
  ])("%s → %s", (dep, state) => {
    expect(dependencyState(dep, context).state).toBe(state)
  })

  it("an active change that is not queued is not started", () => {
    expect(dependencyState("add-standings", { ...context, queueEntries: [] })).toEqual({ name: "add-standings", state: "pending", label: "not started" })
  })

  it("an archived change wins over a stale live queue entry", () => {
    expect(dependencyState("quest-outcomes", { ...context, queueEntries: [{ change: "quest-outcomes", status: "running" }] }).state).toBe("merged")
  })
})

describe("changeReadiness", () => {
  it("is ready with no dependencies or with every dependency merged", () => {
    expect(changeReadiness({}, context)).toMatchObject({ readiness: "ready", summary: "Ready — no dependencies" })
    expect(changeReadiness({ dependsOn: ["unify-content-gates", "quest-outcomes"] }, context))
      .toMatchObject({ readiness: "ready", summary: "Ready — all 2 dependencies merged" })
  })

  it("is waiting while open dependencies are only in flight or queued", () => {
    expect(changeReadiness({ dependsOn: ["unify-content-gates", "authoring-condition-editor", "add-standings"] }, context))
      .toMatchObject({ readiness: "waiting", summary: "Waiting — 1/3 dependencies merged" })
  })

  it("is blocked when any dependency is stuck, not started or unknown", () => {
    for (const dep of ["quest-deadlines", "missing-change"]) {
      expect(changeReadiness({ dependsOn: ["authoring-condition-editor", dep] }, context).readiness).toBe("blocked")
    }
    expect(changeReadiness({ dependsOn: ["add-standings"] }, { ...context, queueEntries: [] }))
      .toMatchObject({ readiness: "blocked", summary: "Blocked — 0/1 dependencies merged" })
  })
})
