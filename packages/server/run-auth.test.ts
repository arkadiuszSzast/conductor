import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { openMigratedDatabase, type DatabaseConnection } from "./src/database.ts"
import { Store } from "./src/store.ts"
import {
  constantTimeEquals,
  extractBearerToken,
  generateRunToken,
  hashRunToken,
  issueRunCredential,
  verifyRunCredential,
} from "./src/run-auth.ts"

let directory: string
let connection: DatabaseConnection
let store: Store

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "conductor-run-auth-"))
  connection = openMigratedDatabase({ path: join(directory, "state.db") })
  store = new Store(connection.db)
})

afterEach(() => {
  connection.close()
  rmSync(directory, { recursive: true, force: true })
})

function seedRun(): string {
  const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
  store.applyTransition(feature.id, { kind: "feature.start" }, {
    decisions: [{ kind: "execute_step", jobId: "main", stepId: "work" }],
    patch: { status: "running", jobs: { main: { status: "running", currentStep: "work", steps: { work: { status: "running" } } } } },
  })
  return store.insertRun({ featureId: feature.id, jobId: "main", stepId: "work", stepType: "agent", attempt: 1 })
}

describe("4.1: generateRunToken / hashRunToken", () => {
  it("generates a 256-bit (32-byte, 64-hex-char) random token", () => {
    const token = generateRunToken()
    expect(token).toMatch(/^[0-9a-f]{64}$/)
  })

  it("generates distinct tokens on each call", () => {
    expect(generateRunToken()).not.toBe(generateRunToken())
  })

  it("hashes deterministically (same input -> same hash)", () => {
    const token = generateRunToken()
    expect(hashRunToken(token)).toBe(hashRunToken(token))
  })

  it("different tokens hash to different values", () => {
    expect(hashRunToken(generateRunToken())).not.toBe(hashRunToken(generateRunToken()))
  })
})

describe("4.1: issueRunCredential / verifyRunCredential", () => {
  it("issues a credential whose plaintext verifies successfully", () => {
    const runId = seedRun()
    const issued = issueRunCredential(store, { runId, attempt: 1, processGeneration: 1, nowMs: 1000 })
    const result = verifyRunCredential(store, issued.token, 2000)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.credential.runId).toBe(runId)
  })

  it("never stores the plaintext token — only its hash is persisted", () => {
    const runId = seedRun()
    const issued = issueRunCredential(store, { runId, attempt: 1, processGeneration: 1, nowMs: 1000 })
    expect(issued.record.tokenHash).toBe(hashRunToken(issued.token))
    expect(issued.record.tokenHash).not.toBe(issued.token)
    // Confirm the record shape itself carries no plaintext field at all.
    expect(JSON.stringify(issued.record)).not.toContain(issued.token)
  })

  it("rejects a token that was never issued", () => {
    const result = verifyRunCredential(store, generateRunToken(), 1000)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("missing")
  })

  it("rejects a malformed/empty token without a store lookup", () => {
    const result = verifyRunCredential(store, "", 1000)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("malformed")
  })

  it("rejects an expired credential", () => {
    const runId = seedRun()
    const issued = issueRunCredential(store, { runId, attempt: 1, processGeneration: 1, nowMs: 1000, expiresAt: 1500 })
    const result = verifyRunCredential(store, issued.token, 2000)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("expired")
  })

  it("rejects a credential revoked for a non-conclusion reason (fenced/abandoned)", () => {
    const runId = seedRun()
    const issued = issueRunCredential(store, { runId, attempt: 1, processGeneration: 1, nowMs: 1000 })
    store.revokeCredential(issued.record.id, "fenced: lost_prompt_response")
    const result = verifyRunCredential(store, issued.token, 2000)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("revoked")
  })

  it("distinguishes revoked-for-normal-conclusion, allowing the caller to implement the narrow already-concluded allowance", () => {
    const runId = seedRun()
    const issued = issueRunCredential(store, { runId, attempt: 1, processGeneration: 1, nowMs: 1000 })
    store.revokeCredential(issued.record.id, "run_concluded")
    const result = verifyRunCredential(store, issued.token, 2000, { revocationReasonForConcluded: "run_concluded" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("revoked_concluded")
  })

  it("cross-run: a credential for one run never verifies against another run's context (caller must still compare .credential.runId)", () => {
    const runA = seedRun()
    const runB = seedRun()
    const issued = issueRunCredential(store, { runId: runA, attempt: 1, processGeneration: 1, nowMs: 1000 })
    const result = verifyRunCredential(store, issued.token, 2000)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.credential.runId).toBe(runA)
      expect(result.credential.runId).not.toBe(runB)
    }
  })

  it("revalidates cleanly at a later mutation-commit-time call (rechecked at commit, not just preflight)", () => {
    const runId = seedRun()
    const issued = issueRunCredential(store, { runId, attempt: 1, processGeneration: 1, nowMs: 1000 })
    // Simulate: preflight passes...
    expect(verifyRunCredential(store, issued.token, 1100).ok).toBe(true)
    // ...then a revocation race lands before the "commit-time" recheck.
    store.revokeCredential(issued.record.id, "fenced: race")
    const commitTimeResult = verifyRunCredential(store, issued.token, 1200)
    expect(commitTimeResult.ok).toBe(false)
  })
})

describe("4.1: constantTimeEquals / extractBearerToken", () => {
  it("constantTimeEquals matches identical strings", () => {
    expect(constantTimeEquals("abc", "abc")).toBe(true)
  })

  it("constantTimeEquals rejects differing strings/lengths", () => {
    expect(constantTimeEquals("abc", "abcd")).toBe(false)
    expect(constantTimeEquals("abc", "xyz")).toBe(false)
  })

  it("extractBearerToken parses a valid Authorization header", () => {
    expect(extractBearerToken("Bearer abc123")).toBe("abc123")
  })

  it("extractBearerToken rejects a missing/malformed header", () => {
    expect(extractBearerToken(null)).toBeNull()
    expect(extractBearerToken("Basic abc123")).toBeNull()
    expect(extractBearerToken("Bearer ")).toBeNull()
  })
})

describe("4.1: no plaintext token in database", () => {
  it("scanning every row in run_credential never finds the plaintext token substring", () => {
    const runId = seedRun()
    const issued = issueRunCredential(store, { runId, attempt: 1, processGeneration: 1, nowMs: 1000 })
    const rows = connection.db.query("SELECT * FROM run_credential").all() as Array<Record<string, unknown>>
    for (const row of rows) {
      expect(JSON.stringify(row)).not.toContain(issued.token)
    }
  })
})
