import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { ScopeTabs } from "../src/board/scope-tabs.tsx"
import { StageSelector } from "../src/board/stage-selector.tsx"
import { WorkflowGraph } from "../src/graph/workflow-graph.tsx"
import type { FeatureDetail, WorkflowProjection } from "../src/api/types.ts"

const stages = [
  { jobId: "design", count: 2, hasAttention: true },
  { jobId: "deliver", count: 1, hasAttention: false },
]

const workflow: WorkflowProjection = {
  name: "feature-delivery",
  stale: false,
  diagnostics: [],
  inputs: {},
  jobs: {
    design: { needs: [], steps: [{ id: "plan", kind: "agent" }] },
    deliver: { needs: ["design"], steps: [{ id: "implement", kind: "agent" }] },
  },
}

const feature: FeatureDetail = {
  id: "feature-1",
  title: "Viewport fixture",
  slug: "viewport-fixture",
  projectDir: "/tmp/project",
  workflow: "feature-delivery",
  workflowRef: { name: "feature-delivery", stale: false },
  description: null,
  status: "running",
  sessionId: null,
  worktree: null,
  branch: null,
  pr: null,
  escalation: null,
  currentStep: "deliver/implement",
  createdAt: 1,
  updatedAt: 2,
  findingCounts: { new: 0, fixed: 0, dismissed: 0, reopened: 0 },
  feedback: null,
  jobs: {
    design: {
      status: "succeeded",
      currentStep: null,
      attempts: {},
      reruns: {},
      outputs: {},
      steps: { plan: { status: "succeeded", outputs: {} } },
    },
    deliver: {
      status: "running",
      currentStep: "implement",
      attempts: {},
      reruns: {},
      outputs: {},
      steps: { implement: { status: "running", outputs: {} } },
    },
  },
}

describe("responsive component markup", () => {
  it("renders stage and scope selectors as named pressed-button groups", () => {
    const stageMarkup = renderToStaticMarkup(
      <StageSelector stages={stages} selected="design" onSelect={() => {}} />,
    )
    expect(stageMarkup).toContain('role="group"')
    expect(stageMarkup).toContain('aria-label="Workflow job stage"')
    expect(stageMarkup).toContain('aria-pressed="true"')
    expect(stageMarkup).not.toContain('role="tab"')

    const scopeMarkup = renderToStaticMarkup(
      <ScopeTabs
        selectedKey="/tmp/project::feature-delivery"
        onSelect={() => {}}
        scopes={[
          {
            key: "/tmp/project::feature-delivery",
            projectDir: "/tmp/project",
            projectLabel: "project",
            workflow: "feature-delivery",
            featureCount: 2,
            activeCount: 2,
          },
          {
            key: "/tmp/other::review",
            projectDir: "/tmp/other",
            projectLabel: "other",
            workflow: "review",
            featureCount: 1,
            activeCount: 1,
          },
        ]}
      />,
    )
    expect(scopeMarkup).toContain('aria-label="Workflow scope"')
    expect(scopeMarkup).toContain('aria-pressed="true"')
  })

  it("renders a keyboard-operable graph with camera and step controls", () => {
    const markup = renderToStaticMarkup(<WorkflowGraph workflow={workflow} detail={feature} />)
    expect(markup).toContain("Workflow graph canvas. Drag to pan")
    expect(markup).toContain('aria-label="Zoom out"')
    expect(markup).toContain("Fit workflow to view")
    expect(markup).toContain('role="button"')
    expect(markup).toContain("Job deliver, running, active")
    expect(markup).toContain("Step implement in job deliver, running")
  })
})
