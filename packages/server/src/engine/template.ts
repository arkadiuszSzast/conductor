/**
 * Minimal {{path.to.value}} template rendering for pipeline step prompts and
 * params. Ported unchanged from opencode-conductor's
 * `src/pipeline/template.ts`. Deliberately tiny: no conditionals, no
 * loops, no escaping directives. Unknown variables render as an empty
 * string and are reported, so a typo in a pipeline definition surfaces
 * instead of silently producing a half-empty prompt.
 */

export interface RenderResult {
  readonly text: string
  /** Variables referenced by the template but absent from the context. */
  readonly missing: readonly string[]
}

const VAR_PATTERN = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g

export function renderTemplate(template: string, context: Record<string, unknown>): RenderResult {
  const missing: string[] = []
  const text = template.replace(VAR_PATTERN, (_match, path: string) => {
    const value = lookup(context, path)
    if (value === undefined || value === null) {
      missing.push(path)
      return ""
    }
    return typeof value === "string" ? value : JSON.stringify(value)
  })
  return { text, missing }
}

function lookup(context: Record<string, unknown>, path: string): unknown {
  let current: unknown = context
  for (const key of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}
