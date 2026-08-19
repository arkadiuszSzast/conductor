/**
 * Start-work form model — pure, DOM-free typed validation/serialization.
 *
 * Draft state keeps every field as an editable string except booleans
 * (a real checkbox state) — in particular a number input's draft is text,
 * not a number, so "nothing typed yet" is representable and distinct from
 * `0` (design.md "Keep an explicit unset state in the form, convert only
 * on validation"). `validateStartForm` is the single place raw drafts
 * become the typed `string | number | boolean` map the daemon expects;
 * it never trusts the browser's own number-input coercion.
 *
 * Two distinct reset strategies exist for when a target's input
 * definitions change underneath the form, and callers (`use-start-work-
 * form.ts`) must pick the right one:
 *
 *  - `resetInputsForTarget` — an EXPLICIT operator target switch (or the
 *    form silently landing on a different project because the previous
 *    selection disappeared). A genuinely different project's inputs share
 *    no meaning with the old ones, so this wholesale-replaces the input
 *    drafts with fresh defaults (spec "Switching targets replaces
 *    workflow-specific fields").
 *  - `reconcileInputsForRefresh` — a SAME-project metadata refresh (e.g.
 *    `refetchWorkflow` after a `unknown_workflow`/`invalid_input`
 *    configuration-race rejection). The operator's already-entered values
 *    are still meaningful here and must survive: a same-named input whose
 *    declared type did not change keeps its entered value; only inputs
 *    that are new, removed, or changed type are reseeded/dropped. This is
 *    what keeps a workflow *rename* (name changes, `feature` input stays
 *    a required string) from silently wiping a title/description/pr-
 *    adjacent draft the operator was mid-filling.
 *
 * Visible validation errors are TOUCHED/SUBMISSION-ATTEMPT gated
 * (`visibleFieldErrors`), never raw: a field's live validation problem
 * (computed fresh from the current draft on every render) only becomes
 * VISIBLE once the operator has touched that specific field or has
 * attempted a submit at least once. This keeps the surface from yelling
 * "required" at an untouched field the instant the sheet opens, while
 * still guaranteeing `use-start-work-form.ts` never reports a blocked
 * submit as "fix the highlighted fields" when nothing is actually
 * highlighted yet (spec: "never leave submit disabled with 'highlighted
 * fields' and no highlights"). A SERVER-reported error (`serverErrors`,
 * set only from a 422 rejection's per-input diagnostics) is always
 * visible immediately — the operator already tried to submit — and
 * takes precedence over a live client error for the same field until it
 * is reconciled away (`staleServerInputErrorNames`) by: the operator
 * editing that exact field again (the caller clears it directly), a
 * same-target schema refresh that reseeds/removes that input, or an
 * explicit target switch (the caller wholesale-clears `inputs`).
 */

import type { InputDef } from "../api/types.ts"

export type InputDraftValue = string | boolean

export interface StartFormDraft {
  readonly title: string
  readonly description: string
  /** Raw text; "" means unset (no PR attached), not "PR 0". */
  readonly pr: string
  readonly inputs: Readonly<Record<string, InputDraftValue>>
}

export const EMPTY_START_FORM_DRAFT: StartFormDraft = { title: "", description: "", pr: "", inputs: {} }

/** Draft values for one workflow's inputs: booleans/defaulted values seed
 *  from their declared default (numbers/strings as display text); a
 *  required input with no default starts unset. */
export function initialInputDraft(defs: Readonly<Record<string, InputDef>>): Readonly<Record<string, InputDraftValue>> {
  const draft: Record<string, InputDraftValue> = {}
  for (const [name, def] of Object.entries(defs)) {
    if (def.type === "boolean") {
      draft[name] = def.presence === "optional" ? Boolean(def.default) : false
    } else {
      draft[name] = def.presence === "optional" ? String(def.default) : ""
    }
  }
  return draft
}

/** Target switch resets ONLY the workflow-input drafts — feature-level
 *  title/description/pr survive (design.md, spec "Switching targets
 *  replaces workflow-specific fields"). */
export function resetInputsForTarget(draft: StartFormDraft, defs: Readonly<Record<string, InputDef>>): StartFormDraft {
  return { ...draft, inputs: initialInputDraft(defs) }
}

/** Two `InputDef`s are compatible enough to keep an operator-entered
 *  value across a metadata refresh when they declare the same `type` —
 *  a change in `presence`/`default` alone does not invalidate whatever
 *  the operator already typed (the value itself is still the right
 *  shape; required-ness is re-checked at submit time regardless). */
function inputDefCompatible(prev: InputDef, next: InputDef): boolean {
  return prev.type === next.type
}

/**
 * Reconcile workflow-input drafts against a REFRESHED definition set for
 * the SAME target (never a target switch — see module doc). Preserves
 * every same-name, type-compatible entered value as-is; seeds an added
 * input from its default/unset; silently drops a removed input's draft
 * value. Never throws the whole draft away for a metadata edit the
 * operator did not cause (e.g. a workflow rename discovered via
 * `refetchWorkflow` after `unknown_workflow`).
 */
export function reconcileInputsForRefresh(
  draft: StartFormDraft,
  prevDefs: Readonly<Record<string, InputDef>>,
  nextDefs: Readonly<Record<string, InputDef>>,
): StartFormDraft {
  const nextInputs: Record<string, InputDraftValue> = {}
  for (const [name, def] of Object.entries(nextDefs)) {
    const prevDef = prevDefs[name]
    const current = draft.inputs[name]
    if (prevDef !== undefined && inputDefCompatible(prevDef, def) && current !== undefined) {
      nextInputs[name] = current
      continue
    }
    // New input, or same name with an incompatible type change — seed
    // fresh rather than carry over a value that no longer matches.
    const seeded = initialInputDraft({ [name]: def })
    nextInputs[name] = seeded[name]!
  }
  return { ...draft, inputs: nextInputs }
}

/**
 * Reconcile SERVER-reported per-input errors (from a prior 422 rejection)
 * against a REFRESHED definition set for the SAME target, using the
 * exact same same-name/type-compatible test `reconcileInputsForRefresh`
 * applies to the draft values themselves. A server error for an input
 * that was reseeded (new, removed, or type-changed) describes a value
 * that no longer exists in this shape, so it is dropped rather than
 * left dangling on a field the operator can no longer see/edit the way
 * it was reported against. A server error for a still-compatible input
 * is kept — the operator has not corrected that value yet, so the
 * daemon's diagnostic is still the most relevant thing to show until
 * either the value changes (`use-start-work-form.ts` clears it directly
 * on edit) or this same reconciliation runs again.
 */
export function reconcileServerErrorsForRefresh(
  serverErrors: StartFormFieldErrors,
  prevDefs: Readonly<Record<string, InputDef>>,
  nextDefs: Readonly<Record<string, InputDef>>,
): StartFormFieldErrors {
  const inputs: Record<string, string> = {}
  for (const [name, message] of Object.entries(serverErrors.inputs)) {
    const prevDef = prevDefs[name]
    const nextDef = nextDefs[name]
    if (prevDef !== undefined && nextDef !== undefined && inputDefCompatible(prevDef, nextDef)) {
      inputs[name] = message
    }
  }
  return { ...(serverErrors.title !== undefined ? { title: serverErrors.title } : {}), ...(serverErrors.pr !== undefined ? { pr: serverErrors.pr } : {}), inputs }
}

/** Reconcile `StartFormTouched.inputs` the same way — a touched flag for
 *  an input that was reseeded by a refresh (new/removed/type-changed)
 *  no longer describes anything meaningful; a touched flag for a
 *  compatible input survives so its live error, if any, stays visible
 *  rather than silently hiding again after a metadata refresh the
 *  operator did not initiate. */
export function reconcileTouchedForRefresh(
  touched: StartFormTouched,
  prevDefs: Readonly<Record<string, InputDef>>,
  nextDefs: Readonly<Record<string, InputDef>>,
): StartFormTouched {
  const inputs: Record<string, boolean> = {}
  for (const name of Object.keys(nextDefs)) {
    const prevDef = prevDefs[name]
    const nextDef = nextDefs[name]!
    if (prevDef !== undefined && inputDefCompatible(prevDef, nextDef) && touched.inputs[name] === true) {
      inputs[name] = true
    }
  }
  return { title: touched.title, pr: touched.pr, inputs }
}

export interface StartFormFieldErrors {
  readonly title?: string
  readonly pr?: string
  readonly inputs: Readonly<Record<string, string>>
}

export function hasFieldErrors(errors: StartFormFieldErrors): boolean {
  return errors.title !== undefined || errors.pr !== undefined || Object.keys(errors.inputs).length > 0
}

export const NO_FIELD_ERRORS: StartFormFieldErrors = { inputs: {} }

/** Which fields the operator has interacted with (or a submit attempt
 *  was already made for) — the gate for whether a LIVE client-validation
 *  problem is shown, so an untouched, never-submitted field never shows
 *  a "required" error the instant the sheet opens (spec-adjacent:
 *  "provide immediate actionable client validation" without noise). A
 *  named input's touched state is tracked separately from `title`/`pr`
 *  since each has its own control. */
export interface StartFormTouched {
  readonly title: boolean
  readonly pr: boolean
  readonly inputs: Readonly<Record<string, boolean>>
}

export const NO_FIELDS_TOUCHED: StartFormTouched = { title: false, pr: false, inputs: {} }

/** Every field touched — used once a submit attempt has been made
 *  (submit failing client validation counts as "touch everything", so a
 *  currently-invalid but never-focused field's error becomes visible at
 *  that point too; see `visibleFieldErrors`). */
export function touchAll(defs: Readonly<Record<string, InputDef>>): StartFormTouched {
  const inputs: Record<string, boolean> = {}
  for (const name of Object.keys(defs)) inputs[name] = true
  return { title: true, pr: true, inputs }
}

/**
 * Compose the LIVE client-validation result (`liveErrors`, freshly
 * recomputed from the current draft on every call — never memoized
 * against a stale attempt) with `touched`/`submitAttempted` gating and
 * any still-live SERVER-reported error, to produce exactly what should
 * be visibly shown right now:
 *
 *  - a field's live client error is shown once that field is `touched`
 *    OR `submitAttempted` is true (spec: never leave submit disabled
 *    with "highlighted fields" and no highlights — once submit is
 *    blocked on validation, every offending field must already be
 *    visible, which requires having attempted submit at least once to
 *    reach that blocked state in the first place);
 *  - a SERVER error for a field is shown whenever present in
 *    `serverErrors`, REGARDLESS of touched state (the operator already
 *    submitted; the daemon's diagnostic is unconditionally relevant)
 *    and takes precedence over a live client error for the same field —
 *    correcting the value clears the client problem but the server
 *    error for that exact input name must ALSO be dropped by the
 *    caller (`use-start-work-form.ts`) the moment its value changes, so
 *    a fixed field does not keep showing a diagnostic for the old value;
 *  - title/pr behave the same way via their own dedicated slots.
 */
export function visibleFieldErrors(
  liveErrors: StartFormFieldErrors,
  serverErrors: StartFormFieldErrors,
  touched: StartFormTouched,
  submitAttempted: boolean,
): StartFormFieldErrors {
  const showTitle = touched.title || submitAttempted
  const showPr = touched.pr || submitAttempted
  const inputs: Record<string, string> = {}
  for (const [name, message] of Object.entries(liveErrors.inputs)) {
    if (touched.inputs[name] === true || submitAttempted) inputs[name] = message
  }
  for (const [name, message] of Object.entries(serverErrors.inputs)) inputs[name] = message
  return {
    ...(serverErrors.title !== undefined ? { title: serverErrors.title } : showTitle && liveErrors.title !== undefined ? { title: liveErrors.title } : {}),
    ...(serverErrors.pr !== undefined ? { pr: serverErrors.pr } : showPr && liveErrors.pr !== undefined ? { pr: liveErrors.pr } : {}),
    inputs,
  }
}

export interface ValidatedStartForm {
  readonly title: string
  readonly description?: string
  readonly pr?: number
  readonly inputs: Readonly<Record<string, string | number | boolean>>
}

export type ValidateStartFormResult =
  | { readonly ok: true; readonly value: ValidatedStartForm }
  | { readonly ok: false; readonly errors: StartFormFieldErrors }

/**
 * Validate and serialize a draft against one workflow's declared inputs.
 * `defs` must be the SAME target the draft's `inputs` were seeded from —
 * callers own keeping the two in sync (`resetInputsForTarget` on target
 * switch). Required title; optional multiline description (trimmed to
 * `undefined` when blank); optional positive-integer PR; typed workflow
 * inputs with defaults applied for omitted optional values and a
 * non-finite/empty number rejected rather than silently coerced.
 */
export function validateStartForm(draft: StartFormDraft, defs: Readonly<Record<string, InputDef>>): ValidateStartFormResult {
  const inputErrors: Record<string, string> = {}
  const title = draft.title.trim()
  const titleError = title === "" ? "a title is required" : undefined

  let pr: number | undefined
  let prError: string | undefined
  const prRaw = draft.pr.trim()
  if (prRaw !== "") {
    const parsed = Number(prRaw)
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
      prError = "pull request number must be a positive integer"
    } else {
      pr = parsed
    }
  }

  const inputs: Record<string, string | number | boolean> = {}
  for (const name of Object.keys(defs).sort()) {
    const def = defs[name]!
    const raw = draft.inputs[name]
    if (def.type === "boolean") {
      inputs[name] = typeof raw === "boolean" ? raw : def.presence === "optional" ? def.default : false
      continue
    }
    if (def.type === "number") {
      const text = typeof raw === "string" ? raw.trim() : ""
      if (text === "") {
        if (def.presence === "required") {
          inputErrors[name] = `"${name}" is required`
        } else {
          inputs[name] = def.default
        }
        continue
      }
      const parsed = Number(text)
      if (!Number.isFinite(parsed)) {
        inputErrors[name] = `"${name}" must be a finite number`
        continue
      }
      inputs[name] = parsed
      continue
    }
    // string
    const text = typeof raw === "string" ? raw : ""
    if (def.presence === "required" && text.trim() === "") {
      inputErrors[name] = `"${name}" is required`
      continue
    }
    inputs[name] = text
  }

  const errors: StartFormFieldErrors = {
    ...(titleError !== undefined ? { title: titleError } : {}),
    ...(prError !== undefined ? { pr: prError } : {}),
    inputs: inputErrors,
  }
  if (hasFieldErrors(errors)) return { ok: false, errors }

  const description = draft.description.trim()
  return {
    ok: true,
    value: {
      title,
      ...(description !== "" ? { description } : {}),
      ...(pr !== undefined ? { pr } : {}),
      inputs,
    },
  }
}
