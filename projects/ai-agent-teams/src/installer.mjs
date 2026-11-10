import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statfsSync, writeFileSync } from 'node:fs';
import { cpus, release, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recommendPreset } from './domain/lifecycle.mjs';
import { validateConfig } from './config.mjs';
import { CONTAINER_IMAGE_PULL_POLICIES } from './domain/container-image-policy.mjs';
import { detectSystemLocale, detectSystemTimeZone, normalizeLocale, normalizeTimeZone } from './i18n.mjs';
import { isGitWorkspace } from './domain/workspace.mjs';

const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const CONTAINER_DISPATCH_READY = true;

export const HARD_ISOLATION_COMMANDS = {
  wsl: {
    id: 'wsl',
    label: '安装 WSL2',
    command: 'wsl.exe',
    args: ['--install', '--no-distribution'],
  },
  wslStore: {
    id: 'wsl-store',
    label: '从 Microsoft Store 安装 WSL',
    command: 'winget',
    args: ['install', '-e', '--id', 'Microsoft.WSL', '--accept-source-agreements', '--accept-package-agreements'],
  },
  podman: {
    id: 'podman',
    label: '安装 Podman Desktop',
    command: 'winget',
    args: ['install', '-e', '--id', 'RedHat.Podman-Desktop', '--accept-source-agreements', '--accept-package-agreements'],
  },
  podmanCli: {
    id: 'podman-cli',
    label: '安装 Podman CLI',
    command: 'winget',
    args: ['install', '-e', '--id', 'RedHat.Podman', '--accept-source-agreements', '--accept-package-agreements'],
  },
  docker: {
    id: 'docker',
    label: '安装 Docker Desktop',
    command: 'winget',
    args: ['install', '-e', '--id', 'Docker.DockerDesktop', '--accept-source-agreements', '--accept-package-agreements'],
  },
};

/**
 * Build the executable hard-isolation setup plan. It never runs anything and
 * never reboots; callers must explicitly opt into execution.
 * @param {{ runtime?: 'podman'|'docker', platform?: string }} input
 */
export function hardIsolationInstallPlan({ runtime = 'podman', platform = process.platform } = {}) {
  if (platform !== 'win32') {
    return {
      ok: false,
      code: 'UNSUPPORTED_PLATFORM',
      runtime,
      reason: '自动安装前置目前只支持 Windows 10/11；其他系统请手动安装 Docker/Podman。',
    };
  }
  const runtimeId = runtime === 'docker' ? 'docker' : 'podman';
  const runtimeSteps = runtimeId === 'docker'
    ? [HARD_ISOLATION_COMMANDS.docker]
    : [HARD_ISOLATION_COMMANDS.podman, HARD_ISOLATION_COMMANDS.podmanCli];
  return {
    ok: true,
    runtime: runtimeId,
    requiresAdmin: true,
    requiresReboot: true,
    steps: [HARD_ISOLATION_COMMANDS.wsl, ...runtimeSteps],
    fallbacks: { wsl: HARD_ISOLATION_COMMANDS.wslStore },
    verify: [
      { command: 'wsl.exe', args: ['-l', '-v'], label: '确认 WSL2 已安装' },
      { command: runtimeId === 'docker' ? 'docker' : 'podman', args: ['info'], label: `确认 ${runtimeId} 运行时可用` },
      ...(runtimeId === 'podman' ? [{ command: 'podman', args: ['machine', 'list'], label: '确认 Podman machine 状态' }] : []),
    ],
    note: '安装完成后由用户手动重启 Windows；重启后重新执行 --inspect。Podman 还需为 worker 镜像准备 ZCode 登录态和模型选择，否则容器能启动但 worker turn 会失败。',
  };
}

/**
 * Execute the hard-isolation setup plan when `execute` is true. The caller must
 * explicitly pass `execute`; this function never reboots the host.
 * @param {{ runtime?: 'podman'|'docker', execute?: boolean, runner?: Function, platform?: string }} input
 */
export function installHardIsolationPrerequisites({
  runtime = 'podman',
  execute = false,
  runner = spawnSync,
  platform = process.platform,
} = {}) {
  const plan = hardIsolationInstallPlan({ runtime, platform });
  if (!plan.ok) return plan;
  if (!execute) return { ...plan, executed: false };
  const results = [];
  const runStep = (step) => {
    const result = runner(step.command, step.args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 600000,
    });
    const record = {
      id: step.id,
      label: step.label,
      status: result.status,
      stdout: String(result.stdout ?? '').slice(0, 4000),
      stderr: String(result.stderr ?? '').slice(0, 4000),
    };
    results.push(record);
    return record;
  };
  for (const step of plan.steps) {
    const record = runStep(step);
    if (record.status !== 0) {
      const fallback = plan.fallbacks?.[step.id];
      if (fallback) {
        const fallbackRecord = runStep(fallback);
        if (fallbackRecord.status === 0) continue;
        return {
          ...plan,
          ok: false,
          code: 'PREREQUISITE_INSTALL_FAILED',
          executed: true,
          failedStep: fallback.id,
          originalStep: step.id,
          results,
        };
      }
      return {
        ...plan,
        ok: false,
        code: 'PREREQUISITE_INSTALL_FAILED',
        executed: true,
        failedStep: step.id,
        results,
      };
    }
  }
  const verifyResults = [];
  for (const check of plan.verify ?? []) {
    const result = runner(check.command, check.args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 120000,
    });
    const record = {
      label: check.label,
      command: check.command,
      args: check.args,
      status: result.status,
      stdout: String(result.stdout ?? '').slice(0, 4000),
      stderr: String(result.stderr ?? '').slice(0, 4000),
    };
    verifyResults.push(record);
    if (result.status !== 0) {
      return {
        ...plan,
        ok: false,
        code: 'PREREQUISITE_PENDING_REBOOT',
        executed: true,
        installed: true,
        needsReboot: true,
        pending: true,
        failedVerify: check.label,
        results,
        verifyResults,
        message: 'Prerequisites were installed but verification failed; reboot Windows and rerun --inspect/--verify.',
      };
    }
  }
  return { ...plan, executed: true, results, verifyResults, verified: true, rebootRequired: true };
}


export const CONTAINER_RUNTIME_OPTIONS = [
  {
    id: 'podman',
    name: 'Podman Desktop',
    price: 'free',
    priceLabel: '免费',
    license: 'Apache-2.0',
    recommended: true,
    note: '推荐。免费开源，Windows 上有 podman 命令。',
  },
  {
    id: 'docker',
    name: 'Docker Desktop',
    price: 'freemium',
    priceLabel: '个人/小规模免费，商用可能付费',
    license: 'Docker Subscription Service Agreement',
    recommended: false,
    note: '最省事；商用规模请按 Docker 官方订阅条款确认是否付费。',
  },
  {
    id: 'wsl-docker',
    name: 'WSL2 + Docker Engine',
    price: 'free',
    priceLabel: '免费',
    license: 'Apache-2.0',
    recommended: false,
    advanced: true,
    note: '高级选项；Windows 侧需要 wsl-docker 适配，第一版不作为普通选项。',
  },
];

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 15000, ...options });
}

function runBuffer(command, args) {
  return spawnSync(command, args, { windowsHide: true, timeout: 15000 });
}

function decodeWsl(result) {
  const chunks = [result.stdout, result.stderr].filter(Boolean);
  const buffer = Buffer.concat(chunks);
  if (buffer.includes(0)) {
    return buffer.toString('utf16le').split(String.fromCharCode(0)).join('');
  }
  return buffer.toString('utf8');
}

function powershell(script) {
  const result = run('powershell.exe', ['-NoProfile', '-Command', script]);
  if (result.status !== 0) return undefined;
  return (result.stdout ?? '').trim();
}

function parseBuild() {
  const match = String(release()).match(/^(\d+)\.(\d+)\.(\d+)/);
  return match ? Number(match[3]) : 0;
}

function diskFreeGb(path) {
  try {
    const stat = statfsSync(path);
    return Math.round((Number(stat.bavail) * Number(stat.bsize)) / 1024 ** 3 * 10) / 10;
  } catch {
    return null;
  }
}

export async function detectHost(options = {}) {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const nodeMinor = Number(process.versions.node.split('.')[1]);
  const nodeOk = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 5);
  let sqlite = false;
  try { await import('node:sqlite'); sqlite = true; } catch { sqlite = false; }

  let virtualization = { hypervisorPresent: false, vmpState: null, cpuVirtualization: null, slat: null, enabled: false };
  let admin = false;
  if (process.platform === 'win32') {
    const raw = powershell([
      '$cs=Get-CimInstance Win32_ComputerSystem;',
      '$p=Get-CimInstance Win32_Processor | Select-Object -First 1;',
      '$v=Get-CimInstance Win32_OptionalFeature -Filter "Name=\'VirtualMachinePlatform\'";',
      '[pscustomobject]@{HypervisorPresent=$cs.HypervisorPresent;VmpState=$v.InstallState;CpuVirtualization=$p.VirtualizationFirmwareEnabled;Slat=$p.SecondLevelAddressTranslationExtensions} | ConvertTo-Json -Compress',
    ].join(' '));
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        virtualization = {
          hypervisorPresent: parsed.HypervisorPresent === true,
          vmpState: parsed.VmpState ?? null,
          cpuVirtualization: parsed.CpuVirtualization ?? null,
          slat: parsed.Slat ?? null,
          enabled: parsed.HypervisorPresent === true || parsed.VmpState === 1,
        };
      } catch {
        // keep unknown
      }
    }
    admin = powershell("([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)") === 'True';
  }

  let wsl = { installed: false, version2: false, distros: [], raw: '' };
  if (process.platform === 'win32') {
    const version = runBuffer('wsl.exe', ['--version']);
    const list = runBuffer('wsl.exe', ['-l', '-v']);
    const text = decodeWsl(version);
    const listed = list.status === 0 ? decodeWsl(list) : '';
    const failed = /not installed|没有安装|未安装|wsl --install/i.test(`${text}\n${listed}`);
    const distros = listed.split(/\r?\n/).slice(1)
      .map((line) => line.replace(/^\s*\*?\s*/, '').split(/\s{2,}/)[0])
      .filter(Boolean);
    wsl = {
      installed: version.status === 0 && !failed,
      version2: /VERSION\s+2|版本\s+2/i.test(listed) || /WSL\s+version/i.test(text),
      distros,
      raw: `${text}\n${listed}`.trim(),
    };
  }

  const docker = run('docker', ['--version']);
  const podman = run('podman', ['--version']);
  const git = run('git', ['--version']);
  const appCli = process.platform === 'win32' ? join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Zcode', 'resources', 'glm', 'zcode.cjs') : '';
  const cliCandidates = [process.env.ZCODE_CLI, appCli, join(process.env.APPDATA ?? '', 'npm', 'zcode.cmd')].filter(Boolean);
  const zcodePath = cliCandidates.find((candidate) => existsSync(candidate));
  const build = parseBuild();
  const memoryGb = Math.max(1, Math.round(totalmem() / 1024 ** 3));
  return {
    platform: process.platform,
    arch: process.arch,
    windows: { build, caption: process.platform === 'win32' ? 'Windows' : null, supported: process.platform === 'win32' && build >= 19041 },
    node: { version: process.versions.node, ok: nodeOk },
    sqlite,
    memoryGb,
    logicalCpus: cpus().length,
    freeDiskGb: diskFreeGb(options.workspace ?? process.cwd()),
    git: { ok: git.status === 0, version: (git.stdout ?? '').trim() },
    admin,
    virtualization,
    wsl,
    container: {
      docker: docker.status === 0,
      podman: podman.status === 0,
      dockerVersion: (docker.stdout ?? '').trim() || undefined,
      podmanVersion: (podman.stdout ?? '').trim() || undefined,
    },
    zcode: { ok: Boolean(zcodePath), path: zcodePath },
  };
}

const HARD_ISOLATION_REQUIREMENTS = [
  'Windows 10/11 x64',
  '管理员权限',
  'BIOS/UEFI 已开启虚拟化（Intel VT-x / AMD-V）',
  '至少 16GB 内存',
  '至少 10GB 可用磁盘',
  'WSL2 已安装并完成初始化',
  'Podman Desktop（推荐）或 Docker Desktop 正在运行',
  '容器派发已接线，且 worker 镜像自测通过',
];

function hardIsolationRepairSteps(host) {
  const steps = [];
  if (!host.windows?.supported) steps.push('当前系统不受支持；请使用 Windows 10/11 x64。');
  if (!host.admin) steps.push('以管理员身份运行 PowerShell/安装程序。');
  if (!host.virtualization?.enabled) steps.push('重启进入 BIOS/UEFI，开启 Intel VT-x 或 AMD-V 虚拟化。');
  if (!(Number(host.memoryGb) >= 16)) steps.push('增加内存到至少 16GB。');
  if (!(Number.isFinite(host.freeDiskGb) && host.freeDiskGb >= 10)) steps.push('释放磁盘空间到至少 10GB。');
  if (!host.wsl?.installed) steps.push('以管理员身份执行 wsl --install，重启 Windows，并完成 Linux 用户初始化。');
  if (!(host.container?.docker || host.container?.podman)) steps.push('安装 Podman Desktop（推荐，免费）或 Docker Desktop，启动后用 podman info 或 docker info 验证。');
  steps.push('构建包含 ZCode 的 worker 镜像（参考 deploy/worker.Dockerfile），并在镜像内执行 zcode --version 自测。');
  return steps;
}

function softIsolationRepairSteps(host, workspace) {
  const steps = [];
  if (host.git?.ok === false) steps.push('安装 git，并确保 git --version 可用。');
  if (workspace && !isGitWorkspace(workspace)) steps.push('在目标工作区执行 git init，或选择一个已有的 git 仓库。');
  return steps;
}

/**
 * Recommendation only. It never installs or reboots.
 * @param {any} host
 * @returns {{ recommended: 'wsl'|'worktree', state: string, effective: 'container'|'worktree', requiresWsl: boolean, canChooseSoft: boolean, reason: string, checks: Array<{name:string,ok:boolean,detail:string}> }}
 */
export function recommendIsolation(host, options = {}) {
  const base = recommendIsolationBase(host);
  const hardReady = Boolean(CONTAINER_DISPATCH_READY
    && host.windows?.supported
    && host.memoryGb >= 16
    && (Number.isFinite(host.freeDiskGb) && host.freeDiskGb >= 10)
    && host.admin
    && host.virtualization?.enabled
    && host.wsl?.installed
    && (host.container?.docker || host.container?.podman));
  const hardInstallable = Boolean(host.windows?.supported
    && host.memoryGb >= 16
    && (Number.isFinite(host.freeDiskGb) && host.freeDiskGb >= 10)
    && host.admin
    && host.virtualization?.enabled);
  const softAvailable = host.git?.ok !== false && (!options.workspace || isGitWorkspace(options.workspace));
  const effective = hardReady ? 'container' : (softAvailable ? 'worktree' : 'none');
  return {
    ...base,
    effective,
    canChooseSoft: softAvailable,
    recommendedRuntime: 'podman',
    runtimeOptions: CONTAINER_RUNTIME_OPTIONS,
    options: {
      hard: {
        available: hardReady,
        installable: hardInstallable,
        effective: hardReady ? 'container' : 'worktree',
        requirements: HARD_ISOLATION_REQUIREMENTS,
        repairSteps: hardReady ? [] : hardIsolationRepairSteps(host),
        reason: hardReady
          ? '硬隔离可用：每个活动 worker 独立容器。'
          : hardInstallable
            ? '硬隔离前置未就绪；先安装 WSL2/Podman，并构建包含 ZCode 的 worker 镜像。'
            : '硬件、权限或虚拟化不满足硬隔离前置条件；可先按修复步骤补齐，或选择软隔离。',
      },
      soft: {
        available: softAvailable,
        effective: 'worktree',
        requirements: ['git 已安装', '目标工作区是 git 仓库'],
        repairSteps: softAvailable ? [] : softIsolationRepairSteps(host, options.workspace),
        reason: softAvailable
          ? '软隔离：每个任务独立 git worktree，仅隔离文件，不是安全边界。'
          : '未检测到 git；worktree 不可用，只能退化为无隔离，必须先安装 git。',
      },
    },
  };
}

function recommendIsolationBase(host) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });
  add('windows', host.windows?.supported, `build ${host.windows?.build ?? 'unknown'}`);
  add('memory', host.memoryGb >= 16, `${host.memoryGb}GB`);
  add('disk', Number.isFinite(host.freeDiskGb) && host.freeDiskGb >= 10, `${host.freeDiskGb ?? 'unknown'}GB free`);
  add('admin', host.admin, 'needed to install WSL2');
  add('virtualization', host.virtualization?.enabled, JSON.stringify(host.virtualization ?? {}));
  add('wsl', host.wsl?.installed, host.wsl?.distros?.join(', ') || 'not installed');
  add('container-runtime', host.container?.docker || host.container?.podman, host.container?.docker ? 'docker' : host.container?.podman ? 'podman' : 'none');

  const systemOk = host.windows?.supported && host.memoryGb >= 16
    && (Number.isFinite(host.freeDiskGb) && host.freeDiskGb >= 10);
  const virtualized = host.virtualization?.enabled === true;
  const wslReady = host.wsl?.installed === true;
  const runtimeReady = Boolean(host.container?.docker || host.container?.podman);

  if (!virtualized) {
    return {
      recommended: 'worktree', state: 'soft-only', effective: 'worktree', requiresWsl: false,
      canChooseSoft: true, reason: '虚拟化未开启或不可用；推荐软隔离（worktree），不需要 WSL。', checks,
    };
  }
  if (!systemOk) {
    return {
      recommended: 'worktree', state: 'soft-only', effective: 'worktree', requiresWsl: false,
      canChooseSoft: true, reason: '虚拟化已开，但内存/磁盘/系统版本不足；推荐软隔离。', checks,
    };
  }
  if (!host.admin) {
    return {
      recommended: 'worktree', state: 'needs-admin', effective: 'worktree', requiresWsl: false,
      canChooseSoft: true, reason: '虚拟化已开，但安装 WSL 需要管理员权限；先软隔离，或用管理员重跑。', checks,
    };
  }
  if (!wslReady) {
    return {
      recommended: 'wsl', state: 'install-wsl', effective: 'worktree', requiresWsl: true,
      canChooseSoft: true, reason: '虚拟化已开、系统满足要求；推荐安装 WSL2，再装 Podman/Docker。可先选软隔离。', checks,
    };
  }
  if (!runtimeReady) {
    return {
      recommended: 'wsl', state: 'install-runtime', effective: 'worktree', requiresWsl: true,
      canChooseSoft: true, reason: 'WSL2 已就绪；推荐安装 Podman/Docker 后启用标准隔离。', checks,
    };
  }
  return {
    recommended: 'wsl', state: CONTAINER_DISPATCH_READY ? 'ready' : 'runtime-ready-dispatch-pending',
    effective: CONTAINER_DISPATCH_READY ? 'container' : 'worktree',
    requiresWsl: false,
    canChooseSoft: true,
    reason: CONTAINER_DISPATCH_READY
      ? 'WSL2 与容器运行时已就绪；可以启用标准隔离。'
      : 'WSL2 与容器运行时已就绪；容器派发未接线。',
    checks,
  };
}

/**
 * First-install values are concrete. `auto` (or an omitted value) means "ask
 * the host once at install time"; local.json never stores `auto` because the
 * daemon must not re-detect on every restart.
 */
function resolutionValue(explicit, detect, normalize, label) {
  if (explicit === undefined || explicit === null) return detect();
  const value = String(explicit).trim();
  if (!value || value.toLowerCase() === 'auto') return detect();
  const resolved = normalize(value);
  if (!resolved) throw new Error(`unsupported ${label} for local.json: ${explicit}`);
  return resolved;
}

/**
 * Build a validated install plan without writing anything.
 * @param {{ host: any, teamMode: 'single'|'dual', preset?: 'conservative'|'balanced', recommended?: any, isolation?: 'hard'|'soft'|'worktree'|'container', runtime?: string, imagePullPolicy?: 'never'|'if-missing'|'always', locale?: string, timezone?: string }} input
 */
export function buildInstallPlan(input) {
  const teamMode = input.teamMode === 'single' ? 'single' : 'dual';
  const preset = input.preset === 'conservative' ? 'conservative' : 'balanced';
  const recommendation = input.recommended ?? recommendIsolation(input.host, { workspace: input.workspace });
  const teams = teamMode === 'single' ? 1 : 2;
  const locale = resolutionValue(input.locale, () => detectSystemLocale(), (value) => normalizeLocale(value), 'locale');
  const timezone = resolutionValue(input.timezone, () => detectSystemTimeZone(), (value) => normalizeTimeZone(value, {}), 'time zone');
  if (input.imagePullPolicy != null && !CONTAINER_IMAGE_PULL_POLICIES.includes(input.imagePullPolicy)) {
    throw new Error(`unsupported image pull policy: ${String(input.imagePullPolicy)}`);
  }
  const values = recommendPreset({ memoryGb: input.host.memoryGb, mode: preset, teams });
  const requested = input.isolation ?? recommendation.effective;
  let effective;
  if (requested === 'hard' || requested === 'container') {
    if (!CONTAINER_DISPATCH_READY) {
      throw new Error('hard isolation is not wired in this version; choose soft isolation');
    }
    effective = 'container';
  } else if (requested === 'none') {
    effective = 'none';
  } else if (input.workspace && !isGitWorkspace(input.workspace)) {
    if (input.isolation) {
      throw new Error('soft worktree isolation requires a git workspace; initialize git or choose another isolation mode');
    }
    // A plan generated without an explicit isolation choice must not claim
    // worktree isolation for a non-git directory; fall back to an explicit none.
    effective = 'none';
  } else {
    if (input.isolation === 'soft' && input.workspace && recommendation.options?.soft?.available === false) {
      throw new Error(recommendation.options.soft.reason ?? 'soft isolation is unavailable for this workspace');
    }
    effective = 'worktree';
  }
  const base = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'config', 'example.v06.json'), 'utf8'));
  const config = structuredClone(base);
  config.captain.maxTeams = teams;
  config.teams = config.teams.slice(0, teams);
  config.scheduler = {
    ...config.scheduler,
    preset,
    memoryGb: input.host.memoryGb,
    activeWorkerSlots: values.activeWorkerSlots,
    maxActivePerTeam: values.maxActivePerTeam,
    minActivePerTeam: values.minActivePerTeam,
    maxControlSessions: values.maxControlSessions,
    maxTotalSessions: values.maxTotalSessions,
    allowAboveDesignCap: false,
  };
  config.zcode.maxConcurrentSessions = Math.max(6, values.activeWorkerSlots);
  config.zcode.locale = locale;
  config.zcode.timezone = timezone;
  // Start pacing for the default 6 workers + 2 contractor slots. Raise it only
  // when the provider's group RPM budget is known to be higher.
  config.zcode.maxRequestsPerMinute = 8;
  const isolationRuntime = input.runtime
    ?? (input.host?.container?.docker ? 'docker' : input.host?.container?.podman ? 'podman' : recommendation.recommendedRuntime)
    ?? config.isolation.containerRuntime
    ?? 'podman';
  config.isolation = {
    ...config.isolation,
    mode: effective,
    containerRuntime: isolationRuntime === 'docker' ? 'docker' : 'podman',
    image: input.image ?? config.isolation.image ?? 'ai-agent-teams-worker:latest',
    ...(input.imagePullPolicy ? { imagePullPolicy: input.imagePullPolicy } : {}),
    cliPath: input.cliPath ?? config.isolation.cliPath ?? 'zcode',
    containerUrl: input.containerUrl ?? config.isolation.containerUrl ?? null,
    hostAddress: input.hostAddress ?? config.isolation.hostAddress ?? null,
    bindHost: input.bindHost ?? config.isolation.bindHost ?? null,
    homeSeed: input.homeSeed ?? config.isolation.homeSeed ?? null,
    workerModel: input.workerModel ?? config.isolation.workerModel ?? null,
    workerMode: input.workerMode ?? config.isolation.workerMode ?? 'yolo',
  };
  return {
    host: input.host,
    teamMode,
    preset,
    teams,
    values,
    recommendation,
    isolation: { requested, effective },
    runtime: input.runtime ?? recommendation.recommendedRuntime ?? 'podman',
    runtimeOptions: CONTAINER_RUNTIME_OPTIONS,
    config,
  };
}

export function writeInstallConfig(plan, outputPath) {
  const validation = validateConfig(plan.config);
  if (!validation.ok) {
    throw new Error(`generated config is invalid: ${validation.errors.join('; ')}`);
  }
  const target = resolve(outputPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(plan.config, null, 2)}\n`, 'utf8');
  return target;
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const workspaceIndex = args.indexOf('--workspace');
  const workspace = resolve((workspaceIndex >= 0 ? args[workspaceIndex + 1] : undefined) ?? process.cwd());
  // Read optional flags without mistaking the next option for their value.
  const value = (name) => {
    const index = args.indexOf(name);
    const raw = index >= 0 ? args[index + 1] : undefined;
    return raw && !raw.startsWith('--') ? raw : undefined;
  };
  const requiredValue = (name) => {
    const index = args.indexOf(name);
    if (index < 0) return undefined;
    const raw = args[index + 1];
    if (!raw || raw.startsWith('--')) {
      console.error(`ERROR ${name} requires a value`);
      process.exit(2);
    }
    return raw;
  };
  const imagePullPolicy = requiredValue('--image-pull-policy');
  const host = await detectHost({ workspace });
  const recommendation = recommendIsolation(host, { workspace });
  if (!args.includes('--plan')) {
    printJson({ host, recommendation });
    process.exit(0);
  }
  const teamMode = value('--team-mode') === 'single' ? 'single' : 'dual';
  const preset = value('--preset') === 'conservative' ? 'conservative' : 'balanced';
  const runtime = value('--runtime');
  const locale = value('--locale');
  const timezone = value('--timezone');
  const plan = buildInstallPlan({
    host,
    teamMode,
    preset,
    runtime,
    imagePullPolicy,
    recommended: recommendation,
    workspace,
    ...(locale ? { locale } : {}),
    ...(timezone ? { timezone } : {}),
  });
  const writeIndex = args.indexOf('--write');
  if (writeIndex >= 0) {
    const path = writeInstallConfig(plan, args[writeIndex + 1] ?? 'config/local.json');
    printJson({ ...plan, written: path });
  } else {
    printJson(plan);
  }
}
