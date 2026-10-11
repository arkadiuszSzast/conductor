export const name = "@conductor/runner-opencode" as const

export { ConductorReportPlugin, PLUGIN_ID } from "./plugin.ts"
export type { PluginContext } from "./plugin.ts"
export { REPORT_DESCRIPTION, REVIEW_JSON_SCHEMA, TOOL_SCHEMAS, UNBOUND_MESSAGE, createReportTools, credentialFromMetadata } from "./report.ts"
export type { ReportFetch, ReportToolsDeps, SessionCredential, ToolResult } from "./report.ts"
export { default } from "./plugin.ts"
