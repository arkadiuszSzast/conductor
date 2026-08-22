/**
 * `StartWorkFormFields` markup — target picker states (valid/stale/
 * invalid, single vs. multiple selectable, discovery loading/error),
 * typed workflow input controls, warnings/errors, and no agent/model
 * controls anywhere in the surface (spec: "Start-work targets reflect
 * registered project workflows", "Start surface renders declared
 * workflow inputs"). `renderToStaticMarkup` only — `ActionSheet`'s
 * portal needs a real DOM this environment doesn't provide, so the
 * sheet shell itself is untested here; this covers everything the sheet
 * composes. Mounted focus/keyboard behavior of the sheet shell (the
 * `ActionSheet` portal, Tab trap, Escape) is covered separately in
 * `action-sheet-mounted.test.tsx` and `start-work-sheet-mounted.test.tsx`.
 */
import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { StartWorkFormFields } from "../src/start-work/start-work-form-fields.tsx"
import { EMPTY_START_FORM_DRAFT, NO_FIELD_ERRORS, type StartFormDraft, type StartFormFieldErrors } from "../src/start-work/form.ts"
import type { UseStartWorkFormResult } from "../src/start-work/use-start-work-form.ts"
import type { ResolvedTarget, StartTarget, TargetDiscoveryState } from "../src/start-work/targets.ts"

function baseForm(overrides: Partial<UseStartWorkFormResult> = {}): UseStartWorkFormResult {
  return {
    targets: [],
    discovery: { status: "ready" },
    requiresSelection: false,
    selectedProjectDir: null,
    selectTarget: () => {},
    resolved: null,
    runnerWarning: false,
    draft: EMPTY_START_FORM_DRAFT,
    setTitle: () => {},
    setDescription: () => {},
    setPr: () => {},
    setInputValue: () => {},
    errors: NO_FIELD_ERRORS,
    inlineError: null,
    pending: false,
    canSubmit: true,
    blockedReason: null,
    submit: async () => {},
    retryWorkflow: () => {},
    ...overrides,
  }
}

function target(partial: Partial<StartTarget>): StartTarget {
  return { projectDir: "/p", projectLabel: "p", state: "valid", selectable: true, stale: false, diagnostics: [], ...partial }
}

function resolved(partial: Partial<ResolvedTarget>): ResolvedTarget {
  return {
    projectDir: "/p",
    projectLabel: "p",
    submittable: true,
    workflowName: "delivery",
    staleWarning: null,
    unavailableReason: null,
    inputs: {},
    refreshError: null,
    canRetryWorkflow: false,
    ...partial,
  }
}

describe("StartWorkFormFields: target picker", () => {
  it("shows a registration hint when no projects are configured", () => {
    const markup = renderToStaticMarkup(<StartWorkFormFields formId="f" form={baseForm()} />)
    expect(markup).toContain("register one with the CLI")
  })

  it("marks project selection required only when multiple targets are eligible", () => {
    const single = renderToStaticMarkup(
      <StartWorkFormFields formId="f" form={baseForm({ targets: [target({})], requiresSelection: false })} />,
    )
    expect(single).not.toMatch(/project[\s\S]{0,40}\(required\)/)

    const multiple = renderToStaticMarkup(
      <StartWorkFormFields
        formId="f"
        form={baseForm({ targets: [target({ projectDir: "/a" }), target({ projectDir: "/b" })], requiresSelection: true })}
      />,
    )
    expect(multiple).toMatch(/project[\s\S]{0,60}\(required\)/)
  })

  it("renders every target as a native radio grouped under one radiogroup, and marks the selected one checked", () => {
    const markup = renderToStaticMarkup(
      <StartWorkFormFields
        formId="f"
        form={baseForm({
          targets: [target({ projectDir: "/a", projectLabel: "alpha" }), target({ projectDir: "/b", projectLabel: "beta" })],
          selectedProjectDir: "/b",
          requiresSelection: true,
        })}
      />,
    )
    expect(markup).toContain('role="radiogroup"')
    expect(markup).toContain("alpha")
    expect(markup).toContain("beta")
    expect(markup).toContain('type="radio"')
    // exactly one radio carries the checked attribute (beta, the selected one)
    expect((markup.match(/type="radio"[^>]*checked=""/g) ?? []).length).toBe(1)
    // both radios share one `name` so they form a single native group
    const names = [...markup.matchAll(/name="([^"]+)"/g)].map(m => m[1])
    expect(new Set(names).size).toBe(1)
  })

  it("renders each target's full project path distinctly from its short label — safe to tell apart even on a basename collision", () => {
    const markup = renderToStaticMarkup(
      <StartWorkFormFields
        formId="f"
        form={baseForm({
          targets: [
            target({ projectDir: "/home/a/webapp", projectLabel: "a/webapp" }),
            target({ projectDir: "/home/b/webapp", projectLabel: "b/webapp" }),
          ],
          requiresSelection: true,
        })}
      />,
    )
    expect(markup).toContain("/home/a/webapp")
    expect(markup).toContain("/home/b/webapp")
    expect(markup).toContain("a/webapp")
    expect(markup).toContain("b/webapp")
  })

  it("an invalid/unregistered target is disabled and shows its diagnostics inline", () => {
    const markup = renderToStaticMarkup(
      <StartWorkFormFields
        formId="f"
        form={baseForm({
          targets: [target({ state: "invalid", selectable: false, diagnostics: ["missing jobs key"] })],
        })}
      />,
    )
    expect(markup).toContain("disabled=\"\"")
    expect(markup).toContain("missing jobs key")
  })

  it("a stale target shows the stale warning banner", () => {
    const markup = renderToStaticMarkup(
      <StartWorkFormFields
        formId="f"
        form={baseForm({
          targets: [target({ state: "stale", stale: true })],
          selectedProjectDir: "/p",
          resolved: resolved({ staleWarning: "last valid workflow snapshot in use — parse error" }),
        })}
      />,
    )
    expect(markup).toContain("last valid workflow snapshot in use")
  })

  it("an unavailable resolved target shows why, distinctly from the stale warning", () => {
    const markup = renderToStaticMarkup(
      <StartWorkFormFields
        formId="f"
        form={baseForm({
          targets: [target({ state: "invalid", selectable: false })],
          resolved: resolved({ submittable: false, workflowName: null, unavailableReason: "project is invalid" }),
        })}
      />,
    )
    expect(markup).toContain("project is invalid")
  })

  it("does not render a Retry action for an unavailable target that cannot be retried (a real config state, not a transport failure)", () => {
    const markup = renderToStaticMarkup(
      <StartWorkFormFields
        formId="f"
        form={baseForm({
          targets: [target({ state: "invalid", selectable: false })],
          resolved: resolved({ submittable: false, workflowName: null, unavailableReason: "project is invalid", canRetryWorkflow: false }),
        })}
      />,
    )
    expect(markup).not.toContain("retry")
  })

  it("renders an explicit Retry action for an unavailable target from an INITIAL transport failure", () => {
    const markup = renderToStaticMarkup(
      <StartWorkFormFields
        formId="f"
        form={baseForm({
          targets: [target({})],
          selectedProjectDir: "/p",
          resolved: resolved({ submittable: false, workflowName: null, unavailableReason: "network down", canRetryWorkflow: true }),
        })}
      />,
    )
    expect(markup).toContain("network down")
    expect(markup).toContain("retry")
  })

  it("renders an explicit Retry action alongside a failed-refresh warning", () => {
    const markup = renderToStaticMarkup(
      <StartWorkFormFields
        formId="f"
        form={baseForm({
          targets: [target({})],
          selectedProjectDir: "/p",
          resolved: resolved({ refreshError: "network down", canRetryWorkflow: true }),
        })}
      />,
    )
    expect(markup).toContain("could not confirm")
    expect(markup).toContain("retry")
  })

  it("runner unavailability renders a non-blocking warning", () => {
    const markup = renderToStaticMarkup(<StartWorkFormFields formId="f" form={baseForm({ runnerWarning: true })} />)
    expect(markup).toContain("no runner is currently available")
  })

  it("a failed refresh on the resolved target renders a distinct blocking warning, alongside the still-cached submittable state", () => {
    const markup = renderToStaticMarkup(
      <StartWorkFormFields
        formId="f"
        form={baseForm({
          targets: [target({})],
          selectedProjectDir: "/p",
          resolved: resolved({ refreshError: "network down" }),
        })}
      />,
    )
    expect(markup).toContain("could not confirm")
    expect(markup).toContain("network down")
    expect(markup).toContain("preserved")
    // Distinct from the stale-snapshot warning and the fully-unavailable
    // notice — neither of those copy strings should appear here.
    expect(markup).not.toContain("last valid workflow snapshot in use")
  })

  it("shows the resolved target's selected workflow name distinctly from the project picker", () => {
    const markup = renderToStaticMarkup(
      <StartWorkFormFields
        formId="f"
        form={baseForm({
          targets: [target({})],
          selectedProjectDir: "/p",
          resolved: resolved({ workflowName: "feature-delivery" }),
        })}
      />,
    )
    expect(markup).toContain("feature-delivery")
  })
})

describe("StartWorkFormFields: discovery states", () => {
  it("renders a loading status distinct from 'no configured projects' while discovery is in flight", () => {
    const markup = renderToStaticMarkup(
      <StartWorkFormFields formId="f" form={baseForm({ discovery: { status: "loading" }, targets: [] })} />,
    )
    expect(markup).toContain("discovering configured projects")
    expect(markup).not.toContain("register one with the CLI")
    expect(markup).toContain('role="status"')
  })

  it("renders an actionable error distinct from 'no configured projects' on a failed discovery with no prior data", () => {
    const discovery: TargetDiscoveryState = { status: "error", message: "network unreachable", stale: false }
    const markup = renderToStaticMarkup(<StartWorkFormFields formId="f" form={baseForm({ discovery, targets: [] })} />)
    expect(markup).toContain("could not load configured projects")
    expect(markup).toContain("network unreachable")
    expect(markup).not.toContain("register one with the CLI")
    expect(markup).toContain('role="alert"')
  })

  it("a failed refresh with a prior cached target list renders it labeled as possibly stale, not silently trustworthy", () => {
    const discovery: TargetDiscoveryState = { status: "error", message: "network unreachable", stale: true }
    const markup = renderToStaticMarkup(
      <StartWorkFormFields formId="f" form={baseForm({ discovery, targets: [target({ projectLabel: "cached-project" })] })} />,
    )
    expect(markup).toContain("could not load configured projects")
    expect(markup).toContain("stale")
    expect(markup).toContain("cached-project")
  })
})

describe("StartWorkFormFields: no agent/model controls", () => {
  it("never renders agent or model selection anywhere in the surface", () => {
    const markup = renderToStaticMarkup(
      <StartWorkFormFields
        formId="f"
        form={baseForm({
          targets: [target({})],
          selectedProjectDir: "/p",
          resolved: resolved({ inputs: { feature: { type: "string", presence: "required" } } }),
        })}
      />,
    )
    expect(markup.toLowerCase()).not.toContain("agent")
    expect(markup.toLowerCase()).not.toContain("model")
  })
})

describe("StartWorkFormFields: advanced fields", () => {
  it("hides the existing PR attachment field in a collapsed Advanced section by default", () => {
    const markup = renderToStaticMarkup(<StartWorkFormFields formId="f" form={baseForm()} />)
    expect(markup).toContain("<details")
    expect(markup).not.toContain("<details open")
    expect(markup).toContain("advanced")
    expect(markup).toContain("existing pull request number")
    expect(markup).toContain("already exists")
  })

  it("opens Advanced when the PR field has a validation error", () => {
    const markup = renderToStaticMarkup(
      <StartWorkFormFields
        formId="f"
        form={baseForm({ errors: { inputs: {}, pr: "pull request number must be a positive integer" } })}
      />,
    )
    expect(markup).toContain("<details open")
    expect(markup).toContain("pull request number must be a positive integer")
  })
})

describe("StartWorkFormFields: workflow inputs", () => {
  it("renders one labeled control per declared input, typed", () => {
    const markup = renderToStaticMarkup(
      <StartWorkFormFields
        formId="f"
        form={baseForm({
          targets: [target({})],
          selectedProjectDir: "/p",
          resolved: resolved({
            inputs: {
              feature: { type: "string", presence: "required" },
              count: { type: "number", presence: "optional", default: 3 },
              verbose: { type: "boolean", presence: "optional", default: false },
            },
          }),
          draft: { ...EMPTY_START_FORM_DRAFT, inputs: { feature: "", count: "3", verbose: false } },
        })}
      />,
    )
    expect(markup).toContain("workflow inputs")
    expect(markup).toContain("feature")
    expect(markup).toContain("count")
    expect(markup).toContain("verbose")
    expect(markup).toContain('type="checkbox"')
    // required marker present for the required string input
    expect(markup).toMatch(/feature[\s\S]{0,80}\(required\)/)
  })

  it("switching targets (a fresh resolved.inputs) renders only the new workflow's fields", () => {
    const oldDraft: StartFormDraft = { ...EMPTY_START_FORM_DRAFT, inputs: { legacyOnly: "stale" } }
    const markup = renderToStaticMarkup(
      <StartWorkFormFields
        formId="f"
        form={baseForm({
          targets: [target({})],
          selectedProjectDir: "/p",
          resolved: resolved({ inputs: { feature: { type: "string", presence: "required" } } }),
          draft: oldDraft,
        })}
      />,
    )
    expect(markup).toContain("feature")
    expect(markup).not.toContain("legacyOnly")
  })

  it("renders no workflow-inputs fieldset when the target declares none", () => {
    const markup = renderToStaticMarkup(
      <StartWorkFormFields formId="f" form={baseForm({ targets: [target({})], selectedProjectDir: "/p", resolved: resolved({ inputs: {} }) })} />,
    )
    expect(markup).not.toContain("workflow inputs")
  })
})

describe("StartWorkFormFields: errors", () => {
  it("shows the title field error and the inline server error", () => {
    const errors: StartFormFieldErrors = { title: "a title is required", inputs: {} }
    const markup = renderToStaticMarkup(
      <StartWorkFormFields formId="f" form={baseForm({ errors, inlineError: "workflow changed since you opened this form" })} />,
    )
    expect(markup).toContain("a title is required")
    expect(markup).toContain("workflow changed since you opened this form")
  })

  it("shows a per-input error under its own control", () => {
    const errors: StartFormFieldErrors = { inputs: { feature: '"feature" is required' } }
    const markup = renderToStaticMarkup(
      <StartWorkFormFields
        formId="f"
        form={baseForm({
          targets: [target({})],
          selectedProjectDir: "/p",
          resolved: resolved({ inputs: { feature: { type: "string", presence: "required" } } }),
          errors,
        })}
      />,
    )
    expect(markup).toContain("feature&quot; is required")
  })
})

describe("StartWorkFormFields: pending state", () => {
  it("disables every field while a request is pending", () => {
    const markup = renderToStaticMarkup(
      <StartWorkFormFields
        formId="f"
        form={baseForm({
          targets: [target({})],
          selectedProjectDir: "/p",
          resolved: resolved({ inputs: { feature: { type: "string", presence: "required" } } }),
          pending: true,
        })}
      />,
    )
    // title, description, pr, and the one workflow input are all disabled
    expect((markup.match(/disabled=""/g) ?? []).length).toBeGreaterThanOrEqual(4)
  })
})
