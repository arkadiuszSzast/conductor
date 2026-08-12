## ADDED Requirements

### Requirement: The web UI serves automatically from the artifact

The daemon SHALL serve the web UI without configuration when the artifact
carries it: a compiled binary serves the SPA embedded at build time; a
checkout-run daemon serves the repo's built SPA (`apps/web/dist`) resolved
relative to the package, building it once at startup when missing but
buildable (the build is logged). When no UI is available (build failed,
no checkout assets), the daemon SHALL start normally without UI and log
an instructive message. `conductor daemon --no-ui` SHALL disable UI
serving entirely. The user-facing daemon config SHALL NOT contain a UI
field; API routes (`/v1/*`) always take precedence over static serving.

#### Scenario: Compiled binary serves the embedded UI
- **WHEN** a daemon started from the compiled binary receives `GET /`
- **THEN** it serves the embedded SPA's index.html while `/v1/*` routes
  keep API precedence

#### Scenario: Checkout daemon serves or builds the SPA
- **WHEN** a checkout-run daemon starts and `apps/web/dist` exists (or is
  buildable and the startup build succeeds)
- **THEN** the SPA is served at `/` with no configuration

#### Scenario: --no-ui disables serving
- **WHEN** a daemon starts with `--no-ui`
- **THEN** no static assets are served and non-API paths 404

#### Scenario: No UI available degrades cleanly
- **WHEN** a daemon starts where no embedded or checkout UI exists and a
  startup build is impossible or fails
- **THEN** the daemon starts and serves the API normally, logging that
  the UI is unavailable
