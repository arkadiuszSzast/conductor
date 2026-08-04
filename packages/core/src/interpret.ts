import type {
  AgentStep,
  Decision,
  FeatureState,
  FeatureStatus,
  JobDef,
  JobPatch,
  Patch,
  PipelineEvent,
  StepDef,
  Transition,
  WorkflowDef,
} from "./types.ts"

const DEFAULT_MAX_ATTEMPTS = 1
const DEFAULT_MAX_ROUNDS = 3

export function interpret(workflow: WorkflowDef, state: FeatureState, event: PipelineEvent): Transition {
  switch (event.kind) {
    case "feature.start":     return onStart(workflow)
    case "step.succeeded":    return onSucceeded(workflow, state, event.jobId, event.stepId, event.output)
    case "step.failed":       return onFailed(workflow, state, event.jobId, event.stepId, event.reason)
    case "step.verdict":      return onVerdict(workflow, state, event.jobId, event.stepId, event.verdict)
    case "human.approved":    return onHumanApproved(workflow, state, event.jobId, event.stepId)
    case "human.rejected":    return onHumanRejected(workflow, state, event.jobId, event.stepId)
    case "human.paused":      return tx([{ kind: "pause" }], { status: "paused" })
    case "human.resumed":     return onResumed(workflow, state)
    case "human.abandoned":   return tx([{ kind: "abandon" }], { status: "abandoned" })
  }
}

export function isTerminal(d: Decision): boolean {
  return d.kind === "finish" || d.kind === "abandon" || d.kind === "escalate"
}

function tx(decisions: Decision[], patch: Patch): Transition { return { decisions, patch } }
function noop(reason: string): Transition { return tx([{ kind: "noop", reason }], {}) }

function jobById(w: WorkflowDef, id: string): JobDef | undefined { return w.jobs[id] }
function stepById(j: JobDef, id: string): StepDef | undefined { return j.steps.find(s => s.id === id) }
function stepIdx(j: JobDef, id: string): number { return j.steps.findIndex(s => s.id === id) }
function firstStep(j: JobDef): string | null { return j.steps[0]?.id ?? null }

function nextStep(j: JobDef, s: StepDef): string | null {
  if (s.then !== undefined) return s.then
  const skip = s.type === "agent" ? (s as AgentStep).rounds_with : undefined
  const i = stepIdx(j, s.id)
  for (let k = i + 1; k < j.steps.length; k++) {
    const c = j.steps[k]
    if (c && c.id !== skip) return c.id
  }
  return null
}

function enterStep(w: WorkflowDef, state: FeatureState, jobId: string, stepId: string | null): Transition {
  if (stepId === null) return onJobDone(w, state, jobId)

  const j = jobById(w, jobId)
  if (!j) return tx([{ kind: "escalate", reason: `unknown job "${jobId}"` }], { status: "escalated" })

  const s = stepById(j, stepId)
  if (!s) return tx([{ kind: "escalate", reason: `unknown step "${stepId}"` }], { status: "escalated" })

  const jp: JobPatch = { status: "running", currentStep: stepId }

  if (s.type === "human")
    return tx(
      [{ kind: "wait_human", jobId, stepId }],
      { status: "waiting_human", jobs: { [jobId]: { ...jp, steps: { [stepId]: { status: "waiting_human" } } } } },
    )

  return tx(
    [{ kind: "execute_step", jobId, stepId }],
    { jobs: { [jobId]: { ...jp, steps: { [stepId]: { status: "running" } } } } },
  )
}

// ---------------------------------------------------------------------------

function onStart(w: WorkflowDef): Transition {
  const ready: string[] = []
  for (const [id, j] of Object.entries(w.jobs))
    if (!j.needs || j.needs.length === 0) ready.push(id)
  if (ready.length === 0) return tx([{ kind: "finish" }], { status: "done" })

  const decisions: Decision[] = []
  const jp: Record<string, JobPatch> = {}
  for (const jid of ready) {
    const j = jobById(w, jid)!
    const sid = firstStep(j)
    if (sid === null) { jp[jid] = { status: "succeeded", currentStep: null }; continue }
    const s = stepById(j, sid)!
    if (s.type === "human") {
      decisions.push({ kind: "wait_human", jobId: jid, stepId: sid })
      jp[jid] = { status: "running", currentStep: sid, steps: { [sid]: { status: "waiting_human" } } }
    } else {
      decisions.push({ kind: "execute_step", jobId: jid, stepId: sid })
      jp[jid] = { status: "running", currentStep: sid, steps: { [sid]: { status: "running" } } }
    }
  }
  return tx(decisions, { status: "running", jobs: jp })
}

function onSucceeded(w: WorkflowDef, state: FeatureState, jobId: string, stepId: string, output?: string): Transition {
  const js = state.jobs[jobId]
  if (!js || js.currentStep !== stepId) return noop(`stale success for "${jobId}/${stepId}"`)
  const j = jobById(w, jobId)
  const s = j && stepById(j, stepId)
  if (!j || !s) return tx([{ kind: "escalate", reason: `unknown step "${stepId}"` }], { status: "escalated" })

  const entry = enterStep(w, state, jobId, nextStep(j, s))
  return tx(entry.decisions as Decision[], mp(
    { jobs: { [jobId]: { steps: { [stepId]: { status: "succeeded", output: output ?? null } } } } },
    entry.patch,
  ))
}

function onFailed(w: WorkflowDef, state: FeatureState, jobId: string, stepId: string, reason: string): Transition {
  const js = state.jobs[jobId]
  if (!js || js.currentStep !== stepId) return noop(`stale failure for "${jobId}/${stepId}"`)
  const j = jobById(w, jobId)
  const s = j && stepById(j, stepId)
  if (!j || !s) return tx([{ kind: "escalate", reason: `unknown step "${stepId}"` }], { status: "escalated" })

  const attempts = (js.attempts[stepId] ?? 0) + 1
  const fail: JobPatch = { attempts: { ...js.attempts, [stepId]: attempts }, steps: { [stepId]: { status: "failed" } } }
  const onF = s.on_fail

  if (onF?.escalate === true)
    return tx([{ kind: "escalate", reason: `"${jobId}/${stepId}" failed: ${reason}` }], { status: "escalated", jobs: { [jobId]: fail } })

  const max = onF?.max_attempts ?? onF?.retry?.max_attempts ?? DEFAULT_MAX_ATTEMPTS
  if (attempts > max)
    return tx([{ kind: "escalate", reason: `"${jobId}/${stepId}" exhausted ${max} attempt(s)` }], { status: "escalated", jobs: { [jobId]: fail } })

  if (onF?.goto !== undefined) {
    const entry = enterStep(w, state, jobId, onF.goto)
    return tx(entry.decisions as Decision[], mp({ jobs: { [jobId]: fail } }, entry.patch))
  }

  return tx(
    [{ kind: "execute_step", jobId, stepId }],
    { status: "running", jobs: { [jobId]: { ...fail, status: "running", currentStep: stepId, steps: { [stepId]: { status: "running" } } } } },
  )
}

function onVerdict(w: WorkflowDef, state: FeatureState, jobId: string, stepId: string, verdict: string): Transition {
  const js = state.jobs[jobId]
  const j = jobById(w, jobId)
  const s = j && stepById(j, stepId)
  if (!j || !js || !s || s.type !== "agent") return noop(`verdict for invalid step "${jobId}/${stepId}"`)
  if (js.currentStep !== stepId) return noop(`stale verdict for "${jobId}/${stepId}"`)

  const a = s as AgentStep
  let rounds = js.rounds

  if (a.rounds_with !== undefined) {
    const done = (js.rounds[stepId] ?? 0) + 1
    rounds = { ...js.rounds, [stepId]: done }
    const maxR = a.max_rounds ?? DEFAULT_MAX_ROUNDS
    const route = a.on_verdict?.[verdict]
    if (route?.goto === a.rounds_with && done >= maxR)
      return tx([{ kind: "escalate", reason: `"${jobId}/${stepId}" reached ${maxR} round(s)` }], { status: "escalated", jobs: { [jobId]: { rounds } } })
  }

  const route = a.on_verdict?.[verdict]
  if (!route)
    return tx([{ kind: "escalate", reason: `unmapped verdict "${verdict}"` }], { status: "escalated", jobs: { [jobId]: { rounds } } })

  const target = route.goto ?? nextStep(j, a) ?? null
  const entry = enterStep(w, state, jobId, target)
  return tx(entry.decisions as Decision[], mp({ jobs: { [jobId]: { rounds } } }, entry.patch))
}

function onHumanApproved(w: WorkflowDef, state: FeatureState, jobId: string, stepId: string): Transition {
  const js = state.jobs[jobId]
  if (!js || js.currentStep !== stepId) return noop(`no pending approval for "${jobId}/${stepId}"`)
  const j = jobById(w, jobId)
  const s = j && stepById(j, stepId)
  if (!j || !s || s.type !== "human") return noop(`"${jobId}/${stepId}" is not a human gate`)

  const entry = enterStep(w, state, jobId, nextStep(j, s))
  return tx(entry.decisions as Decision[], mp(
    { status: "running", jobs: { [jobId]: { steps: { [stepId]: { status: "succeeded" } } } } },
    entry.patch,
  ))
}

function onHumanRejected(w: WorkflowDef, state: FeatureState, jobId: string, stepId: string): Transition {
  const js = state.jobs[jobId]
  if (!js || js.currentStep !== stepId) return noop(`no pending rejection for "${jobId}/${stepId}"`)
  const j = jobById(w, jobId)
  const s = j && stepById(j, stepId)
  if (!j || !s) return tx([{ kind: "escalate", reason: `unknown step "${jobId}/${stepId}"` }], { status: "escalated" })

  if (s.on_reject?.goto !== undefined) {
    const entry = enterStep(w, state, jobId, s.on_reject.goto)
    return tx(entry.decisions as Decision[], mp(
      { status: "running", jobs: { [jobId]: { steps: { [stepId]: { status: "failed" } } } } },
      entry.patch,
    ))
  }

  return tx([{ kind: "escalate", reason: `human rejected at "${jobId}/${stepId}" (no on_reject)` }], { status: "escalated" })
}

function onResumed(w: WorkflowDef, state: FeatureState): Transition {
  if (state.status !== "paused" && state.status !== "escalated")
    return noop("feature is not paused or escalated")

  const decisions: Decision[] = []
  const jp: Record<string, JobPatch> = {}

  for (const [jid, js] of Object.entries(state.jobs)) {
    if (js.status !== "running" || js.currentStep === null) continue
    const j = jobById(w, jid)
    if (!j) { decisions.push({ kind: "escalate", reason: `job "${jid}" no longer exists` }); continue }
    const s = stepById(j, js.currentStep)
    if (!s) { decisions.push({ kind: "escalate", reason: `step "${js.currentStep}" no longer exists` }); continue }

    const reset: JobPatch = state.status === "escalated"
      ? { attempts: { ...js.attempts, [js.currentStep]: 0 }, rounds: { ...js.rounds, [js.currentStep]: 0 } }
      : {}

    if (s.type === "human") {
      decisions.push({ kind: "wait_human", jobId: jid, stepId: s.id })
      jp[jid] = { ...reset, steps: { [s.id]: { status: "waiting_human" } } }
    } else {
      decisions.push({ kind: "execute_step", jobId: jid, stepId: s.id })
      jp[jid] = { ...reset, steps: { [s.id]: { status: "running" } } }
    }
  }

  if (decisions.length === 0) return onStart(w)
  return tx(decisions, { status: "running", jobs: jp })
}

// ---------------------------------------------------------------------------
// DAG: job completion
// ---------------------------------------------------------------------------

function onJobDone(w: WorkflowDef, state: FeatureState, done: string): Transition {
  const base: Patch = { jobs: { [done]: { status: "succeeded", currentStep: null } } }

  const decisions: Decision[] = []
  const dp: Record<string, JobPatch> = {}

  for (const [id, dj] of Object.entries(w.jobs)) {
    if (state.jobs[id]?.status !== "pending" || !dj.needs?.includes(done)) continue
    const needs = (dj.needs ?? []).map(n => n === done ? "succeeded" as const : (state.jobs[n]?.status ?? "pending"))
    if (!needs.every(s => s === "succeeded" || s === "failed" || s === "skipped")) continue

    const ok = needs.every(s => s === "succeeded")
    if (!ok && dj.if !== "always()" && dj.if !== "failure()") {
      decisions.push({ kind: "skip_job", jobId: id, reason: "dependency failed" })
      dp[id] = { status: "skipped", currentStep: null }
      continue
    }

    const sid = firstStep(dj)
    if (sid === null) { dp[id] = { status: "succeeded", currentStep: null }; continue }
    const s = stepById(dj, sid)!
    if (s.type === "human") {
      decisions.push({ kind: "wait_human", jobId: id, stepId: sid })
      dp[id] = { status: "running", currentStep: sid, steps: { [sid]: { status: "waiting_human" } } }
    } else {
      decisions.push({ kind: "execute_step", jobId: id, stepId: sid })
      dp[id] = { status: "running", currentStep: sid, steps: { [sid]: { status: "running" } } }
    }
  }

  const allDone = Object.keys(w.jobs).every(id =>
    id === done || dp[id]?.status === "skipped" ||
    ["succeeded", "failed", "skipped"].includes(state.jobs[id]?.status ?? "pending"),
  )

  if (allDone) return tx([{ kind: "finish" }], mp(base, mp({ jobs: dp }, { status: "done" })))
  if (decisions.length === 0) return tx([{ kind: "noop", reason: `job "${done}" done, no dependents ready` }], mp(base, { jobs: dp }))
  return tx(decisions, mp(base, { jobs: dp }))
}

// ---------------------------------------------------------------------------
// Patch merge
// ---------------------------------------------------------------------------

function mp(a: Patch, b: Patch): Patch {
  const r: { status?: FeatureStatus; jobs?: Record<string, JobPatch> } = {}
  if (a.status) r.status = a.status
  if (b.status) r.status = b.status
  if (a.jobs || b.jobs) {
    const m: Record<string, JobPatch> = {}
    for (const [k, v] of Object.entries(a.jobs ?? {})) m[k] = v
    for (const [k, v] of Object.entries(b.jobs ?? {}))
      m[k] = m[k] ? mjp(m[k]!, v) : v
    r.jobs = m
  }
  return r
}

function mjp(a: JobPatch, b: JobPatch): JobPatch {
  return {
    status: b.status ?? a.status,
    currentStep: b.currentStep ?? a.currentStep,
    attempts: b.attempts ?? a.attempts,
    rounds: b.rounds ?? a.rounds,
    steps: { ...a.steps, ...b.steps },
  }
}
