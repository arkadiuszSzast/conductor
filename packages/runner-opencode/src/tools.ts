/**
 * Daemon-backed Conductor tools — the seed's tool surface with every
 * engine/store call replaced by a daemon API call through the typed
 * `ApiClient` (`@conductor/cli`). No pipeline logic lives here: the
 * tools validate nothing the daemon already validates, and their output
 * strings preserve the seed's guidance text (the "this session is the
 * feature's home, do not poll" contract that keeps starting sessions
 * from babysitting the pipeline).
 *
 * The tool functions are transport-only and runtime-typed loosely on
 * purpose: `createConductorTools` returns plain descriptors that the
 * plugin entry point wraps in `tool()` from `@opencode-ai/plugin`, so
 * this module needs no SDK import and stays testable with a socketless
 * `ApiClient`.
 *
 * The tools stay scoped to their instance's project directory, exactly
 * as the seed's were: `conductor_status` lists only this project's
 * features; the gate tools refuse a feature belonging to a different
 * project with the seed's redirect message. The duplicate-report
 * contract maps `run_already_concluded` (HTTP 409) back onto the same
 * "Run <id> already concluded" text agents saw from the seed, so a
 * retried report reads as already-recorded, never as a failure.
 */

import { ApiClient, ApiError } from "@conductor/cli"
import type { FeatureView } from "@conductor/cli"
import type { ReviewReport } from "@conductor/server"

export interface ConductorToolContext {
  readonly sessionID: string
}

export interface StartArgs {
  readonly title: string
  readonly description?: string
  readonly pr?: number
  readonly workflow?: string
}

export interface ReportArgs {
  readonly run_id: string
  readonly review?: ReviewReport
  readonly outcome?: "succeeded" | "failed"
  readonly verdict?: string
  readonly notes?: string
}

export interface GateArgs {
  readonly feature_id: string
  readonly notes?: string
}

export interface ConductorTools {
  start(args: StartArgs, context: ConductorToolContext): Promise<string>
  report(args: ReportArgs): Promise<string>
  ask(args: { run_id: string; question: string }): Promise<string>
  status(): Promise<string>
  approve(args: GateArgs): Promise<string>
  requestChanges(args: { feature_id: string; notes: string }): Promise<string>
}

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === "unreachable") return `Conductor daemon is unreachable: ${err.message}`
    return err.message
  }
  return err instanceof Error ? err.message : String(err)
}

export function createConductorTools(client: ApiClient, projectDir: string): ConductorTools {
  const guardProject = async (featureId: string): Promise<{ feature: FeatureView } | { error: string }> => {
    let feature: FeatureView
    try {
      feature = (await client.getFeature(featureId)).feature
    } catch (err) {
      if (err instanceof ApiError && err.code === "not_found") return { error: `Unknown feature "${featureId}".` }
      return { error: describeError(err) }
    }
    if (feature.projectDir !== projectDir) {
      return {
        error: `Feature "${feature.title}" belongs to ${feature.projectDir} — use a session in that project.`,
      }
    }
    return { feature }
  }

  return {
    async start(args, context) {
      try {
        const payload = await client.startFeature({
          title: args.title,
          project: projectDir,
          sessionId: context.sessionID,
          ...(args.description !== undefined ? { description: args.description } : {}),
          ...(args.workflow !== undefined ? { workflow: args.workflow } : {}),
          ...(args.pr !== undefined ? { pr: args.pr } : {}),
        })
        return (
          `Feature "${args.title}" started (id ${payload.feature.id}).\n` +
          `Current step: ${payload.feature.currentStep ?? "?"} — status: ${payload.feature.status}.\n\n` +
          `THIS session is now the feature's home: the conductor daemon drives the pipeline ` +
          `autonomously in child sessions and posts a progress note here after every step — ` +
          `do NOT monitor, poll, or do any further work on the feature yourself. ` +
          `Tell the user the feature has started and end your turn; ` +
          `the user will be notified when human approval is needed.`
        )
      } catch (err) {
        if (err instanceof ApiError && err.code === "project_not_configured") {
          return (
            "No conductor.yaml configured for this project. Run `conductor init` to scaffold one, " +
            "then register the project with the daemon."
          )
        }
        if (err instanceof ApiError && err.code === "unknown_workflow") return err.message
        return describeError(err)
      }
    },

    async report(args) {
      try {
        const result = await client.report(args.run_id, {
          ...(args.review !== undefined ? { review: args.review } : {}),
          ...(args.outcome !== undefined ? { outcome: args.outcome } : {}),
          ...(args.verdict !== undefined ? { verdict: args.verdict } : {}),
          ...(args.notes !== undefined ? { notes: args.notes } : {}),
        })
        return result.result
      } catch (err) {
        // A duplicate report is already-recorded, not a failure: hand the
        // agent the daemon's idempotent-rejection text so a retry loop
        // stops instead of escalating.
        if (err instanceof ApiError && err.code === "run_already_concluded") return err.message
        if (err instanceof ApiError && err.code === "not_found") return `Unknown run_id "${args.run_id}".`
        return describeError(err)
      }
    },

    async ask(args) {
      try {
        const result = await client.report(args.run_id, { ask: args.question })
        return (
          `${result.result}\n` +
          `Your session stays alive: the human's answer will arrive here as a new message. ` +
          `End your turn now and wait — do NOT report an outcome yet.`
        )
      } catch (err) {
        if (err instanceof ApiError && err.code === "run_already_concluded") return err.message
        if (err instanceof ApiError && err.code === "not_found") return `Unknown run_id "${args.run_id}".`
        return describeError(err)
      }
    },

    async status() {
      try {
        const { features } = await client.listFeatures({ project: projectDir, active: true })
        if (features.length === 0) return "No active conductor features."
        const lines: string[] = []
        for (const feature of features) {
          const { activeRun } = await client.getFeature(feature.id)
          lines.push(
            `${feature.title} [${feature.status}]\n` +
              `  step: ${feature.currentStep ?? "-"}${activeRun ? ` (run ${activeRun.id}, attempt ${activeRun.attempt})` : ""}\n` +
              `  pr: ${feature.pr ?? "-"} branch: ${feature.branch ?? "-"}\n` +
              `  id: ${feature.id}`,
          )
        }
        return lines.join("\n\n")
      } catch (err) {
        return describeError(err)
      }
    },

    async approve(args) {
      const guarded = await guardProject(args.feature_id)
      if ("error" in guarded) return guarded.error
      try {
        const result = await client.approve(args.feature_id, args.notes)
        return result.result ?? "Approved."
      } catch (err) {
        if (err instanceof ApiError && err.code === "conflict") return err.message
        return describeError(err)
      }
    },

    async requestChanges(args) {
      const guarded = await guardProject(args.feature_id)
      if ("error" in guarded) return guarded.error
      try {
        const result = await client.requestChanges(args.feature_id, args.notes)
        return result.result ?? "Changes requested."
      } catch (err) {
        if (err instanceof ApiError && err.code === "conflict") return err.message
        return describeError(err)
      }
    },
  }
}
