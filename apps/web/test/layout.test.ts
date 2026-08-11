/**
 * DAG layout — pure geometry from `needs` edges, no DOM, no graph lib.
 */
import { describe, expect, it } from "bun:test"
import { assignLayers, DEFAULT_LAYOUT, edgePath, layoutJobs, loopEdgePath, nodeHeightFor, type LayoutJob } from "../src/graph/layout.ts"

function job(id: string, needs: string[] = [], stepCount = 2): LayoutJob {
  return { id, needs, stepCount }
}

describe("layer assignment", () => {
  it("a source job with no needs sits in layer 0", () => {
    const layers = assignLayers([job("design")])
    expect(layers.get("design")).toBe(0)
  })

  it("layers follow the longest path, not the shortest", () => {
    // fan: design → implement → review, plus design → review directly.
    const layers = assignLayers([
      job("design"),
      job("implement", ["design"]),
      job("review", ["design", "implement"]),
    ])
    expect(layers.get("design")).toBe(0)
    expect(layers.get("implement")).toBe(1)
    expect(layers.get("review")).toBe(2)
  })

  it("a deep chain layers linearly", () => {
    const chain = ["a", "b", "c", "d", "e"].map((id, i, arr) => job(id, i === 0 ? [] : [arr[i - 1]!]))
    const layers = assignLayers(chain)
    expect([...chain.map(j => layers.get(j.id))]).toEqual([0, 1, 2, 3, 4])
  })

  it("wide fan-in from parallel jobs lands one layer past the deepest", () => {
    const layers = assignLayers([
      job("a"),
      job("b"),
      job("c"),
      job("merge", ["a", "b", "c"]),
    ])
    expect(layers.get("merge")).toBe(1)
  })

  it("a need pointing at an unknown job is ignored rather than crashing", () => {
    const layers = assignLayers([job("x", ["ghost"])])
    expect(layers.get("x")).toBe(0)
  })
})

describe("layout geometry", () => {
  it("nodes in later layers sit strictly to the right", () => {
    const layout = layoutJobs([job("a"), job("b", ["a"]), job("c", ["b"])])
    const byId = new Map(layout.nodes.map(n => [n.id, n]))
    expect(byId.get("a")!.x).toBeLessThan(byId.get("b")!.x)
    expect(byId.get("b")!.x).toBeLessThan(byId.get("c")!.x)
  })

  it("parallel jobs in one layer never overlap vertically", () => {
    const layout = layoutJobs([job("root"), job("p1", ["root"]), job("p2", ["root"]), job("p3", ["root"])])
    const parallel = layout.nodes.filter(n => n.layer === 1).sort((a, b) => a.y - b.y)
    for (let i = 1; i < parallel.length; i++) {
      expect(parallel[i]!.y).toBeGreaterThanOrEqual(parallel[i - 1]!.y + parallel[i - 1]!.height)
    }
  })

  it("node height grows with the step count", () => {
    expect(nodeHeightFor(5, DEFAULT_LAYOUT)).toBeGreaterThan(nodeHeightFor(1, DEFAULT_LAYOUT))
  })

  it("edges only connect jobs that exist and skips self-needs", () => {
    const layout = layoutJobs([job("a", ["a", "ghost"]), job("b", ["a"])])
    expect(layout.edges).toEqual([{ from: "a", to: "b" }])
  })

  it("canvas dimensions cover every node", () => {
    const layout = layoutJobs([job("a"), job("b", ["a"]), job("c", ["a"]), job("d", ["b", "c"])])
    for (const node of layout.nodes) {
      expect(node.x + node.width).toBeLessThanOrEqual(layout.width)
      expect(node.y + node.height).toBeLessThanOrEqual(layout.height)
    }
  })

  it("duplicate needs produce a single edge", () => {
    const layout = layoutJobs([job("a"), job("b", ["a", "a"])])
    expect(layout.edges.length).toBe(1)
  })
})

describe("edge paths", () => {
  it("a forward edge starts at the source's right edge and ends at the target's left edge", () => {
    const layout = layoutJobs([job("a"), job("b", ["a"])])
    const byId = new Map(layout.nodes.map(n => [n.id, n]))
    const a = byId.get("a")!
    const b = byId.get("b")!
    const d = edgePath(a, b)
    expect(d.startsWith(`M ${a.x + a.width} `)).toBe(true)
    expect(d.endsWith(`H ${b.x}`)).toBe(true)
  })

  it("a loop edge routes under both nodes", () => {
    const layout = layoutJobs([job("a"), job("b", ["a"])])
    const byId = new Map(layout.nodes.map(n => [n.id, n]))
    const a = byId.get("a")!
    const b = byId.get("b")!
    const d = loopEdgePath(b, a, 28)
    const dropY = Math.max(a.y + a.height, b.y + b.height) + 28
    expect(d).toContain(`V ${dropY}`)
  })
})
