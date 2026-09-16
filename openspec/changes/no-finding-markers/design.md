# Design — no-finding-markers

## Context

The fixer agent, while fixing review findings, inserted provenance
markers `(code-review finding N)` into production KDoc, comments, and
test names.  The next review round correctly blocked on these — the
repo's AGENTS.md forbids delivery narration in per-aggregate docs.  The
agent instructions were silent on this, so the fixer did not know it
was producing blockers for the reviewer.

## Fix

Add an explicit ban on provenance markers to the `conductor-implementer`
and `conductor-fixer` agent instructions.  The implementer gets the ban
in its Repo adaptation section; the fixer gets it in Review-findings
mode.  The reviewer gate already has the complementary rule — no change
there.

## Trade-offs

- The ban is narrow: only provenance markers that tie code to a specific
  review round are forbidden.  ADR citations, OpenSpec change
  references, and prose describing the system as it is remain permitted.
- The fixer still reports provenance in its conductor_report (JSON) —
  that output stays in the pipeline, not in the codebase.
