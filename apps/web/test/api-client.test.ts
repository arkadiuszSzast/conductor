/**
 * `ApiClient` — the centralized 401 handling (`request()` fires
 * `onUnauthorized` for every read and mutation) and `startFeature`'s wire
 * contract, per `start-work-from-control-room` task 3.1.
 */
import { describe, expect, it } from "bun:test"
import { ApiClient, ApiError, type FetchLike } from "../src/api/client.ts"
import type { StartFeatureRequest } from "../src/api/types.ts"

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

describe("ApiClient: central 401 handling", () => {
  it("fires onUnauthorized on a 401 from a read (GET)", async () => {
    let unauthorized = 0
    const fetchImpl = (async () => jsonResponse(401, { error: { code: "unauthorized", message: "no", requestId: "r" } })) as FetchLike
    const client = new ApiClient({ token: () => null, onUnauthorized: () => unauthorized++, fetch: fetchImpl })
    await expect(client.health()).rejects.toBeInstanceOf(ApiError)
    expect(unauthorized).toBe(1)
  })

  it("fires onUnauthorized on a 401 from a mutation (POST)", async () => {
    let unauthorized = 0
    const fetchImpl = (async () => jsonResponse(401, { error: { code: "unauthorized", message: "no", requestId: "r" } })) as FetchLike
    const client = new ApiClient({ token: () => null, onUnauthorized: () => unauthorized++, fetch: fetchImpl })
    await expect(client.startFeature({ title: "T", project: "/p" })).rejects.toBeInstanceOf(ApiError)
    expect(unauthorized).toBe(1)
  })

  it("does not fire onUnauthorized on a non-401 failure", async () => {
    let unauthorized = 0
    const fetchImpl = (async () => jsonResponse(500, { error: { code: "internal", message: "boom", requestId: "r" } })) as FetchLike
    const client = new ApiClient({ token: () => null, onUnauthorized: () => unauthorized++, fetch: fetchImpl })
    await expect(client.health()).rejects.toBeInstanceOf(ApiError)
    expect(unauthorized).toBe(0)
  })

  it("does not fire onUnauthorized on success", async () => {
    let unauthorized = 0
    const fetchImpl = (async () => jsonResponse(200, { alive: true })) as FetchLike
    const client = new ApiClient({ token: () => null, onUnauthorized: () => unauthorized++, fetch: fetchImpl })
    await client.request("/v1/health")
    expect(unauthorized).toBe(0)
  })
})

describe("ApiClient.startFeature", () => {
  it("POSTs the request body verbatim to /v1/features", async () => {
    let capturedPath = ""
    let capturedBody: unknown = null
    const request: StartFeatureRequest = {
      title: "Add dark mode",
      project: "/home/dev/project",
      description: "task text",
      workflow: "delivery",
      pr: 42,
      inputs: { feature: "auth", count: 5, verbose: true },
    }
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      capturedPath = String(url)
      capturedBody = JSON.parse(String(init?.body))
      return jsonResponse(201, {
        feature: {
          id: "f-new",
          title: "Add dark mode",
          slug: "add-dark-mode",
          projectDir: "/home/dev/project",
          workflow: "delivery",
          description: "task text",
          status: "running",
          sessionId: null,
          worktree: null,
          branch: null,
          pr: 42,
          escalation: null,
          currentStep: null,
          createdAt: 1,
          updatedAt: 1,
          findingCounts: { new: 0, fixed: 0, dismissed: 0, reopened: 0 },
          workflowRef: { name: "delivery", stale: false },
          feedback: null,
          jobs: {},
        },
        activeRun: null,
      })
    }) as FetchLike
    const client = new ApiClient({ token: () => null, fetch: fetchImpl })
    const response = await client.startFeature(request)
    expect(capturedPath).toBe("/v1/features")
    expect(capturedBody).toEqual(request)
    expect(response.feature.id).toBe("f-new")
  })

  it("surfaces a 422 invalid_input rejection with per-input diagnostics", async () => {
    const fetchImpl = (async () =>
      jsonResponse(422, {
        error: { code: "invalid_input", message: 'input "feature" is required', requestId: "r-1" },
        diagnostics: [{ name: "feature", kind: "missing_required", message: 'input "feature" is required (type: string)' }],
      })) as FetchLike
    const client = new ApiClient({ token: () => null, fetch: fetchImpl })
    try {
      await client.startFeature({ title: "T", project: "/p", inputs: {} })
      throw new Error("expected rejection")
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError)
      const apiErr = err as ApiError
      expect(apiErr.status).toBe(422)
      expect(apiErr.code).toBe("invalid_input")
      expect(apiErr.diagnostics).toEqual([
        { name: "feature", kind: "missing_required", message: 'input "feature" is required (type: string)' },
      ])
    }
  })

  it("a plain error response (no diagnostics) leaves ApiError.diagnostics null", async () => {
    const fetchImpl = (async () =>
      jsonResponse(409, { error: { code: "unknown_workflow", message: "workflow changed", requestId: "r-2" } })) as FetchLike
    const client = new ApiClient({ token: () => null, fetch: fetchImpl })
    try {
      await client.startFeature({ title: "T", project: "/p" })
      throw new Error("expected rejection")
    } catch (err) {
      expect((err as ApiError).diagnostics).toBeNull()
    }
  })
})
