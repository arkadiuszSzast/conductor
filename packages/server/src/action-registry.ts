import { open, readdir, realpath, stat } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"
import {
  buildActionRegistry,
  parseActionManifest,
  validateActionManifest,
} from "@conductor/core"
import type { ActionRegistry, ActionRegistryEntry } from "@conductor/core"

export interface ActionRegistryConfig {
  readonly baseDir: string
  readonly bundledPath: string
  readonly localPaths?: readonly string[]
}

export interface ActionRegistrySearchPath {
  readonly kind: "bundled" | "local"
  readonly path: string
  readonly precedence: number
}

export interface ActionRegistryLoadDiagnostic {
  readonly sourcePath: string
  readonly message: string
  readonly line?: number
  readonly col?: number
}

export interface LoadedActionRegistry {
  readonly registry: ActionRegistry
  readonly searchPaths: readonly ActionRegistrySearchPath[]
}

export type LoadActionRegistryResult =
  | { readonly ok: true; readonly value: LoadedActionRegistry }
  | { readonly ok: false; readonly diagnostics: readonly ActionRegistryLoadDiagnostic[] }

const MAX_MANIFEST_BYTES = 1_048_576

interface LoadedEntry extends ActionRegistryEntry {
  readonly sourcePath: string
  readonly precedence: number
}

export async function loadActionRegistry(config: ActionRegistryConfig): Promise<LoadActionRegistryResult> {
  const searchPaths = normalizeSearchPaths(config)
  const diagnostics: ActionRegistryLoadDiagnostic[] = []
  const loaded: LoadedEntry[] = []

  for (const searchPath of searchPaths) {
    const files = await discoverManifestFiles(searchPath.path, diagnostics)
    for (const sourcePath of files) {
      const source = await readManifest(sourcePath, diagnostics)
      if (source === undefined) continue
      const parsed = parseActionManifest(source)
      if (!parsed.ok) {
        diagnostics.push(...parsed.errors.map(error => ({ sourcePath, ...error })))
        continue
      }
      const errors = validateActionManifest(parsed.manifest)
      if (errors.length > 0) {
        diagnostics.push(...errors.map(message => ({ sourcePath, message })))
        continue
      }
      loaded.push({ manifest: parsed.manifest, sourcePath, precedence: searchPath.precedence })
    }
  }

  const entries = applyPrecedence(loaded, diagnostics)
  if (diagnostics.length > 0) {
    return { ok: false, diagnostics: sortDiagnostics(diagnostics) }
  }
  return {
    ok: true,
    value: {
      registry: buildActionRegistry(entries),
      searchPaths,
    },
  }
}

function normalizeSearchPaths(config: ActionRegistryConfig): readonly ActionRegistrySearchPath[] {
  const paths = [
    { kind: "bundled" as const, path: resolvePath(config.baseDir, config.bundledPath) },
    ...(config.localPaths ?? []).map(path => ({ kind: "local" as const, path: resolvePath(config.baseDir, path) })),
  ]
  return paths.map((path, precedence) => ({ ...path, precedence }))
}

function resolvePath(baseDir: string, path: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(baseDir, path)
}

async function discoverManifestFiles(
  root: string,
  diagnostics: ActionRegistryLoadDiagnostic[],
): Promise<readonly string[]> {
  let canonicalRoot
  try {
    const rootStat = await stat(root)
    if (!rootStat.isDirectory()) {
      diagnostics.push({ sourcePath: root, message: "registry search path is not a directory" })
      return []
    }
    canonicalRoot = await realpath(root)
  } catch (error) {
    diagnostics.push({ sourcePath: root, message: `cannot access registry search path: ${errorMessage(error)}` })
    return []
  }

  const files: string[] = []
  await walk(canonicalRoot, files, diagnostics)
  return files.sort(compareText)
}

async function walk(
  directory: string,
  files: string[],
  diagnostics: ActionRegistryLoadDiagnostic[],
): Promise<void> {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    diagnostics.push({ sourcePath: directory, message: `cannot read registry directory: ${errorMessage(error)}` })
    return
  }
  entries.sort((left, right) => compareText(left.name, right.name))
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) {
      diagnostics.push({ sourcePath: path, message: "symbolic links are not allowed in action registry paths" })
    } else if (entry.isDirectory()) {
      await walk(path, files, diagnostics)
    } else if (entry.isFile() && (entry.name === "action.yaml" || entry.name === "action.yml")) {
      files.push(path)
    }
  }
}

async function readManifest(
  sourcePath: string,
  diagnostics: ActionRegistryLoadDiagnostic[],
): Promise<string | undefined> {
  let file
  try {
    file = await open(sourcePath, "r")
    const info = await file.stat()
    if (info.size > MAX_MANIFEST_BYTES) {
      diagnostics.push({ sourcePath, message: `action manifest exceeds ${MAX_MANIFEST_BYTES} bytes` })
      return undefined
    }
    return await file.readFile("utf8")
  } catch (error) {
    diagnostics.push({ sourcePath, message: `cannot read action manifest: ${errorMessage(error)}` })
    return undefined
  } finally {
    await file?.close()
  }
}

function applyPrecedence(
  loaded: readonly LoadedEntry[],
  diagnostics: ActionRegistryLoadDiagnostic[],
): readonly ActionRegistryEntry[] {
  const byIdentity = new Map<string, LoadedEntry[]>()
  for (const entry of loaded) {
    const identity = `${entry.manifest.name}@${entry.manifest.version}`
    const entries = byIdentity.get(identity)
    if (entries === undefined) byIdentity.set(identity, [entry])
    else entries.push(entry)
  }

  const selected: LoadedEntry[] = []
  for (const [identity, entries] of [...byIdentity.entries()].sort(([left], [right]) => compareText(left, right))) {
    const highestPrecedence = Math.max(...entries.map(entry => entry.precedence))
    const winners = entries.filter(entry => entry.precedence === highestPrecedence)
    if (winners.length > 1) {
      const paths = winners.map(entry => entry.sourcePath).sort(compareText)
      diagnostics.push({
        sourcePath: paths[0]!,
        message: `duplicate action manifest "${identity}" at the same precedence: ${paths.join(", ")}`,
      })
      continue
    }
    selected.push(winners[0]!)
  }

  return selected
    .sort((left, right) => {
      const identity = compareText(left.manifest.name, right.manifest.name)
      if (identity !== 0) return identity
      return compareVersions(left.manifest.version, right.manifest.version)
    })
    .map(({ manifest, sourcePath }) => ({ manifest, sourcePath }))
}

function sortDiagnostics(diagnostics: readonly ActionRegistryLoadDiagnostic[]): readonly ActionRegistryLoadDiagnostic[] {
  return [...diagnostics].sort((left, right) => {
    const path = compareText(left.sourcePath, right.sourcePath)
    if (path !== 0) return path
    const line = (left.line ?? 0) - (right.line ?? 0)
    if (line !== 0) return line
    const col = (left.col ?? 0) - (right.col ?? 0)
    return col !== 0 ? col : compareText(left.message, right.message)
  })
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number)
  const rightParts = right.split(".").map(Number)
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index++) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
