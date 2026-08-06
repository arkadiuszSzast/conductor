import { describe, expect, it } from "bun:test"
import { makePublishReviewLegacy, parseFindingsLegacy, parseResolutionsLegacy, severitySummaryLegacy } from "./src/legacy/publish-review.ts"
import type { LegacyGh, LegacyReviewPayload, ProcessExecResult, ProcessRunner } from "./src/legacy/ports.ts"

function fakeProcess(scripted: ProcessExecResult = { code: 0, stdout: "minted-token\n", stderr: "", output: "minted-token\n" }): ProcessRunner {
  return {
    exec: async () => scripted,
    shell: async () => scripted,
  }
}

describe("parseFindingsLegacy", () => {
  it("parses fenced JSON findings and defaults unknown severity to major", () => {
    const notes = "```json\n{\"summary\":\"looks ok\",\"findings\":[{\"path\":\"a.ts\",\"line\":3,\"body\":\"nit\"}]}\n```"
    const parsed = parseFindingsLegacy(notes)
    expect(parsed.summary).toBe("looks ok")
    expect(parsed.findings).toHaveLength(1)
    expect(parsed.findings[0]?.severity).toBe("major")
  })

  it("degrades to summary-only on unparseable notes", () => {
    const parsed = parseFindingsLegacy("just some plain text")
    expect(parsed.findings).toEqual([])
    expect(parsed.summary).toBe("just some plain text")
  })
})

describe("parseResolutionsLegacy", () => {
  it("parses resolutions and rejects invalid statuses", () => {
    const notes = '{"resolutions":[{"id":"F1","status":"fixed"},{"id":"F2","status":"bogus"}]}'
    expect(parseResolutionsLegacy(notes)).toEqual([{ id: "F1", status: "fixed" }])
  })
})

describe("severitySummaryLegacy", () => {
  it("orders blocker to nit and pluralizes", () => {
    const summary = severitySummaryLegacy([
      { path: "a", line: 1, severity: "minor", tags: [], body: "" },
      { path: "a", line: 2, severity: "blocker", tags: [], body: "" },
      { path: "a", line: 3, severity: "minor", tags: [], body: "" },
    ])
    expect(summary).toBe("1 blocker, 2 minors")
  })
})

describe("makePublishReviewLegacy", () => {
  it("returns publish: none for mode none without calling gh", async () => {
    let called = false
    const gh: LegacyGh = fakeGh({ postReview: async () => { called = true; return { ok: true } } })
    const publish = makePublishReviewLegacy(gh, fakeProcess())
    const result = await publish({ repo: "o/r", pr: 1, verdict: "approved", notes: "", publish: { mode: "none" }, cwd: "/tmp" })
    expect(result).toBe("publish: none")
    expect(called).toBe(false)
  })

  it("posts an atomic review with inline comments on success", async () => {
    let payload: LegacyReviewPayload | undefined
    const gh: LegacyGh = fakeGh({
      postReview: async (_repo, _pr, p) => {
        payload = p
        return { ok: true }
      },
    })
    const publish = makePublishReviewLegacy(gh, fakeProcess())
    const notes = '{"summary":"lgtm","findings":[{"path":"a.ts","line":1,"body":"nit","severity":"nit"}]}'
    const result = await publish({
      repo: "o/r",
      pr: 1,
      verdict: "approved",
      notes,
      publish: { mode: "github-review" },
      cwd: "/tmp",
      findingIds: ["F1"],
    })
    expect(result).toContain("review posted")
    expect(payload?.event).toBe("APPROVE")
    expect(payload?.comments?.[0]?.body).toContain("`F1`")
  })

  it("degrades own-PR identity rejection to a plain comment", async () => {
    const gh: LegacyGh = fakeGh({
      postReview: async () => ({ ok: false, error: "cannot review your own pull request" }),
      postComment: async () => ({ ok: true }),
    })
    const publish = makePublishReviewLegacy(gh, fakeProcess())
    const result = await publish({ repo: "o/r", pr: 1, verdict: "approved", notes: "notes", publish: { mode: "github-review" }, cwd: "/tmp" })
    expect(result).toContain("degraded to comment")
  })

  it("mints a bot token via the injected ProcessRunner, never a bare shell", async () => {
    let tokenSeen: string | undefined
    const gh: LegacyGh = fakeGh({
      postComment: async (_repo, _pr, _body, opts) => {
        tokenSeen = opts.token
        return { ok: true }
      },
    })
    const process = fakeProcess({ code: 0, stdout: "  bot-token-123  \n", stderr: "", output: "  bot-token-123  \n" })
    const publish = makePublishReviewLegacy(gh, process)
    await publish({
      repo: "o/r",
      pr: 1,
      verdict: "approved",
      notes: "notes",
      publish: { mode: "comment-only", tokenCommand: "mint-token" },
      cwd: "/tmp",
    })
    expect(tokenSeen).toBe("bot-token-123")
  })
})

function fakeGh(over: Partial<LegacyGh> = {}): LegacyGh {
  return {
    prChecks: async () => ({ allConcluded: true, anyFailed: false, failedNames: [] }),
    prView: async () => ({ number: 1, headSha: "sha", state: "OPEN", mergeable: "MERGEABLE" }),
    prCreate: async () => 1,
    prMerge: async () => {},
    unresolvedThreadCount: async () => 0,
    unresolvedThreads: async () => [],
    resolveThread: async () => {},
    replyToThread: async () => {},
    reviewActivitySince: async () => 0,
    postComment: async () => ({ ok: true }),
    postReview: async () => ({ ok: true }),
    ...over,
  }
}
