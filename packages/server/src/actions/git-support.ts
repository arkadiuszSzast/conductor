/** Shared helpers for the bundled `git/*` actions. */

export interface WorktreeEntry {
  readonly path: string
  readonly branch: string | null
}

/** Parses `git worktree list --porcelain` output into path/branch pairs. Detached checkouts carry `branch: null`. */
export function parseWorktreeList(output: string): readonly WorktreeEntry[] {
  const entries: WorktreeEntry[] = []
  let path: string | null = null
  let branch: string | null = null
  const flush = () => {
    if (path !== null) entries.push({ path, branch })
    path = null
    branch = null
  }
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim()
    if (line === "") {
      flush()
      continue
    }
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length)
    else if (line.startsWith("branch ")) branch = line.slice("branch ".length).replace(/^refs\/heads\//, "")
  }
  flush()
  return entries
}

export function slugifyBranch(branch: string): string {
  const slug = branch.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
  return slug === "" ? "branch" : slug
}
