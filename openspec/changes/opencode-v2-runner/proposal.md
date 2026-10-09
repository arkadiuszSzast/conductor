## Why

The host now runs OpenCode 2.0.25. The current native runner (`packages/runner-opencode`) is a v1 plugin: it uses `@opencode-ai/plugin` 1.x, `session.promptAsync` with `noReply`, and the callback hub. v2 does not load it. The only path left is ACP, which carries model effort as a late `configOptions` write, has no receiver-side status, and cannot replay a lost `session/new`.

The v2 HTTP API fixes all three. Session create and prompt accept caller-supplied ids and are idempotent. Status is queryable (`/api/session/active`, `Session.Info.outcome`). `model.variant` is a first-class field. Conductor should drive v2 directly and stop going through ACP or a v1 plugin.

## What Changes

- **BREAKING** Replace the v1 plugin transport with a daemon-side v2 HTTP `SessionClient`. The daemon calls a configured `opencode serve` endpoint directly. The runner callback hub, the runner announce/lease registry use for opencode, and the v1 plugin session code are removed.
- New daemon config section `runners.opencode.<profile>`: `baseUrl`, a password source (env var or file, never inline), `allowedRoots`, `maxConcurrent`, and optional per-agent `bindings` (`model`, `variant`). Projects route to it through `runners.projects`, the same way they route to ACP profiles.
- Every session is created with the full `{providerID, id, variant}`. Model and variant come from one Conductor-side source: the workflow role (`role.model`, `role.variant`), falling back to the profile binding. Nothing is applied late or out of order.
- Before create, the daemon checks the location's agent list (`/api/agent`) and models (`/api/model`). It retries bounded until the list is non-empty, to handle the cold-location race. An unknown agent, model or variant fails as `invalid_config` before any write.
- Session create and prompt use deterministic `ses…`/`msg…` ids derived from the durable operation key. After a lost response, the daemon replays with the same id instead of fencing.
- A v2 plugin (`conductor.report`) replaces the v1 report tools. It exposes `conductor_report`, `conductor_ask` and `conductor_status`. It reads the attempt credential from session metadata set at create time, so the model never supplies the run id or the token.
- Fix ACP effort ordering (`acp/sessions.ts`): apply `effort` after `model`, so a model switch can no longer reset it. Wire `role.variant` through `engine.ts` into both transports.
- Update the install docs for v2: native v2 setup, the ACP section, and the removal of the v1 plugin.

## Capabilities

### New Capabilities
- `opencode-execution`: driving steps through an OpenCode v2 server. Covers routing and config, pre-create validation, model/variant selection, idempotent create and prompt, status and abort semantics, notes, and readiness of the reporting plugin.

### Modified Capabilities
- `run-scoped-reporting`: the reporting surface can now be a runtime plugin that takes its attempt credential from session-scoped metadata, not only an injected stdio MCP bridge. Readiness is defined for both.
- `acp-execution`: the role's variant/effort selection is applied after the model selection and is never overwritten by it.

## Impact

- `packages/server`: new `opencode/` transport module, `runner-router.ts`, `engine.ts` (variant propagation, a third transport), and a store/migration that adds `'opencode'` to the `runner_binding.transport` CHECK constraint. The `runner-registry`/`runner-transport` use for opencode is removed.
- `packages/runner-opencode`: rewritten as a v2 plugin (`@opencode/plugin` 2.x). `hub.ts` and the v1 `sessions.ts` are deleted.
- `packages/cli`: `daemon-config.ts` parses `runners.opencode`; the generated sample config changes.
- `packages/core`: `role.variant` in the workflow types and validation, if it is missing there.
- Docs: `docs/install.md` and the runner protocol notes.
- Host (not this repo): `daemon.yaml` gets a `runners.opencode` profile that points at the OpenChamber-managed server or at a dedicated one.
