# 06 Maintenance and Acceptance

## Before every commit

### 1. Secret scan (full worktree, including untracked files and Markdown)

```bash
# With gitleaks (recommended)
gitleaks dir . --redact --no-banner

# Without gitleaks
grep -rInE "api[_-]?key|secret|passw(or)?d|token" . \
  --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=.venv \
  --exclude="*.example"
```

- Only `*.example` placeholders are excluded, and you must confirm they contain no real values.
- `git grep` searches tracked files only; before the first commit it reports "0 matches"
  even when secrets exist. Do not use it as the acceptance check.
- If a secret leaks: rotate it first, then clean history with `git filter-repo`, then force-push.

### 2. Ignore rules

```bash
git status --ignored --short
```

Confirm `config.json`, `.env`, logs, sqlite and zip files are ignored and not force-added.

### 3. Skill format

- Every `skills/<name>/SKILL.md` has `name` and `description` in its frontmatter.
- `name` matches the directory name.
- Third-party directories contain `LICENSE` and `UPSTREAM.md`, and the hash in
  `UPSTREAM.md` matches the file.

### 4. MCP templates

- `mcps/<name>/mcp.json.example` is valid JSON.
- No real tokens, accounts or usernames.
- Fields match the existing entries in `~\.zcode\cli\config.json`.

### 5. Project tests

Standard tests for `projects/zcode-persistence` (run from the project directory):

```bash
python -I tools/selftest_hook.py
python -I tools/selftest_proxy_429.py
python -I tools/selftest_stream.py
python -I tools/selftest_watch.py
python -I tools/selftest_route.py
python -I tools/selftest_upstreams.py
python -I tools/selftest_ensure.py
```

All seven must pass; details are in the project's `docs/04-test-record.md`.

## After committing

```bash
git count-objects -vH        # repository size, target < 10 MB
git log --oneline -5
git status
```

- Run the size check after the first commit. Before committing, the object count is zero
  and the check proves nothing.
- No single file may exceed 100 MiB; binaries belong in Releases.

## Release checklist

- [ ] All version fields (project `VERSION` and its copies) and `CHANGELOG.md` updated
- [ ] Project tests pass
- [ ] Release archive built and sha256 recorded
- [ ] Tags created: repository `vX.Y.Z`, project `proj-<name>-vX.Y[.Z]`
- [ ] Release uploaded, sha256 matches the local archive
- [ ] History import archive uploaded when needed, tag `proj-<name>-vX.Y[.Z]-history`
- [ ] README index updated (links and status only)

## Periodic checks (monthly recommended)

1. Whether upstream skills have security or behavior fixes; upgrade in a separate commit
   and update `UPSTREAM.md`.
2. Whether `~\.zcode\skills` has drifted from the repository (compare hashes).
3. Whether MCP servers still connect.
4. Repository size, stale branches, unmerged pull requests.
5. Whether the license and source register is still accurate.
