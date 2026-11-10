---
description: Install or upgrade AI Agent Teams and choose the isolation mode and preset
---

# /install-teams

Install AI Agent Teams from the repository the user pasted.

Follow `docs/guides/INSTALL-WITH-AI.md` exactly:

1. Run the host/ZIP inspection (`node src/install-wizard.mjs --inspect ...`).
2. Ask the user to choose hard or soft isolation; do not choose for them. Run `node src/install-wizard.mjs --choose-isolation soft --workspace "<workspace>"` (or `hard --runtime podman|docker`). For hard isolation, ask Podman vs Docker first; hard is self-test-gated: explain missing WSL2/runtime/image prerequisites and show the repair steps.
3. Install the plugin marketplace, ask the user to reboot manually, then run `--verify --restart-confirmed`.
4. Only after verification passes, show conservative and balanced presets, ask the user to choose, and run `--apply`.

Never report success before `phase=complete`. Never reboot the computer automatically.
