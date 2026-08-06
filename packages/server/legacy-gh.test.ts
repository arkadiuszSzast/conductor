import { describe, expect, it } from "bun:test"
import { RealGh } from "./src/legacy/gh.ts"
import type { ProcessExecOptions, ProcessExecResult, ProcessRunner } from "./src/legacy/ports.ts"

function fakeProcess(handler: (command: readonly string[], options: ProcessExecOptions) => ProcessExecResult): ProcessRunner {
  return {
    exec: async (command, options) => handler(command, options),
    shell: async () => ({ code: 0, stdout: "", stderr: "", output: "" }),
  }
}

describe("RealGh postComment/postReview error sanitization", () => {
  it("never leaks the provided token in a postComment failure", async () => {
    const token = "s3cr3t-bot-token-xyz"
    const process = fakeProcess(() => ({
      code: 1,
      stdout: `gh: request failed with GH_TOKEN=${token} against api.github.com`,
      stderr: "",
      output: "",
    }))
    const gh = new RealGh(process, "/tmp")
    const result = await gh.postComment("o/r", 1, "body", { cwd: "/tmp", token })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.error).not.toContain(token)
    expect(result.error).toContain("[REDACTED]")
  })

  it("never leaks the provided token in a postReview failure", async () => {
    const token = "another-secret-token-456"
    const process = fakeProcess(() => ({
      code: 1,
      stdout: "",
      stderr: `403 Forbidden: token ${token} lacks permission`,
      output: "",
    }))
    const gh = new RealGh(process, "/tmp")
    const result = await gh.postReview("o/r", 1, { event: "APPROVE", body: "lgtm" }, { cwd: "/tmp", token })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.error).not.toContain(token)
    expect(result.error).toContain("[REDACTED]")
  })

  it("redacts a classic ghp_ personal access token even without an explicit call token", async () => {
    const leaked = "ghp_" + "A".repeat(36)
    const process = fakeProcess(() => ({
      code: 1,
      stdout: `error: failed to auth using ${leaked}`,
      stderr: "",
      output: "",
    }))
    const gh = new RealGh(process, "/tmp")
    const result = await gh.postComment("o/r", 1, "body", { cwd: "/tmp" })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.error).not.toContain(leaked)
    expect(result.error).not.toMatch(/ghp_[A-Za-z0-9]{20,}/)
  })

  it("redacts a fine-grained github_pat_ token", async () => {
    const leaked = "github_pat_" + "B".repeat(30) + "_" + "C".repeat(20)
    const process = fakeProcess(() => ({
      code: 1,
      stdout: "",
      stderr: `invalid credentials: ${leaked}`,
      output: "",
    }))
    const gh = new RealGh(process, "/tmp")
    const result = await gh.postReview("o/r", 1, { event: "APPROVE", body: "lgtm" }, { cwd: "/tmp" })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.error).not.toContain(leaked)
    expect(result.error).not.toMatch(/github_pat_[A-Za-z0-9_]{20,}/)
  })

  it("redacts an Authorization: Bearer-style credential", async () => {
    const bearer = "Bearer " + "d".repeat(40)
    const process = fakeProcess(() => ({
      code: 1,
      stdout: `HTTP 401: Authorization header was ${bearer}`,
      stderr: "",
      output: "",
    }))
    const gh = new RealGh(process, "/tmp")
    const result = await gh.postComment("o/r", 1, "body", { cwd: "/tmp" })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.error).not.toContain(bearer)
    expect(result.error).not.toMatch(/Bearer\s+[A-Za-z0-9._~+/-]{10,}/i)
  })

  it("redacts a credential even when it straddles the output cap boundary", async () => {
    const token = "ghp_" + "E".repeat(40)
    const padding = "x".repeat(290)
    const process = fakeProcess(() => ({
      code: 1,
      stdout: `${padding}${token}`,
      stderr: "",
      output: "",
    }))
    const gh = new RealGh(process, "/tmp")
    const result = await gh.postComment("o/r", 1, "body", { cwd: "/tmp" })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.error).not.toContain(token)
    expect(result.error).not.toMatch(/ghp_[A-Za-z0-9]{10,}/)
  })

  it("still caps the sanitized error to a bounded tail", async () => {
    const process = fakeProcess(() => ({
      code: 1,
      stdout: "e".repeat(5_000),
      stderr: "",
      output: "",
    }))
    const gh = new RealGh(process, "/tmp")
    const result = await gh.postReview("o/r", 1, { event: "APPROVE", body: "lgtm" }, { cwd: "/tmp" })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.error.length).toBeLessThanOrEqual(300)
  })
})
