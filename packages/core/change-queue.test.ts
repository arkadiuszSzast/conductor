import { describe, expect, it } from "bun:test"
import { planQueue, validateQueueEntry } from "./src/change-queue.ts"
import type { PlanQueueInput, QueueDiagnostic, QueueEntry, QueueEntryStatus } from "./src/change-queue.ts"
import type { FeatureStatus } from "./src/types.ts"

type Spec = {
  entries?: Array<string | [string, QueueEntryStatus, FeatureStatus?]>
  deps?: Record<string, string[]>
  merged?: string[]
  extraKnown?: string[]
  limit?: number
  paused?: boolean
}

function build(spec: Spec): PlanQueueInput {
  const features = new Map<string, FeatureStatus>()
  const entries: QueueEntry[] = (spec.entries ?? []).map((item) => {
    if (typeof item === "string") return { id: item, change: item, status: "waiting" }
    const [change, status, featureStatus] = item
    if (featureStatus === undefined) return { id: change, change, status }
    features.set(`f-${change}`, featureStatus)
    return { id: change, change, status, featureId: `f-${change}` }
  })
  const graph = new Map<string, readonly string[]>(Object.entries(spec.deps ?? {}))
  const merged = new Set(spec.merged ?? [])
  const known = new Set<string>([...entries.map((e) => e.change), ...graph.keys(), ...merged, ...(spec.extraKnown ?? [])])
  for (const list of graph.values()) for (const name of list) known.add(name)
  return { entries, graph, known, merged, features, limit: spec.limit ?? 1, paused: spec.paused ?? false }
}

describe("validateQueueEntry", () => {
  const known = new Set(["a", "b", "c", "d"])
  const cases: Array<{ name: string; graph: Record<string, string[]>; change: string; kind?: QueueDiagnostic["kind"]; names?: string[] }> = [
    { name: "no dependencies", graph: {}, change: "a" },
    { name: "valid chain", graph: { a: ["b"], b: ["c"] }, change: "a" },
    { name: "diamond is not a cycle", graph: { a: ["b", "c"], b: ["d"], c: ["d"] }, change: "a" },
    { name: "two-cycle names both", graph: { a: ["b"], b: ["a"] }, change: "a", kind: "cycle", names: ["a", "b"] },
    { name: "self cycle", graph: { a: ["a"] }, change: "a", kind: "cycle", names: ["a"] },
    { name: "transitive cycle", graph: { a: ["b"], b: ["c"], c: ["b"] }, change: "a", kind: "cycle", names: ["b", "c"] },
    { name: "unknown dependency", graph: { a: ["does-not-exist"] }, change: "a", kind: "unknown-dependency", names: ["a", "does-not-exist"] },
    { name: "transitive unknown dependency", graph: { a: ["b"], b: ["ghost"] }, change: "a", kind: "unknown-dependency", names: ["b", "ghost"] },
  ]
  for (const c of cases) {
    it(c.name, () => {
      const diagnostics = validateQueueEntry(c.change, new Map(Object.entries(c.graph)), known)
      if (c.kind === undefined) {
        expect(diagnostics).toEqual([])
        return
      }
      expect(diagnostics).toHaveLength(1)
      expect(diagnostics[0]?.kind).toBe(c.kind)
      expect(diagnostics[0]?.changes).toEqual(c.names as never)
      for (const name of c.names ?? []) expect(diagnostics[0]?.message).toContain(name)
    })
  }

  it("a dependency that is only archived (known, no graph entry) is valid", () => {
    expect(validateQueueEntry("a", new Map([["a", ["archived-one"]]]), new Set(["a", "archived-one"]))).toEqual([])
  })

  it("reports both a cycle and an unknown dependency", () => {
    const graph = new Map([
      ["a", ["b", "ghost"]],
      ["b", ["a"]],
    ])
    const diagnostics = validateQueueEntry("a", graph, new Set(["a", "b"]))
    expect(diagnostics.map((d) => d.kind).sort()).toEqual(["cycle", "unknown-dependency"])
  })

  it("canonicalises the cycle regardless of where the walk enters it", () => {
    const graph = new Map([
      ["x", ["c"]],
      ["a", ["b"]],
      ["b", ["c"]],
      ["c", ["a"]],
    ])
    const known2 = new Set(["a", "b", "c", "x"])
    expect(validateQueueEntry("x", graph, known2)[0]?.changes).toEqual(["a", "b", "c"])
    expect(validateQueueEntry("b", graph, known2)[0]?.changes).toEqual(["a", "b", "c"])
  })
})

describe("planQueue — readiness and starts", () => {
  it("no depends_on: ready as soon as queued", () => {
    const result = planQueue(build({ entries: ["a"] }))
    expect(result.start).toEqual(["a"])
  })

  it("dependency already archived counts as merged", () => {
    const result = planQueue(build({ entries: ["a"], deps: { a: ["old"] }, merged: ["old"] }))
    expect(result.start).toEqual(["a"])
  })

  it("next change starts once its dependency merged", () => {
    const result = planQueue(build({ entries: [["a", "merged"], "b"], deps: { b: ["a"] }, merged: ["a"] }))
    expect(result.start).toEqual(["b"])
    expect(result.states.get("a")).toEqual({ kind: "merged" })
  })

  it("done feature without an archive on the default branch does not satisfy a dependant", () => {
    const result = planQueue(build({ entries: [["a", "running", "done"], "b"], deps: { b: ["a"] } }))
    expect(result.start).toEqual([])
    const b = result.states.get("b")
    expect(b).toMatchObject({ kind: "waiting", why: "dependencies", waitingOn: ["a"] })
    expect(b?.kind === "waiting" && b.reason).toContain("`a`")
  })

  it("waiting reason names only the unmerged dependencies", () => {
    const result = planQueue(build({ entries: ["c"], deps: { c: ["a", "b"] }, merged: ["a"] }))
    const c = result.states.get("c")
    expect(c).toMatchObject({ kind: "waiting", why: "dependencies", waitingOn: ["b"] })
    expect(c?.kind === "waiting" && c.reason).toBe("waiting for `b`")
  })

  it("independent ready changes run in parallel when the limit allows", () => {
    expect(planQueue(build({ entries: ["a", "b", "c"], limit: 2 })).start).toEqual(["a", "b"])
  })

  it("limit holds back a ready change with a limit reason", () => {
    const result = planQueue(build({ entries: [["a", "running", "running"], "b"], limit: 1 }))
    expect(result.start).toEqual([])
    expect(result.states.get("b")).toMatchObject({ kind: "waiting", why: "limit" })
    const b = result.states.get("b")
    expect(b && "reason" in b && b.reason).toContain("parallelism limit")
  })

  it("starts fill only the remaining slots, in queue order", () => {
    const result = planQueue(
      build({ entries: [["a", "running", "running"], "b", "c", "d"], limit: 3 }),
    )
    expect(result.start).toEqual(["b", "c"])
    expect(result.states.get("d")).toMatchObject({ kind: "waiting", why: "limit" })
  })

  it("a not-ready entry does not consume a slot", () => {
    const result = planQueue(build({ entries: ["b", "c"], deps: { b: ["x"] }, extraKnown: ["x"], limit: 1 }))
    expect(result.start).toEqual(["c"])
  })

  it("a done (non-merged) feature releases its slot", () => {
    const result = planQueue(build({ entries: [["a", "running", "done"], "b"], limit: 1 }))
    expect(result.start).toEqual(["b"])
  })

  it("an abandoned feature releases its slot", () => {
    const result = planQueue(build({ entries: [["a", "escalated", "abandoned"], "b"], limit: 1 }))
    expect(result.start).toEqual(["b"])
  })

  it("escalated and paused features keep their slot", () => {
    expect(planQueue(build({ entries: [["a", "escalated", "escalated"], "b"], limit: 1 })).start).toEqual([])
    expect(planQueue(build({ entries: [["a", "running", "paused"], "b"], limit: 1 })).start).toEqual([])
  })

  it("a starting claim holds a slot", () => {
    expect(planQueue(build({ entries: [["a", "starting"], "b"], limit: 1 })).start).toEqual([])
  })

  it("a merged entry whose feature is still running keeps its slot", () => {
    const result = planQueue(build({ entries: [["a", "running", "running"], "b"], merged: ["a"], limit: 1 }))
    expect(result.states.get("a")).toEqual({ kind: "merged" })
    expect(result.start).toEqual([])
  })

  it("a removed entry whose feature is still non-terminal keeps its slot; a terminal one does not", () => {
    for (const status of ["running", "paused", "escalated", "waiting_human"] as const) {
      const held = planQueue(build({ entries: [["a", "removed", status], "b"], limit: 1 }))
      expect(held.start).toEqual([])
      expect(held.states.get("a")).toEqual({ kind: "removed" })
      expect(held.states.get("b")).toMatchObject({ kind: "waiting", why: "limit" })
    }
    for (const status of ["done", "abandoned"] as const) {
      expect(planQueue(build({ entries: [["a", "removed", status], "b"], limit: 1 })).start).toEqual(["b"])
    }
    expect(planQueue(build({ entries: [["a", "removed", "running"], "b", "c"], limit: 2 })).start).toEqual(["b"])
  })

  it("limit below 1 is treated as 1", () => {
    expect(planQueue(build({ entries: ["a", "b"], limit: 0 })).start).toEqual(["a"])
  })

  it("selected entries get a starting state", () => {
    expect(planQueue(build({ entries: ["a"] })).states.get("a")?.kind).toBe("starting")
  })

  it("removed entries are inert and hold no slot", () => {
    const result = planQueue(build({ entries: [["a", "removed"], "b"], limit: 1 }))
    expect(result.start).toEqual(["b"])
    expect(result.states.get("a")).toEqual({ kind: "removed" })
  })
})

describe("planQueue — pause", () => {
  it("pause stops new starts only; ready entries say 'queue paused'", () => {
    const result = planQueue(build({ entries: [["a", "running", "running"], "b"], limit: 2, paused: true }))
    expect(result.start).toEqual([])
    expect(result.states.get("a")?.kind).toBe("running")
    expect(result.states.get("b")).toMatchObject({ kind: "waiting", why: "paused", reason: "queue paused" })
  })

  it("an entry with unmerged dependencies still names them while paused", () => {
    const result = planQueue(build({ entries: ["b"], deps: { b: ["a"] }, extraKnown: ["a"], paused: true }))
    expect(result.states.get("b")).toMatchObject({ why: "dependencies", waitingOn: ["a"] })
  })
})

describe("planQueue — failure isolation", () => {
  it("unrelated work continues; dependants are blocked naming the stuck change", () => {
    const result = planQueue(
      build({
        entries: [["quest-outcomes", "escalated", "escalated"], "editor", "equipment"],
        deps: { equipment: ["quest-outcomes"] },
        limit: 2,
      }),
    )
    expect(result.start).toEqual(["editor"])
    expect(result.states.get("quest-outcomes")).toMatchObject({ kind: "escalated", featureStatus: "escalated" })
    const equipment = result.states.get("equipment")
    expect(equipment).toMatchObject({ kind: "blocked", by: "quest-outcomes", stuck: "escalated" })
    expect(equipment && "reason" in equipment && equipment.reason).toContain("`quest-outcomes`")
  })

  it("blocks transitively and names the stuck change, not the intermediate one", () => {
    const result = planQueue(
      build({
        entries: [["a", "escalated", "escalated"], "b", "c"],
        deps: { b: ["a"], c: ["b"] },
        limit: 5,
      }),
    )
    expect(result.states.get("b")).toMatchObject({ kind: "blocked", by: "a" })
    expect(result.states.get("c")).toMatchObject({ kind: "blocked", by: "a" })
    expect(result.start).toEqual([])
  })

  it("blocks through a dependency that is not itself queued", () => {
    const result = planQueue(
      build({ entries: [["a", "escalated", "escalated"], "c"], deps: { c: ["mid"], mid: ["a"] }, limit: 5 }),
    )
    expect(result.states.get("c")).toMatchObject({ kind: "blocked", by: "a" })
  })

  it("recovery unblocks the dependants", () => {
    const stuck = build({ entries: [["a", "escalated", "escalated"], "b"], deps: { b: ["a"] }, limit: 5 })
    expect(planQueue(stuck).states.get("b")?.kind).toBe("blocked")
    const recovered = build({ entries: [["a", "running", "running"], "b"], deps: { b: ["a"] }, limit: 5 })
    expect(planQueue(recovered).states.get("b")).toMatchObject({ kind: "waiting", waitingOn: ["a"] })
    const merged = build({ entries: [["a", "running", "running"], "b"], deps: { b: ["a"] }, merged: ["a"], limit: 5 })
    expect(planQueue(merged).start).toEqual(["b"])
  })

  it("paused feature: entry stays running, dependants blocked", () => {
    const result = planQueue(build({ entries: [["a", "running", "paused"], "b"], deps: { b: ["a"] }, limit: 5 }))
    expect(result.states.get("a")).toMatchObject({ kind: "running", featureStatus: "paused" })
    expect(result.states.get("b")).toMatchObject({ kind: "blocked", by: "a", stuck: "paused" })
  })

  it("abandoned feature: entry is escalated-and-named, dependants blocked", () => {
    const result = planQueue(build({ entries: [["a", "escalated", "abandoned"], "b"], deps: { b: ["a"] }, limit: 5 }))
    expect(result.states.get("a")).toMatchObject({ kind: "escalated", featureStatus: "abandoned" })
    expect(result.states.get("b")).toMatchObject({ kind: "blocked", by: "a", stuck: "abandoned" })
  })

  it("removing an abandoned entry leaves dependants blocked", () => {
    const result = planQueue(build({ entries: [["a", "removed", "abandoned"], "b"], deps: { b: ["a"] }, limit: 5 }))
    expect(result.states.get("a")).toEqual({ kind: "removed" })
    expect(result.states.get("b")).toMatchObject({ kind: "blocked", by: "a", stuck: "abandoned" })
  })

  it("dropping the dependency unblocks the dependant", () => {
    const result = planQueue(build({ entries: [["a", "removed", "abandoned"], "b"], deps: { b: [] }, limit: 5 }))
    expect(result.start).toEqual(["b"])
  })

  it("a stuck feature whose change merged anyway blocks nothing", () => {
    const result = planQueue(
      build({ entries: [["a", "escalated", "escalated"], "b"], deps: { b: ["a"] }, merged: ["a"], limit: 5 }),
    )
    expect(result.states.get("a")).toEqual({ kind: "merged" })
    expect(result.start).toEqual(["b"])
  })
})

describe("planQueue — merged and invalid", () => {
  it("entry whose change is in merged becomes merged (final)", () => {
    const result = planQueue(build({ entries: [["a", "running", "done"]], merged: ["a"] }))
    expect(result.states.get("a")).toEqual({ kind: "merged" })
    expect(planQueue(build({ entries: [["a", "merged"]] })).states.get("a")).toEqual({ kind: "merged" })
  })

  it("an entry edited into a cycle becomes invalid and is not started", () => {
    const result = planQueue(build({ entries: ["a", "b"], deps: { a: ["b"], b: ["a"] }, limit: 5 }))
    expect(result.start).toEqual([])
    const a = result.states.get("a")
    expect(a).toMatchObject({ kind: "invalid" })
    expect(a && "reason" in a && a.reason).toContain("`a`")
    expect(a && "reason" in a && a.reason).toContain("`b`")
  })

  it("an unknown dependency makes the entry invalid; other entries proceed", () => {
    const input = build({ entries: ["a", "b"], deps: { a: ["ghost"] }, limit: 5 })
    const known = new Set(input.known)
    known.delete("ghost")
    const result = planQueue({ ...input, known })
    expect(result.states.get("a")).toMatchObject({ kind: "invalid" })
    expect(result.start).toEqual(["b"])
  })

  it("invalid takes precedence over blocked", () => {
    const input = build({ entries: [["s", "escalated", "escalated"], "a"], deps: { a: ["s", "ghost"] }, limit: 5 })
    const known = new Set(input.known)
    known.delete("ghost")
    expect(planQueue({ ...input, known }).states.get("a")?.kind).toBe("invalid")
  })
})

describe("planQueue — every state carries a reason", () => {
  it("all non-final states have a non-empty reason", () => {
    const input = build({
      entries: [
        ["run", "running", "running"],
        ["esc", "escalated", "escalated"],
        ["claim", "starting"],
        "blocked",
        "waiting",
        "limited",
        "bad",
      ],
      deps: { blocked: ["esc"], waiting: ["pending"], bad: ["bad"] },
      extraKnown: ["pending"],
      limit: 3,
    })
    const { states } = planQueue(input)
    expect([...states.values()].map((s) => s.kind)).toEqual([
      "running",
      "escalated",
      "starting",
      "blocked",
      "waiting",
      "waiting",
      "invalid",
    ])
    for (const state of states.values()) {
      expect("reason" in state && state.reason.length > 0).toBe(true)
    }
  })

  it("is deterministic and keeps queue order", () => {
    const input = build({ entries: ["z", "y", "x"], limit: 2 })
    const first = planQueue(input)
    expect(planQueue(input)).toEqual(first)
    expect([...first.states.keys()]).toEqual(["z", "y", "x"])
    expect(first.start).toEqual(["z", "y"])
  })
})

// ---------------------------------------------------------------------------
// Property tests (seeded, no dependencies)
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Scenario {
  input: PlanQueueInput
  slotsHeld: number
}

const FEATURE_STATUSES: FeatureStatus[] = ["running", "waiting_human", "paused", "escalated", "done", "abandoned"]

function generate(seed: number, acyclic: boolean): Scenario {
  const rand = mulberry32(seed)
  const int = (n: number) => Math.floor(rand() * n)
  const count = 1 + int(8)
  const names = Array.from({ length: count }, (_, i) => `c${i}`)
  const archived = ["old1", "old2"]
  const graph = new Map<string, string[]>()
  names.forEach((name, i) => {
    const pool = acyclic ? names.slice(0, i) : names
    const deps = [...pool, ...archived].filter(() => rand() < 0.25)
    if (deps.length > 0 || rand() < 0.5) graph.set(name, deps)
  })
  const merged = new Set<string>([...archived, ...names.filter(() => rand() < 0.15)])
  const features = new Map<string, FeatureStatus>()
  const entries: QueueEntry[] = []
  let slotsHeld = 0
  for (const name of names.filter(() => rand() < 0.85).sort(() => rand() - 0.5)) {
    const roll = rand()
    if (roll < 0.35) {
      const featureStatus = FEATURE_STATUSES[int(FEATURE_STATUSES.length)] as FeatureStatus
      features.set(`f-${name}`, featureStatus)
      entries.push({
        id: name,
        change: name,
        status: featureStatus === "escalated" || featureStatus === "abandoned" ? "escalated" : "running",
        featureId: `f-${name}`,
      })
      if (featureStatus !== "done" && featureStatus !== "abandoned") slotsHeld++
    } else if (roll < 0.4) {
      entries.push({ id: name, change: name, status: "starting" })
      slotsHeld++
    } else {
      entries.push({ id: name, change: name, status: "waiting" })
    }
  }
  const input: PlanQueueInput = {
    entries,
    graph,
    known: new Set([...names, ...archived]),
    merged,
    features,
    limit: 1 + int(4),
    paused: rand() < 0.2,
  }
  return { input, slotsHeld }
}

function closure(graph: ReadonlyMap<string, readonly string[]>, change: string): Set<string> {
  const seen = new Set<string>()
  const todo = [change]
  while (todo.length > 0) {
    for (const dep of graph.get(todo.pop() as string) ?? []) {
      if (!seen.has(dep)) {
        seen.add(dep)
        todo.push(dep)
      }
    }
  }
  return seen
}

describe("planQueue — properties", () => {
  const runs = 600

  it("never starts more than limit minus the slots already held", () => {
    for (let seed = 1; seed <= runs; seed++) {
      const { input, slotsHeld } = generate(seed, seed % 2 === 0)
      const { start } = planQueue(input)
      expect(start.length).toBeLessThanOrEqual(Math.max(0, input.limit - slotsHeld))
      if (input.paused) expect(start).toEqual([])
    }
  })

  it("never starts an entry with an unmerged dependency, an invalid graph, or a non-waiting status", () => {
    for (let seed = 1; seed <= runs; seed++) {
      const { input } = generate(seed, seed % 2 === 0)
      const { start } = planQueue(input)
      const byId = new Map(input.entries.map((e) => [e.id, e]))
      for (const id of start) {
        const entry = byId.get(id) as QueueEntry
        expect(entry.status).toBe("waiting")
        expect(input.merged.has(entry.change)).toBe(false)
        for (const dep of input.graph.get(entry.change) ?? []) expect(input.merged.has(dep)).toBe(true)
        expect(validateQueueEntry(entry.change, input.graph, input.known)).toEqual([])
      }
      expect(start).toEqual(input.entries.filter((e) => start.includes(e.id)).map((e) => e.id))
    }
  })

  it("an entry independent of every stuck feature is never blocked", () => {
    let blockedSeen = 0
    for (let seed = 1; seed <= runs; seed++) {
      const { input } = generate(seed, seed % 2 === 0)
      const { states } = planQueue(input)
      const stuckChanges = new Set<string>()
      for (const entry of input.entries) {
        const status = entry.featureId === undefined ? undefined : input.features.get(entry.featureId)
        if (status === "escalated" || status === "paused" || status === "abandoned") stuckChanges.add(entry.change)
      }
      for (const entry of input.entries) {
        const state = states.get(entry.id)
        const dependsOnStuck = [...closure(input.graph, entry.change)].some((dep) => stuckChanges.has(dep))
        if (!dependsOnStuck) expect(state?.kind).not.toBe("blocked")
        if (state?.kind === "blocked") {
          blockedSeen++
          expect(stuckChanges.has(state.by)).toBe(true)
          expect(closure(input.graph, entry.change).has(state.by)).toBe(true)
        }
      }
    }
    expect(blockedSeen).toBeGreaterThan(0)
  })

  it("is deterministic and covers every entry exactly once", () => {
    for (let seed = 1; seed <= 100; seed++) {
      const { input } = generate(seed, seed % 2 === 0)
      const a = planQueue(input)
      expect(planQueue(input)).toEqual(a)
      expect([...a.states.keys()]).toEqual(input.entries.map((e) => e.id))
    }
  })
})
