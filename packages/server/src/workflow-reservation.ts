import { resolveAction, validateActionInputs } from "@conductor/core"
import type { ActionManifest, ActionRegistry, WorkflowDef } from "@conductor/core"
import type { LoadedActionRegistry } from "./action-registry.ts"

export interface ResolvedActionBinding {
  readonly jobId: string
  readonly stepId: string
  readonly uses: string
  readonly manifest: ActionManifest
  readonly digest: string
  readonly sourcePath: string
}

export type ResolvedActionBindings = Readonly<Record<string, ResolvedActionBinding>>

export interface WorkflowReservationDiagnostic {
  readonly jobId: string
  readonly stepId: string
  readonly uses: string
  /** Full diagnostic — for an unresolved action, names every searched
   *  `sourcePath` and the daemon's configured registry search paths
   *  (both absolute, daemon-local filesystem paths). Operator/log use
   *  only; never forward to a browser-facing route. */
  readonly message: string
  /** The same diagnostic with every filesystem path omitted — still
   *  names the job/step/`uses` reference, the reason, and (for an
   *  unresolved action) the registry's available names/versions. An
   *  input-validation diagnostic (`validateActionInputs`) never
   *  contained a path to begin with, so `safeMessage` equals `message`
   *  for that case. Safe for a client-facing projection. */
  readonly safeMessage: string
}

export interface WorkflowReservation {
  readonly workflow: WorkflowDef
  readonly actionBindings: ResolvedActionBindings
}

export type CheckWorkflowReservationResult =
  | { readonly ok: true; readonly reservation: WorkflowReservation }
  | { readonly ok: false; readonly diagnostics: readonly WorkflowReservationDiagnostic[] }

export interface ReconcilerActionBindings {
  get(jobId: string, stepId: string): ResolvedActionBinding | undefined
}

export function checkWorkflowReservation(
  workflow: WorkflowDef,
  loadedRegistry: LoadedActionRegistry,
): CheckWorkflowReservationResult {
  const diagnostics: WorkflowReservationDiagnostic[] = []
  const bindings: Record<string, ResolvedActionBinding> = {}

  for (const [jobId, job] of Object.entries(workflow.jobs)) {
    for (const step of job.steps) {
      if (step.type !== "action") continue
      const resolved = resolveAction(step.uses, loadedRegistry.registry)
      if (!resolved.ok) {
        diagnostics.push({
          jobId,
          stepId: step.id,
          uses: step.uses,
          message: addConfiguredPaths(resolved.error, loadedRegistry),
          // `resolved.safeError` never mentions a `sourcePath`; the
          // configured registry search paths (which DO leak filesystem
          // layout) are deliberately never appended here either.
          safeMessage: resolved.safeError,
        })
        continue
      }
      const inputErrors = validateActionInputs(resolved.manifest, step.with)
      if (inputErrors.length > 0) {
        // `validateActionInputs` diagnostics never mention a filesystem
        // path (they describe declared vs. supplied `with:` values), so
        // `safeMessage` is the same string as `message`.
        diagnostics.push(...inputErrors.map(message => ({
          jobId,
          stepId: step.id,
          uses: step.uses,
          message,
          safeMessage: message,
        })))
        continue
      }
      const sourcePath = findSourcePath(resolved.manifest, loadedRegistry.registry)
      bindings[bindingKey(jobId, step.id)] = Object.freeze({
        jobId,
        stepId: step.id,
        uses: step.uses,
        manifest: deepFreeze(resolved.manifest),
        digest: resolved.digest,
        sourcePath,
      })
    }
  }

  if (diagnostics.length > 0) return { ok: false, diagnostics: Object.freeze(diagnostics) }
  return {
    ok: true,
    reservation: Object.freeze({ workflow, actionBindings: Object.freeze(bindings) }),
  }
}

export function actionBindingsForReconciler(bindings: ResolvedActionBindings): ReconcilerActionBindings {
  return {
    get(jobId, stepId) {
      return bindings[bindingKey(jobId, stepId)]
    },
  }
}

function bindingKey(jobId: string, stepId: string): string {
  return JSON.stringify([jobId, stepId])
}

function findSourcePath(manifest: ActionManifest, registry: ActionRegistry): string {
  const entry = registry[manifest.name]?.find(candidate => candidate.manifest === manifest)
  return entry?.sourcePath ?? `${manifest.name}@v${manifest.version}`
}

function addConfiguredPaths(error: string, loadedRegistry: LoadedActionRegistry): string {
  const paths = loadedRegistry.searchPaths.map(path => path.path).join(", ")
  return `${error}; configured registry paths: ${paths}`
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const nested of Object.values(value)) deepFreeze(nested)
  return value
}
