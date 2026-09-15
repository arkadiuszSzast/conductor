## Why

Fix rounds should execute an explicit, durable blocking work order instead of repeating the original implementation narrative or interpreting arbitrary review prose. Existing finding storage is disconnected from agent reports, leaving review loops without stable identities or machine-checked acceptance criteria.

## What Changes

- Opt-in structured review reporting with explicit blocking decisions, stable feature-local IDs, reviewed head, acceptance tests and locations; retain plain reports for workflows that do not opt in.
- Extend the existing finding lifecycle and atomic run completion transaction, not a second review framework. Fixed/dismissed findings remain addressable in later rounds; reopening requires a reason.
- Deterministically select a concise fix prompt and accepted blocking pack from explicitly scoped feedback. Keep initial implementation prompts unchanged, and preserve scoped quality diagnostics and operator recovery notes.
- Document deployment coupling without changing or activating operator workflows.

## Capabilities

### New Capabilities

- `structured-fix-work-orders`: Validated structured review completion and scoped deterministic fix execution.

### Modified Capabilities

None.

## Impact

Core workflow parsing/validation, server reporting/store/migrations, CLI reporting, tests and reference documentation. Additive database migration; no external dependencies. Extends the standalone/workflow-as-data and durable operations pillars without changing confirmed decisions. The seed's stable finding IDs and new/fixed/dismissed/reopened lifecycle are retained because they prevent repeated review work; prose parsing and severity-based automatic downgrading are not carried over. Operator manifests must be opted in only with matching daemon/client support; running workflows remain unchanged. Broad analytics, gateway/stall work, GitHub thread synchronization and automatic semantic deduplication are out of scope.
