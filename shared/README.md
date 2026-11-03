# Shared

Reserved for cross-project scripts and prompts.

**It is intentionally empty.** No script or prompt is shared yet: a single project's tool
stays inside that project. Move something here only when at least two projects need the same
code, so the repository does not grow a speculative framework.

```text
scripts/    Cross-project scripts (none yet)
prompts/    Reusable prompt fragments (none yet)
```

## Rules

- No secrets, personal data, real email addresses or machine-specific paths.
- One script or prompt per file, lowercase kebab-case name.
- A script defaults to `--dry-run`, backs up before writing and never deletes extra files.
- State the purpose, the owning projects and the license at the top of the file.

Until a shared script exists, follow the manual steps in
[03-Deployment and Sync](../docs/03-deployment-and-sync.md).
