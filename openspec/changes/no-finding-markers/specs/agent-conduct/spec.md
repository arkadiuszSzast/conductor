# agent-conduct Specification (delta) — no-finding-markers

## ADDED Requirements

### Requirement: Agent code and doc output must not contain delivery narration

When an agent step (implementer or fixer) writes production KDoc, code
comments, or test names, the output MUST NOT contain review-round
provenance markers — strings matching the patterns
`(code-review finding N)`, `(code-review nit)`, `(review finding: …)`,
or similar patterns that tie the code to a specific pipeline review
round.  ADR citations (`ADR-NNN`), OpenSpec change references, and
inline prose describing the system as it is remain permitted.

#### Scenario: Fixer applies a finding without emitting a marker

- **WHEN** a fixer commits a fix for review finding #2 and writes a
  test for the fix
- **THEN** the test name describes the behaviour under test, the KDoc
  describes the aggregate as it is, and neither contains a string like
  `(finding 2)` or `(code-review finding 2)` — the commit message
  carries the provenance instead

#### Scenario: Gate blocks on delivery narration in code

- **WHEN** a reviewer gate scans a diff and finds
  `(code-review finding N)` markers in production KDoc, comments, or
  test names
- **THEN** the gate treats each occurrence as a blocking finding with
  severity "major", citing the AGENTS.md prohibition on delivery
  narration
