/**
 * Start-work target derivation — daemon health (not feature scopes) is
 * the source of eligible project/workflow targets, per
 * `start-work-from-control-room/design.md` "Model selection as a
 * project/workflow target".
 */
import { describe, expect, it } from "bun:test"
import {
  deriveDiscoveryState,
  deriveStartTargets,
  deriveSubmitGate,
  preselectedTarget,
  requiresExplicitSelection,
  resolveSelectedProjectDir,
  resolveTarget,
  runnerUnavailable,
  selectableTargets,
  type ResolvedTarget,
  type StartTarget,
  type WorkflowResourceStateInput,
} from "../src/start-work/targets.ts"
import type { DaemonHealth, WorkflowProjection } from "../src/api/types.ts"
import type { WorkflowState } from "../src/api/store.ts"

function loaded(data: WorkflowState): WorkflowResourceStateInput {
  return { status: "ready", data, error: null }
}

function health(partial: Partial<DaemonHealth> = {}): DaemonHealth {
  return {
    alive: true,
    ready: true,
    phase: "ready",
    database: { path: "", migrated: true, appliedNow: [], knownMigrations: 0 },
    heartbeat: { intervalMs: 0, running: true, inFlight: false, lastStartedAt: null, lastCompletedAt: null, lastError: null, cycles: 0 },
    projects: [],
    runner: "available",
    ...partial,
  }
}

describe("deriveStartTargets", () => {
  it("returns nothing while health has not loaded", () => {
    expect(deriveStartTargets(null)).toEqual([])
  })

  it("maps every health project to a target, sorted by label", () => {
    const targets = deriveStartTargets(
      health({
        projects: [
          { projectDir: "/home/dev/zeta", state: "valid", diagnostics: [] },
          { projectDir: "/home/dev/alpha", state: "valid", diagnostics: [] },
        ],
      }),
    )
    expect(targets.map(t => t.projectLabel)).toEqual(["alpha", "zeta"])
  })

  it("disambiguates a basename collision with the parent segment, leaves non-colliding labels short", () => {
    const targets = deriveStartTargets(
      health({
        projects: [
          { projectDir: "/home/a/webapp", state: "valid", diagnostics: [] },
          { projectDir: "/home/b/webapp", state: "valid", diagnostics: [] },
          { projectDir: "/home/c/solo", state: "valid", diagnostics: [] },
        ],
      }),
    )
    const byDir = Object.fromEntries(targets.map(t => [t.projectDir, t]))
    expect(byDir["/home/a/webapp"]!.projectLabel).toBe("a/webapp")
    expect(byDir["/home/b/webapp"]!.projectLabel).toBe("b/webapp")
    expect(byDir["/home/c/solo"]!.projectLabel).toBe("solo")
    // Every target still carries its own full path regardless of label.
    expect(byDir["/home/a/webapp"]!.projectDir).toBe("/home/a/webapp")
    expect(byDir["/home/b/webapp"]!.projectDir).toBe("/home/b/webapp")
  })

  it("valid and stale are selectable; invalid and unregistered are not", () => {
    const targets = deriveStartTargets(
      health({
        projects: [
          { projectDir: "/p/valid", state: "valid", diagnostics: [] },
          { projectDir: "/p/stale", state: "stale", diagnostics: [{ sourcePath: "conductor.yaml", message: "bad yaml" }] },
          { projectDir: "/p/invalid", state: "invalid", diagnostics: [{ sourcePath: "conductor.yaml", message: "missing jobs" }] },
          { projectDir: "/p/unregistered", state: "unregistered", diagnostics: [] },
        ],
      }),
    )
    const byDir = Object.fromEntries(targets.map(t => [t.projectDir, t]))
    expect(byDir["/p/valid"]!.selectable).toBe(true)
    expect(byDir["/p/valid"]!.stale).toBe(false)
    expect(byDir["/p/stale"]!.selectable).toBe(true)
    expect(byDir["/p/stale"]!.stale).toBe(true)
    expect(byDir["/p/stale"]!.diagnostics).toEqual(["bad yaml"])
    expect(byDir["/p/invalid"]!.selectable).toBe(false)
    expect(byDir["/p/invalid"]!.diagnostics).toEqual(["missing jobs"])
    expect(byDir["/p/unregistered"]!.selectable).toBe(false)
  })

  it("prefers a diagnostic's safeMessage over its path-bearing message when both are present", () => {
    const targets = deriveStartTargets(
      health({
        projects: [
          {
            projectDir: "/p/stale",
            state: "stale",
            diagnostics: [
              {
                sourcePath: "conductor.yaml",
                message: 'action "build" not found: searched /opt/conductor/actions, /home/user/.conductor/actions',
                safeMessage: 'action "build" not found',
              },
            ],
          },
        ],
      }),
    )
    const diagnostics = targets.find(t => t.projectDir === "/p/stale")!.diagnostics
    expect(diagnostics).toEqual(['action "build" not found'])
    expect(diagnostics.join("; ")).not.toContain("/opt/conductor/actions")
    expect(diagnostics.join("; ")).not.toContain("/home/user/.conductor/actions")
  })

  it("falls back to message when safeMessage is absent (wire compatibility with a daemon that predates the field)", () => {
    const targets = deriveStartTargets(
      health({
        projects: [{ projectDir: "/p/stale", state: "stale", diagnostics: [{ sourcePath: "conductor.yaml", message: "bad yaml" }] }],
      }),
    )
    expect(targets.find(t => t.projectDir === "/p/stale")!.diagnostics).toEqual(["bad yaml"])
  })
})

describe("preselectedTarget / requiresExplicitSelection", () => {
  it("preselects the sole eligible target", () => {
    const targets = deriveStartTargets(health({ projects: [{ projectDir: "/only", state: "valid", diagnostics: [] }] }))
    expect(preselectedTarget(targets)?.projectDir).toBe("/only")
    expect(requiresExplicitSelection(targets)).toBe(false)
  })

  it("does not preselect when zero targets are eligible", () => {
    const targets = deriveStartTargets(health({ projects: [{ projectDir: "/bad", state: "invalid", diagnostics: [] }] }))
    expect(preselectedTarget(targets)).toBeNull()
    expect(requiresExplicitSelection(targets)).toBe(false)
  })

  it("requires explicit selection with multiple eligible targets, and does not preselect", () => {
    const targets = deriveStartTargets(
      health({
        projects: [
          { projectDir: "/a", state: "valid", diagnostics: [] },
          { projectDir: "/b", state: "stale", diagnostics: [] },
        ],
      }),
    )
    expect(preselectedTarget(targets)).toBeNull()
    expect(requiresExplicitSelection(targets)).toBe(true)
    expect(selectableTargets(targets).length).toBe(2)
  })
})

describe("resolveSelectedProjectDir", () => {
  const targets = deriveStartTargets(
    health({
      projects: [
        { projectDir: "/a", state: "valid", diagnostics: [] },
        { projectDir: "/b", state: "valid", diagnostics: [] },
      ],
    }),
  )

  it("freezes on the current selection while it still names a target", () => {
    expect(resolveSelectedProjectDir(targets, "/b")).toBe("/b")
  })

  it("falls back to the sole eligible target once the current selection disappears", () => {
    const single = deriveStartTargets(health({ projects: [{ projectDir: "/only", state: "valid", diagnostics: [] }] }))
    expect(resolveSelectedProjectDir(single, "/gone")).toBe("/only")
  })

  it("has nothing to fall back to with no current selection and multiple targets", () => {
    expect(resolveSelectedProjectDir(targets, null)).toBeNull()
  })
})

describe("runnerUnavailable", () => {
  it("is a non-blocking warning flag, independent of targets", () => {
    expect(runnerUnavailable(health({ runner: "unavailable" }))).toBe(true)
    expect(runnerUnavailable(health({ runner: "available" }))).toBe(false)
    expect(runnerUnavailable(null)).toBe(false)
  })
})

function workflow(partial: Partial<WorkflowProjection> = {}): WorkflowProjection {
  return { name: "delivery", stale: false, jobs: {}, inputs: {}, diagnostics: [], ...partial }
}

function target(partial: Partial<StartTarget> = {}): StartTarget {
  return {
    projectDir: "/proj",
    projectLabel: "proj",
    state: "valid",
    selectable: true,
    stale: false,
    diagnostics: [],
    ...partial,
  }
}

describe("resolveTarget", () => {
  it("returns null with no target selected", () => {
    expect(resolveTarget(null, null)).toBeNull()
  })

  it("an unavailable (invalid/unregistered) target reports why, with no inputs", () => {
    const t = target({ selectable: false, state: "invalid", diagnostics: ["bad yaml"] })
    const resolved = resolveTarget(t, null)
    expect(resolved?.submittable).toBe(false)
    expect(resolved?.unavailableReason).toBe("bad yaml")
    expect(resolved?.inputs).toEqual({})
  })

  it("a selectable target with no workflow state yet is not submittable but not flagged unavailable", () => {
    const resolved = resolveTarget(target(), null)
    expect(resolved?.submittable).toBe(false)
    expect(resolved?.unavailableReason).toBeNull()
  })

  it("a valid workflow resolves to a submittable target with its input defs", () => {
    const state: WorkflowState = { ok: true, workflow: workflow({ inputs: { feature: { type: "string", presence: "required" } } }) }
    const resolved = resolveTarget(target(), loaded(state))
    expect(resolved?.submittable).toBe(true)
    expect(resolved?.workflowName).toBe("delivery")
    expect(resolved?.staleWarning).toBeNull()
    expect(resolved?.inputs).toEqual({ feature: { type: "string", presence: "required" } })
    expect(resolved?.refreshError).toBeNull()
  })

  it("a stale workflow remains submittable with a warning that names the diagnostics", () => {
    const state: WorkflowState = { ok: true, workflow: workflow({ stale: true, diagnostics: ["parse error at line 3"] }) }
    const resolved = resolveTarget(target({ stale: true }), loaded(state))
    expect(resolved?.submittable).toBe(true)
    expect(resolved?.staleWarning).toContain("parse error at line 3")
  })

  it("a workflow fetch failure (unregistered/invalid race) is unavailable, not submittable", () => {
    const state: WorkflowState = { ok: false, state: "invalid", message: "workflow invalid: bad jobs" }
    const resolved = resolveTarget(target(), loaded(state))
    expect(resolved?.submittable).toBe(false)
    expect(resolved?.unavailableReason).toBe("workflow invalid: bad jobs")
  })

  it("an INITIAL fetch failure (no prior data) is unavailable, distinct from still loading", () => {
    const resolved = resolveTarget(target(), { status: "error", data: null, error: { message: "network down" } })
    expect(resolved?.submittable).toBe(false)
    expect(resolved?.unavailableReason).toBe("network down")
    expect(resolved?.refreshError).toBeNull()
  })

  it("still loading (no data, no error) reports neither unavailable nor a refresh error", () => {
    const resolved = resolveTarget(target(), { status: "loading", data: null, error: null })
    expect(resolved?.submittable).toBe(false)
    expect(resolved?.unavailableReason).toBeNull()
    expect(resolved?.refreshError).toBeNull()
  })

  it("a FAILED REFRESH with a prior cached valid snapshot stays submittable but reports refreshError, never silently treated as fresh", () => {
    const cached: WorkflowState = { ok: true, workflow: workflow({ inputs: { feature: { type: "string", presence: "required" } } }) }
    const resolved = resolveTarget(target(), { status: "error", data: cached, error: { message: "network down" } })
    expect(resolved?.submittable).toBe(true)
    expect(resolved?.workflowName).toBe("delivery")
    expect(resolved?.inputs).toEqual({ feature: { type: "string", presence: "required" } })
    expect(resolved?.refreshError).toBe("network down")
  })

  it("a failed refresh with a prior unregistered/invalid result stays unavailable and also reports refreshError", () => {
    const cached: WorkflowState = { ok: false, state: "invalid", message: "workflow invalid: bad jobs" }
    const resolved = resolveTarget(target(), { status: "error", data: cached, error: { message: "network down" } })
    expect(resolved?.submittable).toBe(false)
    expect(resolved?.unavailableReason).toBe("workflow invalid: bad jobs")
    expect(resolved?.refreshError).toBe("network down")
  })
})

describe("resolveTarget: canRetryWorkflow", () => {
  it("is true for an INITIAL transport failure (no prior data) — a retry can plausibly resolve a network/500 blip", () => {
    const resolved = resolveTarget(target(), { status: "error", data: null, error: { message: "network down" } })
    expect(resolved?.canRetryWorkflow).toBe(true)
  })

  it("is false while still loading — nothing to retry, a request is already in flight", () => {
    const resolved = resolveTarget(target(), { status: "loading", data: null, error: null })
    expect(resolved?.canRetryWorkflow).toBe(false)
  })

  it("is false for a fresh, successfully loaded valid snapshot — nothing to recover from", () => {
    const state: WorkflowState = { ok: true, workflow: workflow() }
    const resolved = resolveTarget(target(), loaded(state))
    expect(resolved?.canRetryWorkflow).toBe(false)
  })

  it("is true for a FAILED REFRESH with a prior cached valid snapshot — a transport-layer failure worth retrying", () => {
    const cached: WorkflowState = { ok: true, workflow: workflow() }
    const resolved = resolveTarget(target(), { status: "error", data: cached, error: { message: "network down" } })
    expect(resolved?.canRetryWorkflow).toBe(true)
  })

  it("is true for a failed refresh with a prior unregistered/invalid RESULT — the transport-layer refresh itself is what failed, worth retrying", () => {
    const cached: WorkflowState = { ok: false, state: "invalid", message: "workflow invalid: bad jobs" }
    const resolved = resolveTarget(target(), { status: "error", data: cached, error: { message: "network down" } })
    expect(resolved?.canRetryWorkflow).toBe(true)
  })

  it("is false for a plain unregistered/invalid RESPONSE with no transport failure — a real configuration state a retry cannot fix", () => {
    const state: WorkflowState = { ok: false, state: "invalid", message: "workflow invalid: bad jobs" }
    const resolved = resolveTarget(target(), loaded(state))
    expect(resolved?.canRetryWorkflow).toBe(false)
  })

  it("is false for an unselectable (invalid/unregistered per health) target — health, not a workflow fetch, is the failure", () => {
    const t = target({ selectable: false, state: "invalid", diagnostics: ["bad yaml"] })
    const resolved = resolveTarget(t, null)
    expect(resolved?.canRetryWorkflow).toBe(false)
  })
})

describe("deriveDiscoveryState", () => {
  it("is loading before health has ever loaded", () => {
    expect(deriveDiscoveryState({ status: "loading", data: null, error: null })).toEqual({ status: "loading" })
  })

  it("is ready once health data is present, even mid-refresh", () => {
    expect(deriveDiscoveryState({ status: "ready", data: health(), error: null })).toEqual({ status: "ready" })
    expect(deriveDiscoveryState({ status: "loading", data: health(), error: null })).toEqual({ status: "ready" })
  })

  it("a fresh (never-succeeded) health error is non-stale", () => {
    expect(deriveDiscoveryState({ status: "error", data: null, error: { message: "network down" } })).toEqual({
      status: "error",
      message: "network down",
      stale: false,
    })
  })

  it("a health error after a prior successful load is stale, keeping its cached data available", () => {
    expect(deriveDiscoveryState({ status: "error", data: health(), error: { message: "network down" } })).toEqual({
      status: "error",
      message: "network down",
      stale: true,
    })
  })
})

function resolved(partial: Partial<ResolvedTarget> = {}): ResolvedTarget {
  return {
    projectDir: "/proj",
    projectLabel: "proj",
    submittable: true,
    workflowName: "delivery",
    staleWarning: null,
    unavailableReason: null,
    inputs: {},
    refreshError: null,
    canRetryWorkflow: false,
    ...partial,
  }
}

describe("deriveSubmitGate", () => {
  it("blocks (silently — no reason shown) while a submit is pending, regardless of everything else", () => {
    const gate = deriveSubmitGate({ pending: true, discovery: { status: "loading" }, resolved: null, formValid: false, hasVisibleErrors: false })
    expect(gate.canSubmit).toBe(false)
    expect(gate.blockedReason).toBeNull()
  })

  it("blocks with a discovering message while discovery is still loading", () => {
    const gate = deriveSubmitGate({ pending: false, discovery: { status: "loading" }, resolved: null, formValid: true, hasVisibleErrors: false })
    expect(gate.canSubmit).toBe(false)
    expect(gate.blockedReason).toBe("discovering configured projects…")
  })

  it("blocks on a fresh (non-stale) discovery error even with a resolvable target", () => {
    const gate = deriveSubmitGate({
      pending: false,
      discovery: { status: "error", message: "network down", stale: false },
      resolved: resolved(),
      formValid: true,
      hasVisibleErrors: false,
    })
    expect(gate.canSubmit).toBe(false)
    expect(gate.blockedReason).toBe("could not load configured projects")
  })

  it("does NOT block on a stale discovery error — a cached target may still submit", () => {
    const gate = deriveSubmitGate({
      pending: false,
      discovery: { status: "error", message: "network down", stale: true },
      resolved: resolved(),
      formValid: true,
      hasVisibleErrors: false,
    })
    expect(gate.canSubmit).toBe(true)
    expect(gate.blockedReason).toBeNull()
  })

  it("blocks asking to select a project when nothing is resolved yet", () => {
    const gate = deriveSubmitGate({ pending: false, discovery: { status: "ready" }, resolved: null, formValid: true, hasVisibleErrors: false })
    expect(gate.canSubmit).toBe(false)
    expect(gate.blockedReason).toBe("select a project to start work in")
  })

  it("blocks with the target's own unavailable reason when not submittable", () => {
    const gate = deriveSubmitGate({
      pending: false,
      discovery: { status: "ready" },
      resolved: resolved({ submittable: false, workflowName: null, unavailableReason: "bad yaml" }),
      formValid: true,
      hasVisibleErrors: false,
    })
    expect(gate.canSubmit).toBe(false)
    expect(gate.blockedReason).toBe("bad yaml")
  })

  it("blocks with a generic reason when submittable but the workflow name is somehow missing", () => {
    const gate = deriveSubmitGate({
      pending: false,
      discovery: { status: "ready" },
      resolved: resolved({ workflowName: null }),
      formValid: true,
      hasVisibleErrors: false,
    })
    expect(gate.canSubmit).toBe(false)
    expect(gate.blockedReason).toBe("this target is not available to start work in")
  })

  it("blocks asking to fix fields when the target is submittable, the draft is invalid, AND at least one error is visible", () => {
    const gate = deriveSubmitGate({ pending: false, discovery: { status: "ready" }, resolved: resolved(), formValid: false, hasVisibleErrors: true })
    expect(gate.canSubmit).toBe(false)
    expect(gate.blockedReason).toBe("fix the highlighted fields")
  })

  it("never claims fields are highlighted when none are visible yet — an untouched, invalid, never-submitted draft gets a different reason", () => {
    const gate = deriveSubmitGate({ pending: false, discovery: { status: "ready" }, resolved: resolved(), formValid: false, hasVisibleErrors: false })
    expect(gate.canSubmit).toBe(false)
    expect(gate.blockedReason).not.toContain("highlighted")
    expect(gate.blockedReason).toBe("fill in the required fields to continue")
  })

  it("blocks submission when the target's most recent refresh failed, even with a valid cached snapshot and a valid draft — never silently treats cached as fresh", () => {
    const gate = deriveSubmitGate({
      pending: false,
      discovery: { status: "ready" },
      resolved: resolved({ refreshError: "network down" }),
      formValid: true,
      hasVisibleErrors: false,
    })
    expect(gate.canSubmit).toBe(false)
    expect(gate.blockedReason).toContain("network down")
  })

  it("allows submission once every gate clears", () => {
    const gate = deriveSubmitGate({ pending: false, discovery: { status: "ready" }, resolved: resolved(), formValid: true, hasVisibleErrors: false })
    expect(gate.canSubmit).toBe(true)
    expect(gate.blockedReason).toBeNull()
  })
})
