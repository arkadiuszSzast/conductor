import { describe, expect, it } from "bun:test"
import { formatAge } from "../src/lib/time.ts"

describe("formatAge", () => {
  it("scales from seconds through days", () => {
    expect(formatAge(10_000, 9_000)).toBe("just now")
    expect(formatAge(60_000, 10_000)).toBe("50s")
    expect(formatAge(10 * 60_000, 0)).toBe("10m")
    expect(formatAge(2 * 3_600_000 + 3 * 60_000, 0)).toBe("2h 3m")
    expect(formatAge(3 * 86_400_000, 0)).toBe("3d")
  })

  it("clamps future timestamps to zero", () => {
    expect(formatAge(1_000, 5_000)).toBe("just now")
  })
})
