import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, realpathSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import {
  CONTINUE_CAPABILITY,
  RED_REVIEW_KIND,
  RED_REVIEW_PURPOSE,
  memberPermissionMode,
  planPreemption,
  validateTaskGraph,
} from './domain/scheduler.mjs';
import {
  invalidateAttempt,
} from './domain/attempts.mjs';
import {
  deliveryAudit,
} from './domain/gates.mjs';
import { commitArtifactBeforeReview, deriveChangedPaths } from './domain/changes.mjs';
import {
  createBoundPostMergeRepair as createBoundPostMergeRepairFrom,
  createRepairForRejectedMerge as createRepairForRejectedMergeFrom,
  reconcilePostMergeRepairs as reconcilePostMergeRepairsFrom,
} from './service/merge-repair.mjs';
import { isCapacityError } from './domain/provider-errors.mjs';
export { isCapacityError } from './domain/provider-errors.mjs';
import { computeMaxActivePerTeam, readCapacityState, writeCapacityState } from './service/capacity-state.mjs';
import { countControlSessions, countWorkspaceSessions } from './service/session-occupancy.mjs';
import {
  buildCaptainPrompt,
  buildMemberPrompt,
  buildPostMergePrompt,
  buildTaskPrompt,
} from './service/prompts.mjs';
import {
  LEAD_CAPABILITY,
  SHADOW_CAPABILITY,
  nextMemberLabel as nextMemberLabelFrom,
  normalizeRole as normalizeRoleKey,
  resolveCapabilities,
  roleDefaults as roleDefaultsFor,
} from './service/roles.mjs';
import { withPatrolCancelDeadline } from './service/patrol-run.mjs';
import {
  patrol as patrolLifecycle,
  markPatrol as markPatrolLifecycle,
  patrolOnce as patrolOnceLifecycle,
  patrolPrompt as patrolPromptLifecycle,
  queuePatrolReport as queuePatrolReportLifecycle,
  flushPatrolPending as flushPatrolPendingLifecycle,
  patrolTickAll as patrolTickAllLifecycle,
} from './service/patrol-lifecycle.mjs';
import {
  currentMergeReview as currentMergeReviewFor,
  markDeliveryMerged as markDeliveryMergedFor,
  resolveDeliveryMergeTarget as resolveDeliveryMergeTargetFor,
} from './service/delivery-receipts.mjs';
import {
  reconcileIntegrationIntent as reconcileIntegrationIntentFrom,
  reconcilePublication as reconcilePublicationFrom,
  retryCleanup as retryCleanupFrom,
  retryPublication as retryPublicationFrom,
} from './service/publication-recovery.mjs';
import {
  applyModelToActiveSessions as applyModelToActiveSessionsFrom,
  applyModelToActiveSessionsNow as applyModelToActiveSessionsNowFrom,
  currentHostModel as currentHostModelFrom,
  followHostModel as followHostModelFrom,
  modelStatus as modelStatusFrom,
  noteModelFollowAbandoned as noteModelFollowAbandonedFrom,
  recordPolicyChange as recordPolicyChangeFrom,
  resolveModelForSpawn as resolveModelForSpawnFrom,
  setFixedModel as setFixedModelFrom,
} from './service/model-policy.mjs';
import {
  activeContractors as activeContractorsImpl,
  cleanupContractor as cleanupContractorImpl,
  contractorContinueDelay as contractorContinueDelayImpl,
  contractorPools as contractorPoolsImpl,
  contractorSendTurn as contractorSendTurnImpl,
  contractorSlotAllows as contractorSlotAllowsImpl,
  contractorSlotCap as contractorSlotCapImpl,
  contractorSlotFor as contractorSlotForImpl,
  finishContractorCancellation as finishContractorCancellationImpl,
  killContractor as killContractorImpl,
  pumpContractors as pumpContractorsImpl,
  runContractor as runContractorImpl,
  shouldContinueContractor as shouldContinueContractorImpl,
  spawnContractor as spawnContractorImpl,
  submitContractor as submitContractorImpl,
  waitForContractor as waitForContractorImpl,
} from './service/contractors.mjs';
import {
  ensureCaptainSession as ensureCaptainSessionFrom,
  shadowAutoStopTick as shadowAutoStopTickFrom,
  shadowStatus as shadowStatusFrom,
  startShadow as startShadowFrom,
  stopShadow as stopShadowFrom,
  withShadowLock as withShadowLockFrom,
} from './service/control-sessions.mjs';
import {
  onTaskFailed as onTaskFailedFrom,
  ensureRedReview as ensureRedReviewFrom,
  addRedReviewTask as addRedReviewTaskFrom,
  recordRedReviewCreateFailure as recordRedReviewCreateFailureFrom,
  scheduleRedReview as scheduleRedReviewFrom,
  awaitRedReviews as awaitRedReviewsFrom,
  redReviewActorFor as redReviewActorForFrom,
  runRedReview as runRedReviewFrom,
  deferRedReview as deferRedReviewFrom,
  escalateRedReview as escalateRedReviewFrom,
  finishRedReview as finishRedReviewFrom,
  sweepRedReviews as sweepRedReviewsFrom,
  redReviewSummary as redReviewSummaryFrom,
  contractorCanRedReview as contractorCanRedReviewFrom,
  runContractorRedReview as runContractorRedReviewFrom,
} from './service/red-review.mjs';
import {
  adoptPendingCandidates as adoptPendingCandidatesFrom,
  adoptPendingCandidatesUnlocked as adoptPendingCandidatesUnlockedFrom,
  publicationRetryDeferred as publicationRetryDeferredFrom,
  recordPublicationWriteBlocked as recordPublicationWriteBlockedFrom,
  recomputeTeamNeedsCaptain as recomputeTeamNeedsCaptainFrom,
} from './service/pending-adoption.mjs';
import {
  reconcileAfterRestart as reconcileAfterRestartFrom,
  reconcileContractors as reconcileContractorsFrom,
} from './service/restart-recovery.mjs';
import {
  continueTask as continueTaskFrom,
  reassignTask as reassignTaskFrom,
  claimTask as claimTaskFrom,
  heartbeatTask as heartbeatTaskFrom,
  amendTask as amendTaskFrom,
  releaseTaskHold as releaseTaskHoldFrom,
  cancelTask as cancelTaskFrom,
  reopenTask as reopenTaskFrom,
} from './service/task-transitions.mjs';
import {
  deferTransientTick as deferTransientTickFrom,
  tick as tickFrom,
  tickUnlocked as tickUnlockedFrom,
  tickAll as tickAllFrom,
} from './service/tick-workflow.mjs';
import {
  reviewMerge as reviewMergeFrom,
  reviewMergeUnlocked as reviewMergeUnlockedFrom,
  mergeTask as mergeTaskFrom,
  mergeTaskUnlocked as mergeTaskUnlockedFrom,
} from './service/merge-workflow.mjs';
import {
  withClosedLoopLock as withClosedLoopLockFrom,
  applyClosedLoop as applyClosedLoopFrom,
  supersedeLegacyReviews as supersedeLegacyReviewsFrom,
  applyClosedLoopUnlocked as applyClosedLoopUnlockedFrom,
  createLoopTasks as createLoopTasksFrom,
  loopEventFor as loopEventForFrom,
  createLoopTask as createLoopTaskFrom,
  escalateClosedLoop as escalateClosedLoopFrom,
  reconcileClosedLoop as reconcileClosedLoopFrom,
  reconcileClosedLoopUnlocked as reconcileClosedLoopUnlockedFrom,
  recoverEvidenceBackedTasks as recoverEvidenceBackedTasksFrom,
} from './service/closed-loop.mjs';
import { retryAfterMsFrom } from './session/retry-after.mjs';
import {
  armTurnWatcher as armTurnWatcherFrom,
  handleTurnFailure as handleTurnFailureFrom,
  continueDueTurns as continueDueTurnsFrom,
  deferContinue as deferContinueFrom,
  continueOneTask as continueOneTaskFrom,
} from './service/turn-recovery.mjs';
import {
  buildMemberSummary,
  settlementBlockers,
  workStateOf,
} from './domain/lifecycle.mjs';
import { ensureWorktreeBase } from './git/worktree.mjs';
import { reclaimWorktrees } from './git/worktree-reclaim.mjs';
import { reclaimMemberHomes } from './session/worker-home.mjs';
import { worktreeDirty } from './git/merge-queue.mjs';
import { IntervalRateLimiter } from './domain/rate-limit.mjs';
import {
  contractorWriteDenylist,
  modelPolicyToolDenylist,
  pluginTeamToolDenylist,
} from './domain/team-tools.mjs';

const ACTIVE_STATUSES = new Set(['claimed', 'in_progress']);
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

// Fields a task creator may set through the public API. Lifecycle/evidence/
// merge/internal-write fields are never authoritative input: `status` is
// forced to pending and `hidden`, merge state, worktree and attempt data are
// only written by the service.
const TASK_PUBLIC_FIELDS = [
  'id', 'subject', 'kind', 'assignee', 'assigneeRole',
  'objective', 'acceptance', 'verify', 'inScope', 'outOfScope',
  'dependencies', 'reviewedTaskId', 'sourceTaskId', 'findingSourceTaskIds',
  'sourceFindingIds', 'requiresVerification', 'priority', 'complexity', 'effort',
  'round', 'scopeSource',
];
// Closed-loop bookkeeping/evidence is accepted only from internal planners.
// Letting a lead supply these fields could pre-set `closedLoop.status='escalated'`,
// forge findings, or move a task to the front of FIFO via createdAt. Task-graph
// linkage fields (reviewedTaskId/sourceTaskId/...) stay public because the MCP
// create_task contract exposes them for manual review/repair creation.
const TASK_INTERNAL_FIELDS = [
  'assigneeId', 'findings', 'findingsFingerprint', 'closedLoop', 'createdAt',
  'parentReviewTaskId', 'parentIntegrationId', 'deliveryUnitId', 'deliverySeq', 'deliveryGeneration',
  'mode', 'repairOrigin', 'sourceBase', 'sourceReviewId',
  'reviewMode', 'reviewEpoch', 'unitReviewSeq', 'binding',
  'legacyReviewEpoch', 'reviewedSourceCommit', 'contractSource',
  'bindingUnavailable', 'legacyUnbound', 'legacyRepair',
  'repairKey', 'repairGeneration',
];

function cleanTaskInput(raw, { internal = false } = {}) {
  const fields = internal
    ? [...TASK_PUBLIC_FIELDS, ...TASK_INTERNAL_FIELDS]
    : TASK_PUBLIC_FIELDS;
  const clean = {};
  for (const field of fields) {
    if (raw?.[field] !== undefined) clean[field] = raw[field];
  }
  return clean;
}
// The task contract belongs to the captain/shadow. A lead may publish work,
// but cannot widen or rewrite what "done" means.
const TASK_CONTRACT_FIELDS = ['objective', 'acceptance', 'verify', 'inScope', 'outOfScope'];
// Amendment is a contract operation; anything else is not writable here.
// A busy member can reject mailbox delivery on every tick while its prompt is
// still running. Retry with exponential backoff instead of writing one event
// per tick; the message stays pending and is never dropped.

// Adoption can fail transiently while a provider/fence is starting, but a
// deterministic failure must not be retried on every one-second scheduler tick.
// Keep a short retry window, then escalate once for captain intervention.













const WORKTREE_RECLAIM_QUEUES = new Map();


/**
 * Coordinator between the store, the scheduler, and a session adapter.
 * The adapter is replaceable: FakeSessionAdapter in tests, CLI/protocol in the daemon.
 */
import { prepareTaskCompletion, persistInProgressCompletion, normalizeReviewCompletion } from './service/task-completion-validation.mjs';
import {
  bindReviewSnapshot, completionIsCurrent, deriveImplementationChangedPaths,
  runCompletionVerification, validateCompletionEvidence,
} from './service/task-completion-evidence.mjs';
import { persistTaskCompletion } from './service/task-completion-closeout.mjs';
import { collectCompletionEvidence } from './service/task-completion-phases.mjs';
import { runTaskCompletionFollowUps } from './service/task-completion-follow-up.mjs';
export class TeamService {
  constructor({ store, adapter, contractorAdapter, config, cwd = process.cwd(), now = () => Date.now(), roster = {}, useWorktrees = false, repo = cwd, memoryUsage, capacityStatePath, hostModel, nativeAgentModel, artifactFenceProvider = null, homeRoot = join(homedir(), '.ai-agent-teams', 'homes') }) {
    this.store = store;
    this.adapter = adapter;
    this.contractorAdapter = contractorAdapter ?? adapter;
    this.config = config;
    this.cwd = cwd;
    this.homeRoot = resolve(homeRoot);
    this.now = now;
    this.roster = roster;
    this.useWorktrees = useWorktrees;
    this.repo = repo;
    // Trusted infrastructure capability. A boolean/lease/timestamp is not a
    // substitute; without acquire() the daemon fails closed before publishing.
    this.artifactFenceProvider = artifactFenceProvider;
    this.hostModel = typeof hostModel === 'function' ? hostModel : null;
    this.nativeAgentModel = typeof nativeAgentModel === 'function' ? nativeAgentModel : null;
    // `fixed` at startup pins config.zcode.defaultModel; switching to `fixed`
    // later pins whatever `agent_teams_model set` was given.
    const fixedAtStart = config.zcode?.modelPolicy === 'fixed';
    this.modelPolicy = {
      mode: fixedAtStart ? 'fixed' : 'follow-host',
      model: fixedAtStart ? (config.zcode?.defaultModel ?? null) : null,
      reasoning: fixedAtStart ? (config.zcode?.defaultReasoning ?? null) : null,
    };
    // Bumped on every set/follow. A queued follow-host application that runs
    // after a policy change is discarded instead of overwriting the new pin.
    this.modelPolicyEpoch = 0;
    // Model applications are serialized so an in-flight watcher tick cannot
    // land after `agent_teams_model set` and resurrect the host model.
    this.modelApplyChain = Promise.resolve();
    this.leaseMs = (config.scheduler.taskTimeoutMinutes ?? 120) * 60 * 1000;
    this.dispatchLimiter = (Number(config.zcode?.maxRequestsPerMinute) || 0) > 0
      ? new IntervalRateLimiter({ requestsPerMinute: config.zcode.maxRequestsPerMinute })
      : null;
    this.turnRetry = {
      enabled: true,
      maxAttempts: 3,
      capacityMaxAttempts: 3,
      baseDelayMs: 3000,
      maxDelayMs: 60000,
      ...(config.zcode?.turnFailureRetry ?? {}),
    };
    this.turnWatchIntervalMs = Number(config.zcode?.turnWatchIntervalMs) || 2000;
    // A red box (a task that turned `failed`) is reviewed automatically: the
    // review only sends "继续" a bounded number of times, then reports to the
    // captain. Reviews run in the daemon so they never take a worker slot.
    this.redReview = {
      enabled: true,
      maxContinues: 3,
      retryDelayMs: 5000,
      maxAttempts: 5,
      ...(config.zcode?.redAutoReview ?? {}),
    };
    this.redReviewInFlight = new Set();
    this.redReviewJobs = new Map();
    // Review rows are inserted with a row-local validation, but a permanent
    // problem still has to be visible: these feed `redReviewSummary`.
    this.redReviewCreateFailures = new Map();
    this.redReviewCreateFailureAt = new Map();
    this.capacityStatePath = capacityStatePath ? resolve(capacityStatePath) : undefined;
    this.capacityCeiling = Number(config.scheduler.activeWorkerSlots) || 1;
    this.capacityMaxActiveCeiling = Number(config.scheduler.maxActivePerTeam) || 1;
    const recoveryMs = Number(this.turnRetry.capacityRecoveryMs);
    this.capacityRecoveryMs = Number.isFinite(recoveryMs) && recoveryMs >= 0 ? recoveryMs : 60000;
    this.capacityRecoverySuccesses = Math.max(1, Number(this.turnRetry.capacityRecoverySuccesses) || 3);
    this.capacitySuccesses = 0;
    this.capacityReducedAt = 0;
    this.capacityNextRecoveryAt = 0;
    this.loadCapacityState();
    this.turnWatchers = new Map();
    this.continueInFlight = new Set();
    this.features = config.features ?? {};
    this.memoryUsage = memoryUsage ?? (() => process.memoryUsage());
    this.lastPatrolAt = 0;
    this.patrolInFlight = new Set();
    this.patrolFlushInFlight = new Set();
    this.captainSessionStarts = new Map();
    this.patrolStartedAt = new Map();
    this.patrolLastAt = new Map();
    // The daemon owns the patrol clock, but `lastPatrolAt` is persisted on the
    // team row. Hydrate the in-memory cursor so a restart inside the same
    // window does not send a duplicate report.
    for (const team of this.store.listTeams()) {
      const lastPatrolAt = Number(team.lastPatrolAt) || 0;
      if (lastPatrolAt > 0) this.patrolLastAt.set(team.id, lastPatrolAt);
    }
    this.patrolCancelPending = new Map();
    this.contractorSends = new Map();
    this.patrolCancelTimeoutMs = 5000;
    this.patrolTimeoutMs = Math.max(1, Number(config.patrol?.timeoutMinutes) || 30) * 60000;
    this.worktreeBaseState = new Map();
    this.worktreeBaseCheckMs = Math.max(0, Number(config.scheduler.worktreeBaseCheckMs ?? 30000));
    this.contractorRuns = new Map();
    this.contractorPumping = new Set();
    this._tickAllRunning = false;
    this.transientTickBackoff = new Map();
    this.mergeLocks = new Map();
    this.mergeReviewLocks = new Map();
    this.closedLoopLocks = new Map();
    this.adoptPublicationBackoff = new Map();
    this.shadowTransition = Promise.resolve();
  }

  recomputeMaxActivePerTeam(slots = this.config.scheduler.activeWorkerSlots) {
    return computeMaxActivePerTeam(slots, this.capacityCeiling, this.capacityMaxActiveCeiling);
  }

  setCapacitySlots(slots) {
    this.config.scheduler.activeWorkerSlots = slots;
    this.config.scheduler.maxActivePerTeam = this.recomputeMaxActivePerTeam(slots);
  }

  setRecoveryCooldown(now) {
    this.capacitySuccesses = 0;
    this.capacityNextRecoveryAt = now + this.capacityRecoveryMs;
  }

  startCapacityCooldown(now) {
    this.setRecoveryCooldown(now);
    this.capacityReducedAt = now;
  }

  clearCapacitySuccesses() {
    if (this.capacitySuccesses === 0) return;
    this.capacitySuccesses = 0;
    this.persistCapacityState();
  }

  loadCapacityState() {
    const state = readCapacityState(this.capacityStatePath, {
      ceiling: this.capacityCeiling,
      maxCeiling: this.capacityMaxActiveCeiling,
      recoveryMs: this.capacityRecoveryMs,
      recoverySuccesses: this.capacityRecoverySuccesses,
      now: this.now(),
    });
    if (!state) return;
    this.config.scheduler.activeWorkerSlots = state.activeWorkerSlots;
    this.config.scheduler.maxActivePerTeam = state.maxActivePerTeam;
    this.capacitySuccesses = state.successes;
    this.capacityReducedAt = state.reducedAt;
    this.capacityNextRecoveryAt = state.nextRecoveryAt;
  }

  persistCapacityState() {
    writeCapacityState(this.capacityStatePath, {
      activeWorkerSlots: this.config.scheduler.activeWorkerSlots,
      maxActivePerTeam: this.config.scheduler.maxActivePerTeam,
      configuredWorkerSlots: this.capacityCeiling,
      successes: this.capacitySuccesses,
      reducedAt: this.capacityReducedAt,
      nextRecoveryAt: this.capacityNextRecoveryAt,
    });
  }

  recordTurnSuccess(teamId) {
    const active = Number(this.config.scheduler.activeWorkerSlots) || 1;
    if (active >= this.capacityCeiling) {
      this.clearCapacitySuccesses();
      return;
    }
    const now = this.now();
    if (now < this.capacityNextRecoveryAt) return;
    this.capacitySuccesses += 1;
    if (this.capacitySuccesses < this.capacityRecoverySuccesses) {
      this.persistCapacityState();
      return;
    }
    const from = active;
    const to = Math.min(this.capacityCeiling, from + 1);
    this.setCapacitySlots(to);
    this.setRecoveryCooldown(now);
    this.store.addEvent(teamId, 'concurrency.recovered', { from, to });
    this.persistCapacityState();
  }

  normalizeRole(role) {
    return normalizeRoleKey(role);
  }

  roleDefaults(role) {
    return roleDefaultsFor(role);
  }

  nextMemberLabel(teamId, base) {
    return nextMemberLabelFrom(this.store.listMembers(teamId).map((member) => member.name), base);
  }

  issueLicense(teamId, member, overrides = {}) {
    const defaults = this.roleDefaults(overrides.roleKey ?? member.role);
    const label = overrides.label ?? member.name;
    const existing = this.store.findMember(teamId, label);
    if (existing && existing.id !== member.id) throw new Error(`duplicate member name in team: ${label}`);
    const roleKey = this.normalizeRole(overrides.roleKey ?? defaults.roleKey);
    const capabilities = resolveCapabilities(
      roleKey,
      overrides.capabilities ?? defaults.capabilities ?? [],
    );
    if (roleKey === 'shadow') {
      const other = this.findShadowMember();
      if (other && other.id !== member.id) {
        throw Object.assign(
          new Error(`a shadow already exists in team ${other.teamId}: ${other.name}`),
          { status: 409, code: 'E_SHADOW_EXISTS' },
        );
      }
    }
    const license = {
      id: overrides.id ?? `lic_${randomUUID()}`,
      teamId,
      memberId: member.id,
      status: 'active',
      label,
      roleKey,
      allowedTaskKinds: overrides.allowedTaskKinds ?? defaults.kinds,
      pathScope: overrides.pathScope ?? ['**'],
      toolPolicy: overrides.toolPolicy ?? defaults.toolPolicy,
      capabilities,
      control: overrides.control ?? defaults.control === true,
      scope: overrides.scope ?? defaults.scope ?? 'team',
      expiresAt: overrides.expiresAt ?? null,
      issuedBy: overrides.issuedBy ?? 'captain',
      issuedAt: this.now(),
    };
    this.store.addLicense(license);
    return this.store.updateMember(member.id, {
      name: label,
      role: license.roleKey,
      licenseId: license.id,
      license,
      toolPolicy: license.toolPolicy,
    });
  }

  ensureMemberToken(member) {
    const existing = this.store.getMemberToken(member.id);
    if (existing) return existing;
    const token = `mt_${randomBytes(24).toString('hex')}`;
    this.store.setMemberToken(member.id, token);
    return token;
  }

  currentHostModel() {
    return currentHostModelFrom(this);
  }

  resolveModelForSpawn(member) {
    return resolveModelForSpawnFrom(this, member);
  }

  async applyModelToActiveSessions(input) {
    return applyModelToActiveSessionsFrom(this, input);
  }

  async applyModelToActiveSessionsNow(options) {
    return applyModelToActiveSessionsNowFrom(this, options);
  }

  noteModelFollowAbandoned(options) {
    return noteModelFollowAbandonedFrom(this, options);
  }

  recordPolicyChange(from, to, actor) {
    return recordPolicyChangeFrom(this, from, to, actor);
  }

  modelStatus() {
    return modelStatusFrom(this);
  }

  async setFixedModel(options) {
    return setFixedModelFrom(this, options);
  }

  async followHostModel(options) {
    return followHostModelFrom(this, options);
  }

  materializeMember(teamId, input = {}) {
    const team = this.store.getTeam(teamId);
    if (!team) throw new Error(`unknown team: ${teamId}`);
    const configured = this.config.teams.find((item) => item.id === teamId);
    const max = configured?.maxMembers ?? 32;
    if (this.rosterMembers(teamId).length >= max) {
      throw new Error(`team ${teamId} is at its member cap (${max})`);
    }
    const roleKey = this.normalizeRole(input.roleKey ?? input.role ?? 'engineer');
    if (roleKey === 'shadow') {
      throw Object.assign(
        new Error('the shadow is a control role and cannot be materialized as a delivery member'),
        { status: 409, code: 'E_SHADOW_CONTROL' },
      );
    }
    if (roleKey === 'lead') this.assertLeadSlotFree(teamId);
    const defaults = this.roleDefaults(roleKey);
    let label = input.name;
    if (!label) {
      label = this.nextMemberLabel(teamId, defaults.label);
    } else if (this.store.findMember(teamId, label)) {
      label = this.nextMemberLabel(teamId, label);
    }
    for (const retired of this.store.listMembers(teamId)) {
      if (retired.status === 'removed' && !retired.sessionId && !retired.homeCleanupDeferred) this.purgeMemberHome(retired);
    }
    const member = this.store.addMember({
      teamId,
      name: label,
      role: defaults.roleKey,
      status: 'idle',
      workState: 'available',
      residency: 'cold',
      model: input.model ?? this.config.zcode.defaultModel ?? null,
      reasoning: input.reasoning ?? this.config.zcode.defaultReasoning ?? null,
      modelOverride: input.model ?? null,
      reasoningOverride: input.reasoning ?? null,
      toolPolicy: defaults.toolPolicy,
      joinedAt: this.now(),
    });
    const licensed = this.issueLicense(teamId, member, {
      roleKey: defaults.roleKey,
      allowedTaskKinds: input.allowedTaskKinds,
      pathScope: input.pathScope,
      licenseLabel: undefined,
      toolPolicy: input.toolPolicy,
    });
    this.ensureMemberToken(licensed);
    this.store.addEvent(teamId, 'member.materialized', { memberId: licensed.id, name: licensed.name, role: licensed.role });
    return licensed;
  }

  roleForTask(task) {
    if (task.assigneeRole) return this.normalizeRole(task.assigneeRole);
    if (task.kind === 'review' || task.kind === 'requirements') return 'reviewer';
    if (task.kind === 'integration') return 'integrator';
    if (task.kind === 'verification') return 'analyst';
    return 'engineer';
  }

  findReusableMember(teamId, roleKey, { exclude } = {}) {
    const tasks = this.store.listTasks(teamId);
    const occupied = new Set(tasks
      .filter((task) => !TERMINAL_STATUSES.has(task.status) && task.assignee)
      .map((task) => task.assignee));
    const candidates = this.store.listMembers(teamId)
      .filter((member) => member.status !== 'removed' && member.workState !== 'archived'
        && member.sessionRecoveryState !== 'unknown' && !member.workerSessionStart)
      .filter((member) => member.id !== exclude && member.name !== exclude)
      .filter((member) => (member.license?.roleKey ?? this.normalizeRole(member.role)) === roleKey)
      .filter((member) => !occupied.has(member.name))
      .filter((member) => ['available', 'settled'].includes(member.workState ?? 'available'));
    const rank = { hot: 0, warm: 1, cold: 2 };
    candidates.sort((a, b) => (rank[a.residency] ?? 3) - (rank[b.residency] ?? 3));
    return candidates[0];
  }

  ensureAssignee(teamId, task) {
    if (!this.features.lazyMembers) return undefined;
    if (task.assignee) {
      const found = this.store.findMember(teamId, task.assignee) ?? this.store.getMember(task.assignee);
      if (found) return found;
      const materialized = this.materializeMember(teamId, { name: task.assignee, role: task.assigneeRole ?? this.roleForTask(task) });
      this.store.updateTask(task.id, { assignee: materialized.name, assigneeId: materialized.id });
      return materialized;
    }
    const role = this.roleForTask(task);
    let candidate = this.findReusableMember(teamId, role);
    if (task.kind === 'review' && task.reviewedTaskId) {
      const reviewed = this.store.getTask(task.reviewedTaskId);
      if (reviewed?.assigneeId && candidate?.id === reviewed.assigneeId) candidate = undefined;
      else if (reviewed?.assignee && candidate?.name === reviewed.assignee) candidate = undefined;
    }
    if (!candidate) candidate = this.materializeMember(teamId, { role });
    this.store.updateTask(task.id, {
      assignee: candidate.name,
      assigneeId: candidate.id,
      assigneeRole: role,
    });
    return candidate;
  }

  isCurrentAttempt(taskId, attemptId, assignee) {
    const current = this.store.getTask(taskId);
    return Boolean(current
      && current.attemptId === attemptId
      && !TERMINAL_STATUSES.has(current.status)
      && (!assignee || current.assignee === assignee));
  }

  handleCapacityError(teamId, error) {
    const message = error instanceof Error ? error.message : error?.message;
    const capacity = isCapacityError({
      message,
      code: error?.code,
      type: error?.type,
      retryable: error?.retryable,
      retryAfterMs: error?.retryAfterMs ?? retryAfterMsFrom(error),
    });
    if (!capacity) return false;
    const text = String(message ?? error);
    const from = this.config.scheduler.activeWorkerSlots;
    const to = Math.max(1, from - 1);
    const now = this.now();
    if (to === from) {
      this.startCapacityCooldown(now);
      this.persistCapacityState();
      return true;
    }
    this.setCapacitySlots(to);
    this.startCapacityCooldown(now);
    this.persistCapacityState();
    this.store.addEvent(teamId, 'concurrency.reduced', {
      from, to, error: text, nextRecoveryAt: this.capacityNextRecoveryAt,
    });
    return true;
  }

  async resetMemberSession(teamId, memberId, expectedSessionId) {
    const member = this.store.getMember(memberId);
    const sessionId = member?.sessionId;
    if (!sessionId || (expectedSessionId && sessionId !== expectedSessionId)) return;
    const retired = await this.retireMemberSession(teamId, memberId, sessionId, 'session-reset');
    if (retired.ok) this.store.addEvent(teamId, 'member.session_reset', { memberId, sessionId });
    return retired;
  }

  async retireMemberSession(teamId, memberId, sessionId, reason) {
    this.store.transaction(() => {
      const member = this.store.getMember(memberId);
      if (!member || member.teamId !== teamId || member.sessionId !== sessionId) throw new Error('member session changed before retirement');
      this.store.updateMember(memberId, { sessionRecoveryState: 'unknown', workState: 'busy' });
      this.store.revokeMemberToken(memberId);
      this.store.addEvent(teamId, 'member.session_retiring', { memberId, sessionId, reason });
    });
    let proof;
    let warning;
    try {
      await withPatrolCancelDeadline(async () => {
        const stopped = await this.adapter.stop({ sessionId });
        if (stopped?.ok !== true) throw new Error(stopped?.warning ?? 'stop unconfirmed');
        const closed = await this.adapter.close?.({ sessionId });
        if (closed?.ok !== true) throw new Error(closed?.warning ?? 'close unconfirmed');
        proof = await this.adapter.verifySessionTermination?.({ sessionId });
        if (proof?.verified !== true || proof.sessionId !== sessionId || proof.sideEffectsRevoked !== true) {
          throw new Error('termination and side-effect revocation not proven');
        }
      }, 3000);
    } catch (error) {
      warning = error instanceof Error ? error.message : String(error);
    }
    if (warning) {
      this.store.updateTeam(teamId, { needsCaptain: true });
      this.store.addEvent(teamId, 'member.session_retirement_unknown', { memberId, sessionId, reason, error: warning });
      return { ok: false, needsCaptain: true, error: warning };
    }
    let retired = false;
    this.store.transaction(() => {
      const current = this.store.getMember(memberId);
      if (current?.sessionId !== sessionId || current.sessionRecoveryState !== 'unknown') return;
      this.store.updateMember(memberId, { sessionId: undefined, sessionRecoveryState: undefined,
        residency: 'cold', status: 'idle', workState: 'waiting', workdir: undefined });
      this.store.addEvent(teamId, 'member.session_retired', { memberId, sessionId, reason });
      retired = true;
    });
    if (!retired) this.store.updateTeam(teamId, { needsCaptain: true });
    return retired ? { ok: true } : { ok: false, needsCaptain: true, error: 'member session changed while retiring' };
  }

  refreshMemberState(teamId, memberId) {
    const member = this.store.getMember(memberId);
    if (!member) return undefined;
    const tasks = this.store.listTasks(teamId);
    const attempts = this.store.listAttempts(teamId);
    const findings = this.store.listFindings(teamId, 'open', member.id);
    const state = workStateOf(member, tasks);
    const blockers = settlementBlockers({
      member: { ...member, workState: state }, tasks: this.settlementTasks(tasks, member), attempts, findings,
    });
    let workState = state;
    if ((state === 'available' || state === 'waiting') && member.lastTaskAt && blockers.length === 0) workState = 'settled';
    let residency = member.residency ?? (member.sessionId ? 'hot' : 'cold');
    if (workState === 'busy') residency = 'hot';
    else if (!member.sessionId) residency = 'cold';
    else if (residency === 'cold') residency = 'warm';
    return this.store.updateMember(memberId, { workState, residency });
  }

  /**
   * Tasks that can hold a member's settlement. A closed-loop follow-up is a
   * system task: an unassigned or other-member review/repair does not depend on
   * this member's context, but one assigned to this member still blocks.
   * @param {Array<any>} tasks
   * @param {any} member
   */
  settlementTasks(tasks, member) {
    return tasks.filter((task) => {
      if (task.closedLoop?.origin !== 'closed-loop') return true;
      if (TERMINAL_STATUSES.has(task.status)) return true;
      return Boolean(task.assignee && (task.assignee === member.name
        || (task.assigneeId && task.assigneeId === member.id)));
    });
  }

  armTurnWatcher({ teamId, taskId, attemptId, member, sessionId, afterSeq }) {
    return armTurnWatcherFrom(this, { teamId, taskId, attemptId, member, sessionId, afterSeq }, TERMINAL_STATUSES);
  }

  handleTurnFailure({ teamId, taskId, attemptId, memberId, sessionId: attemptSessionId, message, code, type, retryable, retryAfterMs, turnFailure = false, correlationId = randomUUID(), causedBy }) {
    return handleTurnFailureFrom(this, { teamId, taskId, attemptId, memberId, sessionId: attemptSessionId, message, code, type, retryable, retryAfterMs, turnFailure: turnFailure, correlationId: correlationId, causedBy }, ACTIVE_STATUSES);
  }

  /**
   * Whether an actor may call agent_teams_continue_task. The captain (admin
   * token) always may; a contractor may run the automatic red review; a member
   * needs the declared `task:continue` capability on its license, which
   * reviewer/auditor roles get by default.
   * @param {string} teamId
   * @param {{ role?: string, memberId?: string, name?: string, contractorId?: string }} [actor]
   * @returns {boolean}
   */
  canContinueTask(teamId, actor) {
    if (actor?.role === 'admin') return true;
    if (actor?.role === 'contractor') {
      const contractor = actor.contractorId ? this.store.getContractor(actor.contractorId) : undefined;
      if (!contractor || contractor.teamId !== teamId) return false;
      if (['completed', 'failed', 'killed', 'cancelled', 'orphaned'].includes(contractor.status)) return false;
      // Only a running contractor may continue a team task. The daemon's own
      // red-review contractor is allowed while queued because the daemon is
      // about to run it; a plain queued contractor is not.
      const redPurpose = String(contractor.purpose ?? '').split(':')[0] === RED_REVIEW_PURPOSE;
      if (contractor.status !== 'running' && !redPurpose) return false;
      // With no declared `task:continue` capability and no red-review purpose
      // the contractor is still fail-closed (F2).
      return this.contractorCanRedReview(contractor);
    }
    if (actor?.role !== 'member') return false;
    const member = (actor.memberId ? this.store.getMember(actor.memberId) : undefined)
      ?? (actor.name ? this.store.findMember(teamId, actor.name) : undefined);
    if (!member || member.status === 'removed') return false;
    // The shadow is a global control role: its home team must not restrict it
    // from continuing a failed task on the other team.
    if (this.memberIsShadow(member)) return this.memberHasContinueCapability(member);
    if (member.teamId !== teamId) return false;
    return this.memberHasContinueCapability(member);
  }

  /**
   * Whether an actor may manage tasks for a team as its lead. Only a member
   * whose license carries `team:lead` on that same team qualifies; the captain
   * (admin token) keeps its existing authority.
   * @param {string} teamId
   * @param {{ role?: string, memberId?: string, name?: string }} [actor]
   * @returns {boolean}
   */
  canLeadTeam(teamId, actor) {
    if (actor?.role === 'admin') return true;
    if (actor?.role !== 'member') return false;
    const member = (actor.memberId ? this.store.getMember(actor.memberId) : undefined)
      ?? (actor.name ? this.store.findMember(teamId, actor.name) : undefined);
    if (!member || member.teamId !== teamId || member.status === 'removed') return false;
    return this.memberHasCapability(member, LEAD_CAPABILITY);
  }

  memberIsShadow(member) {
    return this.memberHasCapability(member, SHADOW_CAPABILITY);
  }

  memberIsControl(member) {
    return member?.license?.control === true
      || this.memberIsShadow(member)
      || this.memberHasCapability(member, LEAD_CAPABILITY);
  }

  /** A team has at most one lead seat; lead is control, not delivery roster. */
  assertLeadSlotFree(teamId, { exceptMemberId } = {}) {
    const existing = this.store.listMembers(teamId).find((member) => (
      member.status !== 'removed'
      && member.id !== exceptMemberId
      && (this.normalizeRole(member.license?.roleKey ?? member.role) === 'lead'
        || this.memberHasCapability(member, LEAD_CAPABILITY))
    ));
    if (existing) {
      throw Object.assign(
        new Error(`team ${teamId} already has a lead: ${existing.name}`),
        { status: 409, code: 'E_LEAD_EXISTS' },
      );
    }
  }

  /** Delivery roster used for the 8..32 cap; control seats are separate. */
  rosterMembers(teamId) {
    return this.store.listMembers(teamId).filter((member) => (
      member.status !== 'removed'
      && !this.memberIsControl(member)
      && this.normalizeRole(member.license?.roleKey ?? member.role) !== 'shadow'
    ));
  }

  /** One captain principal plus every live control-seat session. */
  controlSessionCount() {
    return countControlSessions(this);
  }

  /** Conservative workspace-wide count for contractor admission. */
  workspaceSessionCount() {
    return countWorkspaceSessions(this);
  }

  assertWorkspaceSessionBudget() {
    const max = Number(this.config.scheduler?.maxTotalSessions ?? 32);
    if (this.workspaceSessionCount() >= max) {
      throw Object.assign(new Error(`workspace session budget is full (${max})`),
        { status: 409, code: 'E_SESSION_CAP' });
    }
  }

  recordUnknownWorkerSession(teamId, memberId, operationId, attemptId, sessionId, reason) {
    this.store.transaction(() => {
      const team = this.store.getTeam(teamId);
      const member = this.store.getMember(memberId);
      if (!team) throw new Error(`unknown team: ${teamId}`);
      if (member?.workerSessionStart?.operationId === operationId) {
        this.store.updateMember(memberId, { workerSessionStart: { ...member.workerSessionStart, state: 'unknown', sessionId, error: reason }, workState: 'busy' });
      } else {
        const conflicts = Array.isArray(team.workerSessionConflicts) ? team.workerSessionConflicts : [];
        if (!conflicts.some((item) => item.operationId === operationId)) {
          this.store.updateTeam(teamId, { workerSessionConflicts: [...conflicts, {
            operationId, attemptId, memberId, sessionId, state: 'unknown', control: Boolean(member && this.memberIsControl(member)), error: reason,
          }] });
        }
      }
      if (member) {
        this.store.revokeMemberToken(memberId);
        this.store.updateMember(memberId, { sessionRecoveryState: 'unknown', workState: 'busy' });
        for (const task of this.store.listTasks(teamId)) {
          if (!ACTIVE_STATUSES.has(task.status) || !task.attemptId
            || (task.assigneeId !== memberId && task.assignee !== member.name)) continue;
          const currentAttempt = this.store.getAttempt(task.attemptId);
          if (currentAttempt) this.store.updateAttempt(task.attemptId, { status: 'orphaned', endedAt: this.now(), error: 'member session conflict' });
          this.store.updateTask(task.id, { ...invalidateAttempt(task, { assignee: task.assignee }),
            hold: { class: 'session_conflict', operationId }, needsCaptain: true });
        }
      }
      this.store.updateTeam(teamId, { needsCaptain: true });
      this.store.addEvent(teamId, 'member.session_start_unknown', { memberId, operationId, attemptId, sessionId, reason });
    });
  }

  assertControlBudget() {
    const max = Number(this.config.scheduler?.maxControlSessions ?? 5);
    if (this.controlSessionCount() >= max) {
      throw Object.assign(
        new Error(`control session budget is full (${max})`),
        { status: 409, code: 'E_CONTROL_CAP' },
      );
    }
  }

  /**
   * The single shadow/secretary works across the whole control plane, so its
   * authority is not restricted to the team row it is attached to. Ordinary
   * team leads remain team-scoped.
   */
  canActAsCaptain(teamId, actor) {
    if (actor?.role === 'admin') return true;
    if (actor?.role !== 'member') return false;
    const member = (actor.memberId ? this.store.getMember(actor.memberId) : undefined)
      ?? (actor.teamId && actor.name ? this.store.findMember(actor.teamId, actor.name) : undefined)
      ?? (actor.name ? this.findMemberAnywhere(actor.name) : undefined);
    if (!member || member.status === 'removed') return false;
    return this.memberHasCapability(member, SHADOW_CAPABILITY);
  }

  canManageTeam(teamId, actor) {
    return this.canActAsCaptain(teamId, actor) || this.canLeadTeam(teamId, actor);
  }

  findMemberAnywhere(identifier) {
    if (!identifier) return undefined;
    for (const team of this.store.listTeams(true)) {
      const member = this.store.findMember(team.id, identifier);
      if (member) return member;
    }
    return undefined;
  }

  findShadowMember() {
    for (const team of this.store.listTeams(true)) {
      const member = this.store.listMembers(team.id)
        .find((item) => item.status !== 'removed' && this.memberIsShadow(item));
      if (member) return member;
    }
    return undefined;
  }

  /** Resolve the roster row behind an HTTP/MCP actor, if it is a member. */
  actorMemberFor(teamId, actor) {
    if (actor?.role !== 'member') return undefined;
    return (actor.memberId ? this.store.getMember(actor.memberId) : undefined)
      ?? (actor.name ? this.store.findMember(teamId, actor.name) : undefined)
      ?? (actor.name ? this.findMemberAnywhere(actor.name) : undefined);
  }

  isShadowActor(teamId, actor) {
    if (actor?.role !== 'member') return false;
    const member = this.actorMemberFor(teamId, actor);
    return Boolean(member && this.memberIsShadow(member));
  }

  /**
   * Only the captain (admin token) or the shadow may set a task contract.
   * A missing actor is an internal daemon call and keeps the legacy path.
   * @param {string} teamId
   * @param {Record<string, any>} input
   * @param {{ role?: string, memberId?: string, name?: string }} [actor]
   */
  assertTaskContractAuthority(teamId, input, actor) {
    if (!actor) return;
    if (actor.role === 'admin' || this.isShadowActor(teamId, actor)) return;
    const present = TASK_CONTRACT_FIELDS.filter((field) => input?.[field] !== undefined);
    if (present.length === 0) return;
    throw Object.assign(
      new Error(`task contract fields require the captain or shadow: ${present.join(', ')}`),
      { status: 403, code: 'E_FORBIDDEN' },
    );
  }

  /**
   * Tasks may only be created or merged on a running, active team. Recovery
   * code that must write outside that window passes `{ internal: true }`.
   * @param {string} teamId
   * @param {{ internal?: boolean }} [options]
   * @param {string} [action]
   */
  assertTeamWritable(teamId, options = {}, action = 'write') {
    const team = this.store.getTeam(teamId);
    if (!team) throw new Error(`unknown team: ${teamId}`);
    if (options?.internal === true) return team;
    if (team.phase !== 'running' || team.control !== 'active') {
      throw Object.assign(
        new Error(`team ${teamId} is not running (phase=${team.phase}, control=${team.control}); ${action} refused`),
        { status: 409, code: 'E_STATE' },
      );
    }
    return team;
  }

  memberHasCapability(member, capability) {
    const declared = member?.license?.capabilities;
    const capabilities = Array.isArray(declared)
      ? declared
      : (roleDefaultsFor(member?.license?.roleKey ?? member?.role).capabilities ?? []);
    return capabilities.includes(capability);
  }

  memberHasContinueCapability(member) {
    return this.memberHasCapability(member, CONTINUE_CAPABILITY);
  }

  /** Re-send "继续" to a failed task, resetting it to in_progress. */
  async continueTask(teamId, taskId, options = {}) {
    return continueTaskFrom(this, teamId, taskId, options);
  }

  // ---------------------------------------------------------------------------
  // Red box auto review
  //
  // Layering with the turn-failure retry above:
  //   1. A retryable turn failure continues the same task/session up to
  //      `zcode.turnFailureRetry.maxAttempts` times (unchanged).
  //   2. Only when that budget is exhausted and the task turns red (`failed`)
  //      is an automatic review task created. The review does exactly one
  //      thing: send "继续" to the failed task. It never reads code, never
  //      creates an implementation task and never edits the subject.
  //   3. The review repeats that at most `zcode.redAutoReview.maxContinues`
  //      times per task/session. The next red box after that messages the
  //      captain and stops automatic continues.
  //
  // Review tasks are hidden in the live task tree and finish as `completed`,
  // so a red task can never produce a growing pile of red review nodes.
  // ---------------------------------------------------------------------------

  /**
   * Called by every code path that moves a task into `failed`. Cheap and
   * synchronous: the review row is created here, its work is scheduled and
   * runs asynchronously so the caller (and the tick) is never blocked.
   * @param {string} teamId
   * @param {string} taskId
   * @returns {any} the review task row when one exists/was created
   */
  onTaskFailed(teamId, taskId) {
    return onTaskFailedFrom(this, teamId, taskId);
  }

  /**
   * Create (once) the review task for one failure event and schedule it.
   * `autoRun: false` creates the row without starting it, so a contractor or an
   * operator can execute the review instead of the daemon.
   * @param {string} teamId
   * @param {any} task the failed task
   * @param {{ autoRun?: boolean }} [options]
   * @returns {any|undefined}
   */
  ensureRedReview(teamId, task, options = {}) {
    return ensureRedReviewFrom(this, teamId, task, options);
  }

  /**
   * Insert a hidden review row without re-validating the whole task graph.
   *
   * `addTask` validates the complete graph, so one unrelated row the gate
   * builder itself considers invalid (an empty repair scope, for example) would
   * make every later review creation throw and leave the red box unhandled.
   * The review row has no dependencies, no assignee and no link back into the
   * graph, so validating the row by itself is the correct contract.
   * @param {string} teamId
   * @param {any} input
   * @returns {any}
   */
  addRedReviewTask(teamId, input) {
    return addRedReviewTaskFrom(this, teamId, input);
  }

  /**
   * Record a failed review creation at most once per throttle window, so a
   * permanent graph problem cannot write an event on every tick while still
   * being visible in the summary.
   * @param {string} teamId
   * @param {string} reviewId
   * @param {string} taskId
   * @param {string} message
   */
  recordRedReviewCreateFailure(teamId, reviewId, taskId, message) {
    return recordRedReviewCreateFailureFrom(this, teamId, reviewId, taskId, message);
  }

  /**
   * Start the asynchronous review job. The returned promise is only used by
   * tests and by the contractor runner; normal callers ignore it.
   * @param {string} teamId
   * @param {string} reviewId
   * @param {any} [options]
   * @returns {Promise<any>|undefined}
   */
  scheduleRedReview(teamId, reviewId, options = {}) {
    return scheduleRedReviewFrom(this, teamId, reviewId, options);
  }

  /**
   * Wait for the reviews that are currently running (tests, shutdown).
   * @returns {Promise<Array<any>>}
   */
  async awaitRedReviews() {
    return awaitRedReviewsFrom(this);
  }

  /**
   * Resolve the identity that performs the automatic continue. Contractors run
   * the review as themselves (they hold the `red_auto_review` purpose); with no
   * contractor the daemon acts on its own as the captain's system identity.
   * @param {string} teamId
   * @param {string} [contractorId]
   * @returns {any|undefined}
   */
  redReviewActorFor(teamId, contractorId) {
    return redReviewActorForFrom(this, teamId, contractorId);
  }

  /**
   * The review's whole job: send "继续", count it, and stop at the limit.
   * @param {string} teamId
   * @param {string} reviewId
   * @param {{ contractorId?: string, actor?: any, force?: boolean }} [options]
   * @returns {Promise<any>}
   */
  async runRedReview(teamId, reviewId, options = {}) {
    return runRedReviewFrom(this, teamId, reviewId, options);
  }

  /**
   * A continue that was requested but never delivered: wait and retry without
   * consuming the three-continue budget. After `maxAttempts` the review gives
   * up and hands the problem to the captain instead of looping forever.
   * @param {string} teamId
   * @param {any} review
   * @param {any} task
   * @param {{ count?: number, sessionId?: string, error?: string }} [details]
   * @returns {any}
   */
  deferRedReview(teamId, review, task, details = {}) {
    return deferRedReviewFrom(this, teamId, review, task, details);
  }

  /**
   * Message the captain, mark the source task as escalated and stop.
   * @param {string} teamId
   * @param {any} review
   * @param {any} task
   * @param {{ count?: number, sessionId?: string, reason?: string, error?: string }} [details]
   * @returns {any}
   */
  escalateRedReview(teamId, review, task, details = {}) {
    return escalateRedReviewFrom(this, teamId, review, task, details);
  }

  /**
   * Close a review row. Reviews are hidden and always complete (they are a
   * bookkeeping record of one continue attempt, never a red node themselves).
   * @param {string} teamId
   * @param {any} review
   * @param {string} outcome
   * @param {any} [extra]
   * @returns {any}
   */
  finishRedReview(teamId, review, outcome, extra = {}) {
    return finishRedReviewFrom(this, teamId, review, outcome, extra);
  }

  /**
   * Recovery sweep, called from tick(): re-runs deferred reviews and creates
   * reviews for red tasks whose event was missed (daemon restart). Idempotent
   * through the deterministic review id.
   * @param {string} teamId
   * @returns {number} reviews created or resumed
   */
  sweepRedReviews(teamId) {
    return sweepRedReviewsFrom(this, teamId);
  }

  /**
   * Captain-facing summary of automatic reviews so a hidden row is never
   * silently dropped from the status view.
   * @param {string} teamId
   * @returns {any}
   */
  redReviewSummary(teamId) {
    return redReviewSummaryFrom(this, teamId);
  }

  /**
   * Whether a contractor may run the automatic review/continue. Ordinary
   * members never may; a contractor must carry the red-review purpose or the
   * explicit `task:continue` capability.
   * @param {any} contractor
   * @returns {boolean}
   */
  contractorCanRedReview(contractor) {
    return contractorCanRedReviewFrom(contractor);
  }

  /**
   * A contractor slot that runs the automatic review itself. No model session
   * is created: the review's only action is the "继续" send.
   * @param {string} teamId
   * @param {any} contractor
   * @returns {Promise<any>}
   */
  async runContractorRedReview(teamId, contractor) {
    return runContractorRedReviewFrom(this, teamId, contractor);
  }

  /**
   * Send "继续" for every active task whose automatic continue is due.
   * Called from tick(), so the daemon's 1s loop is the retry clock.
   * @param {string} teamId
   * @param {number} now
   * @returns {Promise<number>} number of messages sent
   */
  async continueDueTurns(teamId, now) {
    return continueDueTurnsFrom(this, teamId, now);
  }

  /**
   * Defer one due "继续" with bounded exponential backoff.
   *
   * Member-unavailable, cursor-unavailable and prompt-already-running used to
   * retry every 5 seconds with no cap, writing an event per attempt until the
   * two-hour lease expired. Deferrals now back off and stop after
   * CONTINUE_DEFER_LIMIT; the task is closed as failed so a captain/reviewer
   * can decide instead of the daemon spinning forever (F4).
   *
   * @param {string} teamId
   * @param {any} task current task row (must still own `attemptId`)
   * @param {string} attemptId
   * @param {string} reason
   * @param {{ member?: any, error?: string }} [details]
   * @returns {0}
   */
  deferContinue(teamId, task, attemptId, reason, details = {}) {
    return deferContinueFrom(this, teamId, task, attemptId, reason, details);
  }

  /**
   * Send one due "继续". Returns 1 when the message was sent, 0 otherwise.
   * @param {string} teamId
   * @param {any} task
   * @returns {Promise<number>}
   */
  async continueOneTask(teamId, task) {
    return continueOneTaskFrom(this, teamId, task);
  }

  memberPermissionModeFor(member) {
    const policy = member.license?.toolPolicy ?? member.toolPolicy ?? 'workspace-write';
    return memberPermissionMode({
      readOnly: policy === 'read-only',
      isolation: this.config.isolation,
      zcode: this.config.zcode,
    });
  }

  memberDisallowedToolsFor(member) {
    const policy = member.license?.toolPolicy ?? member.toolPolicy ?? 'workspace-write';
    return [
      ...(policy === 'read-only' ? ['Edit', 'Write', 'ApplyPatch', 'Bash', 'NotebookEdit'] : []),
      // A shadow is a control identity, never a worker: it must not regain
      // Bash/Edit through a later send (mail, continue or dispatch) after the
      // create-time denylist. The CLI/container adapters apply denylists per
      // send, so this list must be passed on every send path.
      ...(this.memberIsShadow(member) ? ['Bash', ...contractorWriteDenylist()] : []),
      ...pluginTeamToolDenylist(),
      ...modelPolicyToolDenylist(),
    ];
  }

  close() {
    for (const handle of this.turnWatchers.values()) handle?.cancel?.();
    this.turnWatchers.clear();
  }

  createTeam({ id, name, description, members = [], phase = 'staged', control = 'active' }, options = {}) {
    const configured = new Set((this.config.teams ?? []).map((team) => team.id));
    if (configured.size > 0 && !configured.has(id)) {
      throw new Error(`unknown team id "${id}"; configured ids: ${[...configured].join(', ')}`);
    }
    const selectedMembers = members.length > 0
      ? members
      : (this.features.lazyMembers ? [] : (this.roster[id] ?? []));
    const selectedRoster = selectedMembers.filter((member) => {
      const role = this.normalizeRole(member.role ?? 'engineer');
      return role !== 'shadow' && role !== 'lead';
    });
    if (selectedRoster.length > 32) throw new Error('a team cannot have more than 32 delivery members');
    const team = this.store.createTeam({
      id,
      name,
      description,
      phase,
      control,
      createdBy: options.actor?.name,
      createdByMemberId: options.actor?.memberId,
      requiredReviewers: [...(this.config.quality.reviewPolicy.requiredReviewers ?? [])],
      controlEpoch: 0,
      createdAt: this.now(),
    });
    for (const member of selectedMembers) this.addMember(id, member);
    this.store.savePlan(id, {
      status: phase === 'staged' ? 'staged' : 'approved',
      members: selectedMembers.map((member) => member.name),
      tasks: [],
      version: 1,
    });
    this.store.addEvent(id, 'team.created', { phase, control, lazyMembers: Boolean(this.features.lazyMembers) });
    return team;
  }

  addMember(teamId, input) {
    const team = this.store.getTeam(teamId);
    if (!team) throw new Error(`unknown team: ${teamId}`);
    const clean = this.sanitizeMemberInput(input);
    const configured = this.config.teams.find((item) => item.id === teamId);
    const max = configured?.maxMembers ?? 32;
    const controlSeat = ['shadow', 'lead'].includes(this.normalizeRole(clean.role));
    if (this.normalizeRole(clean.role) === 'lead') this.assertLeadSlotFree(teamId);
    const roster = this.rosterMembers(teamId);
    if (!controlSeat && roster.length >= max) {
      throw new Error(`team ${teamId} is at its member cap (${max})`);
    }
    if (this.normalizeRole(clean.role) === 'shadow') {
      const existing = this.findShadowMember();
      if (existing) {
        throw Object.assign(new Error(`a shadow already exists in team ${existing.teamId}: ${existing.name}`), {
          status: 409, code: 'E_SHADOW_EXISTS',
        });
      }
    }
    const member = this.store.addMember({
      teamId,
      ...clean,
      model: clean.model ?? this.config.zcode.defaultModel ?? null,
      reasoning: clean.reasoning ?? this.config.zcode.defaultReasoning ?? null,
      modelOverride: clean.model ?? null,
      reasoningOverride: clean.reasoning ?? null,
      workState: clean.workState ?? 'available',
      residency: clean.residency ?? 'cold',
    });
    const licensed = this.issueLicense(teamId, member, {
      roleKey: clean.role,
      label: clean.name,
      allowedTaskKinds: clean.allowedTaskKinds,
      pathScope: clean.pathScope,
      toolPolicy: clean.tool_policy ?? clean.toolPolicy,
    });
    this.ensureMemberToken(licensed);
    return licensed;
  }

  sanitizeMemberInput(input = {}) {
    const allowed = [
      'name', 'role', 'model', 'reasoning', 'toolPolicy', 'tool_policy',
      'allowedTaskKinds', 'pathScope', 'workState', 'residency', 'summary', 'summaryApproved',
    ];
    const clean = {};
    for (const key of allowed) {
      if (input[key] !== undefined) clean[key] = input[key];
    }
    return clean;
  }

  memberHomeRoot() {
    return this.homeRoot;
  }


  validateLicenseForTask(teamId, task) {
    const kind = task.kind ?? 'work';
    // The shadow is a control seat, never a delivery worker. This holds even
    // when the legacy license feature is disabled, where the role-kind checks
    // below do not run.
    if (this.normalizeRole(task.assigneeRole) === 'shadow') {
      throw new Error(`shadow cannot execute delivery kind ${kind}`);
    }
    if (task.assignee) {
      const assignee = this.store.findMember(teamId, task.assignee);
      if (assignee && this.memberIsShadow(assignee)) {
        throw new Error(`shadow ${task.assignee} cannot execute delivery kind ${kind}`);
      }
    }
    if (!this.features.licenses) return;
    // The automatic red-box review is executed by the daemon (or a red-review
    // contractor), never by a licensed member role.
    if (kind === RED_REVIEW_KIND) return;
    if (task.assigneeRole) {
      const defaults = this.roleDefaults(task.assigneeRole);
      if (!defaults.kinds.includes(kind)) {
        throw new Error(`role ${defaults.roleKey} cannot execute kind ${kind}`);
      }
    }
    if (task.assignee) {
      const member = this.store.findMember(teamId, task.assignee);
      const kinds = member?.license?.allowedTaskKinds;
      if (kinds && !kinds.includes(kind)) {
        throw new Error(`member ${task.assignee} license does not allow kind ${kind}`);
      }
    }
  }

  addTask(teamId, input = {}, options = {}) {
    this.assertTeamWritable(teamId, options, 'addTask');
    const raw = input ?? {};
    this.assertTaskContractAuthority(teamId, raw, options.actor);
    const clean = cleanTaskInput(raw, { internal: options.internal === true });
    const task = {
      dependencies: [],
      createdAt: this.now(),
      ...clean,
      // A caller can never seed a lifecycle, evidence or merge state.
      status: 'pending',
      teamId,
      id: clean.id ?? `task_${randomUUID()}`,
      taskEpoch: Number.isInteger(clean.taskEpoch) ? clean.taskEpoch : 0,
      controlEpoch: Number.isInteger(clean.controlEpoch) ? clean.controlEpoch : 0,
    };
    // V15 modeOf: a new deliverable is bound only when the daemon owns
    // worktrees; review/verification are always legacy rows whose binding is
    // expressed by review.reviewMode. Never infer from sourceCommit here.
    if (!task.mode) {
      task.mode = this.useWorktrees
        && ['implementation', 'repair', 'integration', 'work'].includes(task.kind ?? 'work')
        ? 'bound' : 'legacy';
    }
    if (task.kind === 'implementation') {
      task.deliveryUnitId = task.id;
      task.deliverySeq = 0;
    }
    // A repair created through the public API cannot carry a delivery unit
    // (those fields are internal). It must dispatch as a legacy repair, not as
    // a half-bound row that nextReady can never release.
    if (task.kind === 'repair' && !task.deliveryUnitId) task.mode = 'legacy';
    if (task.kind === 'repair' && !task.repairOrigin) task.repairOrigin = 'manual';
    if (this.features.lazyMembers && task.assignee === (this.config.captain.name ?? 'captain')) {
      throw new Error('captain is a control identity in v0.6; assign the task to a role instead');
    }
    if (this.features.lazyMembers && !task.assignee && task.kind !== RED_REVIEW_KIND) {
      task.assigneeRole = task.assigneeRole ?? this.roleForTask(task);
    }
    this.validateLicenseForTask(teamId, task);
    const members = this.store.listMembers(teamId);
    if (task.kind === 'review' && !task.assignee) {
      const reviewed = task.reviewedTaskId ? this.store.getTask(task.reviewedTaskId) : undefined;
      const required = this.config.quality.reviewPolicy.requiredReviewers ?? [];
      const candidate = required.find((name) => name !== reviewed?.assignee && members.some((member) => member.name === name));
      if (candidate) task.assignee = candidate;
    }
    const errors = validateTaskGraph([...this.store.listTasks(teamId), task], members, {
      teamIds: [teamId],
      requiredReviewers: this.config.quality.reviewPolicy.requiredReviewers ?? [],
      allowUnassigned: Boolean(this.features.lazyMembers),
    });
    if (errors.length > 0) throw new Error(`invalid task: ${errors.join('; ')}`);
    const created = this.store.addTask(task);
    this.store.addEvent(teamId, 'task.created', { taskId: created.id, kind: created.kind ?? 'work' });
    return created;
  }

  async worktreeBaseCheck(teamId, { force = false } = {}) {
    if (!this.useWorktrees) return { ready: true };
    const pending = this.store.listTasks(teamId).some((task) => task.status === 'pending');
    // No dispatchable work means no reason to create refs or spawn git.
    if (!pending) return { ready: true, skipped: 'no-pending-tasks' };
    const base = this.config.teams.find((team) => team.id === teamId)?.baseBranch ?? 'HEAD';
    const key = `${teamId}:${base}`;
    const now = this.now();
    const cached = this.worktreeBaseState.get(key);
    if (!force && cached && now < cached.nextCheckAt) return cached.result;
    try {
      const resolved = await ensureWorktreeBase({ repo: this.repo, base });
      // Recovery is visible after a restart too, where the cache is empty but
      // the persisted failure event remains.
      const lastBaseEvent = cached === undefined
        ? [...this.store.listEvents(teamId)].reverse()
          .find((event) => ['worktree.base_missing', 'worktree.base_recovered', 'worktree.base_created'].includes(event.type)
            && (!event.base || event.base === resolved.base))
        : undefined;
      const recovered = cached?.ok === false || lastBaseEvent?.type === 'worktree.base_missing';
      const result = { ready: true, base: resolved.base, commit: resolved.commit, ref: resolved.ref };
      const backoff = this.worktreeBaseCheckMs;
      this.worktreeBaseState.set(key, { ok: true, result, failures: 0, nextCheckAt: now + backoff });
      if (resolved.created) {
        this.store.addEvent(teamId, 'worktree.base_created', {
          base: resolved.base,
          commit: resolved.commit,
          reason: 'empty repository; created an empty baseline ref',
        });
      } else if (recovered) {
        this.store.addEvent(teamId, 'worktree.base_recovered', { base: resolved.base, commit: resolved.commit });
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failures = (cached?.failures ?? 0) + 1;
      // Keep the retry window short enough that fixing the base shows up
      // quickly without a manual restart; approve() also forces a recheck.
      const backoff = Math.min(
        Math.max(this.worktreeBaseCheckMs, 5000) * 2 ** Math.min(failures - 1, 5),
        60000,
      );
      const result = { ready: false, base, error: message, blocked: 'worktree-base-missing' };
      this.worktreeBaseState.set(key, { ok: false, result, failures, nextCheckAt: now + backoff });
      // One event per outage, not one per retry.
      if (cached?.ok !== false) {
        this.store.addEvent(teamId, 'worktree.base_missing', { base, error: message });
      }
      return result;
    }
  }

  deferTransientTick(teamId, error) {
    return deferTransientTickFrom(this, teamId, error);
  }

  async tick(teamId) {
    return tickFrom(this, teamId);
  }

  async tickUnlocked(teamId) {
    return tickUnlockedFrom(this, teamId);
  }

  async tickAll() {
    return tickAllFrom(this);
  }

  /**
   * Commit a completed worktree artifact under the trusted fence. Called only
   * after acceptance/verify/license validation and before the completion row is
   * written. On failure the task is held, never completed.
   */
  assertAttemptEpoch(task, attemptId) {
    const attempt = this.store.getAttempt(attemptId);
    if (!attempt) return;
    const team = this.store.getTeam(task.teamId);
    if (Number.isInteger(attempt.taskEpoch) && attempt.taskEpoch !== (task.taskEpoch ?? 0)) {
      throw Object.assign(new Error('stale attempt: task epoch changed'), { status: 409, code: 'E_STALE_EPOCH' });
    }
    if (Number.isInteger(attempt.controlEpoch) && attempt.controlEpoch !== (team?.controlEpoch ?? 0)) {
      throw Object.assign(new Error('stale attempt: team control epoch changed'), { status: 409, code: 'E_STALE_EPOCH' });
    }
  }

  async commitNonDeliveryArtifact(teamId, task) {
    const attemptId = task.lastAttemptId ?? task.attemptId;
    const base = task.sourceBase ?? task.worktreeBase;
    let inScope = Array.isArray(task.inScope) ? [...task.inScope] : [];
    if (!attemptId || !base) {
      return { ok: false, needsCaptain: true,
        error: 'non-delivery merge requires a base and attempt; refusing an unscoped commit' };
    }
    if (inScope.length === 0) {
      // Advisory/non-delivery tasks may not declare a scope. Use the actual
      // changed paths as the allowed set; outOfScope and sensitive-path checks
      // still apply in inspectArtifact.
      inScope = await deriveChangedPaths({ worktree: task.worktree, baseRef: base });
      if (inScope.length === 0) return { ok: false, reason: 'no changes' };
    }
    if (typeof this.artifactFenceProvider?.acquire !== 'function') {
      return { ok: false, needsCaptain: true, code: 'E_ARTIFACT_FENCE',
        error: 'trusted exclusive worktree fence is unavailable' };
    }
    try {
      const fence = await this.artifactFenceProvider.acquire({
        worktree: task.worktree, base, teamId, taskId: task.id, attemptId,
      });
      const artifact = await commitArtifactBeforeReview({
        worktree: task.worktree, base, inScope, outOfScope: task.outOfScope ?? [],
        teamId, taskId: task.id, attemptId, fence, requireProvenance: false,
      });
      return { ok: true, ...artifact, commit: artifact.sourceCommit };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A scoped work task whose worktree simply contains no changes is a
      // successful no-op, not a blocked closeout.
      if (message === 'contract_error: no_changes') return { ok: false, reason: 'no changes' };
      return { ok: false, code: error.code ?? 'E_ARTIFACT_COMMIT', error: message };
    }
  }

  async commitCompletionArtifact({ teamId, taskId, attemptId, task }) {
    const base = task.kind === 'repair' && task.sourceBase ? task.sourceBase : (task.sourceBase ?? task.worktreeBase);
    const acceptedProvenanceAttempts = this.store.listAttempts(teamId)
      .filter((attempt) => attempt.taskId === taskId && attempt.id !== attemptId
        && ['orphaned', 'halted', 'failed', 'cancelled'].includes(attempt.status))
      .map((attempt) => attempt.id);
    try {
      if (typeof this.artifactFenceProvider?.acquire !== 'function') {
        throw Object.assign(new Error('trusted exclusive worktree fence is unavailable'), {
          code: 'E_ARTIFACT_FENCE', reason: 'exclusive_worktree_fence_unavailable',
        });
      }
      const fence = await this.artifactFenceProvider.acquire({
        worktree: task.worktree, base, teamId, taskId, attemptId,
      });
      return {
        ok: true,
        artifact: await commitArtifactBeforeReview({
          worktree: task.worktree, base,
          inScope: task.inScope ?? [], outOfScope: task.outOfScope ?? [],
          teamId, taskId, attemptId, fence, acceptedProvenanceAttempts,
        }),
      };
    } catch (failure) {
      const current = this.store.getTask(taskId);
      if (current?.attemptId === attemptId && !TERMINAL_STATUSES.has(current.status)) {
        this.store.transaction(() => {
          this.store.updateTask(taskId, {
            hold: { class: 'artifact_commit', reason: failure.code === 'E_ARTIFACT_FENCE'
              ? 'exclusive_worktree_fence_unavailable' : 'artifact_commit_failed',
              attemptId, escalated: true },
            needsCaptain: true,
          });
          this.store.addEvent(teamId, 'task.artifact_commit_failed', {
            taskId, attemptId, error: failure instanceof Error ? failure.message : String(failure),
            code: failure.code,
          });
          this.store.updateTeam(teamId, { needsCaptain: true });
        });
      }
      return {
        ok: false,
        code: failure.code ?? 'E_ARTIFACT_COMMIT',
        error: failure instanceof Error ? failure.message : String(failure),
      };
    }
  }

  prepareTaskCompletion(args) {
    return prepareTaskCompletion({ service: this, terminalStatuses: TERMINAL_STATUSES, ...args });
  }

  persistInProgressCompletion(args) {
    return persistInProgressCompletion({ service: this, ...args });
  }

  normalizeCompletionUpdate(task, safeUpdate) {
    const reviewedTask = task.kind === 'review' && safeUpdate.reviewResult !== undefined
      ? this.store.getTask(task.reviewedTaskId) : undefined;
    return normalizeReviewCompletion(task, safeUpdate, reviewedTask);
  }

  runCompletionVerification(args) {
    return runCompletionVerification({ service: this, ...args });
  }

  bindCompletionReviewSnapshot(args) {
    return bindReviewSnapshot({ service: this, ...args });
  }

  deriveCompletionChangedPaths(args) {
    return deriveImplementationChangedPaths({ service: this, ...args });
  }

  isCurrentCompletion(taskId, attemptId) {
    return Boolean(completionIsCurrent(this, taskId, attemptId));
  }

  currentCompletionTask(taskId, attemptId) {
    return completionIsCurrent(this, taskId, attemptId);
  }

  validateCompletionEvidence(args) {
    return validateCompletionEvidence({ service: this, ...args });
  }

  persistTaskCompletion(args) {
    return persistTaskCompletion({ service: this, ...args });
  }

  runTaskCompletionFollowUps(args) {
    return runTaskCompletionFollowUps({ service: this, ...args });
  }

  async collectCompletionEvidence(args) {
    return collectCompletionEvidence({ service: this, ...args });
  }

  async completeTask({ teamId, taskId, attemptId, update, actor }) {
    const prepared = this.prepareTaskCompletion({ teamId, taskId, attemptId, update, actor });
    const { task, safeUpdate } = prepared;
    attemptId = prepared.attemptId;
    if (safeUpdate.status === 'in_progress') {
      return this.persistInProgressCompletion({ teamId, taskId, attemptId, safeUpdate });
    }

    const workdir = task.worktree ?? this.cwd;
    const evidence = await this.collectCompletionEvidence({ task, attemptId, safeUpdate, workdir });
    if (evidence.ok === false) return evidence;
    const effectiveUpdate = evidence.effectiveUpdate;
    const validation = this.validateCompletionEvidence({ teamId, taskId, attemptId, effectiveUpdate });
    if (!validation.ok) return validation;
    let currentTask = validation.currentTask;

    const requiresArtifactCommit = task.worktree
      && ['implementation', 'repair'].includes(task.kind)
      && effectiveUpdate.status === 'completed'
      && (task.mode === 'bound' || task.mode === 'legacy' || this.useWorktrees);
    if (requiresArtifactCommit) {
      const artifactResult = await this.commitCompletionArtifact({ teamId, taskId, attemptId, task });
      if (!artifactResult.ok) return artifactResult;
      if (!this.isCurrentCompletion(taskId, attemptId)) {
        return { ok: false, error: 'stale attempt: task changed during artifact commit' };
      }
      if (!Array.isArray(artifactResult.artifact?.changedPaths) || artifactResult.artifact.changedPaths.length === 0) {
        return { ok: false, error: 'artifact commit did not prove actual changed paths' };
      }
      Object.assign(effectiveUpdate, {
        sourceBase: artifactResult.artifact.sourceBase,
        sourceCommit: artifactResult.artifact.sourceCommit,
        diffHash: artifactResult.artifact.diffHash,
        changedPaths: artifactResult.artifact.changedPaths,
        bindingState: 'ready',
      });
      const committedValidation = this.validateCompletionEvidence({ teamId, taskId, attemptId, effectiveUpdate });
      if (!committedValidation.ok) return committedValidation;
      currentTask = committedValidation.currentTask;
    }

    const closed = this.persistTaskCompletion({ teamId, taskId, attemptId, currentTask, effectiveUpdate });
    return this.runTaskCompletionFollowUps({
      teamId, taskId, task: currentTask, closed, status: effectiveUpdate.status,
    });
  }

  /**
   * One closed-loop step for a task that just became terminal. The planner
   * reads the persisted task list, so the same call after a restart, after a
   * repeated tick, or after a review retry resolves to the same answer.
   * Each team serializes planning and application, including asynchronous steps.
   * @param {string} teamId
   * @param {any} task
   */
  async withClosedLoopLock(teamId, action) {
    return withClosedLoopLockFrom(this, teamId, action);
  }

  async applyClosedLoop(teamId, task) {
    return applyClosedLoopFrom(this, teamId, task);
  }

  /**
   * Archive legacy reviews bound to an older source commit. The caller replans
   * immediately, so the task does not stop for a human merely because its
   * artifact changed after the review was written.
   */
  supersedeLegacyReviews(teamId, task, plan) {
    return supersedeLegacyReviewsFrom(this, teamId, task, plan);
  }

  async applyClosedLoopUnlocked(teamId, task) {
    return applyClosedLoopUnlockedFrom(this, teamId, task);
  }

  /**
   * Create several planned follow-ups in dependency order. Each row is created
   * independently: a failure on one (say a member cap) is recorded and does not
   * drop the others, because they run in parallel.
   * @param {string} teamId
   * @param {Array<any>} planned
   * @param {any} anchorTask
   */
  createLoopTasks(teamId, planned, anchorTask) {
    return createLoopTasksFrom(this, teamId, planned, anchorTask);
  }

  loopEventFor(task) {
    return loopEventForFrom(this, task);
  }

  createLoopTask(teamId, planned, eventType, anchorTask) {
    return createLoopTaskFrom(this, teamId, planned, eventType, anchorTask);
  }

  escalateClosedLoop(teamId, task, { reason, round, findings } = {}) {
    return escalateClosedLoopFrom(this, teamId, task, { reason, round, findings });
  }

  publicationRetryDeferred(teamId, taskId) {
    return publicationRetryDeferredFrom(this, teamId, taskId);
  }

  recordPublicationWriteBlocked(teamId, taskId, error, options = {}) {
    return recordPublicationWriteBlockedFrom(this, teamId, taskId, error, options);
  }

  recomputeTeamNeedsCaptain(teamId) {
    return recomputeTeamNeedsCaptainFrom(this, teamId);
  }

  /**
   * V15 adopt: completed bound work that predates commit-before-review has no
   * sourceCommit. Adopt it only through the same trusted fence contract used by
   * completion; when the fence is unavailable, persist a visible blocked state
   * instead of inventing a commit or merging the worktree HEAD at merge time.
   */
  async adoptPendingCandidates(options = {}) {
    return adoptPendingCandidatesFrom(this, options);
  }

  async adoptPendingCandidatesUnlocked(teams) {
    return adoptPendingCandidatesUnlockedFrom(this, teams);
  }

  async closeoutCompletedWork({ teamId = null, taskId = null } = {}) {
    const teams = teamId
      ? [this.store.getTeam(teamId)].filter(Boolean)
      // Archived teams are read-only history; opening commits in their old
      // worktrees would mutate a closed workspace during every startup.
      : this.store.listTeams(false);
    const closed = [];
    for (const team of teams) {
      if (!team) continue;
      for (const task of this.store.listTasks(team.id)) {
        if (taskId && task.id !== taskId) continue;
        if (task.kind !== 'work' || task.status !== 'completed' || !task.worktree
          || task.sourceCommit || task.noChanges === true || task.mergeState === 'merged') continue;
        const artifact = await this.commitNonDeliveryArtifact(team.id, task);
        if (artifact.ok) {
          this.store.updateTask(task.id, {
            sourceBase: artifact.sourceBase,
            sourceCommit: artifact.sourceCommit,
            diffHash: artifact.diffHash,
            changedPaths: artifact.changedPaths,
            bindingState: 'not_applicable',
            noChanges: false,
          });
          this.store.addEvent(team.id, 'task.work_closeout', {
            taskId: task.id, sourceCommit: artifact.sourceCommit,
          });
          closed.push(task.id);
        } else if (artifact.reason === 'no changes') {
          this.store.updateTask(task.id, { noChanges: true, bindingState: 'not_applicable' });
          this.store.addEvent(team.id, 'task.work_closeout_no_changes', { taskId: task.id });
        } else {
          this.store.addEvent(team.id, 'task.work_closeout_blocked', { taskId: task.id, error: artifact.error });
        }
      }
    }
    return { closed };
  }

  /**
   * Reclaim task worktrees that no longer need to exist.
   *
   * SPEC promises `merged/abandoned + 24h` cleanup and a six-worktree active
   * ceiling; before this method existed nothing removed a task checkout after
   * it reached a terminal state, so the directory count grew without bound.
   * The reclaimer never deletes a dirty checkout and never uses `--force`.
   *
   * Orphan sweeping (directories no task references) is opt-in and requires a
   * persisted store: an in-memory test service shares the real workspace `cwd`,
   * where an unscoped sweep would delete the operator's checkouts.
   *
   * @param {{ ttlHours?: number, maxActive?: number, allowOrphanSweep?: boolean, disabled?: boolean }} [options]
   * @returns {Promise<{
   *   removed: string[],
   *   skipped: Array<{ path: string, reason: string }>,
   *   errors: Array<{ path: string, stage?: string, error: string }>,
   *   active: number, remaining: number, freedDirs: number,
   *   overCapacity: boolean, pinned: number, protected: number, pinnedOverCapacity: number,
   *   byTeam: Record<string, { removedDirs: number, removedTasks: number, skippedDirs: number, skippedTasks: number, errors: number,
   *     pinned: number, protected: number, active: number, remaining: number, pinnedOverGlobalCeiling: number }>,
   * }>} `removed`/`skipped` count directories; `byTeam` counts both, because a
   *   directory can be shared by several tasks. The per-team
   *   `pinnedOverGlobalCeiling` is measured against the *global* `maxActive`
   *   ceiling, not a per-team quota (the project has none); the global
   *   `pinnedOverCapacity` aggregates the same overage across teams.
   */
  async reclaimWorktrees(options = {}) {
    if (options.disabled === true) {
      return { removed: [], skipped: [], errors: [], active: 0, pinned: 0, protected: 0,
        remaining: 0, freedDirs: 0, overCapacity: false, pinnedOverCapacity: 0, byTeam: {} };
    }
    // Serialize all reclaim passes against the same repository, but never merge
    // options: each caller runs its own pass after the previous pass settles.
    // A later allowOrphanSweep=true call must not disappear behind a weaker
    // in-flight pass whose report it would otherwise inherit.
    const repoPath = resolve(this.repo || this.cwd || process.cwd());
    let repoKey;
    try {
      repoKey = realpathSync.native(repoPath);
    } catch {
      repoKey = repoPath;
    }
    if (process.platform === 'win32') repoKey = repoKey.toLowerCase();
    const previous = WORKTREE_RECLAIM_QUEUES.get(repoKey) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(() => this.reclaimWorktreesOnce(options));
    WORKTREE_RECLAIM_QUEUES.set(repoKey, pending);
    try {
      return await pending;
    } finally {
      if (WORKTREE_RECLAIM_QUEUES.get(repoKey) === pending) WORKTREE_RECLAIM_QUEUES.delete(repoKey);
    }
  }

  async reclaimWorktreesOnce(options) {
    const scheduler = this.config?.scheduler ?? {};
    const report = await reclaimWorktrees({
      repo: this.repo,
      cwd: this.cwd,
      store: this.store,
      now: this.now(),
      ttlHours: options.ttlHours ?? scheduler.worktreeTtlHours ?? undefined,
      maxActive: options.maxActive ?? scheduler.maxConcurrentWorktrees ?? undefined,
      allowOrphanSweep: options.allowOrphanSweep === true,
    });
    // `events.team_id` is NOT NULL, so a summary has to be attributed to a real
    // team. Emit for every team represented in the final reference snapshot,
    // including fully pinned teams where cleanup changed nothing.
    for (const [teamId, counts] of Object.entries(report.byTeam ?? {})) {
      try {
        this.store.addEvent(teamId, 'worktree.reclaim_summary', {
          ...counts,
          totalActive: report.active,
          totalPinned: report.pinned,
          totalProtected: report.protected,
          totalRemaining: report.remaining,
          pinnedOverCapacity: report.pinnedOverCapacity,
        });
      } catch (error) {
        report.logErrors = [...(report.logErrors ?? []), {
          teamId, error: error instanceof Error ? error.message : String(error),
        }];
      }
    }
    return report;
  }

  /**
   * Re-scan a team for closed-loop gaps: a completed implementation/repair
   * without a review, or a failed review without a repair and without an
   * escalation. Runs on every tick and after a restart; creation is idempotent
   * because the task ids are deterministic and existing rows win.
   * @param {string} teamId
   */
  async reconcileClosedLoop(teamId) {
    return reconcileClosedLoopFrom(this, teamId);
  }

  async reconcileClosedLoopUnlocked(teamId) {
    return reconcileClosedLoopUnlockedFrom(this, teamId);
  }

  reconcilePostMergeRepairs(teamId) {
    return reconcilePostMergeRepairsFrom(this, teamId);
  }

  /**
   * Recover work whose member session went idle or dropped after the evidence
   * was already recorded, instead of failing or stalling a task that is in
   * fact done. A missing session or expired lease only triggers consideration;
   * attempt-specific termination proof is required before recovery. Completion
   * still goes through the daemon-owned verify gate and the closed loop.
   * @param {string} teamId
   * @returns {Promise<string[]>} recovered task ids
   */
  async recoverEvidenceBackedTasks(teamId) {
    return recoverEvidenceBackedTasksFrom(this, teamId);
  }

  /**
   * Pause lower-priority work so a critical-chain task can use the slot or the
   * only eligible member. The paused task keeps its worktree, its evidence and
   * a `preemptedBy` marker; the next dispatch copies uncommitted changes back.
   * @param {string} teamId
   * @param {Array<any>} tasks
   * @param {number} now
   * @returns {string[]} paused task ids
   */
  preemptForCriticalWork(teamId, tasks, now) {
    const plan = planPreemption({
      tasks,
      members: this.store.listMembers(teamId),
      slots: this.config.scheduler.activeWorkerSlots,
      now,
    });
    const paused = [];
    for (const item of plan) {
      const task = this.store.getTask(item.taskId);
      if (!task || !ACTIVE_STATUSES.has(task.status) || !task.attemptId) continue;
      this.store.updateAttempt(task.attemptId, {
        status: 'cancelled',
        endedAt: now,
        error: `preempted by ${item.forTaskId}`,
      });
      const releaseMember = this.features.lazyMembers;
      this.store.updateTask(task.id, {
        status: 'pending',
        attemptId: undefined,
        leaseExpiresAt: undefined,
        reassigning: false,
        handoffId: undefined,
        handoffFromMemberId: undefined,
        retryNotBefore: now,
        preempted: true,
        preemptedBy: item.forTaskId,
        preemptedFrom: task.assignee,
        preemptedAt: now,
        preemptionCount: Number(task.preemptionCount ?? 0) + 1,
        ...(releaseMember
          ? { assignee: undefined, assigneeId: undefined, licenseId: undefined }
          : {}),
      });
      this.store.addEvent(teamId, 'task.preempted', {
        taskId: task.id,
        byTaskId: item.forTaskId,
        reason: item.reason,
        attemptId: task.attemptId,
        assignee: task.assignee,
      });
      if (task.assignee) {
        const member = this.store.findMember(teamId, task.assignee);
        if (member) {
          // The member is released now, not merely between turns: the critical
          // task must be able to claim it in this same tick.
          this.store.updateMember(member.id, {
            status: 'idle', lastActiveAt: now,
          });
          this.refreshMemberState(teamId, member.id);
        }
      }
      paused.push(task.id);
    }
    return paused;
  }

  async approve(teamId, options = {}) {
    const team = this.store.getTeam(teamId);
    if (!team) throw new Error(`unknown team: ${teamId}`);
    if (team.phase !== 'staged') return { ok: false, status: 'not_staged' };
    // SPEC 2.3.1 / INV-027: a shadow cannot approve the plan it created.
    // Compare memberId when available so a later rename cannot bypass it;
    // the admin/captain token remains the human approval path.
    const sameCreator = options.actor?.role === 'member' && (
      (team.createdByMemberId && options.actor.memberId && team.createdByMemberId === options.actor.memberId)
      || (!team.createdByMemberId && team.createdBy === options.actor.name)
    );
    if (sameCreator) {
      throw Object.assign(new Error('a shadow cannot approve the plan it created'), {
        status: 403, code: 'E_FORBIDDEN',
      });
    }
    this.store.updateTeam(teamId, { phase: 'running', control: 'active', approvedAt: this.now() });
    this.store.savePlan(teamId, { ...(this.store.getPlan(teamId) ?? {}), status: 'approved', approvedAt: this.now() });
    this.store.addEvent(teamId, 'team.plan.approved', {});
    let base;
    try {
      // Force the base recheck before tick so a base created after earlier
      // failures can dispatch on this approval instead of waiting for backoff.
      base = await this.worktreeBaseCheck(teamId, { force: true });
      await this.tick(teamId);
    } catch (error) {
      this.store.updateTeam(teamId, { phase: 'staged', control: 'active' });
      throw error;
    }
    return {
      ok: true,
      team: this.store.getTeam(teamId),
      // Approved but unable to dispatch: surface the blocker instead of
      // reporting a healthy run that never starts a task.
      ...(base.ready ? {} : { blocked: base.blocked, error: base.error }),
    };
  }

  async stopCaptainSession(team, reason) {
    if (!team?.captainSessionId) return;
    let stopError;
    try {
      const result = await this.adapter.stop({ sessionId: team.captainSessionId });
      if (result?.ok !== true) stopError = result?.warning ?? result?.error ?? 'adapter did not confirm stop';
    } catch (error) {
      stopError = error instanceof Error ? error.message : String(error);
    }
    if (!stopError) {
      try {
        const result = await this.adapter.close?.({ sessionId: team.captainSessionId });
        if (result?.ok !== true) stopError = result?.warning ?? result?.error ?? 'adapter did not confirm close';
      } catch (error) {
        stopError = error instanceof Error ? error.message : String(error);
      }
    }
    const current = this.store.getTeam(team.id);
    if (stopError) {
      this.store.updateTeam(team.id, { captainStopError: stopError, needsCaptain: true });
    } else if (current?.captainSessionId === team.captainSessionId) {
      this.store.updateTeam(team.id, { captainSessionId: undefined, captainStopError: undefined });
    }
    this.store.addEvent(team.id, stopError ? 'captain.stop_failed' : 'captain.stopped', {
      sessionId: team.captainSessionId, reason, error: stopError,
    });
  }

  async halt(teamId, reason = 'human halt') {
    const team = this.store.getTeam(teamId);
    if (!team) throw new Error(`unknown team: ${teamId}`);
    this.store.updateTeam(teamId, {
      control: 'halted', haltedAt: this.now(), haltReason: reason,
      controlEpoch: (team.controlEpoch ?? 0) + 1,
    });
    await this.stopCaptainSession(team, `team-halted: ${reason}`);
    for (const task of this.store.listTasks(teamId)) {
      if (['completed', 'failed', 'cancelled'].includes(task.status)) continue;
      if (task.attemptId) {
        this.store.updateAttempt(task.attemptId, {
          status: 'halted', endedAt: this.now(), error: `team halted: ${reason}`,
        });
      }
      this.store.updateTask(task.id, {
        status: 'pending',
        priorStatus: task.status,
        priorAttemptId: task.attemptId,
        attemptId: undefined,
        leaseExpiresAt: undefined,
        reassigning: false,
        parked: false,
        haltedAt: this.now(),
        taskEpoch: (task.taskEpoch ?? 0) + 1,
        controlEpoch: (team.controlEpoch ?? 0) + 1,
      });
    }
    for (const member of this.store.listMembers(teamId)) {
      let stopError;
      if (member.sessionId) {
        try {
          const result = await this.adapter.stop({ sessionId: member.sessionId });
          if (result?.ok === false) stopError = result.warning ?? 'adapter did not confirm stop';
        } catch (error) {
          stopError = error instanceof Error ? error.message : String(error);
        }
      }
      if (member.status !== 'removed') {
        this.store.updateMember(member.id, {
          ...(stopError ? {} : { sessionId: undefined }),
          status: 'idle',
          workState: 'waiting',
          residency: 'cold',
          ...(this.memberIsShadow(member)
            ? {
              shadowState: stopError ? 'stop_failed' : 'stopped',
              shadowStoppedAt: this.now(),
              shadowLastActiveAt: undefined,
              shadowLastError: stopError,
            }
            : {}),
        });
      }
      if (this.memberIsShadow(member)) {
        this.store.addEvent(teamId, 'shadow.stopped', {
          memberId: member.id, reason: `team-halted: ${reason}`, error: stopError,
        });
      }
    }
    this.store.addEvent(teamId, 'team.halted', { reason });
    return { ok: true };
  }

  async resume(teamId, reason) {
    if (typeof reason !== 'string' || !reason.trim()) throw new Error('resume requires a non-empty reason');
    const team = this.store.getTeam(teamId);
    if (!team) throw new Error(`unknown team: ${teamId}`);
    this.store.updateTeam(teamId, {
      control: 'active', haltedAt: undefined, haltReason: undefined,
      controlEpoch: (team.controlEpoch ?? 0) + 1,
    });
    this.store.addEvent(teamId, 'team.resumed', { reason });
    await this.tick(teamId);
    return { ok: true };
  }

  reclaimMemberHomes() {
    return reclaimMemberHomes({
      root: this.memberHomeRoot(), workspace: this.cwd,
      hasMember: (id) => Boolean(this.store.getMember(id)),
      onEvent: (teamId, type, data) => this.store.addEvent(teamId, type, data),
    });
  }

  purgeMemberHome(member) {
    if (!member?.id || !member.teamId) return;
    const target = resolve(member.home ?? join(this.memberHomeRoot(), member.teamId, member.id));
    const allowedRoots = [
      this.memberHomeRoot(),
      join(this.cwd, '.agent-teams-homes'),
    ].map((root) => `${resolve(root)}${sep}`);
    if (!allowedRoots.some((root) => target.startsWith(root))) {
      this.store.addEvent(member.teamId, 'member.home_cleanup_refused', {
        memberId: member.id,
        home: member.home,
        reason: 'home is outside the managed homes root',
      });
      return;
    }
    try {
      if (existsSync(target) && (lstatSync(target).isSymbolicLink()
        || !allowedRoots.some((root) => `${realpathSync(target)}${sep}`.startsWith(root)))) {
        throw new Error('home resolves outside the managed root or is a link');
      }
      rmSync(target, { recursive: true, force: true });
    } catch (error) {
      this.store.addEvent(member.teamId, 'member.home_cleanup_failed', {
        memberId: member.id,
        home: member.home,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async archive(teamId) {
    const team = this.store.getTeam(teamId);
    if (!team) throw new Error(`unknown team: ${teamId}`);
    await this.stopCaptainSession(team, 'team-archived');
    for (const member of this.store.listMembers(teamId)) {
      let stopError;
      if (member.sessionId) {
        try {
          const result = await this.adapter.stop({ sessionId: member.sessionId });
          if (result?.ok === false) stopError = result.warning ?? 'adapter did not confirm stop';
        } catch (error) {
          stopError = error instanceof Error ? error.message : String(error);
        }
        if (!stopError) {
          try { await this.adapter.close?.({ sessionId: member.sessionId }); } catch { /* best effort */ }
        }
      }
      if (this.memberIsShadow(member)) {
        this.store.updateMember(member.id, {
          sessionId: stopError ? member.sessionId : undefined,
          shadowState: stopError ? 'stop_failed' : 'stopped',
          shadowStoppedAt: this.now(),
          shadowLastActiveAt: undefined,
          shadowLastError: stopError,
        });
        this.store.addEvent(teamId, 'shadow.stopped', {
          memberId: member.id, reason: 'team-archived', error: stopError,
        });
      }
      if (!stopError) this.purgeMemberHome(member);
      else this.store.addEvent(teamId, 'member.home_cleanup_deferred', { memberId: member.id, reason: stopError });
    }
    return this.store.archiveTeam(teamId);
  }

  audit(teamId) {
    const team = this.store.getTeam(teamId);
    if (!team) throw new Error(`unknown team: ${teamId}`);
    // Hidden rows (automatic red-box reviews) are bookkeeping, not deliverables:
    // they never carry evidence and must not appear as audit blockers.
    const tasks = this.store.listTasks(teamId).filter((task) => task.hidden !== true);
    const result = deliveryAudit({ ...team, tasks }, {
      allowSelfReview: !this.config.quality.requireIndependentReview,
    });
    if (this.useWorktrees && tasks.some((task) => task.status === 'pending')) {
      const base = this.config.teams.find((item) => item.id === teamId)?.baseBranch ?? 'HEAD';
      const cached = this.worktreeBaseState.get(`${teamId}:${base}`);
      // After a restart the in-memory cache is empty but the event survives.
      // Only the latest base event counts, so a stale failure is not reported
      // after a recovery.
      const baseEvents = [...this.store.listEvents(teamId)].reverse()
        .filter((event) => ['worktree.base_missing', 'worktree.base_recovered', 'worktree.base_created'].includes(event.type));
      const lastBaseEvent = baseEvents.find((event) => event.base === base) ?? baseEvents[0];
      const recorded = cached?.ok === false || lastBaseEvent?.type !== 'worktree.base_missing'
        ? undefined
        : lastBaseEvent;
      const baseError = cached?.ok === false ? cached.result.error : recorded?.error;
      if (baseError) {
        result.ok = false;
        result.blockers.push(`worktree base ${base} is missing: ${baseError}`);
      }
    }
    return result;
  }

  memberPrompt(team, member) {
    return buildMemberPrompt(this.store, team, member);
  }

  taskPrompt(team, task, attemptId) {
    return buildTaskPrompt(team, task, attemptId);
  }


  editPlan(teamId, plan = {}) {
    const team = this.store.getTeam(teamId);
    if (!team) throw new Error(`unknown team: ${teamId}`);
    if (team.phase !== 'staged') throw new Error('only a staged plan can be edited');
    const existingMembers = this.store.listMembers(teamId);
    const plannedMembers = [];
    for (const member of plan.members ?? []) {
      if (existingMembers.some((item) => item.name === member.name)) continue;
      if (plannedMembers.some((item) => item.name === member.name)) throw new Error(`duplicate planned member: ${member.name}`);
      plannedMembers.push({ teamId, ...this.sanitizeMemberInput(member) });
    }
    const plannedRoster = plannedMembers.filter((member) => {
      const role = this.normalizeRole(member.role ?? 'engineer');
      return role !== 'shadow' && role !== 'lead';
    });
    if (this.rosterMembers(teamId).length + plannedRoster.length > 32) {
      throw new Error('a team cannot have more than 32 delivery members');
    }
    const plannedTasks = (plan.tasks ?? []).map((task) => {
      // Plan input is public input even when a shadow edits it. Reuse the
      // same allowlist as addTask instead of spreading caller fields over a
      // forced lifecycle, and force the server-owned fields last.
      const clean = cleanTaskInput(task, { internal: false });
      return {
        ...clean,
        status: 'pending',
        dependencies: clean.dependencies ?? [],
        teamId,
        createdAt: this.now(),
        ...(this.features.lazyMembers && !clean.assignee
          ? { assigneeRole: clean.assigneeRole ?? this.roleForTask(clean) }
          : {}),
      };
    });
    for (const task of plannedTasks) this.validateLicenseForTask(teamId, task);
    const requiredReviewers = this.config.quality.reviewPolicy.requiredReviewers ?? [];
    const errors = validateTaskGraph(
      [...this.store.listTasks(teamId), ...plannedTasks],
      [...existingMembers, ...plannedMembers],
      { teamIds: [teamId], requiredReviewers, allowUnassigned: Boolean(this.features.lazyMembers) },
    );
    if (errors.length > 0) throw new Error(`invalid plan: ${errors.join('; ')}`);

    this.store.transaction(() => {
      for (const member of plan.members ?? []) {
        const existing = this.store.findMember(teamId, member.name);
        if (existing) {
          this.store.updateMember(existing.id, this.sanitizeMemberInput(member));
          if (this.features.licenses && !existing.license) {
            this.issueLicense(teamId, this.store.getMember(existing.id), { roleKey: member.role, label: member.name });
            this.ensureMemberToken(this.store.getMember(existing.id));
          }
        } else {
          this.addMember(teamId, member);
        }
      }
      for (const task of plannedTasks) this.store.addTask(task);
      const current = this.store.getPlan(teamId) ?? {};
      this.store.savePlan(teamId, { ...current, ...plan, status: 'staged', version: (current.version ?? 0) + 1 });
      this.store.addEvent(teamId, 'team.plan.edited', { members: plan.members?.length ?? 0, tasks: plannedTasks.length });
    });
    return this.store.getTeam(teamId);
  }

  discardPlan(teamId, reason = 'discarded by user') {
    const team = this.store.getTeam(teamId);
    if (!team) throw new Error(`unknown team: ${teamId}`);
    if (team.phase !== 'staged') throw new Error('only a staged plan can be discarded');
    this.store.savePlan(teamId, { ...(this.store.getPlan(teamId) ?? {}), status: 'discarded', reason });
    this.store.updateTeam(teamId, { phase: 'archived', control: 'halted', archivedAt: this.now() });
    this.store.addEvent(teamId, 'team.plan.discarded', { reason });
    return { ok: true };
  }

  async removeMember(teamId, nameOrId, options = {}) {
    const member = this.store.getMember(nameOrId) ?? this.store.findMember(teamId, nameOrId);
    if (!member || member.teamId !== teamId) throw new Error(`unknown member: ${nameOrId}`);
    const actor = options.actor;
    if (actor?.role === 'member' && actor.memberId === member.id && this.memberIsShadow(member)) {
      throw Object.assign(
        new Error('the shadow cannot change or remove its own seat'),
        { status: 403, code: 'E_FORBIDDEN' },
      );
    }
    for (const task of this.store.listTasks(teamId)) {
      if (task.assignee !== member.name || ['completed', 'failed', 'cancelled'].includes(task.status)) continue;
      if (task.attemptId) this.store.updateAttempt(task.attemptId, { status: 'reassigned', endedAt: this.now() });
      this.store.updateTask(task.id, { ...invalidateAttempt(task, { assignee: undefined }), reassigning: false });
      this.store.addEvent(teamId, 'task.reassigned', { taskId: task.id, reason: 'member removed' });
    }
    let homeCleanupDeferred;
    if (member.sessionId) {
      try {
        const stopped = await this.adapter.stop({ sessionId: member.sessionId });
        const closed = await this.adapter.close?.({ sessionId: member.sessionId });
        if (stopped?.ok !== true || closed?.ok !== true) homeCleanupDeferred = 'session termination unconfirmed';
      } catch (error) {
        homeCleanupDeferred = error instanceof Error ? error.message : String(error);
      }
    }
    for (const license of this.store.listLicenses(teamId, member.id).filter((item) => item.status === 'active')) {
      this.store.updateLicense(license.id, {
        status: 'revoked', revokedAt: this.now(), revokedBy: options.actor?.name ?? 'captain',
      });
      this.store.addLicenseHistory({ teamId, memberId: member.id, action: 'revoked', license, reason: 'member removed' });
    }
    if (homeCleanupDeferred) {
      this.store.addEvent(teamId, 'member.home_cleanup_deferred', { memberId: member.id, reason: homeCleanupDeferred });
    } else this.purgeMemberHome(member);
    this.store.removeMember(member.id);
    this.store.updateMember(member.id, {
      license: undefined, licenseId: undefined, sessionId: undefined,
      workState: 'archived', residency: 'cold', homeCleanupDeferred,
    });
    this.store.addEvent(teamId, 'member.removed', { memberId: member.id, name: member.name });
    return { ok: true };
  }

  async reassignTask(teamId, taskId, assignee, reason = 'reassigned') {
    return reassignTaskFrom(this, teamId, taskId, assignee, reason);
  }

  claimTask(teamId, taskId, memberName, attemptId, actor) {
    return claimTaskFrom(this, teamId, taskId, memberName, attemptId, actor);
  }

  heartbeatTask(teamId, taskId, attemptId, actor) {
    return heartbeatTaskFrom(this, teamId, taskId, attemptId, actor);
  }

  updateTask(teamId, taskId, attemptId, update, actor) {
    return this.completeTask({ teamId, taskId, attemptId, update, actor });
  }

  amendTask(teamId, taskId, fields, reason, actor) {
    return amendTaskFrom(this, teamId, taskId, fields, reason, actor);
  }

  /**
   * Captain-only release of a dispatch hold. The caller must name the current
   * reason so a stale page cannot clear a newer hold. Legacy manual repairs are
   * intentionally not releasable.
   */
  releaseTaskHold(teamId, taskId, { reason, expectedReason, actor } = {}) {
    return releaseTaskHoldFrom(this, teamId, taskId, { reason, expectedReason, actor });
  }

  cancelTask(teamId, taskId, { reason, actor } = {}) {
    return cancelTaskFrom(this, teamId, taskId, { reason, actor });
  }

  reopenTask(teamId, taskId, { reason, actor } = {}) {
    return reopenTaskFrom(this, teamId, taskId, { reason, actor });
  }

  sendMessage(teamId, from, to, content, extra = {}) {
    if (!content || !String(content).trim()) throw new Error('message content is required');
    const toTeam = extra.toTeam ?? extra.to_team;
    const taskId = extra.taskId ?? extra.task_id;
    const attemptId = extra.attemptId ?? extra.attempt_id;
    const urgent = extra.urgent === true;
    if (toTeam && toTeam !== teamId) {
      if (!this.store.getTeam(toTeam)) throw Object.assign(new Error(`unknown team: ${toTeam}`), { status: 404, code: 'E_NOT_FOUND' });
      const autoApprove = this.config.automation?.mode === 'full-access';
      const message = this.store.addMessage({
        teamId: toTeam,
        fromTeamId: teamId,
        from,
        to: to ?? 'captain',
        content,
        taskId,
        attemptId,
        urgent,
        crossTeam: true,
        approvalState: autoApprove ? 'approved' : 'pending_captain',
        approvedBy: autoApprove ? 'full-access' : undefined,
        approvedAt: autoApprove ? this.now() : undefined,
      });
      this.store.addEvent(teamId, autoApprove ? 'message.cross_team_auto_approved' : 'message.cross_team_pending', {
        messageId: message.id, fromTeamId: teamId, toTeam, to: message.to,
      });
      return message;
    }
    const message = this.store.addMessage({
      teamId, from, to, content, taskId, attemptId, urgent, approvalState: 'local',
    });
    this.store.addEvent(teamId, 'message.created', { messageId: message.id, from, to });
    return message;
  }

  listPendingMessages() {
    return this.store.listAllMessages().filter((message) => message.approvalState === 'pending_captain');
  }

  approveMessage(messageId, approver = 'captain') {
    const message = this.store.getMessage(messageId);
    if (!message) throw Object.assign(new Error(`unknown message: ${messageId}`), { status: 404, code: 'E_NOT_FOUND' });
    if (message.approvalState !== 'pending_captain') {
      throw Object.assign(new Error('message is not awaiting captain approval'), { status: 409, code: 'E_STATE' });
    }
    const approved = this.store.updateMessage(messageId, {
      approvalState: 'approved', approvedBy: approver, approvedAt: this.now(),
    });
    this.store.addEvent(message.teamId, 'message.cross_team_approved', { messageId, approvedBy: approver });
    if (message.fromTeamId) this.store.addEvent(message.fromTeamId, 'message.cross_team_approved', { messageId, approvedBy: approver });
    return approved;
  }

  rejectMessage(messageId, approver = 'captain', reason) {
    const message = this.store.getMessage(messageId);
    if (!message) throw Object.assign(new Error(`unknown message: ${messageId}`), { status: 404, code: 'E_NOT_FOUND' });
    if (message.approvalState !== 'pending_captain') {
      throw Object.assign(new Error('message is not awaiting captain approval'), { status: 409, code: 'E_STATE' });
    }
    const rejected = this.store.updateMessage(messageId, {
      approvalState: 'rejected', rejectedBy: approver, rejectedAt: this.now(), rejectedReason: reason,
    });
    this.store.addEvent(message.teamId, 'message.cross_team_rejected', { messageId, approvedBy: approver, reason });
    if (message.fromTeamId) this.store.addEvent(message.fromTeamId, 'message.cross_team_rejected', { messageId, approvedBy: approver, reason });
    return rejected;
  }

  settlementStatus(teamId, memberId) {
    const member = this.store.getMember(memberId) ?? this.store.findMember(teamId, memberId);
    if (!member || member.teamId !== teamId) throw new Error(`unknown member: ${memberId}`);
    if (member.status === 'removed') return { memberId: member.id, settled: false, blockers: ['member is removed'] };
    const blockers = settlementBlockers({
      member,
      tasks: this.settlementTasks(this.store.listTasks(teamId), member),
      attempts: this.store.listAttempts(teamId),
      findings: this.store.listFindings(teamId, 'open', member.id),
    });
    return { memberId: member.id, settled: blockers.length === 0, blockers };
  }

  listLicenses(teamId, memberId) {
    return this.store.listLicenses(teamId, memberId);
  }

  async relicenseMember(teamId, memberId, input = {}, options = {}) {
    if (!this.features.licenses) throw new Error('licensing is disabled');
    const member = this.store.getMember(memberId) ?? this.store.findMember(teamId, memberId);
    if (!member || member.teamId !== teamId) throw new Error(`unknown member: ${memberId}`);
    if (member.status === 'removed') throw new Error('cannot relicense a removed member');
    const actor = options.actor;
    if (actor?.role === 'member' && actor.memberId === member.id && this.memberIsShadow(member)) {
      throw Object.assign(
        new Error('the shadow cannot change or remove its own seat'),
        { status: 403, code: 'E_FORBIDDEN' },
      );
    }
    const settlement = this.settlementStatus(teamId, member.id);
    if (!settlement.settled) {
      return { ok: false, error: 'member is not settled', blockers: settlement.blockers };
    }
    const label = input.label ?? member.name;
    const duplicate = this.store.findMember(teamId, label);
    if (duplicate && duplicate.id !== member.id) throw new Error(`duplicate member name in team: ${label}`);
    const old = member.license ?? this.store.listLicenses(teamId, member.id).find((license) => license.status === 'active');
    const nextRole = input.roleKey ?? input.role ?? old?.roleKey ?? member.role;
    const nextRoleKey = this.normalizeRole(nextRole);
    const roleChanged = nextRoleKey !== this.normalizeRole(old?.roleKey ?? member.role);
    const nextCapabilities = input.capabilities ?? (roleChanged ? undefined : old?.capabilities);
    const effectiveCapabilities = resolveCapabilities(
      nextRoleKey,
      nextCapabilities ?? this.roleDefaults(nextRoleKey).capabilities ?? [],
    );
    // Validate every control-seat invariant before stopping the session or
    // revoking the old license; a rejected relicense must leave the old
    // authority intact. Capabilities are normalized first, so `team:lead`
    // cannot be smuggled onto an engineer through the public API.
    if (nextRoleKey === 'shadow') {
      const existing = this.findShadowMember();
      if (existing && existing.id !== member.id) {
        throw Object.assign(
          new Error(`a shadow already exists in team ${existing.teamId}: ${existing.name}`),
          { status: 409, code: 'E_SHADOW_EXISTS' },
        );
      }
    }
    if (effectiveCapabilities.includes(LEAD_CAPABILITY)) {
      this.assertLeadSlotFree(teamId, { exceptMemberId: member.id });
      // A delivery member promoted to lead consumes a new control session;
      // a seat already inside the control budget does not.
      if (!this.memberIsControl(member)) this.assertControlBudget();
    }
    if (member.sessionId) {
      try { await this.adapter.stop({ sessionId: member.sessionId }); } catch { /* best effort */ }
      try { await this.adapter.close?.({ sessionId: member.sessionId }); } catch { /* best effort */ }
    }
    const summary = this.summarizeMember(teamId, member);
    if (old) {
      this.store.updateLicense(old.id, {
        status: 'revoked', revokedAt: this.now(), revokedBy: actor?.name ?? 'captain',
      });
      this.store.addLicenseHistory({
        teamId, memberId: member.id, action: 'revoked', license: old,
        reason: input.reason ?? 'relicense', at: this.now(),
      });
    }
    let licensed;
    try {
      licensed = this.issueLicense(teamId, member, {
        label,
        roleKey: nextRole,
        allowedTaskKinds: input.allowedTaskKinds ?? (roleChanged ? undefined : old?.allowedTaskKinds),
        pathScope: input.pathScope ?? (roleChanged ? undefined : old?.pathScope),
        toolPolicy: input.toolPolicy ?? (roleChanged ? undefined : old?.toolPolicy),
        capabilities: effectiveCapabilities,
        expiresAt: input.expiresAt ?? old?.expiresAt,
        issuedBy: actor?.name ?? 'captain',
      });
    } catch (error) {
      // Best-effort rollback: the session is gone, but the old authority must
      // not disappear just because the replacement license was rejected.
      if (old) {
        this.store.updateLicense(old.id, { status: 'active', revokedAt: undefined, revokedBy: undefined });
      }
      this.store.updateMember(member.id, { sessionId: undefined });
      throw error;
    }
    const next = this.store.updateMember(licensed.id, {
      sessionId: undefined,
      status: 'idle',
      workState: 'available',
      residency: 'cold',
      lastActiveAt: this.now(),
      summaryId: summary.savedAt,
      summaryApproved: false,
    });
    this.store.addEvent(teamId, 'member.relicensed', {
      memberId: member.id, label, roleKey: next.role, licenseId: next.licenseId,
      oldLicenseId: old?.id, reason: input.reason,
    });
    return { ok: true, member: next, summary, oldLicenseId: old?.id };
  }

  summarizeMember(teamId, member) {
    const tasks = this.store.listTasks(teamId);
    const messages = this.store.listMessages(teamId)
      .filter((message) => (message.to === member.name || message.from === member.name)
        && (!message.approvalState || ['approved', 'local'].includes(message.approvalState)));
    const summary = buildMemberSummary({ member, tasks, messages, now: this.now() });
    return this.store.saveSummary(member.id, teamId, summary);
  }

  async compactMember(teamId, memberId, { reason = 'idle compaction' } = {}) {
    if (!this.features.compression) throw new Error('compression is disabled');
    const member = this.store.getMember(memberId) ?? this.store.findMember(teamId, memberId);
    if (!member || member.teamId !== teamId) throw new Error(`unknown member: ${memberId}`);
    if (member.status === 'removed') throw new Error('cannot compact a removed member');
    if (member.status === 'working' || member.workState === 'busy') throw new Error('cannot compact a working member');
    const summary = this.summarizeMember(teamId, member);
    let warning;
    if (typeof this.adapter.compact === 'function' && member.sessionId) {
      const result = await this.adapter.compact({ sessionId: member.sessionId, summary });
      warning = result?.warning;
    } else if (!member.sessionId) {
      warning = 'no live session; summary stored';
    } else {
      warning = 'adapter has no compact method; summary stored';
    }
    const next = this.store.updateMember(member.id, {
      residency: member.sessionId ? 'warm' : 'cold',
      lastActiveAt: this.now(),
    });
    this.store.addEvent(teamId, 'member.compacted', { memberId: member.id, reason, warning });
    return { ok: true, member: next, summary, warning };
  }

  async sleepMember(teamId, memberId, { reason = 'idle cold transition' } = {}) {
    if (!this.features.compression) throw new Error('compression is disabled');
    const member = this.store.getMember(memberId) ?? this.store.findMember(teamId, memberId);
    if (!member || member.teamId !== teamId) throw new Error(`unknown member: ${memberId}`);
    if (member.status === 'removed') throw new Error('cannot sleep a removed member');
    if (this.memberIsControl(member)) {
      throw Object.assign(
        new Error('a control seat must be stopped through its own lifecycle, not sleepMember'),
        { status: 409, code: 'E_CONTROL_SEAT' },
      );
    }
    const activeAttempt = this.store.listAttempts(teamId).some((attempt) => (
      (attempt.assignee === member.name || attempt.assigneeId === member.id)
      && ['claimed', 'in_progress'].includes(attempt.status)
    ));
    if (member.status === 'working' || member.workState === 'busy' || activeAttempt) {
      return { ok: false, error: 'member has active work; pause or finish the task first' };
    }
    for (const task of this.store.listTasks(teamId)) {
      if ((task.assignee === member.name || task.assigneeId === member.id) && task.worktree) {
        try {
          if (await worktreeDirty(task.worktree)) {
            return { ok: false, error: `task ${task.id} has uncommitted worktree changes; merge or checkpoint first` };
          }
        } catch {
          return { ok: false, error: `cannot verify worktree cleanliness for task ${task.id}` };
        }
      }
    }
    const summary = this.summarizeMember(teamId, member);
    if (member.sessionId) {
      const retired = await this.retireMemberSession(teamId, member.id, member.sessionId, reason);
      if (!retired.ok) return { ...retired, member: this.store.getMember(member.id), summary };
    }
    const next = this.store.updateMember(member.id, {
      sessionId: undefined,
      status: 'idle',
      residency: 'cold',
      lastActiveAt: this.now(),
      summaryId: summary.savedAt,
      summaryApproved: true,
    });
    this.store.addEvent(teamId, 'member.slept', { memberId: member.id, reason });
    return { ok: true, member: next, summary };
  }

  wakeMember(teamId, memberId) {
    const member = this.store.getMember(memberId) ?? this.store.findMember(teamId, memberId);
    if (!member || member.teamId !== teamId) throw new Error(`unknown member: ${memberId}`);
    if (member.status === 'removed') throw new Error('cannot wake a removed member');
    const next = this.store.updateMember(member.id, { residency: 'warm', status: 'idle', lastActiveAt: this.now() });
    this.store.addEvent(teamId, 'member.woke', { memberId: member.id });
    return { ok: true, member: next };
  }

  lifecycleStats(teamId) {
    const members = this.store.listMembers(teamId);
    const contractors = this.store.listContractors(teamId)
      .filter((item) => ['starting', 'running', 'cancelling', 'cleanup_error'].includes(item.status));
    const sessions = members.filter((member) => member.sessionId).length + contractors.length;
    return {
      hot: members.filter((member) => member.residency === 'hot').length,
      warm: members.filter((member) => member.residency === 'warm').length,
      cold: members.filter((member) => member.residency === 'cold').length,
      archived: members.filter((member) => member.workState === 'archived').length,
      sessions,
      maxTotalSessions: this.config.scheduler.maxTotalSessions ?? 32,
      contractors: contractors.length,
      contractorSlots: this.contractorPools(teamId),
    };
  }

  async lifecycleTick(teamId, { force = false, memoryUsage } = {}) {
    if (!this.features.compression && !force) {
      this.pumpContractors();
      return { compacted: 0, slept: 0 };
    }
    const now = this.now();
    const mem = this.config.memory;
    let compacted = 0;
    let slept = 0;
    const members = this.store.listMembers(teamId);
    for (const member of members) {
      if (member.status === 'removed' || member.workState === 'archived') continue;
      // Control seats (captain/lead/shadow) have their own lifecycle. Sleeping
      // the shadow here would leave shadowState=active with no session.
      if (this.memberIsControl(member)) continue;
      if (member.status === 'working' || member.workState === 'busy') continue;
      const activeAttempt = this.store.listAttempts(teamId).some((attempt) => (
        (attempt.assignee === member.name || attempt.assigneeId === member.id)
        && ['claimed', 'in_progress'].includes(attempt.status)
      ));
      if (activeAttempt) continue;
      const last = member.lastActiveAt ?? member.joinedAt ?? now;
      const idleMinutes = (now - last) / 60000;
      if (member.sessionId && idleMinutes >= (member.workState === 'waiting' ? mem.waitingColdMinutes : mem.availableIdleMinutes)) {
        const result = await this.sleepMember(teamId, member.id, { reason: 'idle TTL' });
        if (result.ok) slept += 1;
      } else if (member.sessionId && idleMinutes >= mem.waitingWarmMinutes) {
        const result = await this.compactMember(teamId, member.id, { reason: 'warm TTL' });
        if (result.ok) compacted += 1;
      }
    }
    const stats = this.lifecycleStats(teamId);
    if (stats.sessions > stats.maxTotalSessions) {
      for (const member of this.store.listMembers(teamId)) {
        if (stats.sessions - slept <= stats.maxTotalSessions) break;
        if (!member.sessionId || member.status === 'working' || member.workState === 'busy') continue;
        if (this.memberIsControl(member)) continue;
        const result = await this.sleepMember(teamId, member.id, { reason: 'session quota' });
        if (result.ok) slept += 1;
      }
    }
    let memory;
    if (memoryUsage ?? this.memoryUsage) {
      try {
        const usage = (memoryUsage ?? this.memoryUsage)();
        const budgetBytes = usage?.budgetBytes ?? (this.config.memory.budgetMb ? this.config.memory.budgetMb * 1024 * 1024 : 0);
        if (usage && budgetBytes > 0) {
          const percent = ((usage.rssBytes ?? usage.rss ?? 0) / budgetBytes) * 100;
          memory = { ...usage, budgetBytes, percent };
          if (percent >= mem.highWatermarkPercent) {
            for (const member of this.store.listMembers(teamId)) {
              if (!member.sessionId || member.status === 'working' || member.workState === 'busy') continue;
              if (this.memberIsControl(member)) continue;
              const result = await this.sleepMember(teamId, member.id, { reason: 'memory high watermark' });
              if (result.ok) slept += 1;
              const next = (memoryUsage ?? this.memoryUsage)();
              const nextBudget = next?.budgetBytes ?? budgetBytes;
              if (next && (((next.rssBytes ?? next.rss ?? 0) / nextBudget) * 100) <= mem.lowWatermarkPercent) break;
            }
          }
        }
      } catch {
        // memory telemetry is optional
      }
    }
    this.pumpContractors();
    return { compacted, slept, memory, stats: this.lifecycleStats(teamId) };
  }

  async lifecycleTickAll(options = {}) {
    const results = [];
    for (const team of this.store.listTeams()) {
      results.push({ teamId: team.id, ...(await this.lifecycleTick(team.id, options)) });
    }
    return results;
  }

  contractorSlotFor(purpose, requestedSlot) {
    return contractorSlotForImpl(this, purpose, requestedSlot);
  }

  contractorSlotCap(slot) {
    return contractorSlotCapImpl(this, slot);
  }

  contractorSlotAllows(slot, purpose) {
    return contractorSlotAllowsImpl(this, slot, purpose);
  }

  activeContractors(slot) {
    return activeContractorsImpl(this, slot);
  }

  contractorPools(teamId) {
    return contractorPoolsImpl(this, teamId);
  }

  async cleanupContractor(adapter, contractorId, sessionId) {
    return cleanupContractorImpl(this, adapter, contractorId, sessionId);
  }

  async submitContractor(input, options) {
    return submitContractorImpl(this, input, options);
  }

  pumpContractors() {
    return pumpContractorsImpl(this);
  }

  async runContractor(teamId, contractor) {
    return runContractorImpl(this, teamId, contractor);
  }

  async contractorSendTurn(input) {
    return contractorSendTurnImpl(this, input);
  }

  shouldContinueContractor(error, attempt, maxContinues, deadline) {
    return shouldContinueContractorImpl(this, error, attempt, maxContinues, deadline);
  }

  contractorContinueDelay(error, attempt) {
    return contractorContinueDelayImpl(this, error, attempt);
  }

  async finishContractorCancellation(teamId, contractor, sessionId, reason, adapter) {
    return finishContractorCancellationImpl(this, teamId, contractor, sessionId, reason, adapter);
  }

  async waitForContractor(id, waitMs) {
    return waitForContractorImpl(this, id, waitMs);
  }

  async spawnContractor(input, options) {
    return spawnContractorImpl(this, input, options);
  }

  async killContractor(teamId, contractorId) {
    return killContractorImpl(this, teamId, contractorId);
  }

  async reconcileIntegrationIntent(teamId, task) {
    return reconcileIntegrationIntentFrom(this, teamId, task);
  }

  async reconcileAfterRestart() {
    return reconcileAfterRestartFrom(this);
  }

  async reconcileContractors() {
    return reconcileContractorsFrom(this);
  }

  listContractors(teamId, slot) {
    return this.store.listContractors(teamId, undefined, slot);
  }

  async reviewMerge(teamId, taskId) {
    return reviewMergeFrom(this, teamId, taskId);
  }

  /**
   * Captain-confirmed recovery for a publication whose external side effect is
   * unknown (crash between git and the DB write). `applied` must be decided by
   * inspecting the target branch; the confirmation is recorded as the receipt.
   */
  async reconcilePublication(teamId, taskId, { applied, publishedCommit, actor } = {}) {
    return reconcilePublicationFrom(this, teamId, taskId, { applied, publishedCommit, actor });
  }

  async retryCleanup(teamId, taskId) {
    return retryCleanupFrom(this, teamId, taskId);
  }

  async retryPublication(teamId, taskId) {
    return retryPublicationFrom(this, teamId, taskId);
  }

  async reviewMergeUnlocked(teamId, taskId) {
    return reviewMergeUnlockedFrom(this, teamId, taskId);
  }

  createRepairForRejectedMerge(teamId, task, verdict, reviewId) {
    return createRepairForRejectedMergeFrom(this, teamId, task, verdict, reviewId);
  }

  createBoundPostMergeRepair(teamId, task, verdict, reviewId) {
    return createBoundPostMergeRepairFrom(this, teamId, task, verdict, reviewId);
  }

  postMergePrompt(task, commit) {
    return buildPostMergePrompt(task, commit);
  }

  captainPrompt(team) {
    return buildCaptainPrompt(team);
  }

  withShadowLock(fn) {
    return withShadowLockFrom(this, fn);
  }

  shadowStatus() {
    return shadowStatusFrom(this);
  }

  /**
   * Close the shadow once the delegated work is done. Starting stays a manual
   * captain decision ("the captain is overloaded"); stopping is automatic after
   * `shadow.idleStopMinutes` only when no team has unfinished work and no
   * contractor is running. A stop keeps the seat, so a later restart is cheap.
   */
  async shadowAutoStopTick() {
    return shadowAutoStopTickFrom(this);
  }

  /**
   * Start the single shadow/secretary on demand. Idempotent while starting or
   * active; a stopped member is reused instead of creating a second seat.
   */
  async startShadow({ teamId } = {}) {
    return startShadowFrom(this, { teamId });
  }

  async stopShadow({ reason } = {}) {
    return stopShadowFrom(this, { reason });
  }

  async ensureCaptainSession(team, { onAdmissionRejected } = {}) {
    return ensureCaptainSessionFrom(this, team, { onAdmissionRejected });
  }

  softIsolationReport(teamId) {
    const team = this.store.getTeam(teamId);
    if (!team) throw new Error(`unknown team: ${teamId}`);
    const checks = [];
    const add = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });
    add('mode', this.config.isolation.mode === 'worktree', `isolation.mode=${this.config.isolation.mode}`);
    add('git-repo', existsSync(join(this.repo, '.git')), this.repo);
    const members = this.store.listMembers(teamId).filter((member) => member.status !== 'removed');
    const active = members.filter((member) => member.home || member.sessionId || member.lastTaskAt);
    for (const member of active) {
      add(`home:${member.name}`, member.home && existsSync(member.home), member.home ?? 'missing');
      add(`token:${member.name}`, Boolean(this.store.getMemberToken(member.id)), 'member-scoped token');
      if (['reviewer', 'analyst'].includes(member.role) || member.license?.toolPolicy === 'read-only') {
        add(`read-only:${member.name}`, (member.license?.toolPolicy ?? member.toolPolicy) === 'read-only', member.license?.toolPolicy ?? member.toolPolicy);
      }
      add(`scope:${member.name}`, Array.isArray(member.license?.pathScope) && member.license.pathScope.length > 0, JSON.stringify(member.license?.pathScope ?? []));
    }
    const worktrees = this.store.listTasks(teamId)
      .filter((task) => task.worktree && task.mergeState !== 'merged')
      .map((task) => task.worktree);
    add('worktrees-exist', worktrees.every((path) => existsSync(path)), `${worktrees.length} worktree(s)`);
    add('worktrees-distinct', new Set(worktrees).size === worktrees.length, `${new Set(worktrees).size}/${worktrees.length} unique`);
    return { ok: checks.every((check) => check.ok), teamId, checks };
  }

  async patrol(teamId, { enforceTrigger = false } = {}) {
    return patrolLifecycle(this, teamId, { enforceTrigger });
  }

  markPatrol(teamId) {
    return markPatrolLifecycle(this, teamId);
  }

  async patrolOnce(teamId, { onExternal, signal, enforceTrigger = false } = {}) {
    return patrolOnceLifecycle(this, teamId, { onExternal, signal, enforceTrigger }, ACTIVE_STATUSES, TERMINAL_STATUSES);
  }

  patrolPrompt(team, tasks, findings) {
    return patrolPromptLifecycle(this, team, tasks, findings, TERMINAL_STATUSES);
  }

  queuePatrolReport(teamId, report, reason, captainBusy, { unknown = false, immediate = false } = {}) {
    return queuePatrolReportLifecycle(this, teamId, report, reason, captainBusy, { unknown, immediate });
  }

  async flushPatrolPending(teamId, { signal, onExternal } = {}) {
    return flushPatrolPendingLifecycle(this, teamId, { signal, onExternal });
  }

  async patrolTickAll() {
    return patrolTickAllLifecycle(this);
  }

  listFindings(teamId, status) {
    return this.store.listFindings(teamId, status);
  }

  closeFinding(teamId, findingId, reason = 'closed') {
    const finding = this.store.getFinding(findingId);
    if (!finding || finding.teamId !== teamId) throw new Error(`unknown finding: ${findingId}`);
    const closed = this.store.updateFinding(findingId, { status: 'closed', closedAt: this.now(), closeReason: reason });
    this.store.addEvent(teamId, 'finding.closed', { findingId, reason });
    return closed;
  }


  async mergeTask(teamId, taskId, options = {}) {
    return mergeTaskFrom(this, teamId, taskId, options);
  }

  currentMergeReview(teamId, task) {
    return currentMergeReviewFor(this, teamId, task);
  }

  resolveDeliveryMergeTarget(teamId, entry) {
    return resolveDeliveryMergeTargetFor(this, teamId, entry);
  }

  markDeliveryMerged(teamId, delivery, commit, publicationOwner) {
    return markDeliveryMergedFor(this, teamId, delivery, commit, publicationOwner);
  }

  async mergeTaskUnlocked(teamId, taskId, options = {}) {
    return mergeTaskUnlockedFrom(this, teamId, taskId, options);
  }

}
