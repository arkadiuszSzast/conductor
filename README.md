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

## Quick start

Conductor installs **only from this repo** (no registry publication before a
stable release). Requires [Bun](https://bun.sh) ≥ 1.0.

```sh
git clone https://github.com/arkadiuszSzast/conductor && cd conductor
bun install
cd packages/cli && bun link && cd ../..   # global `conductor` (or: bun run build:binary → dist/conductor)
```

**1. Start the daemon.** Zero config needed — on first run it generates
its config at `~/.config/conductor/daemon.yaml` (XDG-aware) with working
defaults (loopback bind `127.0.0.1:4400`, database under
`~/.local/share/conductor`, open auth on loopback with a logged warning):

```sh
conductor daemon          # JSON logs on stdout; /v1/readyz → 200
                          # web UI serves automatically at the same address
                          # (ships inside the artifact; --no-ui disables it)
```

Operators who want full control: `conductor daemon --config <path>`
(explicit file, never generated). Edit the generated file and restart to
change bind/auth/anything.

**2. Adopt a project.** Each project carries its own workflow file,
GHA-style. `init` scaffolds it **and** registers the project with the
daemon (config + live API registration, no restart):

```sh
cd /path/to/my-project
conductor init            # scaffold conductor.yaml + register the project
```

**3. CLI connection.** On the daemon's machine nothing to configure — the
CLI reads the daemon's own config for address and token. For a remote
daemon: `export CONDUCTOR_URL=http://<host>:<port>` (+ `CONDUCTOR_TOKEN`).

**4. Connect a runner** (executes `agent:` steps — without one, gates and
the API still work but agent steps wait). The opencode adapter is configured
by environment variables in the environment opencode runs in:

```sh
export CONDUCTOR_URL=http://127.0.0.1:4400
export CONDUCTOR_RUNNER_HOST=127.0.0.1    # callback listener bind
export CONDUCTOR_RUNNER_AUTH=none         # or CONDUCTOR_RUNNER_TOKEN=<token>
# load packages/runner-opencode/src/plugin.ts in the project's opencode config
```

The runner registers itself with the daemon on startup; `GET /v1/health`
then reports it available.

**5. Drive a feature:**

```sh
conductor start "Ship the thing"          # --project defaults to the current dir
conductor status --active                 # the board
conductor status <feature-id>             # detail: status, current step, run
conductor approve <feature-id> --notes "ship it"   # when waiting_human
conductor logs <feature-id>               # transition timeline
```

Full walkthrough, the compiled-binary path and troubleshooting:
[docs/install.md](docs/install.md).

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

## Documentation

- [Install](docs/install.md) — installing from the repo, running the
  daemon, connecting the opencode runner, first feature, troubleshooting.
- [Concepts](docs/concepts.md) — the execution model: jobs, outcomes vs
  failures, loops, feedback, escalation.
- [Workflow reference](docs/workflow-reference.md) — every `conductor.yaml`
  field, GHA-style.
- [Expressions](docs/expressions.md) — the `{{ }}` template contexts and
  their guarantees.

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
