# Roadmap: ACP and the task graph (roadmap, not an implementation plan)

Status: **roadmap for delegation**, not an approved OpenSpec plan. Every stage
marked `[impl]` requires a separate proposal in `openspec/changes/` (per
`AGENTS.md`) — for ACP: agreement/reconciliation with `runner-protocol`
(`openspec/changes/runner-protocol/{proposal,design,tasks}.md`), because both
describe the same `SessionClient` boundary (`packages/server/src/ports.ts:112`).
Do not duplicate `runner-protocol` — extend it or explicitly close it as
superseded.

Context: the work from earlier sessions is already committed (`03e50dd`,
`025ce83`) — do not repeat it. This document covers the next, independently
delegable steps.

## Track A — ACP (Agent Client Protocol): ACP-first, not ACP-only

### Stage 1 — Design review (read-only)
- **Scope:** compare ACP with `SessionClient` (`ports.ts`) and the unfinished
  `runner-protocol` (version/capabilities contract, leased registration,
  idempotent create/prompt — see `design.md`, section "Decisions").
  Identify gaps and coverage.
- **Dependencies:** none (purely analytical).
- **Deliverable:** a gap-analysis note (markdown, in `openspec/changes/` as a
  draft `design.md` fragment or a separate research note) mapping every
  `runner-protocol` capability to its ACP counterpart or absence.
- **Acceptance criteria:** every `runner-protocol` design decision has an
  explicit "ACP: yes/no/partial + why"; no unjustified assumptions.
- **Decision gate:** does ACP cover enough to justify a spike (Stage 2)? If
  not — document it and close the thread.

### Stage 2 — Compatibility spike (disposable, off main)
- **Scope:** the same small task on OpenCode/Codex/Gemini through ACP:
  run-scoped MCP report, permission/cancel, connection loss + restart,
  session recovery — **without blind retries** (per the "safe unknown
  status" principle in `design.md`). Build a capability matrix: native vs
  adapters. Verify negotiation of a stable protocol version and that current
  documentation (`docs/*.md`, `runner-protocol/specs/`) does not hard-code an
  unsupported ACP version.
- **Dependencies:** Stage 1 (the gap analysis as the starting point).
- **Deliverable:** spike code (separate branch/worktree, not integrated),
  a report: capability × runtime matrix, list of connection-loss cases and
  recovery behaviour, a recommended ACP version to pin.
- **Acceptance criteria:** all three runtimes tested on the same task; no
  retry without state confirmation; the report is reproducible (steps + logs).
- **Decision gate:** go/no-go for Stage 3, based on whether MCP reporting +
  cancel + recovery work consistently on ≥2 runtimes.

### Stage 3 — Decision + production plan `[impl]` (requires an OpenSpec proposal)
- **Scope:** if go — a proper ACP runner + shared reporting MCP, preserving:
  Conductor SQLite as the owner of run/retry/review/gate results (supervising
  an ACP worker over stdio **is not automatically durable** — it is a process,
  not state). Tests, documentation, quality gate (typecheck/lint/test/build as
  in `runner-protocol` task 5.5). Keep an escape hatch: the native integration
  remains available; ACP does not forcibly replace it.
- **Dependencies:** Stage 2 (positive result), reconciliation with
  `runner-protocol` (the same version/capabilities/lease contract, or an
  explicit replacement of selected decisions).
- **Deliverable:** an OpenSpec proposal (`proposal.md`/`design.md`/`tasks.md`
  in a new `openspec/changes/<name>/`), then implementation through the usual
  task process.
- **Acceptance criteria:** consistent with `AGENTS.md` (SQLite = source of
  truth, disposable sessions, pure interpreter/engine I/O); passes a
  conformance suite equivalent to the one in `runner-protocol` 1.3.

## Track B — task decomposition / task graph

### Stage 4 — Small-task contract + planning/size gate
- **Status:** done — see [`task-contract-design.md`](task-contract-design.md).
- **Scope:** OpenSpec remains the owner of intent/spec/design (not only the
  "business" part). Distinguish the **backlog DAG** (dependencies between
  small tasks within a change, optionally across changes) from the
  **workflow DAG** (`needs:` in `conductor.yaml`, execution). The current
  OpenSpec plugin parses checkbox text/status and starts **the whole change at
  once** (`plugins/openspec/serve.ts`, `handleStartWork`, around lines
  200–420) — there is no task scheduler. Define a minimal task contract:
  acceptance scope, dependencies, evidence of completion, the "done"
  boundary, newly discovered scope (follow-up), and the requirement for final
  validation of the **whole change** despite the split into tasks.
- **Dependencies:** no hard dependency on Track A; can run in parallel.
- **Deliverable:** a short design note with the task contract + a diagram of
  backlog DAG vs workflow DAG.
- **Acceptance criteria:** the contract is sufficient to describe existing
  `tasks.md` files without losing information; it clearly separates planning
  (backlog) from execution (workflow).
- **Decision gate:** was the example large change split into small,
  independently verifiable tasks with full context for a fresh session? If
  not — fix the decomposition before choosing a task store.

### Stage 5 — Evaluation: Beads vs native SQLite vs a provider interface
- **Scope:** evaluation from a real use case (Stage 4), not up front.
  Note: Beads **does not split tasks automatically** — it is only
  tracking/a graph. The Dolt-based architecture must be verified as current
  at decision time (do not assume it from documentation). Avoid a double
  truth with `tasks.md` — if an external solution is chosen, explicitly
  define: claims, run↔task mapping, reconciliation, and who has "completion
  authority".
- **Dependencies:** Stage 4 (the task contract as the evaluation criterion).
- **Deliverable:** a short comparison (table) + possibly a pilot on one real
  backlog, **without** imposing Dolt and **without** building a full Beads
  clone.
- **Acceptance criteria:** the decision is explicitly justified against the
  Stage 4 contract; it introduces no second source of truth parallel to
  SQLite.
- **Decision gate:** choose among (a) native SQLite, (b) Beads, (c) a
  pluggable provider interface — only after the comparison/pilot.

### Stage 6 — Implementation `[impl]` (requires an OpenSpec proposal)
- **Scope:** `conductor.yaml` remains the **only** execution format
  (workflow-as-data) — no duplicated gates via Beads formulas or any other
  rule engine.
- **Dependencies:** Stage 5 (decision), consistency with `workflow-format`
  and `retry-policy`.
- **Deliverable:** an OpenSpec proposal + implementation through the usual
  process.

## Next task, ready to paste

> Run Stage 1 (ACP design review): compare ACP with `SessionClient`
> (`packages/server/src/ports.ts:112`) and the decisions in
> `openspec/changes/runner-protocol/design.md` (identity/lease, offer before
> attempt, idempotent create/prompt, safe unknown status, error ownership
> boundary). Result: a gap-analysis note mapping every decision to ACP
> coverage (yes/no/partial + justification), no code changes, no commits.
> Conclude with a go/no-go recommendation for the spike (Stage 2).
