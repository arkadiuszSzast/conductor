# Tasks — zero-config-defaults

## 1. Platform paths & config defaults

- [x] 1.1 [cli] Add pure `platformPaths(env)` (XDG → `~` fallback; error without HOME) and `DEFAULT_DAEMON_CONFIG` generation (loopback 4400, XDG data-dir db, auth none, empty projects).
- [x] 1.2 [cli] Allow `projects: []` in `assembleDaemonConfig`; keep element validation.
- [x] 1.3 [test] Cover platformPaths (XDG set/unset, missing HOME) and empty-projects assembly.

## 2. Zero-flag daemon

- [x] 2.1 [cli] `conductor daemon` without `--config`: resolve platform path, generate when missing (log it), start from it; `--config` unchanged (missing explicit file stays an error).
- [x] 2.2 [test] Zero-flag generate+start, reuse-existing, explicit-missing-error scenarios.

## 3. Runtime project registration

- [x] 3.1 [server] `POST /v1/projects` → `registerProject` in ApiDeps wired to `WorkflowRegistry.register`; 200 idempotent success with status, 422 with diagnostics; authenticated.
- [x] 3.2 [test] API tests: register valid, invalid (diagnostics, set unchanged), re-register idempotent, 404 when dep absent, auth required.

## 4. `conductor init` registration

- [x] 4.1 [cli] After scaffold: add project dir to platform daemon config `projects` (create config with defaults when absent; idempotent; parse errors abort before write); `--no-register` opts out.
- [x] 4.2 [cli] Live-register over the API when a daemon is reachable (via resolved connection incl. new fallback); unreachable → hint, exit 0.
- [x] 4.3 [test] Init adds once across repeated runs; creates default config; registers live against harness API; unreachable daemon still exits 0; `--no-register` leaves config untouched.

## 5. CLI connection fallback

- [x] 5.1 [cli] `resolveConnection`: last-resort read of platform daemon config → URL from bind + bearer token; precedence unchanged; keep usage error when nothing exists.
- [x] 5.2 [test] Fallback used only when flags/env/client-config absent; explicit sources win; usage error preserved.

## 6. Docs & verification

- [x] 6.1 [docs] Update `docs/install.md` + README quick start to the collapsed flow (`conductor daemon` → `conductor init` → `conductor start`); document config-comment loss on init rewrite and the auth-none default.
- [x] 6.2 [test] Full gate: `bun test`, typecheck, lint, `openspec validate zero-config-defaults`; manual smoke: zero-flag daemon on clean XDG_CONFIG_HOME/XDG_DATA_HOME, init registers live, status with no env.
