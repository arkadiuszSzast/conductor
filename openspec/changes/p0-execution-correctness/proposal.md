## Why

Workflows must validate the commit they actually pushed and give repair agents the actual command failure. Current push reads ambient HEAD after pushing another branch; checks can pass with absent results; rerun feedback omits command diagnostics from step-specific data.

## What Changes

- Pin the branch commit before pushing and return that exact object, regardless of checkout or branch movement.
- **BREAKING** Require an expected SHA and a nonempty explicit required-check list for `github/await-checks`; query commit-specific observations, wait for missing checks, reject PR head movement, and remove empty-check grace success.
- Add bounded, redacted command diagnostics to step-specific rerun feedback without modifying command outputs or relying on stale global feedback.
- Reproduce suspected stale reviewer dispatch across completion/outbox replay; change only proven unsafe behavior and document unsupported claims.

## Capabilities

### New Capabilities

- `execution-evidence`: Exact push/check identity, durable command repair evidence, and state-valid completion dispatch.

### Modified Capabilities

None.

## Impact

Touches bundled server actions/manifests, engine and focused tests, workflow examples and action/feedback documentation. No live configuration, database, deployment, or feature operations are authorized. No database migration is planned. Workflow authors (including any future gloam-idle configuration) must wire push SHA and declare required check names explicitly. The required list is workflow policy, not automatic discovery of GitHub branch protection or rulesets.

Supports standalone execution, workflow-as-data, and durable resilience; does not replace CI or add structured finding work orders (deferred). Carries over confirmation-of-effect and durable replay from opencode-conductor because they prevent false success and lost work, not for compatibility. No other seed formats or behavior are introduced. AGENTS.md's greenfield/no-compatibility rule takes precedence over the older config context's migration obligations. Existing unrelated dirty work remains untouched.
