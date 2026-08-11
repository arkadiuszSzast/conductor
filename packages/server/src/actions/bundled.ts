/** Handler registry for the bundled in-process actions — keyed by manifest `run.handler` name. */

import type { ActionHandler } from "../action-host.ts"
import { gitWorktree } from "./git-worktree.ts"
import { gitWorktreeRemove } from "./git-worktree-remove.ts"
import { gitPush } from "./git-push.ts"
import { githubPrCreate } from "./github-pr-create.ts"
import { githubAwaitChecks } from "./github-await-checks.ts"
import { githubPrMerge } from "./github-pr-merge.ts"

export const bundledHandlers: Readonly<Record<string, ActionHandler>> = {
  "git/worktree": gitWorktree,
  "git/worktree-remove": gitWorktreeRemove,
  "git/push": gitPush,
  "github/pr-create": githubPrCreate,
  "github/await-checks": githubAwaitChecks,
  "github/pr-merge": githubPrMerge,
}
