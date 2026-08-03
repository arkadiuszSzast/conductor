# Security Policy

## Reporting a vulnerability

Conductor is a self-hosted system that orchestrates agents with repository
write access — treat security findings seriously.

Please **do not open a public issue** for a vulnerability. Report it privately
by emailing the maintainers or, if a security advisory channel is available on
the repository, use that.

Include, if possible:

- the affected version and module (`core` / `server` / `runner-opencode` /
  `cli` / `web`);
- a description of the issue and its impact;
- a minimal reproduction.

## What is in scope

- Arbitrary code execution through workflow files, action definitions, or
  runner prompts.
- AuthN/AuthZ bypass on the daemon's API or dashboard.
- Secret leakage (tokens, model credentials, `GH_TOKEN` minted by
  `tokenCommand`).
- Path traversal / worktree escape in git operations.
- SSRF or injection via GitHub webhook ingress or `gh` operations.

## Response

We aim to acknowledge reports within 3 business days and to provide an
assessment and timeline within 10 business days.
