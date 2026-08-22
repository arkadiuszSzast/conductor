/**
 * Start-feature error mapping — pure. `POST /v1/features` reports
 * `project_not_configured`, `unknown_workflow`, and `invalid_input` all as
 * 422 (`docs/http-api.md`): a configuration race between when the start
 * surface loaded its target and when the operator submitted. Those three
 * mean the operator's form is still meaningful but the target's metadata
 * may have changed underneath it, so the surface refreshes that target's
 * workflow projection alongside showing the inline error — never
 * navigates, never discards the draft (design.md "Server rejection
 * preserves the form").
 */

import { ApiError } from "../api/client.ts"

export interface StartFeatureErrorHandling {
  /** Message for the sheet's inline error slot. */
  readonly message: string
  /** Per-input messages to surface under each input control, keyed by input name. */
  readonly inputErrors: Readonly<Record<string, string>>
  /** Refetch the selected target's workflow projection — a configuration
   *  race (workflow renamed/edited/inputs changed) may have caused this. */
  readonly refreshTarget: boolean
}

export function mapStartFeatureError(err: unknown): StartFeatureErrorHandling {
  if (err instanceof ApiError) {
    if (err.code === "invalid_input" && err.diagnostics !== null) {
      const inputErrors: Record<string, string> = {}
      for (const diagnostic of err.diagnostics) {
        if (diagnostic.name !== undefined) inputErrors[diagnostic.name] = diagnostic.message
      }
      return { message: err.message, inputErrors, refreshTarget: true }
    }
    if (err.code === "project_not_configured" || err.code === "unknown_workflow") {
      return { message: err.message, inputErrors: {}, refreshTarget: true }
    }
    if (err.status === 401) {
      // Central 401 handling already routed the app back to the auth
      // gate (ApiClient.request → onUnauthorized); the sheet still needs
      // an inline message for the brief instant before that unmounts it.
      return { message: err.message, inputErrors: {}, refreshTarget: false }
    }
    const suffix = err.requestId !== null ? ` (request ${err.requestId})` : ""
    return { message: `${err.message}${suffix}`, inputErrors: {}, refreshTarget: false }
  }
  return { message: String(err), inputErrors: {}, refreshTarget: false }
}
