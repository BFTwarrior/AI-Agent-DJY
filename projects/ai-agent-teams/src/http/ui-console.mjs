import { homedir } from 'node:os';
import { taskDeliveryState, taskVisualState } from '../domain/scheduler.mjs';
import { resolveLocale, resolveTimeZone } from '../i18n.mjs';

const MAX_TEXT = 4000;
const MAX_EVENTS = 60;
const MAX_FINDINGS = 40;
const MAX_MESSAGES = 40;
const MAX_TASKS = 200;
const MAX_CONTRACTORS = 40;

const HOME_DIR = homedir();
const HOME_VARIANTS = [...new Set([
  HOME_DIR,
  HOME_DIR.replaceAll('\\', '/'),
  HOME_DIR.replaceAll('/', '\\'),
])].filter(Boolean);

/**
 * Event payloads and free-text fields can carry absolute paths (member homes,
 * preserved worktrees). The console must never expose the operator's home
 * directory or an absolute checkout path, so redact them before projection.
 */
function redactText(value) {
  // Replace the real home first: it may contain spaces, which the generic
  // drive-path pattern would otherwise cut off, leaving the user name visible.
  let output = value;
  for (const home of HOME_VARIANTS) output = output.split(home).join('<home>');
  return output
    // User-profile folders may contain spaces; consume the whole path so the
    // user name cannot survive as a prefix fragment.
    .replace(/[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/][^\r\n"'`,;)]*/g, '<path>')
    .replace(/[A-Za-z]:[\\/][^\s"'`,;)]+/g, '<path>')
    .replace(/\/(?:Users|home)\/[^\r\n"'`,;)]*/g, '<home>');
}

function text(value, limit = MAX_TEXT) {
  if (value === null || value === undefined) return '';
  const rendered = typeof value === 'string' ? value : JSON.stringify(value);
  const redacted = redactText(rendered);
  return redacted.length > limit ? `${redacted.slice(0, limit)}…` : redacted;
}

function strings(value) {
  return Array.isArray(value) ? value.map((item) => text(item, 300)) : [];
}

function numberOrNull(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const PRIVATE_EVENT_KEYS = new Set(['token', 'uiToken', 'adminToken', 'sessionId', 'licenseId', 'prompt']);
const MAX_EVENT_DEPTH = 3;

function safeEventValue(value, depth = 0, parentKey = '') {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
    return typeof value === 'string' ? text(value, 500) : value;
  }
  // Never stringify a deeper container: JSON.stringify would carry the values of
  // private keys (sessionId/token/...) straight into the event tail.
  if (depth >= MAX_EVENT_DEPTH) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => safeEventValue(item, depth + 1, parentKey));
  if (typeof value === 'object') {
    const output = {};
    const idBearing = /license|session/i.test(parentKey);
    for (const [key, item] of Object.entries(value)) {
      if (PRIVATE_EVENT_KEYS.has(key)) continue;
      if (idBearing && key === 'id') continue;
      output[key] = safeEventValue(item, depth + 1, key);
    }
    return output;
  }
  return null;
}

function sanitizeFinding(finding) {
  if (!finding || typeof finding !== 'object') return null;
  return {
    id: finding.id ?? null,
    severity: finding.severity ?? null,
    problem: text(finding.problem),
    requiredFix: text(finding.requiredFix),
    memberId: finding.memberId ?? null,
    status: finding.status ?? null,
    createdAt: numberOrNull(finding.createdAt),
  };
}

function sanitizeCommand(command) {
  if (!command || typeof command !== 'object') return null;
  return {
    command: text(command.command, 500),
    status: command.status ?? null,
    exitCode: numberOrNull(command.exitCode),
    evidence: text(command.evidence, 1000),
  };
}

function sanitizeTask(task, tasks) {
  const review = task.reviewResult && typeof task.reviewResult === 'object'
    ? task.reviewResult
    : null;
  return {
    id: task.id,
    subject: text(task.subject, 500),
    status: task.status ?? null,
    kind: task.kind ?? 'work',
    deliveryState: taskDeliveryState(task, tasks),
    visual: taskVisualState(task, tasks),
    priority: task.priority ?? null,
    round: numberOrNull(task.round),
    dependencies: strings(task.dependencies),
    assignee: task.assignee ?? null,
    assigneeRole: task.assigneeRole ?? null,
    objective: text(task.objective),
    acceptance: strings(task.acceptance),
    inScope: strings(task.inScope),
    outOfScope: strings(task.outOfScope),
    verify: strings(task.verify),
    output: text(task.output),
    lastError: text(task.lastError, 1000),
    mergeState: task.mergeState ?? null,
    mergeCommit: task.mergeCommit ?? null,
    mergedCommit: task.mergedCommit ?? null,
    integrationCommit: task.integrationCommit ?? null,
    integrationBranch: task.integrationBranch ?? null,
    review: review
      ? {
        verdict: review.verdict ?? task.reviewVerdict ?? null,
        overall: numberOrNull(review.overall),
        code: numberOrNull(review.code),
        evidence: text(review.evidence, 1000),
      }
      : (task.reviewVerdict ? { verdict: task.reviewVerdict } : null),
    findings: (Array.isArray(task.findings) ? task.findings : review?.findings ?? [])
      .map(sanitizeFinding).filter(Boolean),
    commandsRun: (Array.isArray(task.commandsRun) ? task.commandsRun : review?.commandsRun ?? [])
      .map(sanitizeCommand).filter(Boolean),
    hold: task.hold
      ? { reason: text(task.hold.reason, 500), since: numberOrNull(task.hold.since) }
      : null,
    attemptCount: numberOrNull(task.attempts ?? task.attemptCount),
    hasActiveAttempt: Boolean(task.attemptId),
    worktree: task.worktree ? text(task.worktree, 500) : null,
    hidden: task.hidden === true,
    createdAt: numberOrNull(task.createdAt),
    updatedAt: numberOrNull(task.updatedAt),
  };
}

function sanitizeEvent(event) {
  const { id, type, createdAt, teamId, ...payload } = event;
  return {
    id: numberOrNull(id),
    type,
    createdAt: numberOrNull(createdAt),
    teamId: teamId ?? null,
    data: safeEventValue(payload),
  };
}

function sanitizeContractor(contractor) {
  return {
    id: contractor.id ?? null,
    slot: contractor.slot ?? null,
    purpose: contractor.purpose ?? null,
    status: contractor.status ?? null,
    createdAt: numberOrNull(contractor.createdAt),
    updatedAt: numberOrNull(contractor.updatedAt),
    errorCode: contractor.errorCode ?? null,
    lastError: contractor.lastError ? text(contractor.lastError, 500) : null,
    result: contractor.result === undefined ? null : text(contractor.result, 1000),
  };
}

function sanitizeMessage(message) {
  return {
    id: message.id ?? null,
    from: message.from ?? null,
    to: message.to ?? null,
    fromTeamId: message.fromTeamId ?? message.teamId ?? null,
    toTeamId: message.toTeamId ?? message.teamId ?? null,
    taskId: message.taskId ?? null,
    urgent: message.urgent === true,
    approvalState: message.approvalState ?? null,
    content: text(message.content, 1000),
    createdAt: numberOrNull(message.createdAt),
  };
}

function sanitizeRedReviews(summary) {
  if (!summary || typeof summary !== 'object') return null;
  const byOutcome = {};
  for (const [key, value] of Object.entries(summary.byOutcome ?? {})) {
    const count = numberOrNull(value);
    if (count !== null) byOutcome[text(key, 40)] = count;
  }
  return {
    enabled: summary.enabled === true,
    maxContinues: numberOrNull(summary.maxContinues),
    total: numberOrNull(summary.total),
    running: numberOrNull(summary.running),
    escalated: numberOrNull(summary.escalated),
    byOutcome,
    createFailures: numberOrNull(summary.createFailures),
    lastCreateError: summary.lastCreateError ? text(summary.lastCreateError, 500) : null,
    last: summary.last
      ? {
        reviewTaskId: summary.last.reviewTaskId ?? null,
        taskId: summary.last.taskId ?? null,
        outcome: summary.last.outcome ?? null,
        at: numberOrNull(summary.last.at),
      }
      : null,
  };
}

function sanitizeMember(store, service, teamId, member, tasks, currentTask) {
  const assigned = tasks.filter((task) => task.assignee === member.name);
  const doneCount = assigned.filter((task) => ['completed', 'done', 'merged'].includes(task.status)).length;
  const license = member.license
    ?? store.listLicenses(teamId, member.id).find((item) => item.status === 'active');
  let settlement = null;
  try {
    const status = service.settlementStatus(teamId, member.id);
    settlement = {
      settled: status.settled === true,
      blockerCount: Array.isArray(status.blockers) ? status.blockers.length : 0,
      blockers: Array.isArray(status.blockers) ? status.blockers.slice(0, 5).map((item) => text(item, 300)) : [],
    };
  } catch {
    // A removed or partially restored member may not have a settlement record.
    settlement = null;
  }
  const sessionState = member.sessionRecoveryState
    ?? member.workerSessionStart?.state
    ?? (member.sessionId ? 'active' : 'none');
  return {
    id: member.id,
    name: member.name,
    label: member.label ?? license?.label ?? member.name,
    role: member.role ?? member.roleKey ?? license?.roleKey ?? 'member',
    status: member.status ?? 'unspawned',
    residency: member.residency ?? member.status ?? 'unspawned',
    workState: member.workState ?? null,
    toolPolicy: member.toolPolicy ?? null,
    currentTask: currentTask ?? null,
    taskCount: assigned.length,
    doneCount,
    hasSession: Boolean(member.sessionId),
    sessionState,
    mode: member.mode ?? null,
    model: member.model ?? null,
    reasoning: member.reasoning ?? null,
    license: license
      ? { label: license.label ?? null, roleKey: license.roleKey ?? null, status: license.status ?? null }
      : null,
    settlement,
  };
}

function sanitizeModel(modelStatus) {
  if (!modelStatus) return null;
  return {
    policy: modelStatus.policy
      ? {
        mode: modelStatus.policy.mode ?? null,
        model: modelStatus.policy.model ?? null,
        reasoning: modelStatus.policy.reasoning ?? null,
      }
      : null,
    host: modelStatus.host
      ? {
        model: modelStatus.host.model ?? null,
        reasoning: modelStatus.host.reasoning ?? null,
        source: modelStatus.host.source ?? null,
        sessionSource: modelStatus.host.sessionSource ?? null,
      }
      : null,
    defaults: modelStatus.defaults
      ? {
        model: modelStatus.defaults.model ?? null,
        reasoning: modelStatus.defaults.reasoning ?? null,
      }
      : null,
  };
}

function sanitizeShadow(shadow) {
  if (!shadow) return null;
  return {
    exists: shadow.exists === true,
    status: shadow.status ?? null,
    active: shadow.active === true,
    memberId: shadow.memberId ?? null,
    teamId: shadow.teamId ?? null,
    name: shadow.name ?? null,
    startedAt: numberOrNull(shadow.startedAt),
    stoppedAt: numberOrNull(shadow.stoppedAt),
    lastActiveAt: numberOrNull(shadow.lastActiveAt),
    lastError: shadow.lastError ? text(shadow.lastError, 500) : null,
  };
}

function projectTeam({ store, service, config, scheduler, team, pendingMessages }) {
  const allTasks = store.listTasks(team.id);
  // Keep the newest window for display, but resolve dependencies and member
  // counters against the full task set: hidden red-review rows and tasks
  // beyond the window are still valid dependencies.
  const countableTasks = allTasks.filter((task) => task.hidden !== true);
  const tasks = countableTasks.slice(-MAX_TASKS);
  const members = store.listMembers(team.id).filter((member) => member.status !== 'removed');
  const currentByAssignee = new Map(
    countableTasks
      .filter((task) => ['in_progress', 'active', 'claimed', 'running'].includes(task.status))
      .map((task) => [task.assignee, task.id]),
  );
  const stats = typeof service?.lifecycleStats === 'function'
    ? service.lifecycleStats(team.id)
    : { hot: 0, warm: 0, cold: 0, archived: 0, sessions: 0, contractors: 0, contractorSlots: [] };
  const contractorPools = typeof service?.contractorPools === 'function'
    ? service.contractorPools(team.id)
    : [];
  const lastPatrolAt = numberOrNull(team.lastPatrolAt ?? service?.patrolLastAt?.get?.(team.id));
  const patrolInterval = Math.max(1, Number(config.patrol?.intervalMinutes) || 15);
  const patrolEnabled = config.patrol?.enabled !== false;
  const mailbox = pendingMessages
    .filter((message) => message.teamId === team.id)
    .slice(-MAX_MESSAGES)
    .map(sanitizeMessage);
  const taskViews = tasks.map((task) => sanitizeTask(task, allTasks));

  return {
    id: team.id,
    name: team.name ?? team.id,
    phase: team.phase ?? 'running',
    control: team.control ?? 'active',
    capacity: {
      workerSlots: numberOrNull(scheduler.activeWorkerSlots),
      maxActivePerTeam: numberOrNull(scheduler.maxActivePerTeam),
      maxControlSessions: numberOrNull(scheduler.maxControlSessions),
      maxTotalSessions: numberOrNull(scheduler.maxTotalSessions),
      activeWorkers: members.filter((member) => (
        member.sessionId
        && !['captain', 'lead', 'shadow'].includes(String(member.role ?? member.roleKey ?? '').toLowerCase())
      )).length,
      activeContractors: numberOrNull(stats.contractors ?? 0),
      sessions: numberOrNull(stats.sessions ?? 0),
      hot: numberOrNull(stats.hot ?? 0),
      warm: numberOrNull(stats.warm ?? 0),
      cold: numberOrNull(stats.cold ?? 0),
      archived: numberOrNull(stats.archived ?? 0),
    },
    contractorSlots: (Array.isArray(contractorPools) ? contractorPools : [])
      .map((slot) => ({
        slot: slot.slot ?? null,
        cap: numberOrNull(slot.cap),
        active: numberOrNull(slot.active ?? 0),
        queued: numberOrNull(slot.queued ?? 0),
      })),
    members: members.map((member) => sanitizeMember(store, service, team.id, member, countableTasks, currentByAssignee.get(member.name))),
    tasks: taskViews,
    mergeQueue: taskViews.filter((task) => task.mergeState
      || task.integrationCommit
      || task.mergedCommit
      || (task.status === 'completed' && task.deliveryState === 'completed')),
    contractors: store.listContractors(team.id).slice(-MAX_CONTRACTORS).map(sanitizeContractor),
    findings: store.listFindings(team.id, 'open').slice(-MAX_FINDINGS).map(sanitizeFinding).filter(Boolean),
    patrol: {
      enabled: patrolEnabled,
      intervalMinutes: patrolInterval,
      lastAt: lastPatrolAt,
      nextAt: lastPatrolAt && patrolEnabled ? lastPatrolAt + patrolInterval * 60000 : null,
      inFlight: Boolean(service?.patrolInFlight?.has?.(team.id)),
      pending: Boolean(team.patrolPending) || (Array.isArray(team.patrolBacklog) && team.patrolBacklog.length > 0),
      backlogCount: Array.isArray(team.patrolBacklog) ? team.patrolBacklog.length : (team.patrolPending ? 1 : 0),
    },
    mailbox,
    events: (typeof store.listRecentEvents === 'function'
      ? store.listRecentEvents(team.id, MAX_EVENTS)
      : store.listEvents(team.id).slice(-MAX_EVENTS))
      .map((event) => sanitizeEvent({ ...event, teamId: team.id })),
    ...(typeof service?.redReviewSummary === 'function'
      ? { redReviews: sanitizeRedReviews(service.redReviewSummary(team.id)) }
      : {}),
  };
}

/**
 * Read-only projection for the web console. It deliberately contains no
 * tokens, license ids, session ids, home paths or message delivery details;
 * the console is a dashboard, not a control surface.
 *
 * @param {{ store:any, service:any, version?:string }} input
 */
export function buildUiConsole({ store, service, version = '' } = {}) {
  const config = service?.config ?? {};
  const scheduler = config.scheduler ?? {};
  const modelStatus = typeof service?.modelStatus === 'function' ? service.modelStatus() : null;
  const shadow = typeof service?.shadowStatus === 'function' ? service.shadowStatus() : null;
  const pendingMessages = typeof service?.listPendingMessages === 'function' ? service.listPendingMessages() : [];
  const teams = store.listTeams().slice(0, 2)
    .map((team) => projectTeam({ store, service, config, scheduler, team, pendingMessages }));
  // `auto` (or an omitted/invalid value) falls back to host detection; the
  // console never invents a locale or exposes the raw preference.
  const locale = resolveLocale(config.zcode?.locale);
  const timeZone = resolveTimeZone(config.zcode?.timezone);
  return {
    version,
    generatedAt: Date.now(),
    localization: {
      locale: locale.locale,
      timeZone: timeZone.timeZone,
    },
    // Deliberately no workspace/instanceId/pid here: `/api/v1/health` only
    // exposes those on loopback, while the UI token may be used remotely.
    health: {
      status: 'ok',
      version,
    },
    capacity: {
      workerSlots: numberOrNull(scheduler.activeWorkerSlots),
      maxActivePerTeam: numberOrNull(scheduler.maxActivePerTeam),
      maxControlSessions: numberOrNull(scheduler.maxControlSessions),
      maxTotalSessions: numberOrNull(scheduler.maxTotalSessions),
      contractorMaxConcurrent: numberOrNull(config.contractors?.maxConcurrent),
    },
    limits: {
      maxTurnsPerTask: numberOrNull(scheduler.maxTurnsPerTask),
      taskTimeoutMinutes: numberOrNull(scheduler.taskTimeoutMinutes),
      idleSessionMinutes: numberOrNull(scheduler.idleSessionMinutes),
      maxRequestsPerMinute: numberOrNull(config.zcode?.maxRequestsPerMinute),
      patrolTimeoutMinutes: numberOrNull(config.patrol?.timeoutMinutes),
    },
    model: sanitizeModel(modelStatus),
    shadow: sanitizeShadow(shadow),
    teams,
  };
}
