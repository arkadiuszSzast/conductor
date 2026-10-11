/**
 * OpenCode v2 server plugin `conductor.report`. Shaped for `Plugin.define`
 * from `@opencode/plugin` (an identity function), typed structurally so the
 * package has no SDK dependency: the server provides the context at load.
 *
 * Install: list this package directory under `plugins` in the server's
 * opencode.json (`{"package": "/path/to/packages/runner-opencode"}`).
 */

import { REPORT_DESCRIPTION, TOOL_SCHEMAS, createReportTools, type ToolResult } from "./report.ts"

interface ToolEditor {
  add(tool: {
    name: string
    description: string
    input: unknown
    options?: { codemode: boolean }
    execute(input: unknown, context: { sessionID: string }): Promise<ToolResult>
  }): void
}

export interface PluginContext {
  readonly session: { get(input: { sessionID: string }): Promise<unknown> }
  readonly tool: { transform(edit: (editor: ToolEditor) => void): Promise<unknown> | unknown }
}

export const PLUGIN_ID = "conductor.report"

const asRecord = (input: unknown): Record<string, unknown> => (input && typeof input === "object" ? input as Record<string, unknown> : {})

export const ConductorReportPlugin = {
  id: PLUGIN_ID,
  async setup(ctx: PluginContext): Promise<void> {
    const tools = createReportTools({ sessionMetadata: sessionID => ctx.session.get({ sessionID }) })
    await ctx.tool.transform(editor => {
      editor.add({
        name: "conductor_report",
        description: REPORT_DESCRIPTION,
        input: TOOL_SCHEMAS.conductor_report,
        options: { codemode: false },
        execute: (input, context) => tools.report(asRecord(input), context.sessionID),
      })
      editor.add({
        name: "conductor_ask",
        description: "Ask a human on an interactive step; the step pauses until the answer arrives.",
        input: TOOL_SCHEMAS.conductor_ask,
        options: { codemode: false },
        execute: (input, context) => tools.ask(asRecord(input), context.sessionID),
      })
      editor.add({
        name: "conductor_status",
        description: "Minimal status of this session's own Conductor run only.",
        input: TOOL_SCHEMAS.conductor_status,
        options: { codemode: false },
        execute: (input, context) => tools.status(asRecord(input), context.sessionID),
      })
    })
  },
}

export default ConductorReportPlugin
