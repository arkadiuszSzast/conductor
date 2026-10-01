/**
 * Start-input derivation and `.openspec.yaml` `depends_on` reading, shared
 * by the OpenSpec plugin and the daemon's change-queue scheduler so a
 * queued change starts with exactly the title, description and inputs a
 * manual "Start work" produces.
 *
 * Dependency-free on purpose: this file lives in the plugin directory
 * because an installed plugin is a verbatim copy of `plugins/openspec/`
 * (no symlinks, no `node_modules`, no `@conductor/*` resolution), so it
 * can only import siblings. The server imports it by relative path.
 */

/** Workflows commonly declare which OpenSpec change a feature delivers
 *  as a required string input (the dogfood workflow calls it
 *  `change_slug`). */
export const CHANGE_INPUT_NAMES = ["change_slug", "change"] as const

export interface ChangeStart {
  readonly title: string
  readonly description?: string
  readonly inputs?: Readonly<Record<string, string>>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function titleFromChangeName(name: string): string {
  return name
    .split(/[-_]+/)
    .filter(word => word !== "")
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
}

/** Body of the first `## <heading>` section (case-insensitive), trimmed;
 *  null when the heading is absent or the section is empty. */
export function extractSection(markdown: string, heading: string): string | null {
  const lines = markdown.split("\n")
  const headingPattern = new RegExp(`^##\\s+${heading}\\s*$`, "i")
  const startIndex = lines.findIndex(line => headingPattern.test(line.trim()))
  if (startIndex === -1) return null
  const rest = lines.slice(startIndex + 1)
  const endIndex = rest.findIndex(line => /^##\s+/.test(line))
  const section = (endIndex === -1 ? rest : rest.slice(0, endIndex)).join("\n").trim()
  return section === "" ? null : section
}

/** The input name to fill with the change name: the first of
 *  `CHANGE_INPUT_NAMES` the workflow declares as a string input.
 *  `workflowInputs` is the `inputs` object of the workflow projection
 *  (`GET /v1/projects/workflow`); anything else means "no inputs". */
export function resolveChangeInput(changeName: string, workflowInputs: unknown): Record<string, string> | null {
  if (!isRecord(workflowInputs)) return null
  for (const name of CHANGE_INPUT_NAMES) {
    const input = workflowInputs[name]
    if (isRecord(input) && input.type === "string") return { [name]: changeName }
  }
  return null
}

/** Title from the change name; description from the proposal's *Why*
 *  section, falling back to the whole trimmed proposal, and absent when
 *  there is no proposal; `inputs` only when the workflow declares one. */
export function deriveChangeStart(
  changeName: string,
  proposalText: string | null | undefined,
  workflowInputs?: unknown,
): ChangeStart {
  const inputs = resolveChangeInput(changeName, workflowInputs)
  return {
    title: titleFromChangeName(changeName),
    ...(proposalText !== null && proposalText !== undefined
      ? { description: extractSection(proposalText, "why") ?? proposalText.trim() }
      : {}),
    ...(inputs !== null ? { inputs } : {}),
  }
}

export type DependsOnErrorCode =
  | "invalid_yaml"
  | "too_large"
  | "yaml_anchors"
  | "not_a_mapping"
  | "not_a_list"
  | "non_string_item"

/** `.openspec.yaml` is a few lines; anything bigger is refused before parsing. */
export const MAX_OPENSPEC_YAML_BYTES = 64 * 1024

/** Anchors (`&name`) and aliases (`*name`) at a value position, after
 *  dropping `#` comments. Conservative on purpose: they let a tiny file
 *  expand into a huge structure, and `.openspec.yaml` has no use for them. */
const YAML_ANCHOR_OR_ALIAS = /(?:^|[\s,[{])[&*][A-Za-z0-9_.-]+/m

function hasAnchorsOrAliases(source: string): boolean {
  return YAML_ANCHOR_OR_ALIAS.test(source.replace(/(^|\s)#.*$/gm, "$1"))
}

export interface DependsOnError {
  readonly code: DependsOnErrorCode
  readonly message: string
}

export type DependsOnResult =
  | { readonly ok: true; readonly dependsOn: readonly string[] }
  | { readonly ok: false; readonly error: DependsOnError }

const failure = (code: DependsOnErrorCode, message: string): DependsOnResult => ({
  ok: false,
  error: { code, message },
})

/** Reads `depends_on` from an already-parsed `.openspec.yaml` value.
 *  Absent (or an empty document / empty key) → []; a list of non-empty
 *  strings → that list; anything else → a typed error. Never throws. */
export function readDependsOn(parsed: unknown): DependsOnResult {
  if (parsed === null || parsed === undefined) return { ok: true, dependsOn: [] }
  if (!isRecord(parsed)) return failure("not_a_mapping", ".openspec.yaml must be a mapping")
  const value = parsed["depends_on"]
  if (value === undefined || value === null) return { ok: true, dependsOn: [] }
  if (!Array.isArray(value)) return failure("not_a_list", "depends_on must be a list of change names")
  const items: string[] = []
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || item.trim() === "") {
      return failure("non_string_item", `depends_on[${index}] must be a non-empty string`)
    }
    items.push(item)
  }
  return { ok: true, dependsOn: items }
}

/** A YAML parser as `parseYamlObject` from `@conductor/core` exposes it.
 *  Injected because this module cannot import a YAML dependency; the
 *  server passes core's parser. */
export type ParseYaml = (
  source: string,
) =>
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly errors: readonly { readonly message: string }[] }

export function parseDependsOn(source: string, parseYaml: ParseYaml): DependsOnResult {
  const bytes = new TextEncoder().encode(source).length
  if (bytes > MAX_OPENSPEC_YAML_BYTES) {
    return failure("too_large", `.openspec.yaml is ${bytes} bytes; the limit is ${MAX_OPENSPEC_YAML_BYTES}`)
  }
  if (hasAnchorsOrAliases(source)) {
    return failure("yaml_anchors", ".openspec.yaml must not use YAML anchors or aliases (& or *)")
  }
  let parsed: ReturnType<ParseYaml>
  try {
    parsed = parseYaml(source)
  } catch (error) {
    return failure("invalid_yaml", error instanceof Error ? error.message : String(error))
  }
  if (!parsed.ok) return failure("invalid_yaml", parsed.errors[0]?.message ?? "invalid YAML")
  return readDependsOn(parsed.value)
}
