/**
 * Board card mapping — list payload → card model, zone grouping.
 */
import { describe, expect, it } from "bun:test"
import { cardModel, groupIntoZones, zoneOf } from "../src/board/card-model.ts"
import type { FeatureListItem } from "../src/api/types.ts"

function item(partial: Partial<FeatureListItem>): FeatureListItem {
  return {
    id: "f-1",
    title: "pdf export",
    slug: "pdf-export",
    projectDir: "/home/dev/projects/conductor",
    workflow: "web",
    description: null,
    status: "running",
    sessionId: null,
    worktree: null,
    branch: null,
    pr: null,
    escalation: null,
    currentStep: "implement",
    createdAt: 1_000,
    updatedAt: 61_000,
    findingCounts: { new: 3, fixed: 1, dismissed: 0, reopened: 0 },
    jobs: {
      core: { status: "succeeded", currentStep: null },
      web: { status: "running", currentStep: "implement" },
      docs: { status: "pending", currentStep: null },
    },
    ...partial,
  }
}

describe("zone mapping", () => {
  it("waiting_human and escalated fuse into the NEEDS YOU zone", () => {
    expect(zoneOf("waiting_human")).toBe("needs-you")
    expect(zoneOf("escalated")).toBe("needs-you")
  })

  it("terminal statuses share the collapsed zone", () => {
    expect(zoneOf("done")).toBe("terminal")
    expect(zoneOf("abandoned")).toBe("terminal")
  })
})

describe("card model", () => {
  it("maps every card field from the list payload alone", () => {
    const card = cardModel(item({}), 121_000)
    expect(card.project).toBe("conductor")
    expect(card.workflow).toBe("web")
    expect(card.age).toBe("1m")
    expect(card.jobsDone).toBe(1)
    expect(card.jobsTotal).toBe(3)
    expect(card.findingsNew).toBe(3)
    expect(card.currentStep).toBe("implement")
    expect(card.attention).toBe(false)
  })

  it("escalated cards carry the verbatim reason and the attention flag", () => {
    const card = cardModel(item({ status: "escalated", escalation: "maxRounds exhausted (3/3)" }), 121_000)
    expect(card.attention).toBe(true)
    expect(card.escalation).toBe("maxRounds exhausted (3/3)")
  })
})

describe("zone grouping", () => {
  it("groups by zone with NEEDS YOU populated from both statuses", () => {
    const zones = groupIntoZones(
      [
        item({ id: "a", status: "waiting_human" }),
        item({ id: "b", status: "escalated" }),
        item({ id: "c", status: "running" }),
        item({ id: "d", status: "done" }),
        item({ id: "e", status: "paused" }),
      ],
      200_000,
    )
    expect(zones["needs-you"].map(c => c.id).sort()).toEqual(["a", "b"])
    expect(zones["running"].map(c => c.id)).toEqual(["c"])
    expect(zones["paused"].map(c => c.id)).toEqual(["e"])
    expect(zones["terminal"].map(c => c.id)).toEqual(["d"])
  })

  it("cards within a zone sort oldest-updated first (longest-waiting on top)", () => {
    const zones = groupIntoZones(
      [
        item({ id: "fresh", status: "waiting_human", updatedAt: 90_000 }),
        item({ id: "stale", status: "waiting_human", updatedAt: 10_000 }),
      ],
      100_000,
    )
    expect(zones["needs-you"].map(c => c.id)).toEqual(["stale", "fresh"])
  })
})
