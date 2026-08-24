## 1. Backend

- [x] 1.1 [server] `plugins/openspec/serve.ts`: add `GET /change?name=`
  — resolve the change dir under `openspec/changes/<name>/` or
  `openspec/changes/archive/<name>/` (safe-name check first); parse
  proposal.md into Why / What Changes sections; walk
  `specs/*/spec.md` collecting capability name + requirement headings
  (`### Requirement:`) with body text; parse tasks.md into ordered
  { text, done } entries; omit absent artifacts; 404 for unknown names
- [x] 1.2 [test] serve.test.ts: full detail, sparse detail (proposal
  only), archived change detail, unknown name 404, unsafe name
  rejected without fs access, requirement grouping by capability

## 2. Panel UI

- [x] 2.1 [web] `plugins/openspec/ui/`: tile click (outside the
  start-work button) opens a modal — name, progress, Why visible;
  What Changes / Requirements / Tasks as collapsed expandable
  sections; Start work button for active changes only; close via
  button, backdrop, Escape; minimal safe markdown renderer (headings,
  lists, inline code/bold/italic, paragraphs — text nodes only, no
  innerHTML of raw input)
- [x] 2.2 [test] Extend the mounted app.js test (or serve static test
  fixtures): tile click fetches `../change?name=` and renders the
  modal, sections expand, archived modal hides start-work, Escape
  closes

## 3. Verification

- [ ] 3.1 [test] Full suite green (typecheck, lint, bun test, web
  mounted); redeploy dogfood daemon and verify the modal on the todo
  project
