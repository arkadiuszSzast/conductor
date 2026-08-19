/**
 * Start-work form state/commands — the sheet's logic, split out so the
 * component only renders. Mirrors `use-gate-actions.ts`'s split between
 * hook (state/commands) and component (markup).
 *
 * Target derivation reads daemon health plus the selected project's own
 * workflow projection (`targets.ts`); health is refreshed once on open
 * (design.md "On open, health is refreshed"). Two distinct triggers can
 * change the resolved target's input definitions, and each uses a
 * different reconciliation strategy against the draft (see `form.ts`'s
 * module doc for the full rationale):
 *
 *  - an EXPLICIT `selectTarget` call (the operator picked a different
 *    project, or the previous selection disappeared) wholesale-resets
 *    the workflow-input drafts (`resetInputsForTarget`) — a genuinely
 *    different target's inputs share no meaning with the old ones.
 *  - the SAME target's workflow projection changing underneath the form
 *    (a `refetchWorkflow` after a configuration-race rejection, or any
 *    other refresh that lands while the same `projectDir` stays
 *    selected) reconciles instead (`reconcileInputsForRefresh`) —
 *    same-name/same-type values survive, only truly incompatible ones
 *    are reseeded.
 *
 * Submission is non-optimistic: `startFeature` is the store's
 * authoritative creation mutation, and success is reported through
 * `onSuccess(featureId)` so the caller (the sheet) can close and
 * navigate without this hook knowing about routing.
 */

import { useEffect, useMemo, useRef, useState } from "react"
import { useApp } from "../app-context.ts"
import { useHealth, useStartFeature, useWorkflow } from "../api/hooks.ts"
import {
  deriveDiscoveryState,
  deriveStartTargets,
  deriveSubmitGate,
  resolveSelectedProjectDir,
  resolveTarget,
  runnerUnavailable,
  type ResolvedTarget,
  type StartTarget,
  type TargetDiscoveryState,
} from "./targets.ts"
import {
  EMPTY_START_FORM_DRAFT,
  NO_FIELDS_TOUCHED,
  NO_FIELD_ERRORS,
  hasFieldErrors,
  reconcileInputsForRefresh,
  reconcileServerErrorsForRefresh,
  reconcileTouchedForRefresh,
  resetInputsForTarget,
  touchAll,
  validateStartForm,
  visibleFieldErrors,
  type InputDraftValue,
  type StartFormDraft,
  type StartFormFieldErrors,
  type StartFormTouched,
} from "./form.ts"
import { mapStartFeatureError } from "./errors.ts"
import type { InputDef } from "../api/types.ts"

export interface UseStartWorkFormOptions {
  readonly onSuccess: (featureId: string) => void
}

export interface UseStartWorkFormResult {
  readonly targets: readonly StartTarget[]
  readonly discovery: TargetDiscoveryState
  readonly requiresSelection: boolean
  readonly selectedProjectDir: string | null
  readonly selectTarget: (projectDir: string) => void
  readonly resolved: ResolvedTarget | null
  readonly runnerWarning: boolean
  readonly draft: StartFormDraft
  readonly setTitle: (value: string) => void
  readonly setDescription: (value: string) => void
  readonly setPr: (value: string) => void
  readonly setInputValue: (name: string, value: InputDraftValue) => void
  /** Live client-validation errors gated by touched/submission-attempt
   *  state (`form.ts`'s `visibleFieldErrors`) merged with any still-live
   *  server-reported error — never a raw, always-on validation result, so
   *  an untouched, never-submitted field is never shown as invalid the
   *  instant the sheet opens; but once shown (touched, or after a
   *  blocked submit attempt) recomputes fresh from the CURRENT draft on
   *  every render, so correcting a value clears its own error without
   *  requiring another submit attempt. */
  readonly errors: StartFormFieldErrors
  readonly inlineError: string | null
  readonly pending: boolean
  /** Whether `submit()` would currently do anything — the single source
   *  of truth for the sheet's submit-button `disabled` state. */
  readonly canSubmit: boolean
  /** Human-readable reason submission is blocked, or null when it is not
   *  (also null while merely `pending`, which has its own label). */
  readonly blockedReason: string | null
  readonly submit: () => Promise<void>
  /**
   * Explicit recovery action for `resolved.canRetryWorkflow` — force-
   * refetches the SELECTED target's workflow projection. A no-op with
   * no selected project. The only mechanism a caller needs for recovery
   * (the hook's own bounded auto-retry-once on mount/reselection is a
   * convenience, not a substitute — an operator can always retry again
   * explicitly, including after the bounded auto-retry has already
   * fired and failed again for the current target). Never loops on its
   * own: each call issues exactly one forced fetch attempt
   * (`DataSource.refetchWorkflow` does not apply the store's bounded
   * internal retry chain to forced calls), and nothing here re-invokes
   * it automatically on failure.
   */
  readonly retryWorkflow: () => void
}

export function useStartWorkForm({ onSuccess }: UseStartWorkFormOptions): UseStartWorkFormResult {
  const { store } = useApp()
  const healthState = useHealth(store)
  const startFeature = useStartFeature(store)

  // Health is refreshed once per sheet instance so target eligibility
  // reflects the daemon's current view, not whatever was last polled
  // (design.md "On open, health is refreshed"). `useHealth` below already
  // triggers the resource's FIRST-EVER load via `ensureHealthLoaded`
  // (load-once semantics, and its `useEffect` fires before this one:
  // hooks run their effects in call order) — unconditionally force-
  // refreshing here as well would fire a SECOND, concurrent GET
  // /v1/health racing the one `ensureHealthLoaded` just started on a
  // fresh standalone sheet (a mounted test caught exactly this: 2
  // requests on first mount instead of 1). The condition below is
  // therefore "health has already SETTLED from some earlier attempt,
  // successful or not" — `status !== "loading"` — rather than merely
  // `data !== null`: a settled `error` (including one that never had
  // data, e.g. the very first health load failed before this sheet ever
  // opened) must also force a fresh retry on open/reopen, or reopening
  // the sheet after an initial health failure would leave the operator
  // stuck on a permanent error with no way back in. `status === "loading"`
  // still correctly skips the force in both directions it needs to:
  // "never requested yet" (nothing to race, `ensureHealthLoaded` above
  // just started the only in-flight request) and "currently loading"
  // (a force here would race that same in-flight request).
  useEffect(() => {
    if (store.getHealth().status !== "loading") store.refreshHealth()
    // Intentionally once per mount — the sheet is a fresh instance each
    // time it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const targets = useMemo(() => deriveStartTargets(healthState.data), [healthState.data])
  const discovery = useMemo(() => deriveDiscoveryState(healthState), [healthState])
  const [selectedProjectDirState, setSelectedProjectDirState] = useState<string | null>(null)
  const selectedProjectDir = resolveSelectedProjectDir(targets, selectedProjectDirState)
  if (selectedProjectDir !== selectedProjectDirState) setSelectedProjectDirState(selectedProjectDir)

  const selectedTargetSummary = targets.find(t => t.projectDir === selectedProjectDir) ?? null
  // No workflow fetch for an invalid/unregistered target — its
  // "unavailable" diagnostics already come from health, and the project
  // has no valid snapshot to serve anyway.
  const workflowDir = selectedTargetSummary?.selectable === true ? selectedTargetSummary.projectDir : ""
  const workflowState = useWorkflow(store, workflowDir)
  // The FULL resource state (status/data/error), not merely `data` — a
  // `data === null` alone cannot distinguish "still loading" from "the
  // initial fetch itself failed", and a non-null `data` alone cannot
  // distinguish a successful load from a cached projection kept after a
  // failed REFRESH (module doc on `resolveTarget`).
  const resolved = useMemo(
    () =>
      resolveTarget(
        selectedTargetSummary,
        workflowDir !== "" ? { status: workflowState.status, data: workflowState.data, error: workflowState.error } : null,
      ),
    [selectedTargetSummary, workflowDir, workflowState.status, workflowState.data, workflowState.error],
  )

  const retryWorkflow = (): void => {
    if (selectedProjectDir !== null) store.refetchWorkflow(selectedProjectDir)
  }

  // Bounded auto-retry-once, per project selection — a convenience on
  // top of the always-available EXPLICIT `retryWorkflow` above, never a
  // substitute for it. Tracks which `projectDir`s have already gotten
  // their one automatic attempt in THIS hook instance (a fresh instance,
  // and therefore a fresh empty set, is created every time the sheet
  // remounts — reopening the sheet already resets this for free).
  // `selectTarget` below additionally clears an incoming target's own
  // entry so explicitly RESELECTING a previously-failed target also
  // gets a fresh automatic attempt. Cannot loop: the effect only acts
  // the first time it observes `canRetryWorkflow: true` for a given
  // `projectDir` — a retry that fails again re-renders with
  // `canRetryWorkflow: true` still true, but the ref already marks that
  // `projectDir` as spent, so the effect is a no-op on that later run.
  const autoRetriedRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (resolved === null || !resolved.canRetryWorkflow) return
    if (autoRetriedRef.current.has(resolved.projectDir)) return
    autoRetriedRef.current.add(resolved.projectDir)
    store.refetchWorkflow(resolved.projectDir)
  }, [resolved, store])

  const [draft, setDraft] = useState<StartFormDraft>(EMPTY_START_FORM_DRAFT)
  // SERVER-reported per-input errors only (from a 422 rejection's
  // diagnostics) — kept separate from the LIVE client-validation result
  // (recomputed below on every render from `draft`) so a value the
  // operator has since corrected can drop its client error immediately
  // while the server's diagnostic for that exact field is cleared
  // explicitly (on edit, refresh reconciliation, or target switch) per
  // `form.ts`'s module doc, rather than the two being conflated in one
  // "errors" bucket that a stale live recompute could silently paper
  // over or a corrected value could leave stuck.
  const [serverErrors, setServerErrors] = useState<StartFormFieldErrors>(NO_FIELD_ERRORS)
  const [touched, setTouched] = useState<StartFormTouched>(NO_FIELDS_TOUCHED)
  const [submitAttempted, setSubmitAttempted] = useState(false)
  const [inlineError, setInlineError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  // Tracks the target the draft's inputs were last seeded/reconciled
  // against, so a re-render can tell an EXPLICIT switch (`projectDir`
  // itself changed) apart from a SAME-target metadata refresh (only
  // `resolved.inputs`/`workflowName` changed underneath the same
  // `projectDir`) and apply the right reconciliation strategy (module
  // doc).
  const lastTargetRef = useRef<{ projectDir: string; inputs: Readonly<Record<string, InputDef>> } | null>(null)
  if (resolved !== null && resolved.submittable) {
    const last = lastTargetRef.current
    const sameProject = last !== null && last.projectDir === resolved.projectDir
    const inputsChanged = last === null || last.inputs !== resolved.inputs
    if (inputsChanged) {
      if (sameProject) {
        // Same target, metadata refreshed underneath it — reconcile,
        // don't discard (e.g. `unknown_workflow` → `refetchWorkflow`).
        // Every reconciled piece of state (draft values, server-reported
        // errors, touched flags) uses the SAME same-name/type-compatible
        // test, so a reseeded/removed/type-changed input's stale server
        // error and stale touched flag never survive a schema refresh
        // that already discarded its value.
        setDraft(prev => reconcileInputsForRefresh(prev, last.inputs, resolved.inputs))
        setServerErrors(prev => reconcileServerErrorsForRefresh(prev, last.inputs, resolved.inputs))
        setTouched(prev => reconcileTouchedForRefresh(prev, last.inputs, resolved.inputs))
      } else {
        // A genuinely different target (or the very first resolution).
        setDraft(prev => resetInputsForTarget(prev, resolved.inputs))
        setServerErrors(prev => ({ ...(prev.title !== undefined ? { title: prev.title } : {}), ...(prev.pr !== undefined ? { pr: prev.pr } : {}), inputs: {} }))
        setTouched(prev => ({ ...prev, inputs: {} }))
      }
      lastTargetRef.current = { projectDir: resolved.projectDir, inputs: resolved.inputs }
    }
  }

  // An EXPLICIT target switch clears target-specific errors (per-input
  // errors, and the inline server error — both meaningless once the
  // target itself changed) immediately, without waiting for the new
  // target's workflow projection to resolve, but preserves feature-level
  // field errors (title/pr) since those describe THIS draft, not the
  // old target (spec: "Clear/reconcile target-specific server/input
  // errors on explicit switch without losing feature-level fields").
  const selectTarget = (projectDir: string): void => {
    if (projectDir === selectedProjectDir) return
    lastTargetRef.current = null
    setServerErrors(prev => ({ ...(prev.title !== undefined ? { title: prev.title } : {}), ...(prev.pr !== undefined ? { pr: prev.pr } : {}), inputs: {} }))
    setTouched(prev => ({ ...prev, inputs: {} }))
    // A prior submit attempt's "show everything" no longer applies to
    // the NEW target's not-yet-seen input fields — otherwise an
    // untouched, freshly-rendered required input would immediately show
    // an error the operator never had a chance to react to yet.
    setSubmitAttempted(false)
    setInlineError(null)
    // Re-selecting a target that previously exhausted its bounded
    // auto-retry gets a fresh one — the operator explicitly chose to
    // come back to it (spec: "bounded... on remount/reselection").
    autoRetriedRef.current.delete(projectDir)
    setSelectedProjectDirState(projectDir)
  }

  const setTitle = (value: string): void => {
    setDraft(prev => ({ ...prev, title: value }))
    setTouched(prev => (prev.title ? prev : { ...prev, title: true }))
    // The operator is actively correcting the title — a stale SERVER
    // diagnostic for the old value no longer describes this one.
    setServerErrors(prev => (prev.title === undefined ? prev : { ...prev, title: undefined }))
  }
  const setDescription = (value: string): void => setDraft(prev => ({ ...prev, description: value }))
  const setPr = (value: string): void => {
    setDraft(prev => ({ ...prev, pr: value }))
    setTouched(prev => (prev.pr ? prev : { ...prev, pr: true }))
    setServerErrors(prev => (prev.pr === undefined ? prev : { ...prev, pr: undefined }))
  }
  const setInputValue = (name: string, value: InputDraftValue): void => {
    setDraft(prev => ({ ...prev, inputs: { ...prev.inputs, [name]: value } }))
    setTouched(prev => (prev.inputs[name] === true ? prev : { ...prev, inputs: { ...prev.inputs, [name]: true } }))
    // Reconcile a stale SERVER-reported error for this exact input the
    // moment its value changes — the operator has started correcting
    // it, so a diagnostic against the PREVIOUS value must not linger
    // (spec: "Correcting title/PR/input must clear/recompute stale
    // client errors" and "reconcile stale server input errors after
    // value correction").
    setServerErrors(prev => {
      if (prev.inputs[name] === undefined) return prev
      const inputs = { ...prev.inputs }
      delete inputs[name]
      return { ...prev, inputs }
    })
  }

  // Live re-check against the CURRENT draft on every render — never
  // memoized against a past attempt, so `canSubmit` and the visible
  // errors below both track the operator's most recent edit.
  const liveValidation = resolved !== null && resolved.submittable ? validateStartForm(draft, resolved.inputs) : null
  const liveErrors: StartFormFieldErrors = liveValidation !== null && !liveValidation.ok ? liveValidation.errors : NO_FIELD_ERRORS
  const formValid = liveValidation !== null && liveValidation.ok
  // What is actually shown: a live client problem only once its field is
  // touched or a submit attempt has been made (never "highlighted
  // fields" with nothing highlighted); a server diagnostic is always
  // shown once present. See `form.ts`'s `visibleFieldErrors` doc.
  const errors = visibleFieldErrors(liveErrors, serverErrors, touched, submitAttempted)
  // Whether the gate can honestly say "fix the highlighted fields" right
  // now — if the draft is invalid but nothing is touched/submitted yet,
  // `errors` above is empty and the gate must say something else
  // instead (spec: never claim fields are highlighted when none are).
  const gate = deriveSubmitGate({ pending, discovery, resolved, formValid, hasVisibleErrors: hasFieldErrors(errors) })

  const submit = async (): Promise<void> => {
    if (pending) return
    if (resolved === null || !resolved.submittable || resolved.workflowName === null) {
      setInlineError("select a project to start work in")
      return
    }
    const result = validateStartForm(draft, resolved.inputs)
    if (!result.ok) {
      // A blocked submit attempt makes every offending field's client
      // error visible immediately, even one the operator never touched
      // — otherwise `canSubmit` would report false with no highlighted
      // field to explain why.
      setSubmitAttempted(true)
      setTouched(touchAll(resolved.inputs))
      return
    }
    setServerErrors(NO_FIELD_ERRORS)
    setSubmitAttempted(false)
    setInlineError(null)
    setPending(true)
    try {
      const response = await startFeature({
        title: result.value.title,
        project: resolved.projectDir,
        workflow: resolved.workflowName,
        ...(result.value.description !== undefined ? { description: result.value.description } : {}),
        ...(result.value.pr !== undefined ? { pr: result.value.pr } : {}),
        inputs: result.value.inputs,
      })
      onSuccess(response.feature.id)
    } catch (err) {
      const handled = mapStartFeatureError(err)
      setInlineError(handled.message)
      if (Object.keys(handled.inputErrors).length > 0) {
        setServerErrors(prev => ({ ...prev, inputs: { ...prev.inputs, ...handled.inputErrors } }))
      }
      if (handled.refreshTarget && selectedProjectDir !== null) {
        store.refetchWorkflow(selectedProjectDir)
      }
    } finally {
      setPending(false)
    }
  }

  return {
    targets,
    discovery,
    requiresSelection: targets.filter(t => t.selectable).length > 1,
    selectedProjectDir,
    selectTarget,
    resolved,
    runnerWarning: runnerUnavailable(healthState.data),
    draft,
    setTitle,
    setDescription,
    setPr,
    setInputValue,
    errors,
    inlineError,
    pending,
    canSubmit: gate.canSubmit,
    blockedReason: gate.blockedReason,
    submit,
    retryWorkflow,
  }
}
