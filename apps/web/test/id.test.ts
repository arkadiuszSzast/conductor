import { describe, expect, it } from "bun:test"
import { createIdempotencyKey } from "../src/lib/id.ts"

describe("createIdempotencyKey", () => {
  it("uses the native UUID generator when available", () => {
    let getRandomValuesCalled = false
    const key = createIdempotencyKey({
      randomUUID: () => "native-id",
      getRandomValues: bytes => {
        getRandomValuesCalled = true
        return bytes
      },
    })

    expect(key).toBe("native-id")
    expect(getRandomValuesCalled).toBe(false)
  })

  it("generates a UUID when randomUUID is unavailable", () => {
    const key = createIdempotencyKey({
      getRandomValues: bytes => {
        bytes.forEach((_, index) => {
          bytes[index] = index
        })
        return bytes
      },
    })

    expect(key).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f")
  })

  it("still generates an opaque key without Web Crypto", () => {
    expect(createIdempotencyKey(null)).toMatch(/^recover-[a-z0-9]+-[a-z0-9]+-[a-z0-9]+$/)
  })
})
