## Why

The web UI required two manual steps (build the SPA, point `ui.staticDir`
at it) — config for something that is really a property of the artifact.
The target distribution is a registry package / compiled binary, where the
UI ships inside the artifact; serving it should be automatic, not
configured. `ui.staticDir` as user-facing config has no future.

## What Changes

- **The UI is part of the artifact, not configuration.** `ui.staticDir`
  is removed from the user daemon config (**BREAKING** for the config
  format; greenfield). The server's internal `ApiConfig.ui` stays as the
  serving mechanism.
- **Compiled binary embeds the SPA.** `bun run build:binary` builds the
  SPA and embeds `apps/web/dist` into the executable (Bun file embedding);
  the daemon serves it from the embedded filesystem automatically.
- **Checkout runs serve/build automatically.** When the CLI runs from a
  repo checkout (`bun link`), the daemon serves `apps/web/dist` relative
  to the package; when `dist` is missing but the checkout can build it,
  the daemon builds it once at startup (logged) and then serves it.
  Build failure or no checkout → no UI, instructive log, daemon runs on.
- **`conductor daemon --no-ui`** disables UI serving.

## Capabilities

### Modified Capabilities
- `daemon-entrypoint`: UI serving becomes automatic from the artifact
  (embedded binary / checkout with build-on-first-start), `ui.staticDir`
  leaves the config surface, `--no-ui` added.

### New Capabilities
_None._

## Impact

- `packages/cli` — daemon command passes `noUi`; `main.ts` resolves the
  UI root (embedded → checkout dist → build once → none); build script
  `scripts/build-binary.ts` (SPA build + embed manifest + compile)
  replaces the plain `bun build --compile` line.
- `packages/cli/src/daemon-config.ts` — drop `ui` from the accepted
  config fields and template.
- `packages/server` — unchanged (internal `ApiConfig.ui` reused).
- docs (install, README) — UI "just works"; `--no-ui` documented.
