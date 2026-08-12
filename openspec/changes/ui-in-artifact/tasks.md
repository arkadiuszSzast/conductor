# Tasks — ui-in-artifact

## 1. Config surface

- [ ] 1.1 [cli] Remove `ui` from the daemon config fields and template; update tests.

## 2. UI resolution in the daemon process

- [ ] 2.1 [cli] `--no-ui` flag on `conductor daemon`, passed through `DaemonStartInput`.
- [ ] 2.2 [cli] `main.ts`: resolve UI root — embedded manifest → package-relative `apps/web/dist` → one-time startup build (`vite build` via bun) → none with log; wire into `ApiConfig.ui`.
- [ ] 2.3 [test] CLI tests: `--no-ui` passthrough; daemon starts with no UI available.

## 3. Binary embedding

- [ ] 3.1 [cli] `scripts/build-binary.ts`: build SPA, generate embed manifest (file-type imports preserving dist structure), compile with `Bun.build`; root `build:binary` uses it.
- [ ] 3.2 [test] Smoke: binary serves `/` (SPA) and `/v1/readyz`; `--no-ui` binary 404s `/`.

## 4. Docs

- [ ] 4.1 [docs] install.md + README: UI automatic from artifact, `--no-ui`, remove staticDir instructions.
