/**
 * Rail persistence — `localStorageRailStorage`'s parse/tolerate-garbage
 * behavior (plugin-panels spec: "Rail state survives reload"), mirroring
 * `auth-store.ts`'s storage test conventions.
 */
import { describe, expect, it } from "bun:test"

class FakeLocalStorage {
  private store = new Map<string, string>()
  getItem(key: string): string | null {
    return this.store.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value)
  }
  removeItem(key: string): void {
    this.store.delete(key)
  }
}

describe("localStorageRailStorage", () => {
  it("returns null before anything is persisted", async () => {
    ;(globalThis as { localStorage?: unknown }).localStorage = new FakeLocalStorage()
    const { localStorageRailStorage } = await import("../src/plugins/rail-storage.ts")
    expect(localStorageRailStorage().get()).toBeNull()
  })

  it("round-trips a persisted open/selected state", async () => {
    ;(globalThis as { localStorage?: unknown }).localStorage = new FakeLocalStorage()
    const { localStorageRailStorage } = await import("../src/plugins/rail-storage.ts")
    const storage = localStorageRailStorage()
    storage.set({ open: true, selectedId: "openspec" })
    expect(storage.get()).toEqual({ open: true, selectedId: "openspec" })
  })

  it("round-trips a closed state with no selection", async () => {
    ;(globalThis as { localStorage?: unknown }).localStorage = new FakeLocalStorage()
    const { localStorageRailStorage } = await import("../src/plugins/rail-storage.ts")
    const storage = localStorageRailStorage()
    storage.set({ open: false, selectedId: null })
    expect(storage.get()).toEqual({ open: false, selectedId: null })
  })

  it("treats malformed persisted JSON as absent rather than throwing", async () => {
    const fake = new FakeLocalStorage()
    fake.setItem("conductor.plugin-rail", "{not json")
    ;(globalThis as { localStorage?: unknown }).localStorage = fake
    const { localStorageRailStorage } = await import("../src/plugins/rail-storage.ts")
    expect(localStorageRailStorage().get()).toBeNull()
  })

  it("treats a persisted shape missing the required open boolean as absent", async () => {
    const fake = new FakeLocalStorage()
    fake.setItem("conductor.plugin-rail", JSON.stringify({ selectedId: "x" }))
    ;(globalThis as { localStorage?: unknown }).localStorage = fake
    const { localStorageRailStorage } = await import("../src/plugins/rail-storage.ts")
    expect(localStorageRailStorage().get()).toBeNull()
  })
})
