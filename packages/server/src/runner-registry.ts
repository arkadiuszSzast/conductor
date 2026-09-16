export interface RunnerRegistration {
  readonly id: string
  readonly name: string
  readonly endpoint: string
  readonly token?: string
  readonly projects: readonly string[]
  readonly registeredAt: number
  readonly expiresAt: number
}

export interface RegisterRunnerInput {
  readonly name: string
  readonly endpoint: string
  readonly token?: string
  readonly projects: readonly string[]
}

export interface RunnerDirectory {
  list(): readonly RunnerRegistration[]
  markUnreachable(registration: RunnerRegistration): void
  hasUnavailable(): boolean
}

export class RunnerRegistry implements RunnerDirectory {
  private readonly registrations = new Map<string, RunnerRegistration>()
  private counter = 0
  private unavailable = false

  constructor(private readonly now: () => number = () => Date.now(), private readonly leaseMs = 60_000) {}

  register(input: RegisterRunnerInput): RunnerRegistration {
    if (input.name.trim() === "") throw new Error("runner name must be a non-empty string")
    for (const project of input.projects) {
      if (project.trim() === "") throw new Error("runner projects must be non-empty strings")
    }
    let parsed: URL
    try {
      parsed = new URL(input.endpoint)
    } catch {
      throw new Error(`runner endpoint "${input.endpoint}" is not a valid URL`)
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`runner endpoint "${input.endpoint}" must use http or https`)
    }
    this.list()
    const endpoint = parsed.toString().replace(/\/+$/, "")
    const existing = this.registrations.get(endpoint)
    const at = this.now()
    const registration: RunnerRegistration = {
      id: existing?.id ?? `runner-${++this.counter}`,
      name: input.name,
      endpoint,
      ...(input.token !== undefined ? { token: input.token } : {}),
      projects: [...new Set([...(existing?.projects ?? []), ...input.projects])],
      registeredAt: at,
      expiresAt: at + this.leaseMs,
    }
    this.registrations.set(endpoint, registration)
    return registration
  }

  deregister(id: string): boolean {
    for (const [endpoint, registration] of this.registrations) {
      if (registration.id === id) {
        this.registrations.delete(endpoint)
        this.unavailable = true
        return true
      }
    }
    return false
  }

  markUnreachable(registration: RunnerRegistration): void {
    if (this.registrations.get(registration.endpoint) === registration) this.deregister(registration.id)
  }

  get(id: string): RunnerRegistration | null {
    return this.list().find(registration => registration.id === id) ?? null
  }

  list(): readonly RunnerRegistration[] {
    for (const registration of this.registrations.values()) {
      if (registration.expiresAt <= this.now()) this.deregister(registration.id)
    }
    return [...this.registrations.values()].sort((a, b) => a.endpoint < b.endpoint ? -1 : a.endpoint > b.endpoint ? 1 : 0)
  }

  hasUnavailable(): boolean {
    this.list()
    return this.unavailable
  }

  hasAny(): boolean {
    return this.list().length > 0
  }
}
