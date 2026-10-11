/**
 * `runners.opencode.<profile>` — a daemon-side client of an external
 * OpenCode v2 server (`opencode serve`). The server process itself is
 * never supervised here; the profile only says how to reach it, which
 * directories it may run in, and the per-agent model selection fallback.
 */

export interface OpencodeRoleBinding {
  /** `provider/id`, split at the first `/`. */
  readonly model?: string
  readonly variant?: string
}

export interface OpencodeDeadlines {
  /** Bounded wait for a cold location's agent catalog to load. */
  readonly startupMs: number
  /** Per HTTP request. */
  readonly requestMs: number
}

export const DEFAULT_OPENCODE_DEADLINES: OpencodeDeadlines = { startupMs: 30_000, requestMs: 15_000 }

export interface OpencodeProfileConfig {
  readonly baseUrl: string
  readonly username?: string
  /** Exactly one of `passwordEnv` / `passwordFile`; never an inline secret. */
  readonly passwordEnv?: string
  readonly passwordFile?: string
  readonly allowedRoots: readonly string[]
  readonly maxConcurrent: number
  readonly deadlines?: Partial<OpencodeDeadlines>
  readonly bindings: Readonly<Record<string, OpencodeRoleBinding>>
}

/** Role first, binding only for the fields the role omits (D2). */
export function resolveModelSelection(
  role: { readonly agent: string; readonly model?: string; readonly variant?: string },
  binding: OpencodeRoleBinding | undefined,
): { readonly model?: string; readonly variant?: string } {
  const model = role.model ?? binding?.model
  const variant = role.variant ?? binding?.variant
  return { ...(model !== undefined ? { model } : {}), ...(variant !== undefined ? { variant } : {}) }
}

/** `omniroute/claude/x` → provider `omniroute`, id `claude/x`. */
export function splitModelRef(model: string): { readonly providerID: string; readonly id: string } | null {
  const slash = model.indexOf("/")
  if (slash <= 0 || slash === model.length - 1) return null
  return { providerID: model.slice(0, slash), id: model.slice(slash + 1) }
}
