## Why

The OpenSpec panel lists changes with task progress and a start-work
action, but a change is just a name on a tile — to understand *what* a
change is about the operator must leave the Control Room and open the
files. The first dogfooding session asked for exactly this: click a
tile, read what the change does, optionally dig into requirements and
tasks, and start work from the same place.

## What Changes

- The bundled OpenSpec plugin's backend gains a **change detail
  endpoint**: for one named change it returns the proposal's Why/What
  sections, the list of delta specs (capability name + requirement
  headings with their full text), and the task list (text + done flag).
  Missing artifacts (no design, no specs yet) are simply absent, not
  errors.
- The plugin panel gains a **detail modal**: clicking a change tile
  opens an overlay with the change name, task progress, the proposal's
  Why (visible by default), and collapsible sections — What Changes,
  Requirements (per capability), Tasks — collapsed by default. The
  modal carries the same **Start work** action as the tile and closes
  on backdrop/Escape/close button.
- Tiles remain otherwise unchanged: Start work stays directly on the
  tile; clicking anywhere else on the tile opens the modal. Archived
  changes open the same modal (start-work hidden for them).

Not in scope: rendering design.md, markdown-to-HTML fidelity beyond a
minimal safe renderer (headings, lists, code, emphasis), editing
anything from the panel, host-app changes (this is entirely within
`plugins/openspec/`).

## Capabilities

### Modified Capabilities

- `openspec-plugin`: the panel's change listing gains a per-change
  detail view (backend endpoint + modal UI) with progressive
  disclosure; start-work remains available from both tile and modal.

## Impact

- `plugins/openspec/serve.ts` (+ tests): new `GET /change?name=` route
  reading `proposal.md`, `specs/**/spec.md`, `tasks.md` for one change
  (archived ones resolve under `changes/archive/`).
- `plugins/openspec/ui/` (app.js, style.css, index.html): modal,
  collapsible sections, minimal markdown rendering.
- No daemon/web-host changes; the plugin contract is untouched.
