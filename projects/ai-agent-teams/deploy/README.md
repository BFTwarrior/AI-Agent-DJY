# Runtime deployment

The package runs in three isolation tiers:

1. `worktree` — no container; per-task git worktree. Works everywhere git works.
2. `container` — one hardened container per active worker. Docker/Podman is a host prerequisite; the installer can print or execute the WSL2/Podman/Docker setup with `node src/install-wizard.mjs --install-hard --runtime podman --execute`, then the user must reboot.
3. `microvm` — Kata/gVisor/Firecracker; not bundled.

## Container image

`worker.Dockerfile` is configured to build a Linux ZCode CLI/runtime into the worker image from the pinned upstream tag `v3.17.2` / commit `a9fe401eede6e6e5e01be9048679c206fe6f02d9`; it does not rely on desktop AppImage/DEB/RPM packages. Its build sequence installs the pinned upstream root workspace and invokes the existing `apps/zcode-cli` `build:sea` script, which uses the upstream Turbo dependency build, rebuilds the CLI bundle (staging the upstream third-party notices), and produces all six documented SEA targets. The Docker build selects and copies only the artifact matching its Debian architecture. This intentionally follows the existing upstream build entrypoint rather than inventing an unverified single-target dependency graph. The SEA builder collects the TUI, plugin, bundled-skill, runtime-tool, Playwright, and provider-config assets before injecting them into each target Node binary. The image then runs `zcode --version` as a fail-closed check after switching to the non-root worker user. These are configured upstream steps, not proof of successful image construction: this source's build is not yet runtime-verified; current acceptance status is recorded in `docs/status/STATUS.md`. Rebuild the image to move to another CLI release; `imagePullPolicy` only updates the selected image reference and does not discover newer ZCode releases. The package does not publish a worker registry image.

```bash
docker build -f worker.Dockerfile -t ai-agent-teams-worker deploy
podman run --rm --entrypoint '' ai-agent-teams-worker zcode --version
```

`src/runtime/container.mjs` builds the invocation with:

- non-root uid 10001
- read-only root + tmpfs `/tmp`
- `--cap-drop ALL` and `no-new-privileges`
- only the task worktree, member home and read-only package `src` mounted
- CPU/memory/pids limits
- `gateway-only` (the config default) uses a Podman bridge/NAT with the host gateway; outbound egress is allowed and is not firewalled. `none` disables networking
- worker home is seeded from `isolation.homeSeed`; `HOME=/home/zcode` is set explicitly; `isolation.workerModel` injects `defaultModelSelection`

`isolation.imagePullPolicy` controls optional startup pulls before the CLI self-test: `never` (default) uses only the local image, `if-missing` pulls only if absent, and `always` pulls the configured reference. Use a trusted registry image to enable pulls. Pull errors abort startup; no stale-image fallback is attempted. Pulling a mutable tag refreshes only that worker image. The bundled Dockerfile pins ZCode CLI source at the revision above; rebuilding the image is required to change it, and this package does not publish a worker image.

If Docker/Podman, the worker image or the self-test is absent, `isolation.mode=container` refuses to start; it does not silently fall back to worktree.
