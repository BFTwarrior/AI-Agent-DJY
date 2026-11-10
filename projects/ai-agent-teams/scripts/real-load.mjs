#!/usr/bin/env node
/**
 * Real-model load test through the app-server Protocol adapter.
 *
 * Creates a two-team workspace, dispatches N work tasks, and waits for the
 * members themselves to claim/complete them through the member MCP server.
 * This is intentionally separate from scripts/load-test.mjs, which uses the
 * fake adapter and only measures scheduling.
 *
 * Example:
 *   node scripts/real-load.mjs --workers 32 --model provider-a/model-x \
 *     --reasoning max --rpm 8 --deadline 1800000
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadConfig, validateConfig } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { TeamService } from '../src/scheduler-service.mjs';
import { ProtocolSessionAdapter, parseModelRef } from '../src/session/protocol.mjs';
import { resolveCli } from '../src/session/cli.mjs';
import { createApp, listenWithFallback } from '../src/http/server.mjs';

const parsed = parseArgs({
  options: {
    workers: { type: 'string', default: '32' },
    teams: { type: 'string', default: '2' },
    model: { type: 'string' },
    reasoning: { type: 'string', default: 'max' },
    rpm: { type: 'string', default: '8' },
    timeout: { type: 'string', default: '900000' },
    deadline: { type: 'string', default: '1800000' },
    'capacity-attempts': { type: 'string', default: '3' },
    cwd: { type: 'string' },
    out: { type: 'string' },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (parsed.values.help) {
  console.log(`Usage: node scripts/real-load.mjs --model <providerId>/<modelId> [options]

Options:
  --workers <n>             Total work tasks (default 32)
  --teams <n>               Teams, 2 supported by the current presets (default 2)
  --model <id>              Required providerId/modelId
  --reasoning <level>       Default max
  --rpm <n>                 Dispatch starts per minute (default 8; 0 disables)
  --timeout <ms>            Per-turn timeout (default 900000)
  --deadline <ms>           Whole run deadline (default 1800000)
  --capacity-attempts <n>   Capacity retry budget (default 3)
  --cwd <path>              Workspace; defaults to .tmp/<date>-real-load-<workers>-<timestamp>
  --out <path>              Write the JSON result to this file
  --json                    Print the full JSON result
`);
  process.exit(0);
}

const model = parsed.values.model;
if (!model) {
  console.error('ERROR: --model (or ZCODE_MODEL) is required');
  process.exit(2);
}
try {
  parseModelRef(model, parsed.values.reasoning);
} catch (error) {
  console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
const workers = Number(parsed.values.workers);
const teams = Number(parsed.values.teams);
const rpm = Number(parsed.values.rpm);
const timeoutMs = Number(parsed.values.timeout);
const deadlineMs = Number(parsed.values.deadline);
const capacityAttempts = Number(parsed.values['capacity-attempts']);
for (const [name, value] of Object.entries({ workers, teams, rpm, timeoutMs, deadlineMs, capacityAttempts })) {
  if (!Number.isFinite(value) || value < 0) {
    console.error(`ERROR: --${name} must be a non-negative number`);
    process.exit(2);
  }
}
if (teams !== 2) {
  console.error('ERROR: the current v0.6 presets define exactly two teams');
  process.exit(2);
}
if (workers % teams !== 0) {
  console.error('ERROR: --workers must divide evenly across --teams');
  process.exit(2);
}

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const workspace = parsed.values.cwd
  ? resolve(parsed.values.cwd)
  : join(projectRoot, '.tmp', `${stamp.slice(0, 10)}-real-load-${workers}-${stamp}`);
mkdirSync(workspace, { recursive: true });

const { config, warnings } = loadConfig(join(projectRoot, 'config', 'example.v06.json'));
config.isolation.mode = 'none';
config.scheduler.activeWorkerSlots = workers;
config.scheduler.maxActivePerTeam = Math.ceil(workers / teams);
config.scheduler.maxTotalSessions = workers + 8;
config.scheduler.allowAboveDesignCap = workers > 32;
config.zcode.protocol = 'app-server';
config.zcode.defaultModel = model;
config.zcode.defaultReasoning = parsed.values.reasoning;
config.zcode.mode = 'yolo';
config.zcode.maxConcurrentSessions = workers;
config.zcode.maxRequestsPerMinute = rpm;
config.zcode.turnFailureRetry.capacityMaxAttempts = capacityAttempts;
config.scheduler.taskTimeoutMinutes = Math.max(1, Math.ceil(timeoutMs / 60000));
config.features.contractors = false;
config.features.patrol = false;
config.features.compression = false;
const validation = validateConfig(config);
if (!validation.ok) {
  console.error(`ERROR: invalid generated config: ${validation.errors.join('; ')}`);
  process.exit(2);
}
for (const warning of [...warnings, ...validation.warnings]) console.error(`WARN: ${warning}`);

const perTeam = workers / teams;
const store = new Store(':memory:');
const adapter = new ProtocolSessionAdapter({ cliPath: resolveCli(), cwd: workspace, mode: 'yolo' });
const service = new TeamService({
  store,
  adapter,
  config,
  cwd: workspace,
  roster: { alpha: [], beta: [] },
  useWorktrees: false,
  repo: workspace,
  capacityStatePath: join(workspace, '.ai-agent-teams', 'runtime-capacity.json'),
});

const started = Date.now();
let ticks = 0;
let stopped = '';
let app;
let sessionUsage = [];
let interrupted = false;
const onSigint = () => {
  interrupted = true;
  console.error('SIGINT received; stopping after the current tick');
};
process.once('SIGINT', onSigint);
const previousTeamUrl = process.env.AGENT_TEAMS_URL;
try {
  const token = randomBytes(32).toString('hex');
  app = createApp({ store, service, token, version: 'real-load' });
  const port = await listenWithFallback(app, 0);
  process.env.AGENT_TEAMS_URL = `http://127.0.0.1:${port}`;

  for (const teamId of ['alpha', 'beta']) {
    service.createTeam({ id: teamId, name: teamId, phase: 'running' });
    for (let index = 1; index <= perTeam; index += 1) {
      service.addTask(teamId, {
        id: `${teamId}-${index}`,
        subject: `${teamId} task ${index}`,
        kind: 'work',
        assigneeRole: 'engineer',
        objective: 'Claim this task with the team CLI/MCP tools, do no file edits, then complete it with status completed and output OK.',
        acceptance: ['The task is completed with output OK'],
        inScope: ['src/'],
      });
    }
  }

  let lastLog = 0;
  while (true) {
    if (interrupted) {
      stopped = 'interrupted';
      break;
    }
    if (Date.now() - started >= deadlineMs) {
      stopped = 'deadline';
      break;
    }
    await service.tickAll();
    ticks += 1;
    const tasks = ['alpha', 'beta'].flatMap((teamId) => store.listTasks(teamId));
    const terminal = tasks.filter((task) => ['completed', 'failed', 'cancelled'].includes(task.status));
    if (terminal.length === tasks.length) break;
    if (Date.now() - lastLog >= 30000) {
      lastLog = Date.now();
      const counts = tasks.reduce((acc, task) => {
        acc[task.status] = (acc[task.status] ?? 0) + 1;
        return acc;
      }, {});
      console.error(`[${Math.round((Date.now() - started) / 1000)}s] ${JSON.stringify(counts)} slots=${config.scheduler.activeWorkerSlots}`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
  }

  for (const teamId of ['alpha', 'beta']) {
    for (const member of store.listMembers(teamId)) {
      if (!member.sessionId) continue;
      try {
        const messages = await adapter.messages(member.sessionId);
        const final = messages.findLast((item) => item?.info?.role === 'assistant'
          && ['stop', 'length', 'content-filter'].includes(item?.info?.finish));
        const tokens = final?.info?.tokens ?? {};
        const inputTokens = Number(tokens.input ?? 0);
        const outputTokens = Number(tokens.output ?? 0);
        sessionUsage.push({
          teamId,
          memberId: member.id,
          inputTokens,
          outputTokens,
          totalTokens: Number(tokens.total ?? (inputTokens + outputTokens)),
        });
      } catch {
        // A closed or failed session cannot report usage; keep the lower bound.
      }
    }
  }
} finally {
  process.off('SIGINT', onSigint);
  service.close();
  await adapter.shutdown();
  await app?.close();
  if (previousTeamUrl === undefined) delete process.env.AGENT_TEAMS_URL;
  else process.env.AGENT_TEAMS_URL = previousTeamUrl;
}

const taskRows = ['alpha', 'beta'].flatMap((teamId) => store.listTasks(teamId));
const attempts = ['alpha', 'beta'].flatMap((teamId) => store.listAttempts(teamId));
const usage = sessionUsage.length > 0
  ? sessionUsage
  : ['alpha', 'beta'].flatMap((teamId) => store.listUsage(teamId));
const events = ['alpha', 'beta'].flatMap((teamId) => store.listEvents(teamId));
const eventCounts = events.reduce((acc, event) => {
  acc[event.type] = (acc[event.type] ?? 0) + 1;
  return acc;
}, {});
const statusCounts = taskRows.reduce((acc, task) => {
  acc[task.status] = (acc[task.status] ?? 0) + 1;
  return acc;
}, {});
const audits = Object.fromEntries(['alpha', 'beta'].map((teamId) => [teamId, service.audit(teamId)]));
const errors = taskRows
  .filter((task) => task.status !== 'completed')
  .map((task) => ({ taskId: task.id, status: task.status, error: task.lastTurnError ?? task.error ?? null }));
const providerErrors = events
  .filter((event) => event.type === 'task.turn_failed' || event.type === 'task.dispatch_failed')
  .slice(-10)
  .map((event) => ({ type: event.type, taskId: event.taskId, error: event.error, code: event.errorCode, retryAfterMs: event.retryAfterMs, capacity: event.capacity }));

const result = {
  model,
  reasoning: parsed.values.reasoning,
  rpm,
  workers,
  teams,
  perTeam,
  capacityAttempts,
  workspace,
  elapsedMs: Date.now() - started,
  ticks,
  stopped: stopped || 'complete',
  statusCounts,
  completed: statusCounts.completed ?? 0,
  failed: statusCounts.failed ?? 0,
  unfinished: taskRows.length - (statusCounts.completed ?? 0) - (statusCounts.failed ?? 0) - (statusCounts.cancelled ?? 0),
  completionRate: taskRows.length > 0 ? (statusCounts.completed ?? 0) / taskRows.length : 0,
  attempts: attempts.length,
  failedAttempts: attempts.filter((attempt) => attempt.status === 'failed').length,
  tokens: usage.reduce((sum, item) => sum + (Number(item.totalTokens) || 0), 0),
  usageSessions: usage.length,
  activeWorkerSlots: config.scheduler.activeWorkerSlots,
  maxActivePerTeam: config.scheduler.maxActivePerTeam,
  eventCounts,
  audits,
  errors,
  providerErrors,
};
store.close();

const text = JSON.stringify(result, null, 2);
if (parsed.values.out) {
  const target = resolve(parsed.values.out);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${text}\n`, 'utf8');
}
if (parsed.values.json) console.log(text);
else console.log(JSON.stringify({
  model, workers, rpm, elapsedMs: result.elapsedMs, completed: result.completed,
  failed: result.failed, unfinished: result.unfinished, completionRate: result.completionRate,
  tokens: result.tokens, slots: result.activeWorkerSlots, audits: result.audits,
  eventCounts: result.eventCounts, output: parsed.values.out ?? null,
}, null, 2));
