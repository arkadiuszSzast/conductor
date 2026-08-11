/**
 * Fetch-based SSE reader — frame parsing against crafted streams.
 * The reader is the most novel runtime code in the data layer: it must
 * parse `event:`/`data:` frames split across arbitrary chunk boundaries,
 * honor `retry:` and reject non-200 responses so auth failures surface.
 */
import { describe, expect, it } from "bun:test"
import { readSseStream, SseDropError, SseHttpError, type FetchLike, type SseFrame } from "../src/api/client.ts"

function streamOf(chunks: readonly string[]): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(body, { status: 200 })
}

async function collect(chunks: readonly string[]): Promise<{ frames: SseFrame[]; retries: number[] }> {
  const frames: SseFrame[] = []
  const retries: number[] = []
  const fetchImpl = (() => Promise.resolve(streamOf(chunks))) as FetchLike
  try {
    await readSseStream({
      url: "/v1/events",
      token: () => null,
      fetch: fetchImpl,
      onFrame: frame => frames.push(frame),
      onRetryDelay: ms => retries.push(ms),
    })
  } catch (err) {
    if (!(err instanceof SseDropError)) throw err
  }
  return { frames, retries }
}

describe("SSE reader", () => {
  it("parses the server's hello frame with the retry delay", async () => {
    const { frames, retries } = await collect(['retry: 2000\nevent: hello\ndata: {"requestId":"r-1"}\n\n'])
    expect(frames).toEqual([{ type: "hello", requestId: "r-1" }])
    expect(retries).toEqual([2000])
  })

  it("parses change frames into typed invalidations", async () => {
    const { frames } = await collect([
      'event: change\ndata: {"kind":"feature","featureId":"f-1"}\n\n',
      'event: change\ndata: {"kind":"run_log","featureId":"f-2"}\n\n',
    ])
    expect(frames).toEqual([
      { type: "change", change: { kind: "feature", featureId: "f-1" } },
      { type: "change", change: { kind: "run_log", featureId: "f-2" } },
    ])
  })

  it("reassembles frames split across chunk boundaries", async () => {
    const { frames } = await collect([
      "event: cha",
      'nge\ndata: {"kind":"transi',
      'tion","featureId":"f-3"}\n',
      "\n",
    ])
    expect(frames).toEqual([{ type: "change", change: { kind: "transition", featureId: "f-3" } }])
  })

  it("handles several frames arriving in one chunk", async () => {
    const { frames } = await collect([
      'event: change\ndata: {"kind":"run","featureId":"a"}\n\nevent: change\ndata: {"kind":"finding","featureId":"a"}\n\n',
    ])
    expect(frames.map(f => (f.type === "change" ? f.change.kind : f.type))).toEqual(["run", "finding"])
  })

  it("ignores malformed data payloads without dying", async () => {
    const { frames } = await collect([
      "event: change\ndata: {broken\n\n",
      'event: change\ndata: {"kind":"feature","featureId":"ok"}\n\n',
    ])
    expect(frames).toEqual([{ type: "change", change: { kind: "feature", featureId: "ok" } }])
  })

  it("ignores comment lines per the SSE spec", async () => {
    const { frames } = await collect([': keepalive\n\nevent: change\ndata: {"kind":"feature","featureId":"x"}\n\n'])
    expect(frames).toEqual([{ type: "change", change: { kind: "feature", featureId: "x" } }])
  })

  it("throws SseHttpError on a non-200 response so 401 surfaces to auth", async () => {
    const fetchImpl = (() => Promise.resolve(new Response("nope", { status: 401 }))) as FetchLike
    await expect(
      readSseStream({ url: "/v1/events", token: () => "t", fetch: fetchImpl, onFrame: () => {} }),
    ).rejects.toBeInstanceOf(SseHttpError)
  })

  it("sends the bearer header when a token is present", async () => {
    let seenAuth = ""
    const fetchImpl = ((url: RequestInfo | URL, init?: RequestInit) => {
      seenAuth = (init?.headers as Record<string, string>)["authorization"] ?? ""
      return Promise.resolve(streamOf([]))
    }) as FetchLike
    try {
      await readSseStream({ url: "/v1/events", token: () => "secret", fetch: fetchImpl, onFrame: () => {} })
    } catch {
      // clean close throws SseDropError
    }
    expect(seenAuth).toBe("Bearer secret")
  })

  it("ends with a drop error when the server closes the stream", async () => {
    const fetchImpl = (() => Promise.resolve(streamOf([]))) as FetchLike
    await expect(
      readSseStream({ url: "/v1/events", token: () => null, fetch: fetchImpl, onFrame: () => {} }),
    ).rejects.toBeInstanceOf(SseDropError)
  })
})
