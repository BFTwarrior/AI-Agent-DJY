import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectHost, recommendIsolation, buildInstallPlan, writeInstallConfig, installHardIsolationPrerequisites, CONTAINER_RUNTIME_OPTIONS, CONTAINER_DISPATCH_READY } from './installer.mjs';
import { readDiscoveryForWorkspace } from './discovery.mjs';
import { isGitWorkspace, sameWorkspace } from './domain/workspace.mjs';
import { containerSelfTest, detectContainerHostAddress, detectContainerRuntime, ensureContainerRuntime } from './runtime/container.mjs';
import { panelInfo } from './panel.mjs';

export const PACKAGE_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const SELECTABLE_RUNTIMES = CONTAINER_RUNTIME_OPTIONS.filter((option) => option.id === 'podman' || option.id === 'docker');

const CONTENT_ROOTS = ['package.json', 'src', 'assets', 'config', 'skills', 'commands', 'agents', '.zcode-plugin'];
const CONTENT_SKIP = new Set(['.ai-agent-teams', '.agent-teams', 'node_modules', 'dist', 'local.json']);

function treeDigest(base, relPaths = CONTENT_ROOTS) {
  const hash = createHash('sha256');
  const visit = (path, rel) => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (CONTENT_SKIP.has(entry.name)) continue;
      const full = join(path, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        visit(full, childRel);
      } else if (entry.isFile()) {
        hash.update(childRel);
        hash.update('\0');
        hash.update(readFileSync(full));
        hash.update('\0');
      }
    }
  };
  for (const rel of relPaths) {
    const full = join(base, rel);
    try {
      if (rel.endsWith('.json')) {
        hash.update(rel);
        hash.update('\0');
        hash.update(readFileSync(full));
        hash.update('\0');
      } else {
        visit(full, rel);
      }
    } catch {
      return undefined;
    }
  }
  return hash.digest('hex');
}

export const INSTALL_PHASES = [
  'awaiting-isolation-choice',
  'awaiting-restart-verification',
  'awaiting-preset-choice',
  'complete',
];

export function defaultStatePath(workspace = process.cwd()) {
  return resolve(workspace, '.ai-agent-teams', 'install-state.json');
}

export function readInstallState(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

export function writeInstallState(path, state) {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return target;
}

function pluginInventory() {
  const path = join(homedir(), '.zcode', 'cli', 'plugins', 'installed_plugins.json');
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    const found = (data.plugins ?? []).find((item) => item.name === 'ai-agent-teams');
    if (!found) return { installed: false, inventoryPath: path };
    let manifestVersion;
    let contentOk = false;
    try {
      const manifest = JSON.parse(readFileSync(join(found.installPath, '.zcode-plugin', 'plugin.json'), 'utf8'));
      manifestVersion = manifest.version;
      const runningRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
      const independentReference = !sameWorkspace(runningRoot, found.installPath);
      const installedDigest = treeDigest(found.installPath);
      const expectedDigest = treeDigest(runningRoot);
      contentOk = Boolean(independentReference && installedDigest && expectedDigest && installedDigest === expectedDigest);
    } catch {
      contentOk = false;
    }
    return {
      installed: true,
      version: manifestVersion ?? found.version,
      manifestVersion,
      contentOk,
      installPath: found.installPath,
      marketplace: found.marketplace,
    };
  } catch {
    return { installed: false, inventoryPath: path };
  }
}

async function daemonStatus(workspace) {
  const discovery = readDiscoveryForWorkspace(workspace);
  if (!discovery?.port) return { running: false };
  const workspaceOk = Boolean(workspace && discovery.workspace && sameWorkspace(discovery.workspace, workspace));
  try {
    const response = await fetch(`http://127.0.0.1:${discovery.port}/api/v1/health`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return { running: false, port: discovery.port, status: response.status, workspaceOk };
    const body = await response.json();
    return {
      running: true,
      port: discovery.port,
      version: body?.data?.version,
      workspaceOk,
      ...(workspaceOk ? {} : { error: 'daemon discovery belongs to a different workspace' }),
    };
  } catch (error) {
    return { running: false, port: discovery.port, workspaceOk, error: error instanceof Error ? error.message : String(error) };
  }
}

function hostChecks(host, gitRepo = host.gitRepo) {
  return [
    { name: 'windows', ok: host.windows?.supported, detail: `build ${host.windows?.build ?? 'unknown'}` },
    { name: 'node>=22.5', ok: host.node?.ok, detail: host.node?.version ?? 'unknown' },
    { name: 'node:sqlite', ok: host.sqlite, detail: host.sqlite ? 'available' : 'missing' },
    { name: 'git', ok: host.git?.ok, detail: host.git?.version || 'not installed' },
    { name: 'git-repo', ok: Boolean(gitRepo), detail: gitRepo ? 'workspace is inside a git worktree' : 'workspace is not a git repository; soft worktree isolation is unavailable' },
    { name: 'memory>=16GB', ok: host.memoryGb >= 16, detail: `${host.memoryGb}GB` },
    { name: 'disk>=10GB', ok: Number.isFinite(host.freeDiskGb) && host.freeDiskGb >= 10, detail: host.freeDiskGb === null || host.freeDiskGb === undefined ? 'unknown; disk scan failed' : `${host.freeDiskGb}GB free` },
    { name: 'zcode', ok: host.zcode?.ok, detail: host.zcode?.path ?? 'not detected' },
  ];
}

export async function inspectInstall({ workspace = process.cwd(), statePath = defaultStatePath(workspace), githubUrl = null } = {}) {
  const host = await detectHost({ workspace });
  const gitRepo = isGitWorkspace(workspace);
  host.gitRepo = gitRepo;
  const recommendation = recommendIsolation(host, { workspace });
  if (!gitRepo) {
    recommendation.options.soft = {
      ...recommendation.options.soft,
      available: false,
      effective: 'none',
      reason: '当前工作区不是 git 仓库；worktree 软隔离不可用。请先在目标工作区 git init 或选择一个 git 仓库。',
      repairSteps: [
        '在目标工作区执行 git init，或选择一个已有的 git 仓库。',
        '重新执行 --inspect，确认 soft.available=true。',
      ],
    };
  }
  const plugin = pluginInventory();
  const daemon = await daemonStatus(workspace);
  const state = {
    version: 1,
    phase: 'awaiting-isolation-choice',
    githubUrl,
    workspace: resolve(workspace),
    host,
    recommendation,
    checks: hostChecks(host, gitRepo),
    plugin,
    daemon,
    createdAt: new Date().toISOString(),
  };
  writeInstallState(statePath, state);
  return {
    ok: true,
    phase: state.phase,
    statePath: resolve(statePath),
    checks: state.checks,
    host: {
      platform: host.platform,
      memoryGb: host.memoryGb,
      freeDiskGb: host.freeDiskGb,
      admin: host.admin,
      virtualization: host.virtualization,
      wsl: host.wsl,
      container: host.container,
      git: host.git,
      gitRepo,
      node: host.node,
      zcode: host.zcode,
    },
    plugin,
    daemon,
    recommendation: {
      recommended: recommendation.recommended,
      state: recommendation.state,
      reason: recommendation.reason,
      options: recommendation.options,
      requiredChecks: recommendation.checks,
    },
    questions: [
      {
        id: 'isolation',
        prompt: '请选择隔离方式：硬隔离（容器/更强安全边界）或软隔离（git worktree，仅文件隔离）。',
        options: [
          {
            value: 'hard',
            label: '硬隔离（容器）',
            available: recommendation.options.hard.available,
            installable: recommendation.options.hard.installable,
            recommended: recommendation.options.hard.available && recommendation.recommended === 'wsl',
            reason: recommendation.options.hard.reason,
            requirements: recommendation.options.hard.requirements,
            repairSteps: recommendation.options.hard.repairSteps,
          },
          {
            value: 'soft',
            label: '软隔离（git worktree）',
            available: recommendation.options.soft.available,
            recommended: recommendation.options.soft.available && (recommendation.recommended !== 'wsl' || !recommendation.options.hard.available),
            reason: recommendation.options.soft.reason,
            requirements: recommendation.options.soft.requirements,
            repairSteps: recommendation.options.soft.repairSteps,
          },
        ],
      },
      {
        id: 'containerRuntime',
        prompt: '硬隔离使用哪个容器运行时？',
        when: 'isolation=hard',
        options: SELECTABLE_RUNTIMES.map((option) => ({
          value: option.id,
          label: option.name,
          recommended: option.recommended,
          price: option.priceLabel,
          note: option.note,
        })),
      },
      {
        id: 'teamMode',
        prompt: '请选择团队规模：双队（默认）或单队。安装后固定，面板不提供运行时切换。',
        options: [
          {
            value: 'dual',
            label: '双队',
            description: 'A队 + B队，共享队员池按任务动态抽调。',
            recommended: true,
          },
          {
            value: 'single',
            label: '单队',
            description: '只创建一支队伍，面板固定显示单队。',
            recommended: false,
          },
        ],
      },
    ],
    next: 'choose-isolation',
  };
}

export async function chooseIsolation({
  workspace = process.cwd(),
  statePath = defaultStatePath(workspace),
  isolation,
  runtime,
  githubUrl,
  teamMode = 'dual',
} = {}) {
  const existing = readInstallState(statePath);
  if (!existing) throw new Error(`install state not found: ${statePath}; run --inspect first`);
  if (existing.phase !== 'awaiting-isolation-choice') {
    throw new Error(`choose-isolation requires phase awaiting-isolation-choice, current phase is ${existing.phase}`);
  }
  if (!['hard', 'soft'].includes(isolation)) throw new Error('isolation must be hard|soft');
  if (runtime !== undefined && !['podman', 'docker'].includes(runtime)) throw new Error('runtime must be podman|docker');
  const options = existing.recommendation?.options ?? {};
  const selectedRuntime = runtime;
  if (isolation === 'hard' && !options.hard?.available) {
    return {
      ok: false,
      phase: existing.phase,
      code: 'HARD_ISOLATION_UNAVAILABLE',
      reason: options.hard?.reason ?? 'hard isolation is unavailable',
      detail: CONTAINER_DISPATCH_READY
        ? 'container prerequisites are not ready'
        : 'this version does not wire container dispatch; install and verify soft isolation, or wait for the hard-isolation release',
      installable: Boolean(options.hard?.installable),
      requirements: options.hard?.requirements ?? [],
      repairSteps: options.hard?.repairSteps ?? [],
      canChooseSoft: Boolean(options.soft?.available),
      next: 'install-hard-prerequisites-or-choose-soft',
    };
  }
  if (isolation === 'soft' && !options.soft?.available) {
    return {
      ok: false,
      phase: existing.phase,
      code: 'SOFT_ISOLATION_UNAVAILABLE',
      reason: options.soft?.reason ?? 'git worktree is unavailable',
      requirements: options.soft?.requirements ?? [],
      repairSteps: options.soft?.repairSteps ?? [],
      next: 'fix-soft-prerequisites-or-choose-hard',
    };
  }
  if (isolation === 'hard' && !selectedRuntime) {
    return {
      ok: false,
      phase: existing.phase,
      code: 'RUNTIME_CHOICE_REQUIRED',
      reason: '硬隔离需要先选择容器运行时：Podman 或 Docker。',
      options: SELECTABLE_RUNTIMES.map((option) => ({ value: option.id, label: option.name, recommended: option.recommended })),
      next: 'choose-container-runtime',
    };
  }
  if (isolation === 'hard') {
    const image = process.env.AGENT_TEAMS_CONTAINER_IMAGE ?? 'ai-agent-teams-worker:latest';
    const detected = detectContainerRuntime(selectedRuntime);
    const selfTest = containerSelfTest({
      runtime: selectedRuntime,
      command: detected.command ?? selectedRuntime,
      image,
      cliPath: process.env.AGENT_TEAMS_CONTAINER_CLI ?? 'zcode',
    });
    if (!selfTest.ready) {
      return {
        ok: false,
        phase: existing.phase,
        code: 'HARD_ISOLATION_SELF_TEST_FAILED',
        reason: selfTest.reason ?? 'container self-test failed',
        requirements: options.hard?.requirements ?? [],
        repairSteps: [
          ...(options.hard?.repairSteps ?? []),
          `构建包含 ZCode 的 worker 镜像（参考 deploy/worker.Dockerfile），例如：docker build -f deploy/worker.Dockerfile -t ${image} .`,
          `在镜像内执行 ${process.env.AGENT_TEAMS_CONTAINER_CLI ?? 'zcode'} --version，确认自测通过。`,
        ],
        next: 'fix-worker-image-and-retry',
      };
    }
  }
  const workerHomeSeed = process.env.AGENT_TEAMS_WORKER_HOME_SEED ?? null;
  const workerModel = process.env.AGENT_TEAMS_WORKER_MODEL ? parseWorkerModel(process.env.AGENT_TEAMS_WORKER_MODEL) : null;
  const workerMode = process.env.AGENT_TEAMS_WORKER_MODE ?? 'yolo';
  const state = {
    ...existing,
    phase: 'awaiting-restart-verification',
    githubUrl: githubUrl ?? existing.githubUrl ?? null,
    isolation: {
      requested: isolation,
      effective: isolation === 'hard' ? 'container' : 'worktree',
      ...(isolation === 'hard' ? {
        runtime: selectedRuntime,
        homeSeed: workerHomeSeed,
        workerModel,
        workerMode,
        hostAddress: process.env.AGENT_TEAMS_CONTAINER_HOST ?? null,
        bindHost: process.env.AGENT_TEAMS_CONTAINER_BIND ?? null,
      } : {}),
    },
    teamMode: teamMode === 'single' ? 'single' : 'dual',
    chosenAt: new Date().toISOString(),
    restartRequired: true,
  };
  writeInstallState(statePath, state);
  const hard = isolation === 'hard';
  return {
    ok: true,
    phase: state.phase,
    isolation: state.isolation,
    restartRequired: true,
    restartInstructions: '安装完成后由用户手动重启电脑/ZCode，然后重新打开本任务；不要自动重启。',
    installSteps: hard
      ? [
        '以管理员身份安装 WSL2（wsl --install），再安装 Podman Desktop 或 Docker Desktop。',
        '在 ZCode 插件市场添加本项目根目录（含 marketplace.json）并安装 AI Agent Teams。',
        '安装完成后请用户手动重启电脑。',
      ]
      : [
        '在 ZCode 插件市场添加本项目根目录（含 marketplace.json）并安装 AI Agent Teams。',
        '安装完成后请用户手动重启电脑，确保新版本和 MCP 配置生效。',
      ],
    verifyCommand: `node src/install-wizard.mjs --verify --restart-confirmed --workspace "${resolve(workspace)}"`,
    next: 'restart-and-verify',
  };
}

export function verifyChecks({ host, plugin, daemon, restartConfirmed, gitRepo }) {
  const checks = hostChecks(host, gitRepo);
  checks.push({ name: 'restart-confirmed', ok: Boolean(restartConfirmed), detail: restartConfirmed ? 'confirmed by user' : 'pending' });
  checks.push({
    name: 'plugin-installed',
    ok: Boolean(plugin.installed && plugin.version === PACKAGE_VERSION && plugin.contentOk),
    detail: plugin.installed
      ? `${plugin.version} @ ${plugin.installPath}${plugin.version !== PACKAGE_VERSION ? ` (expected ${PACKAGE_VERSION})` : ''}${plugin.contentOk ? '' : ' (installed files are stale or incomplete)'}`
      : `not installed in ~/.zcode/cli/plugins/installed_plugins.json (expected ${PACKAGE_VERSION})`,
  });
  const daemonRequired = Boolean(daemon.running);
  const daemonWorkspaceOk = daemon.workspaceOk !== false;
  checks.push({
    name: 'daemon-health',
    required: daemonRequired,
    ok: !daemon.running ? true : (daemon.version === PACKAGE_VERSION && daemonWorkspaceOk),
    detail: daemon.running
      ? `port ${daemon.port}, ${daemon.version ?? 'unknown version'}${daemon.version === PACKAGE_VERSION ? '' : ` (expected ${PACKAGE_VERSION})`}${daemonWorkspaceOk ? '' : ' (different workspace)'}`
      : (daemon.error ?? 'not running yet; it starts on the first team tool call'),
  });
  return checks;
}

export async function verifyInstall({
  workspace = process.cwd(),
  statePath = defaultStatePath(workspace),
  restartConfirmed = false,
  dependencies = {},
} = {}) {
  const existing = readInstallState(statePath);
  if (!existing) throw new Error(`install state not found: ${statePath}; run --inspect first`);
  if (existing.phase !== 'awaiting-restart-verification') {
    throw new Error(`verify requires phase awaiting-restart-verification, current phase is ${existing.phase}`);
  }
  if (!existing.isolation || !['hard', 'soft'].includes(existing.isolation.requested)) {
    throw new Error('verify requires an explicit hard|soft isolation choice; run --choose-isolation first');
  }
  const host = dependencies.host ?? await detectHost({ workspace: existing.workspace ?? workspace });
  const gitRepo = dependencies.gitRepo ?? isGitWorkspace(existing.workspace ?? workspace);
  host.gitRepo = gitRepo;
  const plugin = dependencies.plugin ?? pluginInventory();
  const daemon = dependencies.daemon ?? await daemonStatus(existing.workspace ?? workspace);
  const checks = verifyChecks({ host, plugin, daemon, restartConfirmed, gitRepo });
  if (existing.isolation.requested === 'hard' && dependencies.containerChecks !== false) {
    const runtime = existing.isolation.runtime;
    const detected = ensureContainerRuntime(runtime);
    checks.push({
      name: 'container-runtime',
      ok: detected.available,
      detail: detected.available
        ? (detected.command ?? runtime)
        : (detected.machineStartError ?? `${runtime} is not available`),
    });
    const image = process.env.AGENT_TEAMS_CONTAINER_IMAGE ?? 'ai-agent-teams-worker:latest';
    const selfTest = containerSelfTest({
      runtime,
      command: detected.command,
      image,
      cliPath: process.env.AGENT_TEAMS_CONTAINER_CLI ?? 'zcode',
    });
    checks.push({
      name: 'container-image',
      ok: selfTest.ready,
      detail: selfTest.ready ? `${image}: ${selfTest.version ?? 'ok'}` : (selfTest.reason ?? 'container self-test failed'),
    });
    const seedDir = existing.isolation.homeSeed ?? process.env.AGENT_TEAMS_WORKER_HOME_SEED;
    const seedOk = Boolean(seedDir
      && existsSync(join(seedDir, 'credentials.json'))
      && existsSync(join(seedDir, 'provider_config.json')));
    checks.push({
      name: 'worker-home-seed',
      ok: seedOk,
      detail: seedDir ?? 'set AGENT_TEAMS_WORKER_HOME_SEED to ~/.zcode/v2',
    });
    checks.push({
      name: 'worker-model',
      ok: Boolean(existing.isolation.workerModel?.providerId && existing.isolation.workerModel?.modelId),
      detail: existing.isolation.workerModel
        ? `${existing.isolation.workerModel.providerId}/${existing.isolation.workerModel.modelId}`
        : 'set AGENT_TEAMS_WORKER_MODEL={"providerId":"...","modelId":"..."}',
    });
    const callbackHost = existing.isolation.hostAddress ?? detectContainerHostAddress();
    checks.push({
      name: 'container-callback',
      ok: Boolean(callbackHost || process.env.AGENT_TEAMS_CONTAINER_URL),
      detail: process.env.AGENT_TEAMS_CONTAINER_URL ?? existing.isolation.containerUrl ?? callbackHost ?? 'no container-reachable address',
    });
  }
  const ok = checks.filter((check) => check.required !== false).every((check) => check.ok);
  const state = {
    ...existing,
    phase: ok ? 'awaiting-preset-choice' : 'awaiting-restart-verification',
    host,
    plugin,
    daemon,
    checks,
    verifiedAt: ok ? new Date().toISOString() : existing.verifiedAt,
    restartConfirmedAt: restartConfirmed ? new Date().toISOString() : existing.restartConfirmedAt,
  };
  writeInstallState(statePath, state);
  return {
    ok,
    phase: state.phase,
    checks,
    next: ok ? 'choose-preset' : 'fix-checks-and-reverify',
    message: ok
      ? '安装与重启后自检通过。下一步让用户选择保守或平衡方案。'
      : '自检未通过；不要宣称安装成功，先修复失败项并重新验证。',
  };
}

export function presetOptions({ workspace = process.cwd(), statePath = defaultStatePath(workspace) } = {}) {
  const state = readInstallState(statePath);
  if (!state) throw new Error(`install state not found: ${statePath}; run --inspect first`);
  if (state.phase !== 'awaiting-preset-choice') {
    throw new Error(`presets require phase awaiting-preset-choice, current phase is ${state.phase}`);
  }
  if (!state.isolation || !['hard', 'soft'].includes(state.isolation.requested)) {
    throw new Error('presets require an explicit hard|soft isolation choice; rerun --inspect and --choose-isolation');
  }
  if (state.isolation.requested === 'soft' && (!state.recommendation?.options?.soft?.available || !isGitWorkspace(state.workspace))) {
    throw new Error('soft isolation is not available for this workspace; initialize git or choose a valid workspace');
  }
  if (state.isolation.requested === 'hard' && !['podman', 'docker'].includes(state.isolation.runtime)) {
    throw new Error('hard isolation state is missing a runtime; rerun --choose-isolation hard --runtime podman|docker');
  }
  const host = state.host;
  const teamMode = state.teamMode ?? 'dual';
  const isolation = state.isolation?.requested ?? 'soft';
  const options = ['conservative', 'balanced'].map((preset) => {
    const plan = buildInstallPlan({ host, teamMode, preset, isolation, recommended: state.recommendation, workspace: state.workspace });
    return {
      preset,
      label: preset === 'conservative' ? '保守' : '平衡',
      description: preset === 'conservative'
        ? '更少并发会话、成本和速率风险更低。'
        : '更高并发和吞吐，适合内存和 API 配额充足时。',
      activeWorkerSlots: plan.values.activeWorkerSlots,
      maxActivePerTeam: plan.values.maxActivePerTeam,
      maxTotalSessions: plan.values.maxTotalSessions,
      config: plan.config,
    };
  });
  return {
    ok: true,
    phase: 'awaiting-preset-choice',
    teamMode,
    isolation,
    options,
    question: {
      id: 'preset',
      prompt: '请选择保守或平衡方案。',
      options: options.map((option) => ({
        value: option.preset,
        label: option.label,
        description: option.description,
        activeWorkerSlots: option.activeWorkerSlots,
        maxActivePerTeam: option.maxActivePerTeam,
        maxTotalSessions: option.maxTotalSessions,
      })),
    },
    next: 'apply-preset',
  };
}

export function applyPreset({
  workspace = process.cwd(),
  statePath = defaultStatePath(workspace),
  preset,
  locale,
  timezone,
  outputPath = join(workspace, 'config', 'local.json'),
} = {}) {
  const state = readInstallState(statePath);
  if (!state) throw new Error(`install state not found: ${statePath}; run --inspect first`);
  if (state.phase !== 'awaiting-preset-choice') {
    throw new Error(`apply-preset requires phase awaiting-preset-choice, current phase is ${state.phase}`);
  }
  if (!state.isolation || !['hard', 'soft'].includes(state.isolation.requested)) {
    throw new Error('apply-preset requires an explicit hard|soft isolation choice; rerun --inspect and --choose-isolation');
  }
  if (state.isolation.requested === 'soft' && (!state.recommendation?.options?.soft?.available || !isGitWorkspace(state.workspace))) {
    throw new Error('soft isolation is not available for this workspace; initialize git or choose a valid workspace');
  }
  if (state.isolation.requested === 'hard' && !['podman', 'docker'].includes(state.isolation.runtime)) {
    throw new Error('hard isolation state is missing a runtime; rerun --choose-isolation hard --runtime podman|docker');
  }
  if (state.isolation.requested === 'hard' && (!state.isolation.homeSeed || !state.isolation.workerModel)) {
    throw new Error('hard isolation requires worker login/model; set AGENT_TEAMS_WORKER_HOME_SEED and AGENT_TEAMS_WORKER_MODEL before --choose-isolation');
  }
  if (!['conservative', 'balanced'].includes(preset)) throw new Error('preset must be conservative|balanced');
  const plan = buildInstallPlan({
    host: state.host,
    teamMode: state.teamMode ?? 'dual',
    preset,
    isolation: state.isolation?.requested ?? 'soft',
    recommended: state.recommendation,
    workspace: state.workspace,
    runtime: state.isolation?.runtime ?? (state.host?.container?.docker ? 'docker' : 'podman'),
    ...(state.isolation?.homeSeed ? { homeSeed: state.isolation.homeSeed } : {}),
    ...(state.isolation?.workerModel ? { workerModel: state.isolation.workerModel } : {}),
    ...(state.isolation?.workerMode ? { workerMode: state.isolation.workerMode } : {}),
    ...(state.isolation?.hostAddress ? { hostAddress: state.isolation.hostAddress } : {}),
    ...(state.isolation?.bindHost ? { bindHost: state.isolation.bindHost } : {}),
    ...(process.env.AGENT_TEAMS_CONTAINER_IMAGE ? { image: process.env.AGENT_TEAMS_CONTAINER_IMAGE } : {}),
    ...(process.env.AGENT_TEAMS_CONTAINER_CLI ? { cliPath: process.env.AGENT_TEAMS_CONTAINER_CLI } : {}),
    ...(process.env.AGENT_TEAMS_CONTAINER_URL ? { containerUrl: process.env.AGENT_TEAMS_CONTAINER_URL } : {}),
    ...(process.env.AGENT_TEAMS_CONTAINER_HOST ? { hostAddress: process.env.AGENT_TEAMS_CONTAINER_HOST } : {}),
    ...(process.env.AGENT_TEAMS_WORKER_HOME_SEED ? { homeSeed: process.env.AGENT_TEAMS_WORKER_HOME_SEED } : {}),
    ...(process.env.AGENT_TEAMS_WORKER_MODEL ? { workerModel: parseWorkerModel(process.env.AGENT_TEAMS_WORKER_MODEL) } : {}),
    ...(process.env.AGENT_TEAMS_WORKER_MODE ? { workerMode: process.env.AGENT_TEAMS_WORKER_MODE } : {}),
    ...(locale ? { locale } : {}),
    ...(timezone ? { timezone } : {}),
  });
  const written = writeInstallConfig(plan, outputPath);
  const nextState = {
    ...state,
    phase: 'complete',
    preset,
    configPath: resolve(written),
    completedAt: new Date().toISOString(),
    plan: {
      teams: plan.teams,
      activeWorkerSlots: plan.values.activeWorkerSlots,
      maxActivePerTeam: plan.values.maxActivePerTeam,
      maxTotalSessions: plan.values.maxTotalSessions,
      isolation: plan.isolation,
    },
  };
  writeInstallState(statePath, nextState);
  let panel = { url: 'http://127.0.0.1:8779/ui#tasks', running: false };
  try {
    panel = panelInfo({ workspace });
  } catch {
    // panel information is advisory; never fail a completed install for it
  }
  return {
    ok: true,
    phase: 'complete',
    message: `安装流程完成：环境检查、隔离选择、重启自检、方案选择均已通过。打开面板: node src/cli.mjs panel --open${panel.discovered ? `（当前: ${panel.url}）` : ''}。`,
    preset,
    configPath: resolve(written),
    plan: nextState.plan,
    panel: {
      url: panel.url,
      running: panel.running,
      command: 'node src/cli.mjs panel --open',
    },
  };
}

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function parseWorkerModel(value) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error('AGENT_TEAMS_WORKER_MODEL must be valid JSON: {"providerId":"...","modelId":"..."}');
  }
}

function positionalAfter(name) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith('--') ? value : undefined;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const workspace = resolve(arg('--workspace', process.cwd()));
  const statePath = arg('--state', defaultStatePath(workspace));
  const json = (value) => console.log(JSON.stringify(value, null, 2));
  try {
    if (args.includes('--inspect')) {
      json(await inspectInstall({ workspace, statePath, githubUrl: arg('--github', null) }));
    } else if (args.includes('--choose-isolation')) {
      json(await chooseIsolation({
        workspace,
        statePath,
        isolation: arg('--isolation', positionalAfter('--choose-isolation') ?? ''),
        runtime: arg('--runtime', undefined),
        githubUrl: arg('--github', undefined),
        teamMode: arg('--team-mode', 'dual'),
      }));
    } else if (args.includes('--install-hard')) {
      const runtime = arg('--runtime', undefined);
      if (!runtime) {
        json({
          ok: false,
          code: 'RUNTIME_CHOICE_REQUIRED',
          reason: '硬隔离前置安装需要先选择容器运行时：Podman 或 Docker。',
          options: SELECTABLE_RUNTIMES.map((option) => ({ value: option.id, label: option.name, recommended: option.recommended })),
        });
      } else {
        json(installHardIsolationPrerequisites({
          runtime,
          execute: args.includes('--execute'),
        }));
      }
    } else if (args.includes('--verify')) {
      json(await verifyInstall({ workspace, statePath, restartConfirmed: args.includes('--restart-confirmed') }));
    } else if (args.includes('--presets')) {
      json(presetOptions({ workspace, statePath }));
    } else if (args.includes('--apply')) {
      json(applyPreset({
        workspace,
        statePath,
        preset: arg('--preset', ''),
        locale: arg('--locale', undefined),
        timezone: arg('--timezone', undefined),
        outputPath: arg('--write', join(workspace, 'config', 'local.json')),
      }));
    } else {
      json(await inspectInstall({ workspace, statePath, githubUrl: arg('--github', null) }));
    }
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
    process.exit(1);
  }
}
