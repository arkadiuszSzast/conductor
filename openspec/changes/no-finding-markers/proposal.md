# No-finding-markers — ban delivery narration from code and docs

## Why

During the add-journal PR review, the fixer agent inserted
`(code-review finding N)`, `(review finding: …)` and `(code-review nit)`
markers into production KDoc, comments and test names while fixing review
findings.  The next reviewer round correctly flagged ~90 of these
occurrences as a blocker — AGENTS.md explicitly forbids delivery
narration in per-aggregate docs.  The fixer was generating work for the
reviewer in the same pass it was eliminating work, and the reviewer had
no mechanism to stop it because the agent instructions were silent on
this.

## What Changes

- Add an explicit ban on review-related delivery narration to the
  `conductor-implementer` and `conductor-fixer` agent instructions — no
  `(finding N)`, `(code-review nit)`, `(review finding: …)` markers or
  similar provenance strings in production KDoc, comments, or test names.
- Gate agent instructions already have the complementary rule (design and
  code reviewers flag these as blockers) — no change needed there.

## Impact

- `~/.config/opencode/agents/conductor-implementer.md`: add the ban to
  the Repo adaptation section.
- `~/.config/opencode/agents/conductor-fixer.md`: add the ban to the
  Review-findings mode section.

## Risks / Trade-offs

- None — the agents retain every other freedom (commit messages, prose in
  docs describing the *system as it is*, ADR/decision citations).  The
  ban is narrow: provenance markers that tie code to a specific review
  round.
