/**
 * Layered DAG layout for job nodes — pure, no DOM, no graph library.
 *
 * Layer = longest path from a source through `needs` (GHA mental model:
 * work flows left → right). Nodes are placed in columns, one per layer;
 * within a layer they stack in declaration order, then one barycenter
 * pass reorders each layer by the average vertical position of its
 * predecessors to cut edge crossings. Orthogonal elbow edges connect
 * right-center of the source to left-center of the target.
 */

export interface LayoutJob {
  readonly id: string
  readonly needs: readonly string[]
  readonly stepCount: number
}

export interface JobNodeRect {
  readonly id: string
  readonly layer: number
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface JobEdge {
  readonly from: string
  readonly to: string
}

export interface GraphLayout {
  readonly nodes: readonly JobNodeRect[]
  readonly edges: readonly JobEdge[]
  readonly width: number
  readonly height: number
  readonly layerCount: number
}

export interface LayoutOptions {
  readonly columnWidth?: number
  readonly columnGap?: number
  readonly nodeGap?: number
  readonly stepRowHeight?: number
  readonly headerHeight?: number
  readonly verticalPad?: number
  readonly margin?: number
}

export const DEFAULT_LAYOUT: Required<Omit<LayoutOptions, never>> = {
  columnWidth: 200,
  columnGap: 48,
  nodeGap: 18,
  stepRowHeight: 22,
  headerHeight: 34,
  verticalPad: 12,
  margin: 16,
}

export function nodeHeightFor(stepCount: number, options: Required<LayoutOptions>): number {
  return options.headerHeight + stepCount * options.stepRowHeight + options.verticalPad * 2
}

/** Longest-path layering: a job sits one layer past its deepest need.
 *  Cycles (which the daemon's validation rejects, but a stale/broken
 *  projection could still carry) break at the revisited node. */
export function assignLayers(
  jobs: readonly LayoutJob[],
): ReadonlyMap<string, number> {
  const byId = new Map(jobs.map(job => [job.id, job]))
  const memo = new Map<string, number>()
  const visiting = new Set<string>()
  const visit = (jobId: string): number => {
    const cached = memo.get(jobId)
    if (cached !== undefined) return cached
    if (visiting.has(jobId)) return 0
    visiting.add(jobId)
    const job = byId.get(jobId)
    let deepest = 0
    if (job !== undefined) {
      for (const need of job.needs) {
        if (need !== jobId && byId.has(need)) deepest = Math.max(deepest, visit(need) + 1)
      }
    }
    visiting.delete(jobId)
    memo.set(jobId, deepest)
    return deepest
  }
  for (const job of jobs) visit(job.id)
  return memo
}

/**
 * Vertical slotting within one layer: nodes stacked top to bottom in the
 * given order, with the whole block centered in the layer's band.
 */
function slotLayer(
  jobs: readonly LayoutJob[],
  order: readonly string[],
  options: Required<LayoutOptions>,
): ReadonlyMap<string, number> {
  const byId = new Map(jobs.map(job => [job.id, job]))
  const ys = new Map<string, number>()
  let cursor = 0
  for (const id of order) {
    const job = byId.get(id)
    if (job === undefined) continue
    ys.set(id, cursor)
    cursor += nodeHeightFor(job.stepCount, options) + options.nodeGap
  }
  return ys
}

export function layoutJobs(jobs: readonly LayoutJob[], rawOptions?: LayoutOptions): GraphLayout {
  const options: Required<LayoutOptions> = { ...DEFAULT_LAYOUT, ...rawOptions }
  const layers = assignLayers(jobs)
  const byLayer = new Map<number, LayoutJob[]>()
  for (const job of jobs) {
    const layer = layers.get(job.id) ?? 0
    const bucket = byLayer.get(layer)
    if (bucket === undefined) byLayer.set(layer, [job])
    else bucket.push(job)
  }
  const layerCount = byLayer.size === 0 ? 1 : Math.max(...byLayer.keys()) + 1

  // Deterministic order per layer: declaration order, then one barycenter
  // pass reordering by mean predecessor declaration index (a proxy for
  // vertical flow).
  const declarationIndex = new Map(jobs.map((job, index) => [job.id, index]))
  const orderByLayer = new Map<number, string[]>()
  for (let layer = 0; layer < layerCount; layer++) {
    const bucket = byLayer.get(layer) ?? []
    if (layer === 0) {
      orderByLayer.set(layer, bucket.map(job => job.id))
      continue
    }
    const predecessorIndex = (job: LayoutJob): number => {
      const preds = job.needs.filter(need => declarationIndex.has(need))
      if (preds.length === 0) return 0
      let sum = 0
      for (const pred of preds) sum += declarationIndex.get(pred) ?? 0
      return sum / preds.length
    }
    const ordered = [...bucket].sort((a, b) => predecessorIndex(a) - predecessorIndex(b))
    orderByLayer.set(layer, ordered.map(job => job.id))
  }

  // Stack each layer, then vertically center every layer's band against
  // the tallest one so columns share a coherent top.
  const bands = new Map<number, number>()
  const slotY = new Map<string, number>()
  for (let layer = 0; layer < layerCount; layer++) {
    const order = orderByLayer.get(layer) ?? []
    const ys = slotLayer(byLayer.get(layer) ?? [], order, options)
    let height = 0
    for (const id of order) {
      const job = jobs.find(candidate => candidate.id === id)
      if (job === undefined) continue
      height += nodeHeightFor(job.stepCount, options) + options.nodeGap
    }
    bands.set(layer, Math.max(0, height - options.nodeGap))
    for (const [id, y] of ys) slotY.set(id, y)
  }
  const maxBand = bands.size === 0 ? 0 : Math.max(...bands.values())

  const columnX = (layer: number): number =>
    options.margin + layer * (options.columnWidth + options.columnGap)

  const nodes: JobNodeRect[] = []
  for (const job of jobs) {
    const layer = layers.get(job.id) ?? 0
    const band = bands.get(layer) ?? 0
    const y = slotY.get(job.id) ?? 0
    const offset = (maxBand - band) / 2
    nodes.push({
      id: job.id,
      layer,
      x: columnX(layer),
      y: y + offset,
      width: options.columnWidth,
      height: nodeHeightFor(job.stepCount, options),
    })
  }

  const edges: JobEdge[] = []
  const seen = new Set<string>()
  for (const job of jobs) {
    for (const need of job.needs) {
      if (need === job.id) continue
      if (!jobs.some(candidate => candidate.id === need)) continue
      const key = `${need}\u0000${job.id}`
      if (seen.has(key)) continue
      seen.add(key)
      edges.push({ from: need, to: job.id })
    }
  }

  const width = options.margin * 2 + layerCount * options.columnWidth + Math.max(0, layerCount - 1) * options.columnGap
  const height = options.margin * 2 + maxBand

  return { nodes, edges, width, height, layerCount }
}

/** Orthogonal elbow edge between two laid-out nodes (right → left-center). */
export function edgePath(from: JobNodeRect, to: JobNodeRect): string {
  const startX = from.x + from.width
  const startY = from.y + from.height / 2
  const endX = to.x
  const endY = to.y + to.height / 2
  const midX = startX + (endX - startX) / 2
  return `M ${startX} ${startY} H ${midX} V ${endY} H ${endX}`
}

/** Loop back-edge from the bottom of the routing node, under the graph, up
 *  into the target's bottom — drawn only while the round is in flight. */
export function loopEdgePath(from: JobNodeRect, to: JobNodeRect, yGap: number): string {
  const fromX = from.x + from.width / 2
  const fromY = from.y + from.height
  const toX = to.x + to.width / 2
  const toY = to.y + to.height
  const dropY = Math.max(fromY, toY) + yGap
  return `M ${fromX} ${fromY} V ${dropY} H ${toX} V ${toY}`
}
