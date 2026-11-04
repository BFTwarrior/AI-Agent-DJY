# 01 Install and Rollback

## Pre-flight check

```bash
python --version          # requires 3.9+
```

Confirm that ZCode's two config files exist:

- `~/.zcode/cli/config.json`
- `~/.zcode/v2/provider_config.json`

On Windows, `~` is `C:\Users\<your username>`.

---

## Installing Mode A (hook only)

```bash
python tools/install.py
```

The installer does four things:

1. Copies the five scripts under `src/` (retry_hook / retry_proxy / ensure_proxy / route_providers / error_watch) to `C:\Program Files (x86)\AI\Zcode-Persistence\`
2. Appends the primary hook (`matcher: "Bash"`) to `hooks.events.PostToolUse` in `config.json`, and appends the same script to `hooks.events.PostToolUseFailure` as a fallback
3. Appends a self-start check to `hooks.events.SessionStart`
4. Writes the install information to `install-state.json`

Running it again does not add duplicates. Everything is backed up automatically before each change, with file names like `config.json.bak-20261030-140631`.

**Verification**:

```bash
python tools/doctor.py
```

The `PostToolUse` (primary) hook, the `PostToolUseFailure` (fallback) hook and `hooks.enabled` should all show PASS. Then **open a new ZCode session** (the hook list is snapshotted when the session starts, so an old window will not pick it up).

---

## Installing Mode B (hook + proxy)

```bash
# 1. Install hooks and proxy auto-start (route_providers only edits config)
python tools/install.py

# 2. Recommended (V0.2.6): route every provider through /p/<b64>
python src/route_providers.py --dry-run
python src/route_providers.py
# Open a new ZCode session afterwards (SessionStart starts the proxy).

# 3. Optional: one fixed channel, only if it really is AP/UPSTREAM-B
python tools/install.py --with-proxy --provider-id new-provider
```

`route_providers.py` rewrites the baseUrl to
`http://127.0.0.1:8787/p/<base64url(original)>`; the proxy decodes it and
forwards to the original origin. It backs up the config, records original URLs
in `provider_config.json.proxy-origins.json`, is idempotent, and supports
`--restore`. SessionStart also migrates automatically once the proxy reports
the `p_route` feature.

**After an upgrade, restart the proxy.** `install.py` replaces files but does not stop the
running process, and the timing defaults may be identical between versions. Run
`python "C:/Program Files (x86)/AI/Zcode-Persistence/restart_proxy_idle.py"`, then confirm
`/__zp_health` reports `version=0.2.8`. Since V0.2.7 `doctor.py` compares the running
version with the installed `VERSION` and warns on a mismatch.

**Do not guess a prefix for an unknown address**: `--proxy-prefix ap` would send
that provider's requests to `upstream-a.example.com`. Use `route_providers.py` instead.
The prefix is derived from the original address only for known AP/UPSTREAM-B hosts;
if it cannot be determined the installer errors out and exits, it does not guess.

**Why the provider id must be confirmed first**: the installer changes only the one you name, to avoid damaging other channels. To list the existing ids:

```bash
python - <<'EOF'
import json, os
p = os.path.join(os.path.expanduser("~"), ".zcode", "v2", "provider_config.json")
for r in json.load(open(p, encoding="utf-8"))["config"]["providerConfigRules"]["providerRules"]:
    print(r["providerId"], "->", r["config"]["api"]["baseUrl"])
EOF
```

**Verification order**:

1. `python tools/doctor.py` → the provider check and the proxy-port check should both PASS
2. `python src/retry_proxy.py` (run it once in the foreground to see whether it throws any errors)
3. In another terminal, `curl http://127.0.0.1:8787/ap/v1/models` (or a `/p/<b64>` URL) — returning 401/404 is normal (it means the proxy is forwarding); only a failure to connect is a problem
4. Open a new ZCode session, ask anything, and a normal reply means success

---

## Rollback

### Level 1: revert the config only, keep the scripts

```bash
python tools/uninstall.py
```

It removes the three hook entries (`PostToolUse`, `PostToolUseFailure`, `SessionStart`) and restores the provider address (only if it still points at the proxy); the script files are kept. Backups are made before the change as well.

### Level 2: delete the scripts as well

```bash
python tools/uninstall.py --purge
```

### Level 3: hard restore from backups (when the installer itself is broken too)

```bash
ls ~/.zcode/cli/config.json.bak-*          # find the backup from before installation
cp ~/.zcode/cli/config.json.bak-<timestamp> ~/.zcode/cli/config.json
cp ~/.zcode/v2/provider_config.json.bak-<timestamp> ~/.zcode/v2/provider_config.json
```

> Note: `cp` overwrites. Before running it, confirm that the backup file's timestamp is earlier than your last manual change, otherwise you lose the later modifications.

---

## Just want a temporary effect?

If you do not want to install the hooks and only want to check temporarily whether the proxy works:

```bash
python src/retry_proxy.py          # run in the foreground; Ctrl+C to stop
```

Then hit `127.0.0.1:8787/ap/v1/chat/completions` directly with curl, and **do not** change the provider config. Install for real only after the verification passes.
