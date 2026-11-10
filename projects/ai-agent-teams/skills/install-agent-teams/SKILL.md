---
name: install-agent-teams
description: Install Ai-Agent-Teams-Zcode from a GitHub link with the required four-stage flow: host/ZIP inspection, hard-or-soft isolation choice, install plus user restart and verification, then conservative-or-balanced preset selection. Use when the user pastes this repository's GitHub URL and asks to install it.
---

# Install Ai-Agent-Teams-Zcode from GitHub

Read `docs/guides/INSTALL-WITH-AI.md` and execute it exactly. Do not skip stages.

1. Run `node src/install-wizard.mjs --inspect --workspace "<workspace>" --github "<url>"`.
2. Show **both** hard and soft isolation options to the user, including availability, reason, requirements, and repair steps. Hard isolation is still an option even when unavailable: explain the missing WSL2/Podman/Docker prerequisites and the current container-dispatch limitation. Do not default to soft. Run `node src/install-wizard.mjs --choose-isolation soft|hard --workspace "<workspace>"` only after the user explicitly chooses; the isolation token is mandatory. For hard isolation, also ask the user to choose **Podman Desktop (recommended)** or **Docker Desktop**, then pass `--runtime podman|docker`; do not default the runtime.
3. After the user chooses, **install automatically without asking again**: add the repository root as a ZCode plugin marketplace (if missing), install the plugin, and confirm it is enabled with the expected version and `contentOk=true`. Then tell the user to reboot ZCode manually; never reboot for them or confirm the reboot yourself. After the user replies that they restarted, run `--verify --restart-confirmed`.
4. Only after `phase=awaiting-preset-choice`, run `--presets`, show both conservative and balanced options, then run `--apply --preset ...`.

Report success only when `--apply` returns `phase=complete`. If hard isolation is unavailable, say so; never claim container isolation is active.
