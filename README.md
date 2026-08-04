# Conductor

**A self-hosted, runtime-agnostic "CI for agents".**

Conductor drives AI coding agents through configurable workflows the way CI
systems drive builds — workflow-as-data like GitHub Actions, a task board like
Jira, and agents that pull work themselves under human-set limits and
human-owned gates.

It is the standalone successor to
[`opencode-conductor`](https://github.com/arkadiuszSzast/opencode-conductor):
the engine, store, reconciler, findings lifecycle and human gates are carried
over by extraction — the plugin becomes the first **runner** adapter.

## Status

Early. Phase 0 (foundation) is in place; the extraction of the standalone
daemon is the current workstream. Roadmap and backlog live as OpenSpec changes
in [`openspec/changes/`](openspec/changes).

| Phase | Scope | State |
|---|---|---|
| 0 | Foundation: repo, license, CI, OpenSpec planning | done |
| 1 | Standalone daemon (extraction) + workflow-as-data core | current |
| 2 | Task board + exploration view | planned |
| 3 | Agents pull work (scheduler, scopes, concurrency) | planned |
| 4 | GitHub webhook triggers + git-resolved action registry | future |

## The pillars

1. **A standalone system, not a plugin** — own daemon with its own state, API
   and UI; agent runtimes are integrations behind a `Runner` abstraction.
2. **Workflow-as-data, GitHub-Actions-style** — declarative YAML pipelines
   composed from reusable, versioned **actions**; `needs:`-style graph
   semantics where the work demands them; `on:` triggers.
3. **A task board as the primary UI** — every task shows which workflow run it
   is in, at which step, waiting on whom; plus an exploration view.
4. **Agents pull work** — a scheduler hands available tasks to agents under
   configurable concurrency limits, with declarative scope collision safety.
5. **The operational layer is first-class** — durable state, a reconciler,
   idle detection and reaping, escalation as a designed state, findings with
   bot-identity projection, human gates with notes that flow downstream.
6. **Resilience with patience** — exponential backoff with jitter, budgets in
   time-and-tries, per-failure-class retry policies.
7. **Genuinely open source** — no host-specific paths, no hardcoded model
   gateway.

## Repository layout

```
packages/
  core/              pure engine: interpreter, workflow model, validation, templates
  server/            daemon: HTTP API, reconciler, triggers, scheduler hooks
  runner-opencode/   opencode runner adapter (the old plugin, shrunk)
  cli/               the `conductor` CLI (init, start, status, approve, report, …)
apps/
  web/               task board + exploration view (later phase)
openspec/            specs and change proposals (the backlog)
docs/                architecture notes, runner protocol, workflow format reference
```

## Development

Requires [Bun](https://bun.sh) ≥ 1.0 and Node ≥ 24.

```sh
bun install
bun run typecheck   # tsc --noEmit across the workspace
bun test            # bun test across the workspace
```

## Roadmap & planning

The backlog is managed with [OpenSpec](https://openspec.dev): every workstream
is a change in `openspec/changes/` with a proposal, specs, design and tasks,
archived into `openspec/specs/` when done. Run `openspec list` to see the
current backlog.

## License

[MIT](LICENSE)

<!-- probe: claude review smoke test, remove before merge -->
