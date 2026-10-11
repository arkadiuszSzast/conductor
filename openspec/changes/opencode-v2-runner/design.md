## Context

OpenCode 2.0.25 is the only runtime on the host. The v1 plugin runner (`packages/runner-opencode`: hub + v1 `sessions.ts` + report tools) cannot load in v2. The ACP path works, but it has three problems:

- Effort is a `configOptions` write that a model switch can reset (`acp/sessions.ts:380/389`).
- There is no receiver-side status.
- A lost `session/new` must fence.

The v2 HTTP API (see `research/v2-api-research.md` in the migration workspace) offers:

- `POST /api/session` with `{id?, agent, model: {providerID, id, variant}, location: {directory}, metadata}`.
- `POST /api/session/{id}/prompt` with `{id?, text, resume?}`. It returns immediately, is idempotent on `id`, and returns 409 on a payload mismatch.
- `GET /api/session/active` and `Session.Info.{outcome, time.idle}`.
- `POST /api/session/{id}/interrupt?resume=false`.
- `POST /api/session/{id}/synthetic` with `resume: false`.
- `GET /api/agent`, `GET /api/model` and `GET /api/plugin`, all location-scoped through the `location[directory]` query parameter.
- Basic auth with `opencode:<password>`.

The server also runs plugins (`Plugin.define`, `ctx.tool.transform`, `ctx.session.get`). This has been verified with the `conductor-tool-probe` reference plugin.

## Goals / Non-Goals

**Goals:**
- A daemon-side `SessionClient` over v2 HTTP, selected per project like ACP profiles.
- Deterministic model+variant per session, from the role first and the binding second.
- Idempotent create/prompt that replays instead of fencing.
- A v2 reporting plugin with session-bound credentials.
- Fix ACP effort ordering and carry `role.variant` end to end.

**Non-Goals:**
- Supervising the `opencode serve` process. The server is external: OpenChamber-managed or a systemd unit.
- SSE event streaming. Polling `active` is enough for now; streaming is a later optimisation.
- Keeping the v1 plugin transport or the opencode use of the runner registry.
- Any change to the workflow format beyond adding `role.variant`.

## Decisions

### D1 — Daemon calls the server; no runner process in between
The v1 design had a plugin inside opencode announce itself and receive daemon callbacks. In v2 the daemon owns an HTTP client per profile and calls the server directly. This removes the hub, the callback auth and the lease registry for opencode.

The runner binding persists `transport = 'opencode'`, `profile_id`, a config digest and `remote_session_id`. This needs a migration that widens the CHECK constraint; the project is greenfield, so there is no data to carry over.

`runnerAvailable` for a project means that the profile's `GET /api/location` answers.

*Alternative rejected:* keep a plugin-hosted transport. It brings back the callback hub with no gain, because v2 exposes everything over HTTP.

### D2 — One model source, sent once at create
`engine.ts` resolves `{agent, model, variant}` as role ?? binding. The model string stays `provider/id`, split at the first `/`. Models like `omniroute/claude/claude-opus-5-5` split correctly as provider `omniroute`, id `claude/claude-opus-5-5`.

The resolved values are sent in `session.create`. `prompt` never sends a model. `switchModel` is never called. The agent's frontmatter `model` is ignored by construction, because create always carries one.

`role.variant` is added to the core role type and validation. It is an optional non-empty string, checked against the server catalog at create time and not in core, since core is runtime-neutral.

### D3 — Pre-create validation with a cold-location retry
`prepare()` reads `/api/agent` until the list is non-empty: 250 ms backoff, bounded by `startupMs` (default 30 s). It then checks:
- the agent exists;
- the model exists in `/api/model`;
- the variant, if any, is in the model's variants.

A failure raises `RunnerOperationError({delivery: "not_sent", failureClass: "invalid_config"})`. The same `prepare()` also checks plugin readiness (D5). A timeout on the empty list is a `not_sent` resource-unavailable error, so it goes through the ordinary bounded retry.

### D4 — Deterministic ids from the operation key
`deriveOperationLogicalKey` already gives a stable key per create/prompt/answer/nudge. The client maps it to `ses_<hash>` / `msg_<hash>`: a SHA-256 truncated to the length and alphabet v2 accepts. Task 1.1 checks the exact id grammar against 2.0.25 before the code depends on it.

Replay behaviour:
- A lost response is retried with the same id.
- A 2xx, or a `GET` that finds the session, means done.
- A mismatched echo means delivery is `unknown`, and the run is fenced.

**Probe results, task 1.1 (2.0.25, live server):**
- Client-supplied ids are accepted when they start with `ses`/`msg`; `conductor-x` and `msg_abc`-as-session return 400. The client uses `ses_c<base62>` / `msg_c<base62>`, 26 characters after the prefix.
- Replaying the same id is idempotent: 200 with the original record. **No 409 is returned for a different payload.** The server silently returns the ORIGINAL record. So the client compares the echo with the request: on create, `agent`, `model` and `metadata.conductor.runId`; on prompt, `payload.text`. A mismatch is `delivery: "unknown"`.
- `session.create` does **not** validate `agent` or `model`: unknown values are stored as-is. This makes D3's pre-validation mandatory, not just defensive.
- A cold location returns `GET /api/agent` → `{data: []}`; a moment later the same call returns 40 agents. Agent records look like `{id, name, mode, hidden, …}`. Model records look like `{id, providerID, variants: [{id}]}`.
- `GET /api/session/{missing}` and `interrupt` on a missing session both return 404 `{_tag: "SessionNotFoundError"}`. `interrupt` on an idle session returns `{interrupted: false}`. `GET /api/plugin` returns `{data: [{id, state: {status}}]}`.
- `metadata` round-trips on create and is returned by `GET /api/session/{id}`.

Capabilities: `promptConfirmation: "immediate"`, because the prompt is durably admitted on 2xx. Notes are non-inferential through `synthetic` with `resume: false`, and status is supported.

*Trade-off:* a `synthetic` note stays in the inbox until the parent session's next turn, so it is not in `message.list` before that. That is acceptable for a timeline. Instruction entries were rejected because they reach the model at every step boundary.

### D5 — Reporting plugin with session-bound credentials
`packages/runner-opencode` becomes a v2 plugin, `conductor.report`. It adds `conductor_report`, `conductor_ask` and `conductor_status` with `codemode: false`.

At create, the daemon writes `metadata.conductor = {runUrl, runId, token}`. On a tool call, the plugin does `ctx.session.get(context.sessionID)` to read it, then calls the existing `/v1/worker/*` routes with that bearer token. Because of this, `run_id` arguments are ignored or checked for equality, and are never trusted.

Readiness means `GET /api/plugin?location…` lists `conductor.report` as active. The session metadata write is part of the create that the plugin reads.

*Trade-off:* the plaintext token sits in OpenCode's session DB, readable by anyone holding the server password. It is per-attempt and revoked on conclusion, fencing or expiry under the existing run-auth rules. It is never visible to the model, because session metadata has no model-facing tool.

*Alternative rejected:* a plugin-wide daemon token with sessionID→run lookup. That token would be broader (any session) and long-lived.

### D6 — ACP effort ordering
In `ManagedSessions`, `configOptions` are applied with `model` first, then every other option, with `effort` last. A role variant overrides the binding's `effort` value. The effective value is read back from the `config_option_update` echo before the first prompt; a mismatch is `invalid_config`.

## Risks / Trade-offs

- **Experimental or unpinned v2 routes** → only stable `/api/session*`, `/api/agent`, `/api/model`, `/api/plugin` and `/api/location` are used; `wait` and `log` are not. The OpenCode version is recorded in the binding's config digest.
- **Ancestor v1 `opencode.json` breaks a location (500)** → this is surfaced as a `prepare()` diagnostic with the server's error body. The install docs say to keep worktrees out of such trees.
- **The shared OpenChamber server is restarted under a running step** → status goes to `missing`/`unknown`, and the existing reap/fence rules apply. A dedicated `opencode serve` unit is documented as the recommended setup.
- **Id grammar mismatch** → task 1.1 checks it first. The fallback is server-assigned ids with create fenced on loss, which matches ACP behaviour.

## Migration Plan

This is greenfield. A new migration widens `runner_binding.transport`. The v1 plugin package contents are replaced, and the host `daemon.yaml` gets a `runners.opencode` profile. Rollback means routing the project back to the ACP profile in `daemon.yaml`; no data changes.

## Open Questions

- Should the profile target the OpenChamber server (`127.0.0.1:45707`) or a dedicated `opencode serve` unit? The default is a dedicated unit, documented; either one works through config.
