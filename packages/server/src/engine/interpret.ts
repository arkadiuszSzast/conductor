/**
 * The pipeline interpreter — a pure function.
 *
 *   (pipeline definition, feature state, event) → transition
 *
 * No I/O, no clock, no randomness. `Engine` owns all side effects;
 * this module owns ALL routing decisions, ported unchanged from
 * opencode-conductor's `src/pipeline/interpret.ts`. Kept pure so every
 * pipeline shape is unit-testable without a database, a git repo, or an
 * LLM.
 */

import type {
  Decision,
  FeatureState,
  PipelineEvent,
  Transition,
} from "../store.ts"
import type { AgentStep, PipelineDef, StepDef } from "./types.ts"

const DEFAULT_MAX_ATTEMPTS = 1
const DEFAULT_MAX_ROUNDS = 3

export function interpret(
  def: PipelineDef,
  state: FeatureState,
  event: PipelineEvent,
): Transition {
  switch (event.kind) {
    case "feature.start":
      return enter(def, state, firstRunnableStep(def))
    case "step.succeeded":
      return onSucceeded(def, state, event.stepId)
    case "step.failed":
      return onFailed(def, state, event.stepId, event.reason)
    case "step.verdict":
      return onVerdict(def, state, event.stepId, event.verdict)
    case "human.approved":
      return onHumanApproved(state, event.stepId)
    case "human.rejected":
      return onHumanRejected(def, state, event.stepId)
    case "human.paused":
      return { decision: { kind: "pause" }, patch: { status: "paused" } }
    case "human.resumed":
      return onResumed(def, state)
    case "human.abandoned":
      return { decision: { kind: "abandon" }, patch: { status: "abandoned" } }
  }
}

// ---------------------------------------------------------------------------

function stepById(def: PipelineDef, id: string): StepDef | undefined {
  return def.pipeline.find(s => s.id === id)
}

function stepIndex(def: PipelineDef, id: string): number {
  return def.pipeline.findIndex(s => s.id === id)
}

function firstRunnableStep(def: PipelineDef): string | null {
  return def.pipeline[0]?.id ?? null
}

function nextStepId(def: PipelineDef, current: StepDef): string | null {
  if (current.then !== undefined) return current.then
  // A rounds_with partner (the fix step of a review loop) is not part of
  // the linear flow — entering it only makes sense via an explicit goto.
  const skip = current.type === "agent" ? current.rounds_with : undefined
  const idx = stepIndex(def, current.id)
  for (let i = idx + 1; i < def.pipeline.length; i++) {
    const candidate = def.pipeline[i]
    if (candidate && candidate.id !== skip) return candidate.id
  }
  return null
}

/** Enter a step (or finish when there is none left). */
function enter(def: PipelineDef, state: FeatureState, stepId: string | null): Transition {
  if (stepId === null) {
    return { decision: { kind: "finish" }, patch: { status: "done", currentStep: null } }
  }
  const step = stepById(def, stepId)
  if (!step) {
    return {
      decision: { kind: "escalate", reason: `unknown step "${stepId}"` },
      patch: { status: "escalated" },
    }
  }
  if (step.requires_human === true && state.status !== "waiting_human") {
    return {
      decision: { kind: "wait_human", stepId },
      patch: { status: "waiting_human", currentStep: stepId },
    }
  }
  return {
    decision: { kind: "execute", stepId },
    patch: { status: "running", currentStep: stepId },
  }
}

function onSucceeded(def: PipelineDef, state: FeatureState, stepId: string): Transition {
  const step = stepById(def, stepId)
  if (!step) {
    return {
      decision: { kind: "escalate", reason: `success reported for unknown step "${stepId}"` },
      patch: { status: "escalated" },
    }
  }
  if (state.currentStep !== stepId) {
    return {
      decision: { kind: "noop", reason: `stale success for "${stepId}" (current: ${state.currentStep})` },
      patch: {},
    }
  }
  return enter(def, state, nextStepId(def, step))
}

function onFailed(
  def: PipelineDef,
  state: FeatureState,
  stepId: string,
  reason: string,
): Transition {
  const step = stepById(def, stepId)
  if (!step) {
    return {
      decision: { kind: "escalate", reason: `failure reported for unknown step "${stepId}"` },
      patch: { status: "escalated" },
    }
  }
  if (state.currentStep !== stepId) {
    return {
      decision: { kind: "noop", reason: `stale failure for "${stepId}" (current: ${state.currentStep})` },
      patch: {},
    }
  }

  const attempts = (state.attempts[stepId] ?? 0) + 1
  const patchAttempts = { ...state.attempts, [stepId]: attempts }
  const onFail = step.on_fail

  if (onFail?.escalate === true) {
    return {
      decision: { kind: "escalate", reason: `step "${stepId}" failed: ${reason}` },
      patch: { status: "escalated", attempts: patchAttempts },
    }
  }

  const maxAttempts = onFail?.max_attempts ?? DEFAULT_MAX_ATTEMPTS
  if (attempts > maxAttempts) {
    return {
      decision: {
        kind: "escalate",
        reason: `step "${stepId}" exhausted ${maxAttempts} attempt(s): ${reason}`,
      },
      patch: { status: "escalated", attempts: patchAttempts },
    }
  }

  if (onFail?.goto !== undefined) {
    const target = enter(def, state, onFail.goto)
    return { decision: target.decision, patch: { ...target.patch, attempts: patchAttempts } }
  }

  // No goto: retry the same step.
  return {
    decision: { kind: "execute", stepId },
    patch: { status: "running", currentStep: stepId, attempts: patchAttempts },
  }
}

function onVerdict(
  def: PipelineDef,
  state: FeatureState,
  stepId: string,
  verdict: string,
): Transition {
  const step = stepById(def, stepId)
  if (!step || step.type !== "agent") {
    return {
      decision: { kind: "escalate", reason: `verdict "${verdict}" for non-agent step "${stepId}"` },
      patch: { status: "escalated" },
    }
  }
  if (state.currentStep !== stepId) {
    return {
      decision: { kind: "noop", reason: `stale verdict for "${stepId}" (current: ${state.currentStep})` },
      patch: {},
    }
  }

  // rounds_with loop accounting: each verdict on a rounds_with step
  // concludes one round.
  let rounds = state.rounds
  if (step.rounds_with !== undefined) {
    const done = (state.rounds[stepId] ?? 0) + 1
    rounds = { ...state.rounds, [stepId]: done }
    const maxRounds = step.max_rounds ?? DEFAULT_MAX_ROUNDS
    const route = step.on_verdict?.[verdict]
    const loopsBack = route?.goto !== undefined && route.goto === step.rounds_with
    if (loopsBack && done >= maxRounds) {
      return {
        decision: {
          kind: "escalate",
          reason: `step "${stepId}" reached ${maxRounds} round(s) without approval`,
        },
        patch: { status: "escalated", rounds },
      }
    }
  }

  const route = step.on_verdict?.[verdict]
  if (!route) {
    return {
      decision: {
        kind: "escalate",
        reason: `step "${stepId}" returned unmapped verdict "${verdict}"`,
      },
      patch: { status: "escalated", rounds },
    }
  }
  if (route.goto !== undefined) {
    const target = enter(def, state, route.goto)
    return { decision: target.decision, patch: { ...target.patch, rounds } }
  }
  // next: true
  const target = enter(def, state, nextStepId(def, step))
  return { decision: target.decision, patch: { ...target.patch, rounds } }
}

function onHumanApproved(state: FeatureState, stepId: string): Transition {
  if (state.status !== "waiting_human" || state.currentStep !== stepId) {
    return {
      decision: { kind: "noop", reason: `no pending human approval for "${stepId}"` },
      patch: {},
    }
  }
  return {
    decision: { kind: "execute", stepId },
    patch: { status: "running", currentStep: stepId },
  }
}

/**
 * Human rejected at a requires_human gate ("request changes"). Routes to
 * the step's on_reject.goto (e.g. back to the fix/review loop); the
 * engine stores the human's notes as the gate step's output BEFORE
 * dispatching, so downstream prompts can template them in. A gate
 * without on_reject escalates — rejection always has an effect.
 */
function onHumanRejected(def: PipelineDef, state: FeatureState, stepId: string): Transition {
  if (state.status !== "waiting_human" || state.currentStep !== stepId) {
    return {
      decision: { kind: "noop", reason: `no pending human approval for "${stepId}"` },
      patch: {},
    }
  }
  const step = stepById(def, stepId)
  if (!step) {
    return {
      decision: { kind: "escalate", reason: `rejection at unknown step "${stepId}"` },
      patch: { status: "escalated" },
    }
  }
  if (step.on_reject?.goto !== undefined) {
    return enter(def, state, step.on_reject.goto)
  }
  return {
    decision: { kind: "escalate", reason: `human rejected at "${stepId}" (no on_reject route)` },
    patch: { status: "escalated" },
  }
}

function onResumed(def: PipelineDef, state: FeatureState): Transition {
  if (state.status !== "paused" && state.status !== "escalated") {
    return { decision: { kind: "noop", reason: "feature is not paused or escalated" }, patch: {} }
  }
  // Resuming an ESCALATED feature is a human saying "try again": the
  // current step's attempt/round budget is spent (that is what escalated
  // it), so reset it — otherwise the first next failure re-escalates
  // immediately and the resume was pointless.
  const budgetReset =
    state.status === "escalated" && state.currentStep !== null
      ? {
          attempts: { ...state.attempts, [state.currentStep]: 0 },
          rounds: { ...state.rounds, [state.currentStep]: 0 },
        }
      : {}
  if (state.currentStep === null) {
    return enter(def, state, firstRunnableStep(def))
  }
  const step = stepById(def, state.currentStep)
  // The stored current step may no longer exist (pipeline definition
  // changed under a live feature). Escalate LOUDLY — a silent noop
  // soft-bricks the feature with no visible signal.
  if (!step) {
    return {
      decision: {
        kind: "escalate",
        reason: `current step "${state.currentStep}" no longer exists in the pipeline (config changed?) — fix the config or abandon the feature`,
      },
      patch: { status: "escalated" },
    }
  }
  if (step.requires_human === true) {
    return {
      decision: { kind: "wait_human", stepId: step.id },
      patch: { status: "waiting_human", ...budgetReset },
    }
  }
  return {
    decision: { kind: "execute", stepId: state.currentStep },
    patch: { status: "running", ...budgetReset },
  }
}

/** Convenience for tests and the engine: is this decision terminal? */
export function isTerminal(decision: Decision): boolean {
  return decision.kind === "finish" || decision.kind === "abandon" || decision.kind === "escalate"
}

export type { AgentStep }
