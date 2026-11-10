import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { Store } from './store.mjs';
import { createWorktreeFenceProvider } from './git/worktree-fence.mjs';
import { migratePhase0Epochs } from './service/phase0-epochs.mjs';
import { migrateLegacyRepairs, normalizeTaskModes, quarantineLegacy } from './service/phase0-normalize.mjs';
import { TeamService } from './scheduler-service.mjs';
import { FakeSessionAdapter } from './session/adapter.mjs';
import { CliSessionAdapter } from './session/cli.mjs';
import { ProtocolSessionAdapter } from './session/protocol.mjs';
import { ContainerCliSessionAdapter } from './session/container-cli.mjs';
import { selectedProviderBaseUrl } from './session/provider-config.mjs';
import { detectContainerHostAddress } from './runtime/container.mjs';
import { prepareContainerWorker } from './runtime/container-startup.mjs';
import { formatHostPort, isLoopbackHost, selectBridgeTarget, startLoopbackBridge, stripHostBrackets } from './runtime/loopback-bridge.mjs';
import { createApp, generateToken, listenWithFallback, writeDiscovery } from './http/server.mjs';
import { reclaimDiscoveryDirectories, removeDiscovery } from './discovery.mjs';
import { panelUrl } from './panel.mjs';
import { HostModelReader, ModelWatcher } from './host-model.mjs';
import { createNativeAgentModelReader } from './native-agent-model.mjs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const fake = process.argv.includes('--fake');
const noLoop = process.argv.includes('--no-loop');
const port = Number(arg('--port', process.env.AGENT_TEAMS_PORT || 8779));
const cwd = resolve(arg('--cwd', process.cwd()));
const workspaceConfig = join(cwd, 'config', 'local.json');
const configPath = arg('--config', process.env.AGENT_TEAMS_CONFIG
  ?? (existsSync(workspaceConfig) ? workspaceConfig : join(PACKAGE_ROOT, 'config', 'example.v06.json')));
const token = arg('--token', generateToken());
const instanceId = randomBytes(8).toString('hex');

function logWorktreeReclaim(label, report, failed = false) {
  const errors = Array.isArray(report?.errors) ? report.errors.length : (failed ? 1 : 0);
  console.log(`${label}: active=${Number(report?.active) || 0} remaining=${Number(report?.remaining) || 0} pinnedOverCapacity=${Number(report?.pinnedOverCapacity) || 0} errors=${errors}`);
}

const { config, warnings } = loadConfig(configPath);
for (const warning of warnings) console.warn(`WARN ${warning}`);

const dbPath = arg('--db', config.storage.database);
const store = new Store(dbPath === ':memory:' ? ':memory:' : resolve(cwd, dbPath));
// V15 startup order: epoch migration before any transition or attempt write.
// Failing migration aborts startup instead of running on half-migrated state.
migratePhase0Epochs(store);
const prunedEvents = store.pruneEvents(50000);
if (prunedEvents > 0) console.log(`INFO pruned ${prunedEvents} old events from state.db`);
try {
  if (store.compactAfterPrune(prunedEvents)) console.log('INFO compacted state.db');
} catch (error) {
  console.warn(`WARN database compaction failed: ${error.message}`);
}
try {
  const report = reclaimDiscoveryDirectories();
  console.log(`INFO discovery reclaim removed=${report.removed.length} errors=${report.errors.length}`);
} catch (error) {
  console.warn(`WARN discovery reclaim failed: ${error.message}`);
}
const modelDefaults = Boolean(config.zcode.defaultModel || config.zcode.defaultReasoning);
const useProtocol = config.zcode.protocol === 'app-server' || (config.zcode.protocol === 'cli' && modelDefaults);
if (config.zcode.protocol === 'cli' && modelDefaults) {
  console.warn('WARN zcode.protocol=cli cannot select a model; using app-server because defaultModel/defaultReasoning is set');
}
const containerMode = !fake && config.isolation.mode === 'container';
const configuredContainerUrl = process.env.AGENT_TEAMS_CONTAINER_URL ?? config.isolation.containerUrl;
const gitRootResult = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', windowsHide: true });
const repoRoot = gitRootResult.status === 0 ? String(gitRootResult.stdout).trim() : undefined;
const wantsWorktree = ['worktree', 'soft', 'container', 'microvm'].includes(config.isolation.mode);
const strictWorktree = config.isolation.mode === 'worktree' || config.isolation.mode === 'soft';
let containerHost;
let detectedRuntime;
if (containerMode) {
  const preparation = prepareContainerWorker({
    cwd,
    repoRoot,
    runtime: config.isolation.containerRuntime,
    image: config.isolation.image,
    pullPolicy: config.isolation.imagePullPolicy,
    cliPath: config.isolation.cliPath,
    hostAddress: config.isolation.hostAddress,
  });
  if (!preparation.ready) {
    if (preparation.stage === 'image') {
      console.error(`ERROR worker image preparation failed: ${preparation.reason}`);
    } else if (preparation.stage === 'self-test') {
      console.error(`ERROR container self-test failed: ${preparation.reason}. Build the worker image from deploy/worker.Dockerfile with ZCode installed, then retry.`);
    } else {
      console.error(`ERROR ${preparation.reason}`);
    }
    process.exit(1);
  }
  detectedRuntime = preparation.detectedRuntime;
  containerHost = preparation.containerHost;
  if (preparation.pulled) console.log(`INFO pulled worker image ${config.isolation.image}`);
  if (!configuredContainerUrl && !containerHost) {
    console.error('ERROR isolation.mode=container requires a container-reachable host address; set isolation.hostAddress or AGENT_TEAMS_CONTAINER_URL.');
    process.exit(1);
  }
  if (!config.isolation.homeSeed) {
    console.warn('WARN isolation.homeSeed is not configured; container workers will start without the host ZCode login/model.');
  }
  if (!config.isolation.workerModel) {
    console.warn('WARN isolation.workerModel is not configured; headless workers may fail with "Select a model before sending a message".');
  }
  if (config.isolation.workerMode === 'yolo') {
    console.warn('WARN isolation.workerMode=yolo auto-approves tools inside the container; use plan/guarded if the task does not need shell access.');
  }
}
const containerOptions = {
  runtime: config.isolation.containerRuntime,
  runtimeCommand: detectedRuntime?.command,
  image: config.isolation.image,
  cliPath: config.isolation.cliPath,
  packageRoot: PACKAGE_ROOT,
  containerBaseUrl: configuredContainerUrl,
  homeSeed: config.isolation.homeSeed,
  workerModel: config.isolation.workerModel,
  workerMode: config.isolation.workerMode,
  mode: config.zcode.mode,
  network: config.isolation.network,
  cpus: config.isolation.cpuLimit,
  memoryMb: config.isolation.memoryMb,
  pidsLimit: config.isolation.pidsLimit,
  readOnlyRoot: config.isolation.readOnlyRoot,
  nonRoot: config.isolation.nonRoot,
};
let providerBridge;
if (containerMode && config.isolation.network === 'gateway-only') {
  const providerBase = selectedProviderBaseUrl(
    config.isolation.homeSeed,
    config.isolation.workerModel?.providerId,
  );
  let providerUrl;
  try {
    providerUrl = providerBase ? new URL(providerBase) : undefined;
  } catch {
    providerUrl = undefined;
  }
  if (providerUrl && providerUrl.protocol === 'http:' && isLoopbackHost(providerUrl.hostname)) {
    const selection = selectBridgeTarget({
      explicitHost: config.isolation.hostAddress,
      strictDetected: detectContainerHostAddress({ strict: true }),
      containerUrl: configuredContainerUrl,
    });
    if (!selection.start) {
      console.warn(`WARN local model provider bridge skipped: ${selection.reason}.`);
    } else {
      const listenHost = selection.listenHost;
      try {
        providerBridge = await startLoopbackBridge({
          listenHost,
          targetHost: stripHostBrackets(providerUrl.hostname),
          targetPort: Number(providerUrl.port || 80),
        });
        const bridged = new URL(providerUrl.toString());
        bridged.host = formatHostPort(listenHost, providerBridge.port);
        if (stripHostBrackets(bridged.hostname).toLowerCase() !== listenHost.toLowerCase()) {
          throw new Error(`bridge URL did not resolve to ${listenHost}`);
        }
        containerOptions.providerBaseUrl = bridged.toString().replace(/\/$/, '');
        console.log(`provider bridge ${providerUrl.host} -> ${formatHostPort(listenHost, providerBridge.port)}`);
      } catch (error) {
        await providerBridge?.close?.().catch(() => {});
        providerBridge = undefined;
        console.warn(`WARN cannot start provider bridge for ${providerUrl.host}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}
const cliPath = config.zcode.cliPath === 'auto' ? undefined : config.zcode.cliPath;
const cliOptions = { cliPath, mode: config.zcode.mode, token };
function createWorkerAdapter() {
  if (fake) return new FakeSessionAdapter();
  if (containerMode) return new ContainerCliSessionAdapter(containerOptions);
  if (useProtocol) return new ProtocolSessionAdapter({ cliPath, cwd, mode: config.zcode.mode, baseUrl: `http://127.0.0.1:${port}` });
  return new CliSessionAdapter(cliOptions);
}
function createContractorAdapter() {
  if (fake || !config.features?.contractors) return undefined;
  if (containerMode) return new ContainerCliSessionAdapter(containerOptions);
  if (useProtocol) return undefined;
  return new CliSessionAdapter(cliOptions);
}
const adapter = createWorkerAdapter();
let roster = {};
try {
  const rosterPath = join(dirname(resolve(configPath)), 'roster.two-teams.json');
  if (existsSync(rosterPath)) {
    roster = JSON.parse(readFileSync(rosterPath, 'utf8')).teams ?? {};
  }
} catch {
  roster = {};
}
if (strictWorktree && !repoRoot) {
  console.error(`ERROR isolation.mode=${config.isolation.mode} requires a git workspace, but ${cwd} is not inside a git worktree. Initialize git or set isolation.mode=none explicitly.`);
  process.exit(1);
}
const useWorktrees = wantsWorktree && Boolean(repoRoot);
try {
  migrateLegacyRepairs(store, { useWorktrees });
  normalizeTaskModes(store, { useWorktrees });
  quarantineLegacy(store);
} catch (error) {
  console.error(`ERROR V15 mode migration failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
if (config.isolation.mode === 'microvm') {
  console.warn(`WARN isolation.mode=microvm is not wired; using ${useWorktrees ? 'worktree' : 'none'} isolation`);
}
const contractorAdapter = createContractorAdapter();
// The daemon process does not inherit ZCODE_SESSION_ID (only hook subprocesses
// get it), so the SessionStart hook persists the host session id next to the
// workspace. `read()` re-resolves it every tick: state file first, env fallback.
const hostModelReader = new HostModelReader({
  sessionId: process.env.ZCODE_SESSION_ID,
  workspace: cwd,
  defaultModel: config.zcode.defaultModel,
  defaultReasoning: config.zcode.defaultReasoning,
});
const nativeAgentModelReader = createNativeAgentModelReader({ pluginRoot: PACKAGE_ROOT });
const service = new TeamService({
  store,
  adapter,
  contractorAdapter,
  config,
  cwd,
  roster,
  useWorktrees,
  artifactFenceProvider: useWorktrees ? createWorktreeFenceProvider() : undefined,
  repo: repoRoot ?? cwd,
  capacityStatePath: join(cwd, '.ai-agent-teams', 'runtime-capacity.json'),
  hostModel: () => hostModelReader.read(),
  nativeAgentModel: fake ? undefined : () => nativeAgentModelReader.read(),
});
function reclaimHomes() {
  try {
    const report = service.reclaimMemberHomes();
    console.log(`INFO member home reclaim removed=${report.removed.length} errors=${report.errors.length}`);
  } catch (error) {
    console.warn(`WARN member home reclaim failed: ${error.message}`);
  }
}
if (config.scheduler.memberHomeReclaimMinutes != null) reclaimHomes();
const recovered = await service.reconcileAfterRestart();
if (recovered.tasks.length > 0 || recovered.members.length > 0) {
  console.log(`recovered ${recovered.tasks.length} task(s), ${recovered.members.length} member session(s) after restart`);
}
const closeout = await service.closeoutCompletedWork();
if (closeout.closed.length > 0) console.log(`closed out ${closeout.closed.length} completed work task(s)`);
// Reclaim terminal task worktrees on startup: an unclean shutdown can leave
// merged/cancelled checkouts behind, and nothing else sweeps them.
try {
  const reclaimed = await service.reclaimWorktrees({ allowOrphanSweep: true });
  logWorktreeReclaim('worktree reclaim startup', reclaimed);
} catch {
  logWorktreeReclaim('worktree reclaim startup failed', null, true);
}
await service.reconcileContractors();
const bindHost = (containerMode ? (config.isolation.bindHost || '0.0.0.0') : '127.0.0.1').trim();
const loopbackBind = bindHost === '127.0.0.1' || bindHost === '::1' || bindHost === 'localhost';
const uiAccessKey = randomBytes(24).toString('hex');
const app = createApp({
  store,
  service,
  token,
  version: pkg.version,
  workspace: cwd,
  instanceId,
  uiAccessKey,
  restrictUiToLoopback: !loopbackBind,
});
if (containerMode && !loopbackBind) {
  console.warn(`WARN container isolation binds the HTTP server on ${bindHost} for container callback; bearer token auth is required and /ui is loopback-only.`);
}
const actualPort = await listenWithFallback(app, port, bindHost);
adapter.baseUrl = `http://127.0.0.1:${actualPort}`;
if (contractorAdapter) contractorAdapter.baseUrl = `http://127.0.0.1:${actualPort}`;
if (containerMode) {
  const hostPart = containerHost?.includes(':') ? `[${containerHost}]` : containerHost;
  let reachable = configuredContainerUrl ?? (hostPart ? `http://${hostPart}:${actualPort}` : undefined);
  if (configuredContainerUrl) {
    try {
      const url = new URL(configuredContainerUrl);
      if (['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
        if (!hostPart) {
          console.error('ERROR isolation.containerUrl points to loopback and no container-reachable hostAddress is available.');
          process.exit(1);
        }
        url.host = `${hostPart}:${actualPort}`;
        console.warn(`WARN loopback containerUrl was rewritten to ${url.toString()}`);
      } else if (url.port !== String(actualPort)) {
        url.port = String(actualPort);
        console.warn(`WARN configured containerUrl port was rewritten from ${configuredContainerUrl} to ${url.toString()}`);
      }
      reachable = url.toString().replace(/\/$/, '');
    } catch {
      // config validation normally rejects this; keep the explicit value as a last resort
    }
  }
  if (!reachable) {
    console.error('ERROR isolation.mode=container requires a container-reachable URL; set isolation.containerUrl or isolation.hostAddress.');
    process.exit(1);
  }
  adapter.containerBaseUrl = reachable;
  if (contractorAdapter) contractorAdapter.containerBaseUrl = reachable;
  console.log(`container callback ${reachable}`);
}
const discoveryPath = writeDiscovery({
  port: actualPort,
  token,
  version: pkg.version,
  workspace: cwd,
  instanceId,
  uiKey: uiAccessKey,
}, { path: process.env.AGENT_TEAMS_DISCOVERY });

console.log(`ai-agent-teams ${pkg.version}`);
console.log(`listening on ${bindHost}:${actualPort}`);
console.log(`discovery ${discoveryPath}`);
console.log(`panel ${panelUrl(actualPort, uiAccessKey)}`);
console.log('panel hint: node src/cli.mjs panel --open (or call agent_teams_view in ZCode)');
console.log(`adapter ${fake ? 'fake' : containerMode ? 'zcode-container' : useProtocol ? 'zcode-protocol' : 'zcode-cli'}`);

let timer;
let lifecycleTimer;
let patrolTimer;
let shadowTimer;
let reclaimTimer;
let homeReclaimTimer;
let modelWatcher;
if (!noLoop) {
  timer = setInterval(() => {
    service.tickAll().catch((error) => {
      console.error('tick failed:', error instanceof Error ? error.message : String(error));
    });
  }, 1000);
  timer.unref?.();
  modelWatcher = new ModelWatcher({ service, intervalMs: 3000 }).start();
  if (config.features?.compression) {
    lifecycleTimer = setInterval(() => {
      service.lifecycleTickAll().catch((error) => {
        console.error('lifecycle tick failed:', error instanceof Error ? error.message : String(error));
      });
    }, 60000);
    lifecycleTimer.unref?.();
  }
  if (config.features?.patrol || config.patrol?.enabled) {
    // The service keeps the per-team window and skips idle teams, so a
    // one-minute clock is cheap and keeps report timing close to 15 minutes.
    patrolTimer = setInterval(() => {
      service.patrolTickAll().catch((error) => {
        console.error('patrol tick failed:', error instanceof Error ? error.message : String(error));
      });
    }, 60000);
    patrolTimer.unref?.();
  }
  if (config.shadow?.enabled !== false) {
    // Starting the shadow stays manual. This clock only closes an idle shadow
    // after shadow.idleStopMinutes when no unfinished work remains.
    shadowTimer = setInterval(() => {
      service.shadowAutoStopTick().catch((error) => {
        console.error('shadow auto-stop tick failed:', error instanceof Error ? error.message : String(error));
      });
    }, 60000);
    shadowTimer.unref?.();
  }
  // Worktree reclaim also runs at startup and after cancel/merge, but a long
  // session can finish dozens of tasks without either event. A slow clock keeps
  // the footprint bounded without scanning the filesystem every second.
  const homeReclaimMinutes = config.scheduler.memberHomeReclaimMinutes;
  if (homeReclaimMinutes > 0) {
    homeReclaimTimer = setInterval(reclaimHomes, homeReclaimMinutes * 60000);
    homeReclaimTimer.unref?.();
  }
  const reclaimMinutes = Number(config.scheduler?.worktreeReclaimMinutes ?? 30);
  if (Number.isFinite(reclaimMinutes) && reclaimMinutes > 0) {
    reclaimTimer = setInterval(() => {
      service.reclaimWorktrees({ allowOrphanSweep: true }).then((report) => {
        logWorktreeReclaim('worktree reclaim timer', report);
      }).catch(() => {
        logWorktreeReclaim('worktree reclaim timer failed', null, true);
      });
    }, reclaimMinutes * 60000);
    reclaimTimer.unref?.();
  }
}

async function shutdown() {
  if (timer) clearInterval(timer);
  if (lifecycleTimer) clearInterval(lifecycleTimer);
  if (patrolTimer) clearInterval(patrolTimer);
  if (shadowTimer) clearInterval(shadowTimer);
  if (reclaimTimer) clearInterval(reclaimTimer);
  if (homeReclaimTimer) clearInterval(homeReclaimTimer);
  modelWatcher?.stop();
  service.close();
  await adapter.shutdown?.();
  if (contractorAdapter && contractorAdapter !== adapter) await contractorAdapter.shutdown?.();
  await providerBridge?.close?.();
  await app.close();
  try { removeDiscovery({ path: discoveryPath, pid: process.pid, instanceId }); } catch { /* best effort */ }
  store.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
