/**
 * In-memory registry of runner endpoints — the daemon-side half of the
 * v1 daemon↔runner callback transport. A runner (the opencode plugin
 * today) POSTs its callback endpoint and the project directories it
 * serves to `POST /v1/runners`; the daemon's session transport (an
 * adapter-provided `SessionClient`, e.g. the opencode runner hub) reads
 * the registry to route session operations to the right endpoint.
 *
 * The registry is deliberately runtime-neutral: it stores a name, an
 * endpoint URL, an optional bearer token for calling the runner back,
 * and project directories. Nothing opencode-specific lives here — the
 * adapter package owns the wire protocol spoken against the endpoint.
 *
 * Registration is an UPSERT keyed by the normalized endpoint: a runner
 * process re-registering (plugin reload, another project instance in
 * the same process) keeps its id and unions its project list, so no
 * observable state depends on registration order. Registrations are
 * in-memory only — sessions are disposable executors and a runner
 * re-registers when it reconnects; a daemon restart starts empty and
 * the safe-direction session transport (claim busy, never reap on
 * missing information) covers the gap until the runner re-registers.
 */

export interface RunnerRegistration {
  readonly id: string
  readonly name: string
  /** Normalized (no trailing slash) callback base URL, e.g. `http://127.0.0.1:4096`. */
  readonly endpoint: string
  /** Bearer token the daemon presents when calling the runner back. Never logged, never listed over the API. */
  readonly token?: string
  /** Project directories this runner serves (informative routing hint, unioned across registrations). */
  readonly projects: readonly string[]
  readonly registeredAt: number
}

export interface RegisterRunnerInput {
  readonly name: string
  readonly endpoint: string
  readonly token?: string
  readonly projects: readonly string[]
}

/** Read surface the session-transport adapters need. `RunnerRegistry` satisfies it. */
export interface RunnerDirectory {
  list(): readonly RunnerRegistration[]
}

function normalizeEndpoint(endpoint: string): string {
  let parsed: URL
  try {
    parsed = new URL(endpoint)
  } catch {
    throw new Error(`runner endpoint "${endpoint}" is not a valid URL`)
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`runner endpoint "${endpoint}" must use http or https`)
  }
  return parsed.toString().replace(/\/+$/, "")
}

export class RunnerRegistry implements RunnerDirectory {
  private readonly registrations = new Map<string, RunnerRegistration>()
  private counter = 0

  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * Register (or refresh) a runner endpoint. Upsert by normalized
   * endpoint: the id is stable across re-registrations and `projects`
   * are unioned, so repeated per-project registrations from one runner
   * process converge to the same entry regardless of order.
   */
  register(input: RegisterRunnerInput): RunnerRegistration {
    if (input.name.trim() === "") throw new Error("runner name must be a non-empty string")
    for (const project of input.projects) {
      if (project.trim() === "") throw new Error("runner projects must be non-empty strings")
    }
    const endpoint = normalizeEndpoint(input.endpoint)
    const existing = this.registrations.get(endpoint)
    const projects = existing !== undefined
      ? [...new Set([...existing.projects, ...input.projects])]
      : [...new Set(input.projects)]
    const registration: RunnerRegistration = {
      id: existing?.id ?? `runner-${++this.counter}`,
      name: input.name,
      endpoint,
      ...(input.token !== undefined ? { token: input.token } : {}),
      projects,
      registeredAt: this.now(),
    }
    this.registrations.set(endpoint, registration)
    return registration
  }

  /** Remove a registration by id. Returns false when the id is unknown. */
  deregister(id: string): boolean {
    for (const [endpoint, registration] of this.registrations) {
      if (registration.id === id) {
        this.registrations.delete(endpoint)
        return true
      }
    }
    return false
  }

  get(id: string): RunnerRegistration | null {
    for (const registration of this.registrations.values()) {
      if (registration.id === id) return registration
    }
    return null
  }

  list(): readonly RunnerRegistration[] {
    return [...this.registrations.values()].sort((left, right) =>
      left.endpoint < right.endpoint ? -1 : left.endpoint > right.endpoint ? 1 : 0,
    )
  }

  hasAny(): boolean {
    return this.registrations.size > 0
  }
}
