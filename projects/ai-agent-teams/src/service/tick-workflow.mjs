import { join } from 'node:path';
import { isLeaseExpired, invalidateAttempt } from '../domain/attempts.mjs';
import { allocateSlots, nextReady } from '../domain/scheduler.mjs';
import { dispatchPlannedTasks } from './task-dispatch.mjs';
import { isRecoverableAdoptionWriteError } from './pending-adoption.mjs';
import { deferNativeModelMail, isNativeModelDispatchError, withNativeModelForMail } from './native-model-dispatch.mjs';

const ACTIVE_STATUSES = new Set(['claimed', 'in_progress']);
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const MAIL_RETRY_BASE_MS = 5000;
const MAIL_RETRY_MAX_MS = 300000;
const TRANSIENT_TICK_RETRY_BASE_MS = 5000;
const TRANSIENT_TICK_RETRY_MAX_MS = 60000;

export function deferTransientTick(service, teamId, error) {
  const previous = service.transientTickBackoff.get(teamId);
  const attempts = (previous?.attempts ?? 0) + 1;
  const delay = Math.min(TRANSIENT_TICK_RETRY_MAX_MS,
    TRANSIENT_TICK_RETRY_BASE_MS * (2 ** Math.min(attempts - 1, 4)));
  const blocked = error?.code === 'E_PUBLICATION_HELD' ? 'publication-held' : 'store-busy';
  const retryAt = service.now() + delay;
  service.transientTickBackoff.set(teamId, { attempts, retryAt, blocked });
  // The held write already has its owning task/operation event. Keep the
  // scheduler boundary quiet and defer the team rather than adding one
  // `team.tick_failed` event per one-second daemon tick.
  return {
    dispatched: 0, mail: 0, stalled: 0, continued: 0, redReviews: 0,
    deferred: 1, materialized: 0, recovered: 0, preempted: 0,
    blocked, retryAt,
  };
}

export async function tick(service, teamId) {
  const prior = service.transientTickBackoff.get(teamId);
  if (prior?.retryAt > service.now()) {
    return {
      dispatched: 0, mail: 0, stalled: 0, continued: 0, redReviews: 0,
      deferred: 1, materialized: 0, recovered: 0, preempted: 0, blocked: prior.blocked,
    };
  }
  try {
    const result = await service.tickUnlocked(teamId);
    if (result.blocked === 'publication-held' || result.blocked === 'store-busy') {
      return service.deferTransientTick(teamId, {
        code: result.blocked === 'publication-held' ? 'E_PUBLICATION_HELD' : 'SQLITE_BUSY',
      });
    }
    service.transientTickBackoff.delete(teamId);
    return result;
  } catch (error) {
    if (!isRecoverableAdoptionWriteError(error)) throw error;
    return service.deferTransientTick(teamId, error);
  }
}

export async function tickUnlocked(service, teamId) {
  const team = service.store.getTeam(teamId);
  if (!team || team.phase === 'staged' || team.phase === 'archived' || team.control !== 'active') {
    return {
      dispatched: 0, mail: 0, stalled: 0, continued: 0, redReviews: 0,
      deferred: 0, materialized: 0, recovered: 0, preempted: 0,
    };
  }
  if (service.store.getPublicationGuard(teamId)) {
    return {
      dispatched: 0, mail: 0, stalled: 0, continued: 0, redReviews: 0,
      deferred: 0, materialized: 0, recovered: 0, preempted: 0,
      blocked: 'publication-held',
    };
  }
  // Recovery path for red boxes whose event was missed (restart) and for
  // reviews deferred because the member was busy. Never blocks the tick.
  const redReviews = service.sweepRedReviews(teamId);
  const worktreeBase = await service.worktreeBaseCheck(teamId);
  const now = service.now();
  let tasks = service.store.listTasks(teamId);
  // Heal any closed-loop gap left by a crash between "task closed" and
  // "follow-up created", or by a task completed before this feature existed.
  const loopSweep = await service.reconcileClosedLoop(teamId);
  if (loopSweep.created > 0 || loopSweep.escalated > 0) tasks = service.store.listTasks(teamId);
  // Evidence beats a stall: a task whose member went idle after recording
  // acceptance and changed-path evidence is completed, not failed.
  const recovered = await service.recoverEvidenceBackedTasks(teamId);
  if (recovered.length > 0) tasks = service.store.listTasks(teamId);
  // Critical-chain work preempts low-priority work holding the slot/member.
  const preempted = service.preemptForCriticalWork(teamId, tasks, now);
  if (preempted.length > 0) tasks = service.store.listTasks(teamId);
  let materialized = 0;
  const globalActiveTasks = service.store.listTeams()
    .flatMap((item) => service.store.listTasks(item.id))
    .filter((item) => ACTIVE_STATUSES.has(item.status) && item.attemptId);
  if (service.features.lazyMembers) {
    const activeBefore = globalActiveTasks.length;
    const capacity = Math.max(0, service.config.scheduler.activeWorkerSlots - activeBefore);
    for (const task of nextReady(tasks, now).slice(0, capacity)) {
      try {
        const before = service.store.listMembers(teamId).length;
        service.ensureAssignee(teamId, task);
        if (service.store.listMembers(teamId).length > before) materialized += 1;
      } catch (error) {
        service.store.addEvent(teamId, 'task.assignee_failed', {
          taskId: task.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    tasks = service.store.listTasks(teamId);
  }
  const active = globalActiveTasks.map((task) => ({ teamId: task.teamId }));
  let plan;
  if (service.config.scheduler.dynamicTeams) {
    const allTasks = service.store.listTeams().flatMap((item) => service.store.listTasks(item.id));
    const globalPlan = service._dynamicPlanByTeam
      ? { dispatch: service._dynamicPlanByTeam.get(teamId) ?? [], deferred: [], freeSlots: 0, blocked: [] }
      : allocateSlots({ config: service.config, tasks: allTasks, active, now });
    plan = service._dynamicPlanByTeam
      ? globalPlan
      : { ...globalPlan, dispatch: globalPlan.dispatch.filter((item) => item.teamId === teamId) };
  } else {
    plan = allocateSlots({ config: service.config, tasks, active, now });
  }
  const { dispatched, blocked } = await dispatchPlannedTasks(service, {
    teamId, team, plan, tasks, worktreeBase,
    activeStatuses: ACTIVE_STATUSES, terminalStatuses: TERMINAL_STATUSES,
  });

  const continued = await service.continueDueTurns(teamId, service.now());

  let mail = 0;
  for (const message of service.store.listMessages(teamId)) {
    if (message.deliveredAt || message.discardedAt || !message.to || message.to === 'captain') continue;
    if (message.approvalState && !['approved', 'local'].includes(message.approvalState)) continue;
    if (Number(message.deliveryRetryAt ?? 0) > service.now()) continue;
    const member = service.store.findMember(teamId, message.to);
    if (!member?.sessionId) continue;
    let failure;
    try {
      const sent = await withNativeModelForMail(service, {
        teamId, messageId: message.id, memberId: member.id, memberName: member.name,
        sessionId: member.sessionId, controlEpoch: team.controlEpoch ?? 0,
      }, (currentMember) => service.adapter.send({
        sessionId: currentMember.sessionId,
        message: `Mail from ${message.from}:\n${message.content}`,
        cwd: currentMember.workdir ?? service.cwd,
        delivery: message.urgent ? 'guide' : 'queue',
        ephemeral: false,
        mode: service.memberPermissionModeFor(currentMember),
        disallowedTools: service.memberDisallowedToolsFor(currentMember),
        home: join(service.memberHomeRoot(), teamId, currentMember.id),
        token: service.store.getMemberToken(currentMember.id),
        teamId,
        memberName: currentMember.name,
      }));
      if (sent.ok) {
        service.store.updateMessage(message.id, {
          deliveredAt: service.now(),
          deliveryFailures: 0,
          deliveryRetryAt: undefined,
          lastDeliveryError: undefined,
        });
        mail += 1;
        continue;
      }
      failure = sent.warning ?? 'session rejected the mail';
    } catch (error) {
      if (isNativeModelDispatchError(error)) {
        deferNativeModelMail(service, { teamId, message, error, retryInMs: MAIL_RETRY_BASE_MS });
        continue;
      }
      // A busy member can reject a queued mail while its current prompt is
      // still running. That must not abort the whole scheduler tick: the
      // message stays pending and is retried with backoff.
      failure = error instanceof Error ? error.message : String(error);
    }
    if (failure) {
      const failures = Number(message.deliveryFailures ?? 0) + 1;
      const delay = Math.min(MAIL_RETRY_MAX_MS, MAIL_RETRY_BASE_MS * (2 ** Math.min(failures - 1, 10)));
      const retryAt = service.now() + delay;
      service.store.updateMessage(message.id, {
        deliveryFailures: failures,
        deliveryRetryAt: retryAt,
        lastDeliveryError: String(failure).slice(0, 2000),
      });
      service.store.addEvent(teamId, 'message.delivery_failed', {
        messageId: message.id,
        to: message.to,
        failures,
        retryAt,
        retryInMs: delay,
        error: failure,
      });
    }
  }

  let stalled = 0;
  for (const task of service.store.listTasks(teamId)) {
    if (!ACTIVE_STATUSES.has(task.status) || !task.attemptId) continue;
    if (!isLeaseExpired(task, service.now())) continue;
    service.store.updateAttempt(task.attemptId, { status: 'stalled', endedAt: service.now() });
    service.store.updateTask(task.id, { ...invalidateAttempt(task, { assignee: task.assignee }), reassigning: false, stalled: true, stalledAt: service.now() });
    service.store.addEvent(teamId, 'task.stalled', { taskId: task.id, attemptId: task.attemptId });
    stalled += 1;
  }

  return {
    dispatched,
    mail,
    stalled,
    continued,
    redReviews,
    deferred: plan.deferred.length,
    materialized,
    recovered: recovered.length,
    preempted: preempted.length,
    ...(blocked ? { blocked } : {}),
  };
}

export async function tickAll(service) {
  if (service._tickAllRunning) return [];
  service._tickAllRunning = true;
  const results = [];
  try {
    let preflightBlockedTeams = new Set();
    if (service.config.scheduler.dynamicTeams) {
      const teams = service.store.listTeams()
        .filter((team) => team.phase !== 'staged' && team.phase !== 'archived' && team.control === 'active');
      // A team whose worktree base is missing cannot dispatch. Exclude it
      // before the global allocator runs, otherwise it holds slots that a
      // healthy team could use and the pool never fills.
      const blockedTeams = new Set();
      for (const team of teams) {
        try {
          if (service.store.getPublicationGuard(team.id)) {
            blockedTeams.add(team.id);
            continue;
          }
          const check = await service.worktreeBaseCheck(team.id);
          if (!check.ready) blockedTeams.add(team.id);
        } catch (error) {
          if (!isRecoverableAdoptionWriteError(error)) throw error;
          blockedTeams.add(team.id);
          service.deferTransientTick(team.id, error);
        }
      }
      preflightBlockedTeams = blockedTeams;
      const allTasks = service.store.listTeams().flatMap((team) => service.store.listTasks(team.id));
      const active = allTasks
        .filter((task) => ACTIVE_STATUSES.has(task.status) && task.attemptId)
        .map((task) => ({ teamId: task.teamId }));
      const eligibleTasks = teams
        .filter((team) => !blockedTeams.has(team.id))
        .flatMap((team) => service.store.listTasks(team.id));
      const plan = allocateSlots({ config: service.config, tasks: eligibleTasks, active, now: service.now() });
      const byTeam = new Map();
      for (const item of plan.dispatch) {
        if (!byTeam.has(item.teamId)) byTeam.set(item.teamId, []);
        byTeam.get(item.teamId).push(item);
      }
      service._dynamicPlanByTeam = byTeam;
    }
    for (const team of service.store.listTeams()) {
      if (preflightBlockedTeams.has(team.id) && service.transientTickBackoff.get(team.id)?.retryAt > service.now()) {
        const deferred = service.transientTickBackoff.get(team.id);
        results.push({ teamId: team.id, dispatched: 0, deferred: 1, blocked: deferred.blocked });
        continue;
      }
      try {
        results.push({ teamId: team.id, ...(await service.tick(team.id)) });
      } catch (error) {
        if (isRecoverableAdoptionWriteError(error)) {
          results.push({ teamId: team.id, ...service.deferTransientTick(team.id, error) });
          continue;
        }
        // One team's transient adapter/session error must not starve the
        // other team. Record it and let the next tick retry this team.
        const message = error instanceof Error ? error.message : String(error);
        service.store.addEvent(team.id, 'team.tick_failed', { error: message });
        results.push({ teamId: team.id, error: message });
      }
    }
  } finally {
    service._dynamicPlanByTeam = undefined;
    service._tickAllRunning = false;
  }
  return results;
}

