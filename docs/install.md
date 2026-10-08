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
# changeQueueIntervalMs: 60000   # how often the change queue is evaluated (default 60000)
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

### Change queue interval

| Field | Type | Default | Notes |
|---|---|---|---|
| `changeQueueIntervalMs` | positive number (ms) | `60000` | How often the change-queue scheduler runs. It has its own timer, separate from `heartbeatIntervalMs`, because a pass runs `git fetch` once per project that has queued changes. Omit it for the default. |

A value that is not a positive finite number (zero, negative, `NaN`,
`Infinity`, a string, `null`) fails config loading with
`"changeQueueIntervalMs" must be a positive number`. The scheduler only
does work for projects whose queue holds entries that are not yet
`merged`/`removed`, so an idle queue costs nothing. A merge, a resume or a
queue edit is therefore picked up within one interval (plus the fetch).
See [Running unattended](#running-unattended-change-queue).

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

## Connecting an OpenCode v2 server

OpenCode 2.x runs as an HTTP server (`opencode serve`). Conductor drives
it directly over that API: the daemon validates the agent, model and
variant, creates one session per attempt with deterministic ids, and
prompts it. There is no runner process or callback listener. The server
itself is external to the daemon; run it as its own unit, or reuse an
OpenChamber-managed instance.

1. **Run the server** with a password (Basic auth `opencode:<password>`):

   ```ini
   # /etc/systemd/system/opencode-server.service (example)
   [Service]
   EnvironmentFile=/etc/conductor/opencode-server.env   # OPENCODE_SERVER_PASSWORD=...
   ExecStart=/opt/opencode/bin/opencode serve --hostname 127.0.0.1 --port 4096
   ```

2. **Install the reporting plugin** in the server's `opencode.json`. It
   adds `conductor_report`, `conductor_ask` and `conductor_status`:

   ```json
   { "plugins": [{ "package": "/path/to/conductor/packages/runner-opencode" }] }
   ```

   The daemon writes each attempt's run-scoped credential into the
   session's `metadata.conductor` at creation. The plugin reads it from
   the calling session, so the model never sees or supplies a token, and
   a `run_id` argument can only repeat the session's own run. A session
   Conductor did not create is refused. Before the first prompt,
   `prepare()` checks that `GET /api/plugin` lists `conductor.report` as
   active for the location.

3. **Add a profile** to the daemon config. It requires `auth.mode: bearer`:

   ```yaml
   runners:
     default: native
     projects:
       /path/to/my-project: opencode-v2
     opencode:
       opencode-v2:
         baseUrl: http://127.0.0.1:4096
         passwordFile: /etc/conductor/opencode-server.password   # or passwordEnv: VAR
         allowedRoots: [/path/to/my-project, /path/to/worktrees]
         maxConcurrent: 4
         deadlines: {startupMs: 30000, requestMs: 15000}
         bindings:
           build: {model: provider/model-id, variant: medium}
   ```

   - The password is never inline; it is read on each request, so a
     rotated file needs no restart.
   - Model selection comes from one place: a workflow role's
     `model`/`variant` first, then the profile binding for that agent.
     The full `{providerID, id, variant}` is sent when the session is
     created, and never changed afterwards. `provider/id` splits at the
     first `/`.
   - An unknown agent, model or variant fails the step as a
     configuration error before any session exists. A location whose
     agent catalog is still empty (cold start) is retried within
     `startupMs`.
   - A lost create or prompt response is replayed with the same id. The
     server answers a replay with the original record. If that echo
     disagrees with the request, the run is fenced instead of guessed.
   - `reportBridge` is only required when an ACP profile exists.

Profile ids are unique across `acp` and `opencode`. A routed attempt
stays on its transport for its whole lifetime.

## Connecting an ACP agent (OpenCode)

The native runner protocol remains the default route: an unconfigured
daemon uses it, and nothing below is required to run Conductor. The
Agent Client Protocol (ACP) path is a separate, **opt-in** way to drive
a local ACP-speaking agent — documented first for
[OpenCode](https://opencode.ai/docs/acp/) — as a daemon-managed child
process instead of an OpenCode server profile. Enabling it for
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
worker credential, and stops all ordinary routing for it (no retry
budget, no `onFail`, no nudge, no downstream dispatch). Fences that are
provably safe to replay are then healed automatically — see
[Self-healing of uncertain runs](#self-healing-of-uncertain-runs); every
other fence escalates. A persisted session id
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

### Self-healing of uncertain runs

Once the fenced process's cleanup evidence is in (bounded by
`engine.healing.classifyTimeoutMs`, default 15 s), the fence is classified
from durable evidence:

| Classification | When | What happens |
|---|---|---|
| `no_effect` | No session was ever bound, no prompt left the journal's `prepared` phase, and the process group is **confirmed** terminated — e.g. `session/new` hung during a host stall. | Healed automatically. |
| `replay_safe` | The step declares `replaySafe: true` and the process group is confirmed terminated. | Healed automatically. |
| `unsafe` | Anything else, including any unconfirmed cleanup or an open answer delivery. | Escalates; acknowledged `recover` required (above). |

Healing resolves the fence with an audit note (`system.healed` in the
timeline; the old run stays `uncertain` in history and is never resent) and
schedules a fresh attempt with exponential backoff and full jitter: 1 min, 2,
4, 8, … capped at 30 min, **without an attempt limit**. Healing does not
spend the step's `retry` budget. Pause suspends it; abandon cancels it.

After `attentionAfter` consecutive failed heals (default 3) — or once an
ordinary transient retry has used half its budget — the feature shows
**attention**: still `running` and still retrying, but flagged on the board,
in `conductor status` and through notifications. The first successful run of
the troubled step clears it and sends a `recovered` notification.

```yaml
engine:
  healing:
    initialMs: 60000        # first heal delay
    maxMs: 1800000          # backoff cap
    attentionAfter: 3       # consecutive failures before "attention"
    classifyTimeoutMs: 15000
```

Mark read-only steps (reviews, quality reports) `replaySafe: true` in the
workflow — they then heal from lost prompts and turn deadlines too, not only
from a session that was never created.

### Notifications

The daemon can push operator-relevant events to Telegram: `attention`,
`recovered`, `escalated`, `waiting_human` (gate or question) and `done`.
Notifications are written to a durable outbox in the same transaction as the
state change, so a crash never loses one, and are delivered asynchronously
with retries (up to 24 h) — a dead channel never blocks the pipeline.
Repeats of the same kind for the same feature within `rateLimitWindowMs`
(default 15 min) are suppressed and counted in the next message;
`recovered` and `done` are never suppressed.

```yaml
notifications:
  publicBaseUrl: https://conductor.example.com   # optional: adds an "open" link
  telegram:
    chatId: "-1001234567890"
    tokenEnv: CONDUCTOR_TELEGRAM_BOT_TOKEN       # default; the token itself never goes in this file
    # events: [attention, recovered, escalated, waiting_human, done]
```

Setup: create a bot with @BotFather, add it to your chat (or message it
once), read the chat id from
`https://api.telegram.org/bot<token>/getUpdates`, export the token in the
daemon's environment (e.g. a systemd `EnvironmentFile`), restart the daemon,
then verify with:

```sh
conductor notify test
```

The daemon refuses to start when a Telegram channel is configured but its
token variable is unset.

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
- **Effort is applied last.** Switching the model resets OpenCode's
  `effort` to the model default, so Conductor applies the model first,
  then the other options, and `effort` last. It then checks that every
  value survived. A workflow role's `model`/`variant` overrides the
  binding's `model`/`effort`.
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

## Running unattended (change queue)

The change queue lets Conductor pull OpenSpec changes by itself instead of
waiting for a human to start each one: it starts every queued change whose
dependencies have **merged**, up to a per-project parallelism limit, and a
stuck change blocks only the changes that depend on it. A queued change
starts an ordinary feature, through the same path as "Start work" in the
OpenSpec panel, with the project's own `conductor.yaml`; the workflow is
untouched and the workflow engine does not know the queue exists. The
queue is inert until you queue something.

### Declaring dependencies

A change lists the changes it depends on in its own
`openspec/changes/<name>/.openspec.yaml` as `depends_on`:

```yaml
schema: spec-driven
created: 2026-03-02
depends_on:
  - unify-content-gates
  - dialogue-node-atomic-commit
```

- `depends_on` is a list of change names. Absent, or empty, means "no
  dependencies": the change is ready as soon as it is queued. The OpenSpec
  CLI keeps the key untouched.
- Each name must be a change that exists in the project: active
  (`openspec/changes/<name>/`) or archived
  (`openspec/changes/archive/<date>-<name>/`, in the checkout or on the
  remote default branch). Conductor never derives dependencies from
  `proposal.md` prose; a dependency mentioned only in prose is not scheduled.
- A `.openspec.yaml` that is not a mapping, whose `depends_on` is not a list
  or has a non-string item, is reported on the entry (`invalid`), never a
  crash. The panel shows such a change with no dependencies and a warning. A
`.openspec.yaml` larger than 64 KiB, or one that uses YAML anchors or aliases
(`&`/`*`), is refused the same way, before it is parsed.
- The scheduler re-reads these files on every pass, so editing `depends_on`
  is enough to change the graph; it travels through review with the change.

Queueing is refused up front (`422 invalid_queue_entry`, see
[HTTP API](http-api.md#change-queue)) when the dependencies contain a cycle
or name an unknown change; the same checks run on every pass, so an edit
that later introduces a cycle turns the entry `invalid` instead of starting
it.

Dependency declarations, proposals and the change directory are read from
the **project's checkout on disk**, not from the remote: a change must exist
in the checkout to be startable (otherwise the entry is `invalid`, "has no
directory"). Keep the checkout current — the pipeline's cleanup step
fast-forwards it after a merge. Only the *merged* test below looks at the
remote.

### What "merged" means

A dependency counts as merged when the project's **default branch on the
remote** contains its archive directory: `openspec/changes/archive/<YYYY-MM-DD>-<name>/`.
On each pass, for each project with live queue entries, the daemon:

1. finds the default branch (`git symbolic-ref refs/remotes/origin/HEAD`,
   falling back to `main`);
2. runs one bounded `git fetch --quiet origin <default branch>` (30 s limit,
   never a credential prompt);
3. lists `openspec/changes/archive/` on `origin/<default branch>`.

This is exactly what a merged PR produces when the workflow archives the
change on the feature branch, and it does not depend on Conductor having
watched the merge — a human may merge by hand. A feature that finished
`done` without the archive on the default branch does **not** count (a
workflow without a merge step also ends `done`): its entry stays `running`
with the reason "feature done; waiting for its change to merge on the
default branch", and its dependants keep waiting. "Merged" is final: once an
entry is `merged` it never leaves that state.

If the fetch fails (offline, auth), the failure is logged and the project's
last known merged set from an earlier pass is used — merged only ever grows,
so this can delay a start but never cause a wrong one. With no earlier
result (for example right after a daemon restart) nothing is started for
that project until a fetch succeeds.

### States and what blocks what

Each entry is in exactly one state and carries a reason (full table in the
[HTTP API](http-api.md#entry-payload)):

| State | Why |
|---|---|
| `waiting` | Not started: waiting for named unmerged dependencies, the queue is paused, or the parallelism limit is reached. |
| `blocked` | A change it depends on, directly or transitively, has a feature that is `escalated`, `paused` or `abandoned`; the reason names the nearest stuck change. |
| `invalid` | Cannot be started (cycle, unknown dependency, unreadable `.openspec.yaml`, missing change or `proposal.md`, or a failed start). |
| `starting` / `running` / `escalated` | Claimed / linked to a live feature / linked to an escalated or abandoned feature. |
| `merged` / `removed` | Final. |

When several reasons apply, the entry shows the first that matches, in this
order: invalid, blocked, unmerged dependencies, queue paused, parallelism
limit. So a paused queue says "queue paused" only for changes that are
otherwise ready.

A stuck change blocks **only its dependants**. Independent changes keep
starting, so an escalation at 3 a.m. does not stall unrelated work. When the
stuck feature is resumed or recovered, its dependants return to `waiting`
on the next pass. Abandoning a feature is permanent: removing the queue
entry of an abandoned change leaves its dependants `blocked` until their
`depends_on` no longer names it or you remove them.

An entry can be removed while it has not started, or once its feature is
terminal (`done` without a merge, or `abandoned`). It cannot be removed while
`starting` or while its feature is running, paused or escalated: abandon the
feature first (the API answers `409`). A paused feature keeps its entry
`running`, keeps its parallelism slot and blocks its dependants until it
resumes. A removed entry whose feature is still non-terminal keeps counting
against the parallelism limit.

### Parallelism and pause

- **Parallelism** (default `1`, any integer ≥ 1, per project): the number of
  the queue's started features that may be non-terminal at once. Ready
  entries start in queue order until the limit is reached; the rest wait with
  "parallelism limit reached". A feature waiting at a human gate still holds
  its slot. The default of 1 keeps the blast radius to one change at a time;
  independent changes can still conflict when merged, so raise it knowingly.
- **Pause** stops *new* starts only; running features carry on. Resume
  to continue. Both are set from the OpenSpec panel or `PATCH /v1/projects/queue`.
- **Order** — entries that have not started can be reordered; queue order is
  the start order among ready entries.

### When starting a change fails

For each ready entry the scheduler claims it, creates the feature, then links
it, so a change starts at most once, also across daemon restarts and a second
daemon on the same database. At the start of every pass, a claimed entry left
behind is linked to the feature that was created for it, or its claim is
released. The feature is found by its `change_slug`/`change` input, so a
project whose workflow declares neither as a string input is not startable:
its entries are `invalid` ("the workflow declares no `change_slug`/`change`
string input") and never claimed.

If creating the feature is refused — for example the workflow declares a
required input other than `change_slug`/`change`, which the queue cannot
supply, or the change lost its `proposal.md` — the entry becomes `invalid`
with the error as its reason and **is not retried** on later passes (a
retry would fail forever and loop). Fix the cause, remove the entry, and
queue the change again. (If the project was unregistered mid-pass, the claim
is simply released and the next pass tries again.)

The derived start is the same as "Start work": the title comes from the
change name, the description from the proposal's *Why*, and the workflow's
`change_slug` (or `change`) string input is filled with the change name.

### Auto-merge is the project's choice

Conductor's queue **never merges anything**. Merge policy stays in the
project's `conductor.yaml`. A project that keeps its human merge gate (for
example a `human` step before a `git/pr-merge@v1` action) gets a queue that
starts the next change when a person approves and the PR merges — unattended
between those points. A project that wants fully unattended runs opts in
explicitly by removing that human gate from its own `conductor.yaml`
(see [Workflow reference](workflow-reference.md#human)), and accepts that
merged work is no longer reviewed by a person. Nothing in the daemon config
turns auto-merge on or off.

A dependant starts from whatever the project's workflow checks out, so make
sure it syncs the default branch before creating the worktree (the gloam
workflow does in `prepare/sync_main`); the readiness test only guarantees the
dependency is on `origin/<default branch>`.

### Operating it

```sh
# Queue from the OpenSpec panel ("Queue" next to "Start work"), or:
curl -X POST http://127.0.0.1:4400/v1/projects/queue/entries \
  -H "authorization: Bearer $CONDUCTOR_TOKEN" -H 'content-type: application/json' \
  -d '{"dir": "/path/to/my-project", "change": "quest-outcomes"}'

curl "http://127.0.0.1:4400/v1/projects/queue?dir=/path/to/my-project" \
  -H "authorization: Bearer $CONDUCTOR_TOKEN"
```

The panel ([Plugins](plugins.md#queueing-changes-from-the-panel)) shows
each change's dependencies, queue state and reason, and the pause and
parallelism controls. Daemon logs mention the queue as `change-queue: …`
(starts, failed starts, fetch failures, restart recovery). To roll back,
pause the queue and stop queueing; the queue tables can stay.

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
  or successful. `no_effect`/`replay_safe` fences heal on their own (the
  run inspector says "healing scheduled"); an escalated feature means the
  fence was classified `unsafe`. See
  [Restart, shutdown and unknown execution](#restart-shutdown-and-unknown-execution)
  above and [Recovering an escalated feature](http-api.md#recovering-an-escalated-feature)
  for the required `--acknowledge-uncertain --expected-version
  --idempotency-key` (and, after independently confirming orphan
  cleanup, `--cleanup-attested`) recovery flow.
- **A queued change never starts** — read its `reason` (panel or
  `GET /v1/projects/queue`). `` waiting for `x` `` means `x` is not archived on
  `origin/<default branch>` yet (a `done` feature is not enough);
  `blocked: …` names the escalated/paused/abandoned change to resolve; `invalid: …`
  says what to fix (a failed start stays `invalid` until you remove the entry
  and queue the change again; a project whose workflow declares no
  `change_slug`/`change` string input has every entry `invalid` until the
  workflow declares one). If every entry waits and the daemon log shows
  `git fetch … failed … starting nothing for this project`, fix the remote
  access; the scheduler needs one successful fetch.
