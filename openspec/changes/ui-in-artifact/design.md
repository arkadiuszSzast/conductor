## Context

See proposal. Verified on Bun 1.3.14: `import x from "./f" with {type:"file"}`
embeds files into the compiled binary under `/$bunfs/root/...` preserving
relative structure with `naming: {asset: "[dir]/[name].[ext]"}`;
`statSync`/`Bun.file` work on embedded paths — so the server's existing
`serveStatic(staticRoot)` works unchanged with an embedded root.

## Goals / Non-Goals

**Goals:** UI from the artifact with zero config in both distribution
modes (binary, checkout); `--no-ui` opt-out; server untouched.

**Non-Goals:** registry publication itself; UI dev-server proxying.

## Decisions

- **D1 — Embed via a generated manifest + wrapper entrypoint.** Vite
  output names are hashed (unknown statically), so `scripts/build-binary.ts`
  scans `apps/web/dist`, generates `.build/ui-manifest.ts` (one
  `with {type:"file"}` import per asset, registering the embedded
  index.html path on `globalThis`) and `.build/entry.ts`
  (manifest first, then the CLI main). `Bun.build` compiles that entry.
  `.build/` is git-ignored.
- **D2 — Resolution order in `main.ts`:** embedded index (dirname →
  static root) → `resolve(import.meta.dirname, "../../../apps/web/dist")`
  when index.html exists → if the checkout is buildable
  (`apps/web/package.json` + node_modules) run `bun run build:vite` once,
  synchronously, logged → otherwise null + info log. Only `main.ts`
  touches the real filesystem/process — the command layer passes `noUi`.
- **D3 — `ui.staticDir` removed from user config, kept in `ApiConfig`.**
  The server keeps one mechanism; the CLI decides the root. Greenfield
  removal, no deprecation shim.

## Risks / Trade-offs

- [Startup build needs the web toolchain] → only attempted when the
  checkout looks buildable; failure logs and continues without UI.
- [Embedded paths are an implementation detail of Bun] → covered by the
  binary smoke test; regression would surface there.

## Migration Plan

Greenfield config change: remove `ui:` from existing config files (the
daemon rejects unknown fields loudly). Docs updated.

## Open Questions

None.
