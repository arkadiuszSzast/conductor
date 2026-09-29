/**
 * ACP runner configuration types (design.md D3). Pure data shapes only —
 * parsing/validation from YAML lives in `packages/cli/src/daemon-config.ts`
 * (task 5.2); this module is the shared contract owners C (adapter) and E
 * (composition) both compile against so neither has to guess the other's
 * field names.
 *
 * Deliberately conservative: every field the design's example config
 * names is represented; nothing here invents a default beyond what D3
 * states explicitly ("Omitted section equals native-only").
 */

/** Independently bounded lifecycle deadlines (D7) — never one shared
 *  timeout. `turnMs` in particular must be able to exceed any HTTP-style
 *  request deadline (default 60 minutes; the native transport's fixed
 *  10s request deadline must never apply to ACP turns). */
export interface AcpDeadlines {
  readonly startupMs: number
  readonly writeMs: number
  readonly turnMs: number
  readonly cancelMs: number
  readonly killMs: number
}

export const DEFAULT_ACP_DEADLINES: AcpDeadlines = {
  startupMs: 30_000,
  writeMs: 5_000,
  turnMs: 3_600_000,
  cancelMs: 5_000,
  killMs: 2_000,
}

/** Deny-default permission policy (D9) — `allowKinds` is the ONLY way to
 *  grant anything, and it only ever selects an offered `allow_once`
 *  option; there is no `allow_always` escape hatch in configuration. */
export interface AcpPermissionPolicy {
  readonly allowKinds: readonly string[]
}

/** A workflow `role.agent` → ACP `mode` binding, with optional
 *  config-option selections (D3: "Optional binding config-option
 *  selections are `{optionId: value}`"). `mode` MUST match one of the
 *  session's advertised modes; `configOptions` values are matched
 *  against advertised `SessionConfigOption`s at bind time — never
 *  invented, never silently substituted. */
export interface AcpRoleBinding {
  readonly mode: string
  readonly configOptions?: Readonly<Record<string, string>>
}

/** One configured local ACP executable profile. */
export interface AcpProfileConfig {
  readonly command: string
  readonly args: readonly string[]
  readonly allowedRoots: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly inheritEnv?: readonly string[]
  readonly maxConcurrent: number
  readonly deadlines?: Partial<AcpDeadlines>
  readonly permissions: AcpPermissionPolicy
  readonly bindings: Readonly<Record<string, AcpRoleBinding>>
}

/** The stdio MCP reporting bridge's own launch command — the daemon
 *  passes run-scoped env (`CONDUCTOR_RUN_URL`/`CONDUCTOR_RUN_ID`/
 *  `CONDUCTOR_RUN_TOKEN`) on top of this at spawn time; the config only
 *  says how to invoke it. */
export interface AcpReportBridgeConfig {
  readonly command: string
  readonly args: readonly string[]
}

/** The full optional `runners` daemon-config section (D3). Absent on the
 *  containing `DaemonConfig` means native-only — this type therefore has
 *  no "disabled" flag of its own; its ABSENCE is the disable. */
export interface RunnersConfig {
  readonly default: "native"
  readonly projects: Readonly<Record<string, string>>
  readonly acp: Readonly<Record<string, AcpProfileConfig>>
  readonly reportBridge: AcpReportBridgeConfig
}

/** Environment variable names that must NEVER cross into a spawned ACP
 *  process or its reporting bridge, even if named in an operator's
 *  `inheritEnv` list — the daemon's own control-plane credentials.
 *  Enforced at spawn time in `process.ts` (task 3.2), listed once here so
 *  config validation (task 5.2) can also reject configuring them. */
export const FORBIDDEN_INHERITED_ENV_NAMES: readonly string[] = [
  "CONDUCTOR_ADMIN_TOKEN",
  "CONDUCTOR_API_TOKEN",
  "CONDUCTOR_AUTH_TOKEN",
]

/** Resolve which configured ACP profile (if any) a project directory
 *  routes NEW work to (D3: "Exact project identity chooses a profile").
 *  Only exact-path matches — no longest-prefix fallback to an unrelated
 *  project. Returns null for native (the default, or a project not
 *  listed under `projects`). */
export function resolveAcpProfileForProject(
  config: RunnersConfig | undefined,
  projectDir: string,
): { readonly profileId: string; readonly profile: AcpProfileConfig } | null {
  if (!config) return null
  const profileId = config.projects[projectDir]
  if (profileId === undefined) return null
  const profile = config.acp[profileId]
  if (profile === undefined) return null
  return { profileId, profile }
}

/** Canonical-root membership check (D3: "canonical worktree directory
 *  must independently fall within that profile's allowedRoots"). Exact
 *  match or a proper child path only — never a bare string-prefix match
 *  that a sibling directory name could spoof (e.g. `/srv/work` must not
 *  match `/srv/workshop`). Callers MUST canonicalize (resolve symlinks)
 *  both `directory` and every configured root before calling this — see
 *  `packages/server/src/acp/process.ts`'s validation, which is the
 *  actual security boundary; this is the pure membership predicate. */
export function directoryWithinRoots(directory: string, roots: readonly string[]): boolean {
  return roots.some(root => {
    const normalizedRoot = root.replace(/\/+$/, "")
    return directory === normalizedRoot || directory.startsWith(`${normalizedRoot}/`)
  })
}

export function resolveAcpDeadlines(overrides?: Partial<AcpDeadlines>): AcpDeadlines {
  return { ...DEFAULT_ACP_DEADLINES, ...overrides }
}
