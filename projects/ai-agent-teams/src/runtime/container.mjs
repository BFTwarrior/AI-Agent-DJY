import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { containerInspectError } from './container-image-errors.mjs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';

const WINDOWS_RUNTIME_PATHS = {
  podman: ['C:\\Program Files\\RedHat\\Podman\\podman.exe'],
  docker: ['C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe'],
};

/**
 * Candidate executable names for a runtime, preferring PATH and then the
 * standard Windows install locations. The absolute path matters when the
 * long-lived supervisor was started before the runtime was installed.
 * @param {'docker'|'podman'} runtime
 * @param {string} [platform]
 * @returns {string[]}
 */
export function runtimeCandidates(runtime, platform = process.platform) {
  if (platform !== 'win32') return [runtime];
  return [runtime, ...(WINDOWS_RUNTIME_PATHS[runtime] ?? [])];
}

/**
 * Detect Docker or Podman. Docker Desktop is not bundled; the installer reports
 * this as an optional prerequisite.
 * @param {'docker'|'podman'|undefined} preferred
 * @returns {{ available: boolean, runtime: 'docker'|'podman'|undefined, command?: string, version?: string }}
 */
export function detectContainerRuntime(preferred) {
  const runtimes = preferred ? [preferred] : ['docker', 'podman'];
  for (const runtime of runtimes) {
    for (const command of runtimeCandidates(runtime)) {
      const result = spawnSync(command, ['--version'], { encoding: 'utf8', windowsHide: true });
      if (result.status === 0) {
        return { available: true, runtime, command, version: (result.stdout ?? '').trim() };
      }
    }
  }
  return { available: false, runtime: undefined };
}

/**
 * Detect a runtime and, for Podman on Windows, start its WSL machine when the
 * binary exists but the machine was stopped by a reboot. `podman --version`
 * succeeds even while the machine is stopped, so the probe must be `info`.
 * @param {'docker'|'podman'} runtime
 * @param {{ startMachine?: boolean, platform?: string, runner?: Function, detect?: Function }} [options]
 * @returns {{ available: boolean, runtime?: 'docker'|'podman', command?: string, version?: string, machineStarted?: boolean }}
 */
export function ensureContainerRuntime(runtime, {
  startMachine = true,
  platform = process.platform,
  runner = spawnSync,
  detect = detectContainerRuntime,
} = {}) {
  let detected = detect(runtime);
  if (!detected.available) return detected;
  const probe = runner(detected.command, ['info'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (probe.status === 0) return detected;
  if (!startMachine || platform !== 'win32' || detected.runtime !== 'podman') {
    return {
      ...detected,
      available: false,
      engineUnavailable: true,
      engineError: String(probe.stderr || probe.stdout || probe.error || `${runtime} engine is not running`).slice(0, 1000),
    };
  }
  const list = runner(detected.command, ['machine', 'list', '--format', '{{.Name}}'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  const hasMachine = list.status === 0 && String(list.stdout ?? '').trim().length > 0;
  if (!hasMachine) {
    console.warn('WARN Podman has no machine; running "podman machine init".');
    const init = runner(detected.command, ['machine', 'init'], { encoding: 'utf8', windowsHide: true, timeout: 600000 });
    if (init.status !== 0) {
      return {
        ...detected,
        available: false,
        machineStarted: false,
        machineStartError: String(init.stderr || init.stdout || init.error || 'podman machine init failed').slice(0, 1000),
      };
    }
  }
  console.warn('WARN Podman machine is not ready; attempting "podman machine start".');
  const started = runner(detected.command, ['machine', 'start'], { encoding: 'utf8', windowsHide: true, timeout: 180000 });
  if (started.status !== 0) {
    return {
      ...detected,
      available: false,
      machineStarted: false,
      machineStartError: String(started.stderr || started.stdout || started.error || 'podman machine start failed').slice(0, 1000),
    };
  }
  const ready = runner(detected.command, ['info'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (ready.status !== 0) {
    return {
      ...detected,
      available: false,
      machineStarted: false,
      machineStartError: String(ready.stderr || ready.stdout || ready.error || 'podman info failed after machine start').slice(0, 1000),
    };
  }
  detected = detect(runtime);
  return { ...detected, machineStarted: true };
}

/**
 * Find the Windows vEthernet (WSL) address. Podman containers can reach this
 * address, while the Windows loopback is not reachable from the WSL VM.
 * `strict` is used by the provider bridge: a fallback to an arbitrary LAN or
 * virtual adapter would expose a host-loopback service beyond the WSL boundary.
 * @param {{ strict?: boolean }} [options]
 * @returns {string|undefined}
 */
export function detectContainerHostAddress({ strict = false } = {}) {
  const candidates = [];
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) candidates.push({ name, address: address.address });
    }
  }
  const wsl = candidates.find((candidate) => /WSL|Hyper-V/i.test(candidate.name))?.address;
  if (wsl) return wsl;
  return strict ? undefined : candidates[0]?.address;
}

/**
 * The container must run as the host user on POSIX so 0600 seed files are
 * readable; Windows bind mounts already map the host identity to uid 10001.
 * @returns {string}
 */
export function defaultContainerUser(platform = process.platform) {
  if (platform !== 'win32') {
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    if (Number.isInteger(uid) && Number.isInteger(gid) && uid !== 0) return `${uid}:${gid}`;
  }
  return '10001:10001';
}

/**
 * Build a hardened container invocation for one active worker.
 * Only its worktree, home volume and the read-only package root are mounted.
 * @param {{ image: string, worktree: string, home: string, network?: string, cpus?: number, memory?: string, pids?: number, name?: string, packageRoot?: string, env?: Record<string,string>, command?: string[], user?: string }} input
 * @returns {string[]}
 */
export function buildContainerArgs({
  image,
  worktree,
  home,
  network = 'none',
  cpus = 2,
  memory = '2g',
  pids = 512,
  readOnlyRoot = true,
  nonRoot = true,
  name,
  packageRoot,
  env = {},
  command = ['bash'],
  user = defaultContainerUser(),
}) {
  if (!image || !worktree || !home) throw new Error('image, worktree and home are required');
  const args = [
    'run', '--rm', '-i',
    ...(nonRoot ? ['--user', user] : []),
    ...(readOnlyRoot ? ['--read-only'] : []),
    '--tmpfs', '/tmp',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--entrypoint', '',
    '--network', network === 'gateway-only' ? 'bridge' : 'none',
    '--cpus', String(cpus),
    '--memory', memory,
    '--pids-limit', String(pids),
    '-v', `${worktree}:/workspace`,
    '-v', `${home}:/home/zcode`,
  ];
  if (name) args.push('--name', name);
  if (packageRoot) {
    args.push('-v', `${packageRoot}/src:/opt/agent-teams/src:ro`);
    // The member MCP server reads package.json at module load and the panel
    // resources live under assets; mount both without exposing the whole root.
    args.push('-v', `${packageRoot}/package.json:/opt/agent-teams/package.json:ro`);
    args.push('-v', `${packageRoot}/assets:/opt/agent-teams/assets:ro`);
  }
  if (network === 'gateway-only') args.push('--add-host', 'host.docker.internal:host-gateway');
  for (const [key, value] of Object.entries(env)) {
    // Pass secrets by name only; the child process receives the value through
    // its environment, so it never appears in the host process command line.
    if (/TOKEN|SECRET|PASSWORD|KEY/i.test(key)) args.push('-e', key);
    else args.push('-e', `${key}=${value}`);
  }
  args.push('-w', '/workspace', image, ...command);
  return args;
}

/**
 * @param {{ image: string, worktree: string, home: string, network?: string }} input
 * @returns {{ runtime: string, command: string, args: string[] } | undefined}
 */
export function containerPlan(input) {
  const detected = detectContainerRuntime();
  if (!detected.available) return undefined;
  return { runtime: detected.runtime, command: detected.command, args: buildContainerArgs(input) };
}

/**
 * Verify that the configured image exists and the ZCode CLI can run inside it.
 * This is intentionally explicit: callers must not claim hard isolation until
 * this returns ready=true.
 * @param {{ runtime?: 'docker'|'podman', command?: string, image?: string, cliPath?: string, runner?: Function }} input
 * @returns {{ ready: boolean, runtime?: string, command?: string, image?: string, reason?: string, version?: string }}
 */
export function containerSelfTest({ runtime = 'docker', command, image, cliPath = 'zcode', runner = spawnSync } = {}) {
  if (!image) return { ready: false, reason: 'isolation.image is required' };
  if (process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() === 0) {
    return {
      ready: false,
      runtime,
      image,
      reason: 'root POSIX hosts are unsupported for hard isolation; run as a non-root user so the container uid can read/write the worktree and seed home',
    };
  }
  const bin = command ?? runtime;
  const inspect = runner(bin, ['image', 'inspect', image], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  if (inspect.status !== 0) {
    return { ready: false, runtime, command: bin, image, reason: containerInspectError(runtime, image, inspect) };
  }
  const temp = mkdtempSync(join(tmpdir(), 'agent-teams-container-selftest-'));
  try {
    const args = buildContainerArgs({
      image,
      worktree: temp,
      home: temp,
      network: 'none',
      env: { HOME: '/home/zcode' },
      command: [cliPath, '--version'],
    });
    const probe = runner(bin, args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 120000,
    });
    if (probe.status !== 0) {
      return { ready: false, runtime, command: bin, image, reason: `${cliPath} is not runnable inside ${image}` };
    }
    return { ready: true, runtime, command: bin, image, version: String(probe.stdout ?? '').trim().slice(0, 200) };
  } finally {
    try { rmSync(temp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
