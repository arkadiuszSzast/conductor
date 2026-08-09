import { describe, expect, it } from "bun:test"
import { makePublishReview, parseFindings, parseResolutions, severitySummary } from "./src/engine/publish-review.ts"
import type { GhClient, ReviewPayload, ProcessExecResult, ProcessRunner } from "./src/engine/ports.ts"

function fakeProcess(scripted: ProcessExecResult = { code: 0, stdout: "minted-token\n", stderr: "", output: "minted-token\n" }): ProcessRunner {
  return {
    exec: async () => scripted,
    shell: async () => scripted,
  }
}

describe("parseFindings", () => {
  it("parses a bare JSON object with findings", () => {
    const notes = JSON.stringify({
      summary: "Two issues",
      findings: [
        { path: "src/a.ts", line: 10, body: "bug one" },
        { path: "src/b.ts", line: 20, side: "LEFT", body: "bug two" },
      ],
    })
    const result = parseFindings(notes)
    expect(result.summary).toBe("Two issues")
    expect(result.findings).toHaveLength(2)
    expect(result.findings[1]?.side).toBe("LEFT")
  })

  it("parses JSON inside a markdown fence with leading prose", () => {
    const notes = 'Here is my review:\n```json\n{"summary":"ok","findings":[{"path":"x.ts","line":1,"body":"y"}]}\n```'
    const result = parseFindings(notes)
    expect(result.summary).toBe("ok")
    expect(result.findings).toHaveLength(1)
  })

  it("parses fenced JSON findings and defaults unknown severity to major", () => {
    const notes = "```json\n{\"summary\":\"looks ok\",\"findings\":[{\"path\":\"a.ts\",\"line\":3,\"body\":\"nit\"}]}\n```"
    const parsed = parseFindings(notes)
    expect(parsed.summary).toBe("looks ok")
    expect(parsed.findings).toHaveLength(1)
    expect(parsed.findings[0]?.severity).toBe("major")
  })

  it("degrades plain text to summary-only", () => {
    const result = parseFindings("Just a plain review, no JSON.")
    expect(result.summary).toBe("Just a plain review, no JSON.")
    expect(result.findings).toEqual([])
  })

  it("degrades to summary-only on unparseable notes", () => {
    const parsed = parseFindings("just some plain text")
    expect(parsed.findings).toEqual([])
    expect(parsed.summary).toBe("just some plain text")
  })

  it("degrades broken JSON to summary-only with the raw text", () => {
    const result = parseFindings('{"summary": "unterminated')
    expect(result.summary).toContain("unterminated")
    expect(result.findings).toEqual([])
  })

  it("filters malformed finding entries, keeps valid ones", () => {
    const notes = JSON.stringify({
      summary: "s",
      findings: [
        { path: "ok.ts", line: 5, body: "valid" },
        { path: "bad.ts", body: "missing line" },
        { line: 3, body: "missing path" },
        "not an object",
      ],
    })
    const result = parseFindings(notes)
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]?.path).toBe("ok.ts")
  })

  it("parses severity and tags; missing/unknown severity defaults to major", () => {
    const notes = JSON.stringify({
      summary: "s",
      findings: [
        { path: "a.ts", line: 1, severity: "blocker", tags: ["correctness"], body: "x" },
        { path: "b.ts", line: 2, severity: "made-up", body: "y" },
        { path: "c.ts", line: 3, body: "z", tags: ["style", 7, "tests"] },
      ],
    })
    const result = parseFindings(notes)
    expect(result.findings[0]?.severity).toBe("blocker")
    expect(result.findings[0]?.tags).toEqual(["correctness"])
    expect(result.findings[1]?.severity).toBe("major")
    expect(result.findings[2]?.severity).toBe("major")
    expect(result.findings[2]?.tags).toEqual(["style", "tests"])
  })
})

describe("parseResolutions", () => {
  it("parses resolutions and rejects invalid statuses", () => {
    const notes = '{"resolutions":[{"id":"F1","status":"fixed"},{"id":"F2","status":"bogus"}]}'
    expect(parseResolutions(notes)).toEqual([{ id: "F1", status: "fixed" }])
  })
})

describe("severitySummary", () => {
  it("orders blocker to nit and pluralizes", () => {
    const summary = severitySummary([
      { path: "a", line: 1, severity: "minor", tags: [], body: "" },
      { path: "a", line: 2, severity: "blocker", tags: [], body: "" },
      { path: "a", line: 3, severity: "minor", tags: [], body: "" },
    ])
    expect(summary).toBe("1 blocker, 2 minors")
  })

  it("aggregates ordered blocker→nit, omitting zero counts", () => {
    const notes = JSON.stringify({
      summary: "s",
      findings: [
        { path: "a.ts", line: 1, severity: "nit", body: "n" },
        { path: "b.ts", line: 2, severity: "blocker", body: "b" },
        { path: "c.ts", line: 3, severity: "nit", body: "n2" },
        { path: "d.ts", line: 4, body: "m" },
      ],
    })
    const { findings } = parseFindings(notes)
    expect(severitySummary(findings)).toBe("1 blocker, 1 major, 2 nit")
  })
})

describe("makePublishReview", () => {
  it("returns publish: none for mode none without calling gh", async () => {
    let called = false
    const gh: GhClient = fakeGh({ postReview: async () => { called = true; return { ok: true } } })
    const publish = makePublishReview(gh, fakeProcess())
    const result = await publish({ repo: "o/r", pr: 1, verdict: "approved", notes: "", publish: { mode: "none" }, cwd: "/tmp" })
    expect(result).toBe("publish: none")
    expect(called).toBe(false)
  })

  it("posts an atomic review with inline comments on success", async () => {
    let payload: ReviewPayload | undefined
    const gh: GhClient = fakeGh({
      postReview: async (_repo, _pr, p) => {
        payload = p
        return { ok: true }
      },
    })
    const publish = makePublishReview(gh, fakeProcess())
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
    const gh: GhClient = fakeGh({
      postReview: async () => ({ ok: false, error: "cannot review your own pull request" }),
      postComment: async () => ({ ok: true }),
    })
    const publish = makePublishReview(gh, fakeProcess())
    const result = await publish({ repo: "o/r", pr: 1, verdict: "approved", notes: "notes", publish: { mode: "github-review" }, cwd: "/tmp" })
    expect(result).toContain("degraded to comment")
  })

  it("mints a bot token via the injected ProcessRunner, never a bare shell", async () => {
    let tokenSeen: string | undefined
    const gh: GhClient = fakeGh({
      postComment: async (_repo, _pr, _body, opts) => {
        tokenSeen = opts.token
        return { ok: true }
      },
    })
    const process = fakeProcess({ code: 0, stdout: "  bot-token-123  \n", stderr: "", output: "  bot-token-123  \n" })
    const publish = makePublishReview(gh, process)
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

  it("returns a token failure without calling GitHub", async () => {
    let called = false
    const gh = fakeGh({ postComment: async () => { called = true; return { ok: true } } })
    const publish = makePublishReview(gh, fakeProcess({ code: 1, stdout: "", stderr: "denied", output: "denied" }))
    const result = await publish({ repo: "o/r", pr: 1, verdict: "approved", notes: "notes", publish: { mode: "comment-only", tokenCommand: "mint-token" }, cwd: "/tmp" })
    expect(result).toBe("publish FAILED (token): tokenCommand exited 1")
    expect(called).toBe(false)
  })

  it("retries a rejected inline review as a body-only review", async () => {
    const payloads: ReviewPayload[] = []
    const gh = fakeGh({
      postReview: async (_repo, _pr, payload) => {
        payloads.push(payload)
        return payload.comments ? { ok: false, error: "line mapping failed" } : { ok: true }
      },
    })
    const publish = makePublishReview(gh, fakeProcess())
    const result = await publish({
      repo: "o/r",
      pr: 1,
      verdict: "changes_requested",
      notes: '{"summary":"needs work","findings":[{"path":"a.ts","line":1,"body":"bug"}]}',
      publish: { mode: "github-review" },
      cwd: "/tmp",
      findingIds: ["F1"],
    })
    expect(result).toContain("inline comments degraded to body")
    expect(payloads).toHaveLength(2)
    expect(payloads[0]?.comments).toHaveLength(1)
    expect(payloads[1]?.comments).toBeUndefined()
    expect(payloads[1]?.body).toContain("F1")
  })

  it("returns the original review failure when the body-only retry also fails", async () => {
    const gh = fakeGh({ postReview: async () => ({ ok: false, error: "review rejected" }) })
    const publish = makePublishReview(gh, fakeProcess())
    const result = await publish({
      repo: "o/r",
      pr: 1,
      verdict: "changes_requested",
      notes: '{"summary":"needs work","findings":[{"path":"a.ts","line":1,"body":"bug"}]}',
      publish: { mode: "github-review" },
      cwd: "/tmp",
    })
    expect(result).toBe("publish FAILED (review): review rejected")
  })
})

function fakeGh(over: Partial<GhClient> = {}): GhClient {
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
