import { useMemo } from "react"
import type { FeatureDetail, JobStatus, WorkflowProjection } from "../api/types.ts"
import { mergeGraph, stepGlyph } from "./merge.ts"
import { edgePath, layoutJobs, loopEdgePath } from "./layout.ts"
import { GraphViewport } from "./graph-viewport.tsx"
import { useIsNarrowViewport } from "../lib/viewport.ts"
import styles from "./workflow-graph.module.css"

export interface WorkflowGraphProps {
  readonly workflow: WorkflowProjection
  readonly detail: FeatureDetail
  readonly selectedJobId?: string | null
  readonly onNodeClick?: (jobId: string, stepId: string | null) => void
}

function jobGlyph(status: JobStatus): string {
  switch (status) {
    case "succeeded":
      return "✓"
    case "running":
    case "ready":
      return "●"
    case "failed":
      return "✖"
    case "skipped":
      return "⤼"
    case "pending":
      return "○"
  }
}

function truncate(text: string, max = 48): string {
  return text.length <= max ? text : text.slice(0, max - 1) + "…"
}

const HEADER_OFFSET = 34
const STEP_ROW = 22

function activateOnKey(e: React.KeyboardEvent, fn: () => void): void {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault()
    fn()
  }
}

export function WorkflowGraph(props: WorkflowGraphProps): React.ReactNode {
  const { workflow, detail, selectedJobId, onNodeClick } = props
  const isNarrow = useIsNarrowViewport()
  const model = useMemo(() => mergeGraph({ workflow, detail }), [workflow, detail])
  const layout = useMemo(
    () =>
      layoutJobs(
        model.jobs.map(job => ({
          id: job.id,
          needs: workflow.jobs[job.id]?.needs ?? [],
          stepCount: job.steps.length,
        })),
      ),
    [model, workflow],
  )
  const nodeById = new Map(layout.nodes.map(n => [n.id, n]))

  return (
    <GraphViewport
      contentWidth={layout.width}
      contentHeight={layout.height}
      resetKey={`${workflow.name}:${model.jobs.length}`}
      allowFullscreen={isNarrow}
      fullscreenFitMinScale={2}
    >
      <svg
        className={styles.svg}
        width={layout.width}
        height={layout.height}
        role="group"
        aria-label={`Workflow graph for ${workflow.name}, ${model.jobs.length} jobs`}
      >
        {layout.edges.map((edge, i) => {
          const from = nodeById.get(edge.from)
          const to = nodeById.get(edge.to)
          if (from === undefined || to === undefined) return null
          const fromJob = model.jobs.find(j => j.id === edge.from)
          const toJob = model.jobs.find(j => j.id === edge.to)
          if (fromJob === undefined || toJob === undefined) return null
          let cls = styles.edgeFuture
          if (toJob.isCurrent) cls = styles.edgeCurrent
          else if (fromJob.status === "succeeded") cls = styles.edgeDone
          return <path key={`e${i}`} d={edgePath(from, to)} className={cls} />
        })}
        {model.loopEdge !== null
          ? (() => {
              const from = nodeById.get(model.loopEdge.from)
              const to = nodeById.get(model.loopEdge.to)
              if (from === undefined || to === undefined) return null
              const d = loopEdgePath(from, to, 28)
              const labelX = (from.x + to.x) / 2 + from.width / 2
              const labelY = Math.max(from.y + from.height, to.y + to.height) + 22
              return (
                <g>
                  <path d={d} className={styles.loopEdge} markerWidth={6} />
                  <text x={labelX} y={labelY} textAnchor="middle" className={styles.loopLabel}>
                    {truncate(model.loopEdge.message)}
                  </text>
                </g>
              )
            })()
          : null}
        {layout.nodes.map(node => {
          const job = model.jobs.find(j => j.id === node.id)
          if (job === undefined) return null
          return (
            <g key={node.id}>
              {job.isCurrent ? (
                <rect
                  x={node.x - 4}
                  y={node.y - 4}
                  width={node.width + 8}
                  height={node.height + 8}
                  rx={10}
                  className={styles.halo}
                />
              ) : null}
              <g
                className={styles.jobGroup}
                tabIndex={0}
                role="button"
                aria-label={`Job ${node.id}, ${job.status}${job.isCurrent ? ", active" : ""}`}
                aria-current={job.isCurrent ? "step" : undefined}
                onPointerDown={e => e.stopPropagation()}
                onClick={() => onNodeClick?.(node.id, null)}
                onKeyDown={e => activateOnKey(e, () => onNodeClick?.(node.id, null))}
              >
                <rect
                  x={node.x}
                  y={node.y}
                  width={node.width}
                  height={node.height}
                  rx={6}
                  className={`${styles.jobRect} ${job.isCurrent ? styles.jobRectCurrent : ""} ${selectedJobId === node.id ? styles.jobRectSelected : ""}`}
                />
                <text x={node.x + 10} y={node.y + HEADER_OFFSET - 12} className={styles.jobHeader}>
                  {jobGlyph(job.status)} {node.id}
                </text>
                {job.round > 0 ? (
                  <text
                    x={node.x + node.width - 10}
                    y={node.y + HEADER_OFFSET - 12}
                    textAnchor="end"
                    className={styles.roundChip}
                  >
                    ⟲ {job.round}
                  </text>
                ) : null}
              </g>
              {job.steps.map((step, i) => {
                const y = node.y + HEADER_OFFSET + i * STEP_ROW + 14
                const isCurrent = job.currentStep === step.id && job.isCurrent
                return (
                  <g
                    key={step.id}
                    tabIndex={0}
                    role="button"
                    aria-label={`Step ${step.id} in job ${node.id}, ${step.status}`}
                    onPointerDown={e => e.stopPropagation()}
                    onClick={e => {
                      e.stopPropagation()
                      onNodeClick?.(node.id, step.id)
                    }}
                    onKeyDown={e => activateOnKey(e, () => onNodeClick?.(node.id, step.id))}
                  >
                    <rect
                      x={node.x + 6}
                      y={y - 13}
                      width={node.width - 12}
                      height={STEP_ROW - 2}
                      rx={3}
                      className={styles.stepHit}
                    />
                    <text
                      x={node.x + 16}
                      y={y}
                      className={`${styles.stepText} ${isCurrent ? styles.stepTextCurrent : ""}`}
                    >
                      {stepGlyph(step.status)} {step.id}
                    </text>
                  </g>
                )
              })}
            </g>
          )
        })}
      </svg>
    </GraphViewport>
  )
}
