/**
 * opencode plugin entry point — the adapter, not the host. opencode
 * instantiates the plugin once per project directory; every instance
 * shares one process-wide `OpencodeRunnerHub` (callback listener +
 * daemon registration) and registers its own directory-scoped session
 * transport with it. Nothing else of the seed's daemon remains here:
 * no SQLite, no interpreter, no reconciler, no dashboard — the
 * standalone daemon owns all of that; this plugin is session transport
 * plus daemon-backed tools.
 *
 * The hub singleton is keyed with `Symbol.for` exactly like the seed's
 * daemon singleton was — but unlike the seed, the ONLY state it holds
 * is the shared listener and the project→transport map, and nothing
 * observable depends on which instance created it: its configuration
 * comes entirely from the environment, which is identical for every
 * instance in the process.
 */

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { ApiClient } from "@conductor/cli"
import { resolveRunnerConfig } from "./config.ts"
import { OpencodeRunnerHub } from "./hub.ts"
import { createOpencodeSessions, type RawOpencodeSessionApi } from "./sessions.ts"
import { createConductorTools } from "./tools.ts"
import { createAgentLogPusher } from "./agent-logs.ts"

const HUB_KEY = Symbol.for("conductor.runner-opencode.hub")

function getOrCreateHub(log: (message: string) => void): OpencodeRunnerHub {
  const globalScope = globalThis as { [HUB_KEY]?: OpencodeRunnerHub }
  const existing = globalScope[HUB_KEY]
  if (existing) return existing
  const config = resolveRunnerConfig(process.env)
  const hub = new OpencodeRunnerHub(config, { log })
  globalScope[HUB_KEY] = hub
  return hub
}

export const ConductorRunnerPlugin: Plugin = async input => {
  const log = (message: string) => console.error(`[conductor-runner] ${message}`)

  const config = resolveRunnerConfig(process.env)
  const hub = getOrCreateHub(log)
  const sessions = createOpencodeSessions(input.client as unknown as RawOpencodeSessionApi)
  await hub.registerProject(input.directory, sessions)

  const client = new ApiClient({
    url: config.daemonUrl,
    ...(config.daemonToken !== undefined ? { token: config.daemonToken } : {}),
  })
  const tools = createConductorTools(client, input.directory)
  const agentLogs = createAgentLogPusher({
    client,
    runIdForSession: sessionID => hub.runIdForSession(sessionID),
    log,
  })

  return {
    event: async ({ event }) => {
      agentLogs.push(event)
      // Session-idle is the natural conclusion moment for a step's
      // output: flush whatever the debounce has not yet sent so the log
      // is complete by the time the agent reports.
      if (event.type === "session.idle") await agentLogs.flush()
    },
    dispose: async () => {
      await agentLogs.flush()
    },
    tool: {
      conductor_start: tool({
        description:
          "Start driving a feature through the configured conductor pipeline. " +
          "The pipeline (steps, roles, models) comes from the project's conductor config. " +
          "Returns the feature id; the conductor daemon drives progress autonomously.",
        args: {
          title: tool.schema.string().describe("Feature title (used for prompts, session names, and the branch slug)"),
          description: tool.schema.string().optional().describe(
            "Full feature description — requirements, context, constraints, acceptance criteria. " +
            "This is the spec handed to the pipeline's intake/design steps; distill it from the " +
            "conversation so far. Omit only for trivial self-explanatory titles.",
          ),
          pr: tool.schema.number().optional().describe("Existing PR number, when attaching the pipeline to an already-open PR"),
          workflow: tool.schema.string().optional().describe(
            "Named workflow from the project's conductor config `workflows` map (e.g. \"bugfix\"). Omit for the default pipeline.",
          ),
        },
        async execute(args, context) {
          return tools.start(args, { sessionID: context.sessionID })
        },
      }),

      conductor_report: tool({
        description:
          "Report the outcome of a conductor pipeline step you were asked to execute. " +
          "MANDATORY at the end of every conductor-driven task: pass the run_id from the task header " +
          "plus either outcome (succeeded/failed) or verdict (for review steps).",
        args: {
          run_id: tool.schema.string().describe("The run id from the [conductor] task header"),
          outcome: tool.schema.enum(["succeeded", "failed"]).optional().describe("Step outcome (non-review steps)"),
          verdict: tool.schema.string().optional().describe("Review verdict, e.g. approved / changes_requested"),
          notes: tool.schema.string().optional().describe("Findings, failure reason, or summary for the next step"),
        },
        async execute(args) {
          return tools.report(args)
        },
      }),

      conductor_ask: tool({
        description:
          "Ask the human a question mid-step WITHOUT ending the conductor run — use ONLY when a human " +
          "decision is required to proceed (ambiguous requirements, a choice between approaches). " +
          "The answer arrives in this same session as a new message. Prefer a fenced " +
          "```conductor-questions``` block containing a JSON array of {question, options?} so the " +
          "web UI renders an answer form. After asking, end your turn and wait.",
        args: {
          run_id: tool.schema.string().describe("The run id from the [conductor] task header"),
          question: tool.schema.string().describe(
            "The question text. May embed a ```conductor-questions``` fenced block with " +
            '[{"question": "...", "options": ["..."]}] for structured answers.',
          ),
        },
        async execute(args) {
          return tools.ask(args)
        },
      }),

      conductor_status: tool({
        description: "Show this project's active conductor features with their current step, status, and recent transitions.",
        args: {},
        async execute() {
          return tools.status()
        },
      }),

      conductor_request_changes: tool({
        description:
          "Reject a conductor step that is waiting for human approval (e.g. merge) and send the feature back for fixes. " +
          "Your notes are handed to the fixing agent — describe what you want changed. " +
          "Only effective when the feature status is waiting_human.",
        args: {
          feature_id: tool.schema.string().describe("Feature id (see conductor_status)"),
          notes: tool.schema.string().describe("What should be changed — handed verbatim to the fixing agent"),
        },
        async execute(args) {
          return tools.requestChanges(args)
        },
      }),

      conductor_approve: tool({
        description:
          "Approve a conductor step that is waiting for human approval (e.g. merge, design gate). " +
          "Only effective when the feature status is waiting_human. Optional notes travel to the " +
          "next steps ({{human.<stepId>}}) — use them for 'approved, but adjust X' guidance.",
        args: {
          feature_id: tool.schema.string().describe("Feature id (see conductor_status)"),
          notes: tool.schema.string().optional().describe("Optional guidance recorded with the approval and visible to downstream steps"),
        },
        async execute(args) {
          return tools.approve(args)
        },
      }),
    },
  }
}

export default ConductorRunnerPlugin
