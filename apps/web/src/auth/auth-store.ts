/**
 * Auth session — token lifecycle for the bearer-token gate.
 *
 * The token lives in `localStorage` (brief's documented trade-off, with a
 * "forget" affordance). Bootstrap probes `GET /v1/health` (the only
 * endpoint that answers 200 vs 401 unambiguously); a 200 with no token
 * means `auth.mode: "none"` and the gate is skipped entirely. A 401 at
 * any later point routes through `handleUnauthorized` so the app returns
 * to the token screen.
 */

export interface AuthStorage {
  get(): string | null
  set(token: string | null): void
}

/** Returns the HTTP status of the health probe for the given token. */
export type AuthProbe = (token: string | null) => Promise<number>

export type AuthStatus = "checking" | "needs-token" | "authenticated"

export interface AuthSessionInput {
  readonly storage: AuthStorage
  readonly probe: AuthProbe
}

export class AuthSession {
  status: AuthStatus = "checking"
  token: string | null = null
  error: string | null = null

  private readonly storage: AuthStorage
  private readonly probe: AuthProbe
  private readonly listeners = new Set<() => void>()

  constructor(input: AuthSessionInput) {
    this.storage = input.storage
    this.probe = input.probe
  }

  async bootstrap(): Promise<void> {
    const stored = this.storage.get()
    this.token = stored
    const status = await this.probe(stored)
    if (status === 200) {
      this.status = "authenticated"
      this.error = null
    } else if (status === 401) {
      this.status = "needs-token"
      this.token = null
      this.error = null
    } else {
      this.status = "needs-token"
      this.error = `daemon unreachable (HTTP ${status})`
    }
    this.notify()
  }

  async setToken(token: string): Promise<boolean> {
    this.status = "checking"
    this.error = null
    this.notify()
    const status = await this.probe(token)
    if (status === 200) {
      this.storage.set(token)
      this.token = token
      this.status = "authenticated"
      this.error = null
      this.notify()
      return true
    }
    this.token = null
    this.status = "needs-token"
    this.error = status === 401 ? "token rejected by the daemon" : `daemon unreachable (HTTP ${status})`
    this.notify()
    return false
  }

  forget(): void {
    this.storage.set(null)
    this.token = null
    this.status = "needs-token"
    this.error = null
    this.notify()
  }

  handleUnauthorized(): void {
    this.forget()
  }

  getToken(): string | null {
    return this.token
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

const STORAGE_KEY = "conductor.token"

export function localStorageAuthStorage(): AuthStorage {
  return {
    get() {
      try {
        return globalThis.localStorage?.getItem(STORAGE_KEY) ?? null
      } catch {
        return null
      }
    },
    set(token: string | null) {
      try {
        if (token === null) globalThis.localStorage?.removeItem(STORAGE_KEY)
        else globalThis.localStorage?.setItem(STORAGE_KEY, token)
      } catch {
        // storage unavailable (private mode) — session-only auth still works
      }
    },
  }
}
