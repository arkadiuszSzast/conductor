/**
 * Rail persistence — selected plugin tab + open/collapsed state survive
 * a reload (spec: "Rail state survives reload"). Mirrors
 * `auth/auth-store.ts`'s `localStorageAuthStorage` shape: a small
 * storage interface with a real `localStorage`-backed implementation and
 * `try/catch` guards for private-mode/unavailable storage.
 */

export interface RailPersistedState {
  readonly open: boolean
  readonly selectedId: string | null
}

export interface RailStorage {
  get(): RailPersistedState | null
  set(state: RailPersistedState): void
}

const STORAGE_KEY = "conductor.plugin-rail"

export function localStorageRailStorage(): RailStorage {
  return {
    get() {
      try {
        const raw = globalThis.localStorage?.getItem(STORAGE_KEY) ?? null
        if (raw === null) return null
        const parsed: unknown = JSON.parse(raw)
        if (typeof parsed !== "object" || parsed === null) return null
        const open = (parsed as { open?: unknown }).open
        const selectedId = (parsed as { selectedId?: unknown }).selectedId
        if (typeof open !== "boolean") return null
        if (selectedId !== null && typeof selectedId !== "string") return null
        return { open, selectedId: selectedId ?? null }
      } catch {
        return null
      }
    },
    set(state: RailPersistedState) {
      try {
        globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(state))
      } catch {
        // storage unavailable (private mode) — the rail still works this session
      }
    },
  }
}
