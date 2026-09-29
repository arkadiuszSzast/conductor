# Installing and running Conductor

Conductor installs **only from this repository** — nothing is published to
any registry before a stable release. Two install paths cover the dev loop
and moving a build to another machine; both end at the same place: a
`conductor daemon --config <file>` process and clients talking to its HTTP
API.

## Requirements

- **Bun >= 1.0** (see `engines` in the root `package.json`). Bun is a hard
  runtime requirement — the server uses `bun:sqlite`, so Node/npx cannot
  run the daemon. The compiled binary (path B) embeds the Bun runtime, so
  the *target* machine needs no Bun install.
- Git, and a project you want Conductor to drive.

## Path A — dev loop (`bun link`)

From a repo checkout:

```sh
bun install
cd packages/cli
bun link            # registers @conductor/cli
bun link @conductor/cli   # or rely on the global bin: ~/.bun/bin/conductor
```

`bun link` exposes the `conductor` bin (it points at `src/main.ts`, which
runs directly under Bun — no build step). Verify:

```sh
conductor --help
```

## Path B — single-file binary (`bun build --compile`)

```sh
bun install
bun run build:binary     # → dist/conductor (embedded Bun runtime)
```

Copy `dist/conductor` to any Linux machine of the same architecture and
run it directly — no Bun, no repo needed for the CLI itself.

Two things do **not** travel inside the binary:

- **Bundled action manifests** (`packages/server/actions/*.yaml`). A
  binary-run daemon starts without them and logs a warning; workflows
  using `action:` steps are reported invalid until you point
  `actions.bundledPath` in the daemon config at a directory containing the
  manifests (e.g. a copy of `packages/server/actions` from a checkout).
- ~~The web UI~~ — no longer a pitfall: `bun run build:binary` builds the
  SPA and **embeds it in the executable**; the daemon serves it
  automatically (disable with `conductor daemon --no-ui`).

## Running the daemon

Zero-config start:

```sh
conductor daemon
```

Without `--config` the daemon uses the platform config at
`$XDG_CONFIG_HOME/conductor/daemon.yaml` (falling back to
`~/.config/conductor/daemon.yaml`). On first run the file is generated
with working defaults — database under `$XDG_DATA_HOME/conductor`
(fallback `~/.local/share/conductor`), bind `127.0.0.1:4400`,
`auth.mode: none` (loopback-only; an explicit warning is logged — switch
to `bearer` for anything non-local), empty project list — and the daemon
starts from it. Edit the file and restart to change anything.

The **web UI** ships inside the artifact and serves automatically at the
daemon's address (`/v1/*` keeps API precedence): the compiled binary
carries an embedded SPA; a checkout-run daemon serves `apps/web/dist`,
building it once on first start when missing. `--no-ui` disables it.

Explicit config (operators who want full control):

```sh
conductor daemon --init-config ./conductor-daemon.yaml   # write an annotated example
$EDITOR ./conductor-daemon.yaml
conductor daemon --config ./conductor-daemon.yaml        # missing explicit file = error, never generated
```

Minimal config:

```yaml
databasePath: /var/lib/conductor/conductor.db
createDatabaseDirectory: true
projects:
  - /path/to/my-project        # must contain conductor.yaml
bind:
  host: 127.0.0.1
  port: 4400
auth:
  mode: bearer
  token: "change-me"           # or mode: none — logged as an explicit warning
heartbeatIntervalMs: 5000
# actions:
#   bundledPath: /path/to/conductor/packages/server/actions   # needed for the compiled binary
# plugins:
#   enabled: true
#   disabled: [some-plugin-id]
#   paths: [/path/to/extra/plugins]
```

### Engine tuning

Optional daemon configuration:

```yaml
engine:
  runTtlMs: 3600000
  idleSilenceNudgeMs: 120000
  busySilenceNudgeMs: 600000
  nudgeIdleCycles: 2
  maxNudges: 2
```

`runTtlMs` is the silence TTL (default one hour), overridden by an agent
step's `ttlMs`. `busySilenceNudgeMs` is a positive integer in milliseconds
(default ten minutes): a `busy` or `retry` session silent longer than this
threshold gets a recovery prompt. Both busy-silence and idle recovery use
one durable per-run `maxNudges` budget. A nudge restarts the silence clock;
once the budget is exhausted, another full silent window reaps the run
with a timeout, aborts the session, and applies normal retry/onFail routing.
Recent log activity prevents nudging or reaping without resetting the budget.

`idleSilenceNudgeMs` defaults to two minutes. Before every idle nudge or
exhausted-budget reap, both elapsed silence and `nudgeIdleCycles` debounce
must pass. Failed nudge delivery consumes budget and restarts grace too.
Agent steps override each silence threshold and `maxNudges` independently;
omitted fields inherit daemon settings, then the defaults above.
Restart the daemon to load changed daemon settings or code, and reload the
OpenCode runner to activate timeline fixes. Reload workflow configuration
after applying step overrides. These are operator actions, not automatic deployment.

An expired TTL wins before idle or busy recovery; a TTL at or below the
busy-silence threshold never receives a busy-silence nudge, and likewise a
TTL at or below the idle-silence threshold never receives an idle nudge —
in both cases the TTL floor makes recovery unreachable, so the engine skips
straight to the TTL reap instead of debouncing toward a threshold silence
can never cross. Pending human questions are exempt from nudging, but
retain TTL protection. Paused features are not reconciled, and resume
excludes paused silence from the activity clock (without crediting time
before the latest activity).

Deploy the runner's tool-activity logging before enabling this behavior:
otherwise legitimate tool-heavy turns can appear silent. Existing runs keep
their activity timestamps and consumed nudge budget across daemon restarts,
so stale runs can be nudged or reaped on the first heartbeat after upgrade.
No schema migration or workflow changes are required for this option.

For a long implementation step, the approved operator profile can later be
applied under its `agent` body (not a daemon-wide default):

```yaml
idleSilenceNudgeMs: 120000
busySilenceNudgeMs: 1200000
maxNudges: 3
ttlMs: 10800000
```

### Plugins

An optional `plugins` section — see [Plugins](plugins.md) for the manifest
and runtime contract. Omitting the section entirely is equivalent to
`{enabled: true, disabled: [], paths: []}`.

| Field | Type | Default | Notes |
|---|---|---|---|
| `enabled` | boolean | `true` | `false` turns off the whole subsystem: no plugin directories are scanned, no plugin processes start, and the listing reports the subsystem disabled |
| `disabled` | string[] | `[]` | kebab-case plugin ids to keep discovered-but-inert: listed with state `disabled`, backend never started, routes never mounted |
| `paths` | string[] | `[]` | extra **absolute** search roots scanned as part of the global scope, alongside `<config-dir>/plugins`; a relative path is a validation error at startup |

Global plugins are always discovered from the platform config directory's
`plugins` subdirectory (`~/.config/conductor/plugins` by default,
independent of an explicit `--config` path pointing elsewhere); `paths`
only adds to that, it does not replace it. Project plugins are discovered
per-project from `<project>/.conductor/plugins/`, no config needed.

```yaml
plugins:
  enabled: true
  disabled:
    - some-plugin-id
  paths:
    - /path/to/extra/plugins
```

`CONDUCTOR_BIND_HOST` / `CONDUCTOR_BIND_PORT` override the config's
`bind` without editing the file (Docker/systemd/LAN exposure). Exposing a
non-loopback host with `auth.mode: none` triggers an extra loud warning —
switch to `bearer` first.

Logs are JSON lines on stdout. Readiness: `GET /v1/readyz` → 200 once
migrations ran, projects registered and the heartbeat is armed. The
daemon stops gracefully on SIGINT/SIGTERM (drains in-flight work, closes
the listener and SQLite, exits 0); a second signal forces exit.

## Connecting the opencode runner

The runner adapter (`@conductor/runner-opencode`) is an opencode plugin.
It is configured entirely through environment variables — set them in the
environment opencode runs in:

| Variable | Meaning |
|---|---|
| `CONDUCTOR_URL` | daemon API base URL, e.g. `http://127.0.0.1:4400` (required) |
| `CONDUCTOR_TOKEN` | bearer token, matching the daemon's `auth` (omit for `mode: none`) |
| `CONDUCTOR_RUNNER_HOST` | callback listen host, e.g. `127.0.0.1` (required) |
| `CONDUCTOR_RUNNER_PORT` | callback listen port (omit/0 = ephemeral) |
| `CONDUCTOR_RUNNER_TOKEN` | bearer token the daemon must present on callbacks — or |
| `CONDUCTOR_RUNNER_AUTH` | `none`, the explicit opt-out (exactly one of the two) |

Load the plugin from the repo checkout in the project's opencode config
(`.opencode/`): reference `packages/runner-opencode/src/plugin.ts`. On
start the plugin registers its callback endpoint with the daemon
(`POST /v1/runners`); `GET /v1/health` then reports the runner available.

## Connecting an ACP agent (OpenCode)

Native runner integration (above) remains the default: an unconfigured
daemon uses it, and nothing below is required to run Conductor. The
Agent Client Protocol (ACP) path is a separate, **opt-in** way to drive
a local ACP-speaking agent — documented first for
[OpenCode](https://opencode.ai/docs/acp/) — as a daemon-managed child
process instead of the opencode plugin/callback runner. Enabling it for
one project does not disable or replace native for any other project,
and it never falls back silently: an ACP attempt that is dispatched
stays on ACP for its whole lifetime, even if the config later removes
or changes the profile.

Add a `runners` section to the daemon config. It requires
`auth.mode: bearer` (an ACP worker's scoped credential must never be
usable to bypass an open `auth.mode: none` admin API):

```yaml
auth:
  mode: bearer
  token: "change-me"

runners:
  default: native            # the only supported value — native is
                              # always the fallback for unmapped projects
  projects:
    /path/to/my-project: opencode-acp   # exact project dir → profile id
  acp:
    opencode-acp:
      command: /opt/opencode/bin/opencode   # absolute path, operator-installed
      args: [acp, --cwd, "{directory}"]     # only a whole {directory} element substitutes
      allowedRoots:
        - /path/to/my-project
        - /path/to/worktrees                # sibling worktrees must be listed explicitly
      env:
        HOME: /srv/agent-home
        XDG_CONFIG_HOME: /srv/agent-config
      inheritEnv: [PATH]        # explicit allow-list; CONDUCTOR_* names are always rejected
      maxConcurrent: 2
      deadlines:
        startupMs: 30000         # spawn + initialize + session/new + config
        writeMs: 5000            # local stdio stream write only
        turnMs: 3600000          # the actual turn — default 60 minutes, NOT the
                                  # native transport's 10-second HTTP deadline
        cancelMs: 5000           # cooperative session/cancel budget
        killMs: 2000             # forced TERM→KILL budget after cancelMs
      permissions:
        allowKinds: []           # deny-all is the example's intentional default
      bindings:
        build: {mode: build, configOptions: {model: provider/model-id}}   # mode must be advertised; always bind the model too (see Operational notes)
  reportBridge:
    command: /opt/conductor/conductor
    args: [report-mcp]
    # Source checkout instead of a compiled binary:
    #   command: /absolute/path/to/bun
    #   args: [/absolute/checkout/packages/cli/src/main.ts, report-mcp]
```

Every field is explicit and strictly validated — unknown fields, a
relative `command`/`allowedRoots` entry, an empty `allowedRoots`, a
non-positive `maxConcurrent`/deadline, a `runners.projects` entry
naming an undefined profile, or an `inheritEnv`/`env` key starting with
`CONDUCTOR_` all fail config loading with the exact field named. All
`CONDUCTOR_*` names are also stripped during ACP environment assembly
and rejected by spawn validation, not just known token names. The bridge's
three run-scoped variables below are injected separately via MCP configuration.
There is **no default agent, model, provider or gateway** anywhere in this
path: `command` is an operator-installed absolute executable path you
choose, `bindings` maps each workflow `role.agent` string to one of
that agent's own advertised session modes — either `modes` or a `mode`
config option (and, optionally, an
advertised config-option selection for the role's `model` — never a
silent substitution), and provider/login/authentication is configured
entirely inside the operator-managed OpenCode profile pointed to by
`env`/`inheritEnv`/`HOME`/`XDG_CONFIG_HOME` — Conductor never reads,
copies or performs host login for it. A binding naming an unsupported
mode, or a role whose `model` cannot be selected through an advertised
option, fails closed before any prompt is sent — never a fallback to a
default agent.

### What `report-mcp` actually is

`conductor report-mcp` is not a CLI subcommand you run by hand — it is
the stdio MCP bridge the daemon spawns as the ACP agent's **reporting
tool**, one process per run. It exposes exactly three tools —
`conductor_report`, `conductor_ask`, `conductor_status` — bound to that
one run's attempt-scoped credential. It reads **only** three injected
environment variables (`CONDUCTOR_RUN_URL`, `CONDUCTOR_RUN_ID`,
`CONDUCTOR_RUN_TOKEN`), bypassing all normal CLI config/token discovery
and never starting a daemon of its own; stdout carries MCP protocol
frames only, every diagnostic goes to stderr. `runners.reportBridge`
names the exact argv the daemon spawns for it, and the same subcommand
works two ways:

- **Compiled binary**: `command: /opt/conductor/conductor`, `args: [report-mcp]`.
- **Source checkout**: `command: /absolute/path/to/bun`,
  `args: [/absolute/checkout/packages/cli/src/main.ts, report-mcp]`.

Both are exercised in the repository's own tests against a fake MCP
client — no real OpenCode process, model, provider or host credential
is used to verify that the three tools list correctly.

### Permissions are least-privilege API scope, not an OS sandbox

`permissions.allowKinds` controls only which ACP `request_permission`
tool **kinds** may receive an offered `allow_once` grant — every other
request (missing context, unknown session, a revoked run's request, an
empty `allowKinds`) is denied or cancelled, never granted permanently
and never left waiting. The ACP client advertises no filesystem or terminal
capabilities and explicitly rejects filesystem/terminal requests with
method-not-found errors. Elicitation has no registered handler and is rejected
as unsupported, not forwarded to a human (use `conductor_ask`). This, the run-scoped MCP credential, and the
explicit `env`/`inheritEnv` allow-list are **API and protocol-level**
least privilege — they are not a filesystem or network sandbox. An
agent-owned tool that the operator's own `allowKinds`/OpenCode profile
permits can still read/write anything that OS user can. For real
isolation, run the ACP agent under its own **non-root OS account or
container**; Conductor does not implement or claim such a sandbox.
Cleanup on cancellation/abandon covers the process tree actually
observed at cancel time, including descendants that called their own
`setsid` (e.g. a backgrounded shell-tool command) and so sit in a
different process group/session than the agent leader; a descendant
forked after that observation is outside Conductor's reach — only an
OS-level sandbox bounds processes created afterwards.

### Restart, shutdown and unknown execution

A stable ACP 1 negotiation (`protocolVersion: 1`, exact match, no
`/experimental/*` imports) is required at connect; anything else is
refused. Once a create or prompt operation may have reached the write
boundary, Conductor treats a lost response, process death, daemon
restart, connection EOF, a turn/no-report deadline or cancellation as
**execution-uncertain**, never as proof of failure or success — it
fences the run (`run.status: "uncertain"`), revokes that attempt's
worker credential, and stops all automatic routing for it (no retry,
no `onFail`, no nudge, no downstream dispatch). A persisted session id
after a restart is a diagnostic only, never proof of a live process:
Conductor never reloads or replays an ACP conversation to "recover" an
uncertain run automatically. At startup, durably completed answer operations
are settled as delivered before ownership-loss fencing; fencing still applies
when the project's workflow cannot be resolved. See
[Retries, failure classes and recovery](concepts.md#retries-failure-classes-and-recovery)
and [Recovering an escalated feature](http-api.md#recovering-an-escalated-feature)
for how a fenced run surfaces and what an operator must do next —
`conductor recover` on an uncertain target additionally requires
`--acknowledge-uncertain`, `--expected-version`, `--idempotency-key`
and (before `--cleanup-attested`) independent confirmation that any
orphaned process was actually terminated; a plain `recover` is rejected.
`resume` cannot clear a fence: HTTP returns `409 conflict` with a message
requiring `recover` with `acknowledgeUncertain` and cleanup evidence.

Pause fences only unresolved in-flight ACP turns, not idle asking runs.
Their questions remain durable; an answer accepted while paused stays pending
until resume and reconciliation deliver it to the live session.

On daemon shutdown, abandon, or pause interrupting an unresolved turn, the ACP adapter sends
`session/cancel`, waits `cancelMs`, then TERM's and — after `killMs` —
KILLs the process group; a terminal report never blocks synchronously
on its own ACP turn ending (that would deadlock), so cleanup runs
asynchronously and is drained before SQLite closes. This is
best-effort process-group cleanup, not a guarantee against escaped
descendants — see the sandbox note above.

### ACP turn completion is never workflow success

`session/prompt` ending with `end_turn` (or any other stop reason) is
**not** a report. A step stays incomplete until the agent calls
`conductor_report` through the MCP bridge; an idle turn with no report
gets at most one journaled idle nudge on the same live connection, and
timeout or nudge exhaustion never automatically replays a turn that
may already have executed. While a turn streams, ACP activity notifications
refresh the run's liveness (silence TTL), throttled to once per second;
activity is not a report and does not extend the separate turn deadline.

### Operational notes from live runs

- **Always bind the model per role.** In OpenCode, selecting a session
  mode through ACP does not apply the mode/agent's own configured `model`;
  the session keeps the profile's default model. Put the role's model in
  `bindings.<role>.configOptions.model` (it must be an advertised option;
  Conductor sets the mode, then the model, and fails closed if either is
  not confirmed), for example
  `conductor-implementer: {mode: conductor-implementer, configOptions: {model: provider/model-id}}`.
- **MCP tool names are namespaced.** OpenCode exposes the report bridge's
  tools as `<server>_<tool>`, and Conductor names the server
  `conductor-<runId>`, so the tools appear as
  `conductor-<runId>_conductor_report` etc. An agent whose OpenCode
  permissions are deny-by-default must allow the pattern
  `"conductor-*_conductor_report"` (and `_conductor_ask`/`_conductor_status`
  as needed); allowing only the native plugin tool name `conductor_report`
  leaves the agent unable to report, which surfaces as `no_report_timeout`
  after idle nudges.
- **Overriding `XDG_CONFIG_HOME` hides every other tool's config.** Tools
  the agent runs (`gh`, `git`, `mise`, …) look under `$XDG_CONFIG_HOME`
  too; if the profile uses a dedicated `XDG_CONFIG_HOME`, symlink or copy
  the configs those tools need (for example `gh`) into it, or the agent's
  `gh pr review` etc. silently lose authentication.
- **Remove the native runner plugin from the ACP profile.** If the
  OpenCode profile used for ACP still loads the Conductor native runner
  plugin, each ACP agent process would also register as a native runner.
  Use a profile without it.
- **Gateways that reject empty completions.** Some OpenAI-compatible
  gateways (observed: OmniRoute, `502 empty_content`) treat an empty
  assistant turn as an error; OpenCode then retries internally and the ACP
  turn never ends, which Conductor fences as uncertain. Prompts for
  interactive steps should instruct the agent to always end a turn with a
  short non-empty sentence (e.g. after `conductor_ask`: "Waiting for the
  human answer.").
- **Cold start.** The first `opencode acp` start in a fresh profile
  installs plugins and can take over a minute; size `deadlines.startupMs`
  accordingly (warm starts ~2 s).

### Rollback

Disabling ACP only affects **future** dispatch: removing or editing
`runners` and restarting the daemon never reroutes an already-dispatched
ACP run to native — its binding is immutable for that attempt's
lifetime. To roll back a daemon upgrade that added this feature, prefer
keeping the upgraded schema/code and simply not configuring `runners`
(native stays the default) over restoring a pre-upgrade database
backup, which would lose ACP audit history. If you do stop an
ACP-enabled daemon for rollback, resolve or explicitly abandon every
in-flight ACP attempt/delivery first — an old daemon binary must never
be pointed at a database containing rows it does not understand and
retry them blindly.

### Status of this integration

Beyond the offline, deterministic integration checks (protocol
negotiation, configuration, permissions, process supervision, durable
crash-safety and full repository quality checks), this path was run live
against OpenCode 1.18.32/1.18.33 over ACP (verified 2026-09-28/29):

- **Micro-project smoke**: ask → human answer → file effect →
  `conductor_report` → done. A daemon restart during a pending ask fenced
  the run and required an explicit `recover`. Abandon during a long shell
  tool killed the full process tree, including a `setsid`'d descendant
  (after a fix found by that live run).
- **Full production workflow**: a 19-job multi-agent workflow — planning
  architects in parallel, consensus with a rerun loop, implementer, 7
  parallel reviewers, doc writer, push, PR, CI wait, PR reviewers and a
  human merge gate — ran end to end on ACP with 21 agent runs and was
  merged.

This is still not a universal compatibility certification. The design's
Stage 2 multi-runtime compatibility evidence gate was **explicitly waived
by the user, not passed**: only OpenCode was exercised live, with no
second runtime. Expect provider/model compatibility and
deadline/concurrency tuning to vary per installation — it does not change
the fail-closed contract described above. See
`openspec/changes/acp-runner/design.md` for the full decision record and
`docs/acp-gap-analysis.md` for the ACP-vs-native capability comparison
this change was built from.

## First feature

```sh
cd /path/to/my-project
conductor init      # scaffolds conductor.yaml AND registers the project:
                    # it is added to the LOCAL daemon config (generated if absent) and,
                    # when a daemon is running, registered live — no restart.
                    # With an explicit connection (--url/CONDUCTOR_URL/--config) the
                    # daemon of record may be remote: init registers live only and
                    # never touches the local platform config.
                    # --no-register: scaffold only.

# Only needed for a REMOTE daemon or auth overrides — a local daemon's
# generated config supplies the CLI's address and token automatically:
export CONDUCTOR_URL=http://127.0.0.1:4400
export CONDUCTOR_TOKEN=change-me

conductor start "Ship the thing"     # --project defaults to the current directory
conductor status --active            # watch progress
conductor status <feature-id>        # detail: status, current step, run
conductor approve <feature-id> --notes "ship it"   # when waiting_human
conductor logs <feature-id>          # transition timeline
```

## Troubleshooting

- **Port already in use** — `conductor daemon` fails at startup with a
  bind error. Change `bind.port` in the config (or `CONDUCTOR_BIND_PORT`),
  or find the occupant: `lsof -i :4400`.
- **UI/API not reachable from another machine** — the default bind is
  loopback. Set `bind.host: 0.0.0.0` (or `CONDUCTOR_BIND_HOST=0.0.0.0`)
  AND switch auth to `bearer`; open the port in the firewall.
- **`conductor init` rewrote my daemon config comments** — the platform
  config file is machine-generated and regenerated on project
  registration; hand-crafted configs should live elsewhere and be used
  via `conductor daemon --config <path>` (init never touches those).
- **`error[unauthorized]` / exit code 3** — the client's token does not
  match the daemon's `auth.token`. Set `--token`/`CONDUCTOR_TOKEN` to the
  daemon's configured value. `auth.mode: none` daemons need no token.
- **`daemon unreachable` / exit code 7** — wrong `--url`, daemon not
  running, or it bound a different host/port. Check the daemon's
  `api listening` log line.
- **Workflow invalid at registration** — the daemon logs
  `workflow invalid: …` per diagnostic and `/v1/health` reports the
  project's state. Fix `conductor.yaml`; the registry reloads on the next
  registration (restart the daemon or fix before start).
- **`action:` steps invalid under the compiled binary** — the bundled
  manifests are not inside the binary; set `actions.bundledPath` (see
  Path B above).
- **Runner reported unavailable** — no runner registered yet. Check the
  opencode plugin env (`CONDUCTOR_URL`, callback auth pair) and that
  opencode is running in a directory registered under `projects`.
- **`"runners" requires "auth.mode: bearer"`** — set `auth.mode: bearer`
  with a real token before adding a `runners` section; ACP is refused
  under `auth.mode: none` so a worker's scoped credential can never
  double as a way to reach the open admin API.
- **A run is stuck `uncertain`** — this is the ACP integration's
  fail-closed default when a create/prompt outcome could not be proven
  (lost response, crash, restart, timeout). It is not treated as failed
  or successful and will not automatically retry. See
  [Restart, shutdown and unknown execution](#restart-shutdown-and-unknown-execution)
  above and [Recovering an escalated feature](http-api.md#recovering-an-escalated-feature)
  for the required `--acknowledge-uncertain --expected-version
  --idempotency-key` (and, after independently confirming orphan
  cleanup, `--cleanup-attested`) recovery flow.
