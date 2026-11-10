// Recovery of completed work whose artifact or publication write was interrupted.
//
// The TeamService methods remain compatibility facades; these implementations use
// the service instance for state and dynamic method seams.
import { existsSync } from 'node:fs';
import { commitArtifactBeforeReview } from '../domain/changes.mjs';
import { worktreeDirty } from '../git/merge-queue.mjs';

const ADOPT_RETRY_BASE_MS = 5000;

const ADOPT_RETRY_MAX_MS = 300000;

const ADOPT_RETRY_LIMIT = 6;

const ADOPT_BLOCK_REASONS = new Set([
  'adopt_worktree_missing', 'adopt_fence_unavailable', 'adopt_failed',
  'adopt_failed_terminal', 'adopt_dirty_requires_review', 'missing_unit_inheritance',
]);

function nextAdoptRetry(attempts, now, forceTerminal = false) {
  const nextAttempts = attempts + 1;
  const terminal = forceTerminal || nextAttempts >= ADOPT_RETRY_LIMIT;
  const retryDelay = Math.min(ADOPT_RETRY_MAX_MS,
    ADOPT_RETRY_BASE_MS * (2 ** Math.min(nextAttempts - 1, 6)));
  return {
    attempts: nextAttempts,
    terminal,
    retryAt: terminal ? undefined : now + retryDelay,
  };
}

function adoptionSnapshot(task) {
  return {
    id: task.id,
    teamId: task.teamId,
    status: task.status,
    mode: task.mode,
    kind: task.kind,
    legacyRepair: task.legacyRepair,
    parentIntegrationId: task.parentIntegrationId,
    sourceTaskId: task.sourceTaskId,
    worktree: task.worktree,
    sourceBase: task.sourceBase,
    worktreeBase: task.worktreeBase,
    sourceCommit: task.sourceCommit,
    lastAttemptId: task.lastAttemptId,
    attemptId: task.attemptId,
    taskEpoch: task.taskEpoch,
    deliveryUnitId: task.deliveryUnitId,
    deliverySeq: task.deliverySeq,
    mergeCommit: task.mergeCommit,
    mergeError: task.mergeError,
    mergeReviewError: task.mergeReviewError,
    integrationCommit: task.integrationCommit,
    integrationBranch: task.integrationBranch,
    integrationWorktree: task.integrationWorktree,
    integrationIntent: JSON.stringify(task.integrationIntent ?? null),
    integrationOwnership: JSON.stringify(task.integrationOwnership ?? null),
    negativeMergeIntent: JSON.stringify(task.negativeMergeIntent ?? null),
    postMergeReview: task.postMergeReview,
    ffAttempt: task.ffAttempt,
    mergeState: task.mergeState,
    mergeBlockReason: task.mergeBlockReason,
    bindingState: task.bindingState,
    adoptBlockedReason: task.adoptBlockedReason,
    adoptAttempts: task.adoptAttempts,
    adoptRetryAt: task.adoptRetryAt,
    legacyAdoptAttemptedAt: task.legacyAdoptAttemptedAt,
    needsCaptain: task.needsCaptain,
    hold: JSON.stringify(task.hold ?? null),
    closedLoop: JSON.stringify(task.closedLoop ?? null),
    redReviewEscalated: task.redReviewEscalated,
    escalated: task.escalated,
    inScope: JSON.stringify(task.inScope ?? []),
    outOfScope: JSON.stringify(task.outOfScope ?? []),
  };
}

function sameAdoptionSnapshot(task, snapshot) {
  if (!task || !snapshot) return false;
  const current = adoptionSnapshot(task);
  return Object.keys(snapshot).every((key) => current[key] === snapshot[key]);
}

export function isRecoverableAdoptionWriteError(error) {
  // node:sqlite raises SQLITE_BUSY/LOCKED as `code: 'ERR_SQLITE_ERROR'` with a
  // numeric `errcode` (5 = BUSY, 6 = LOCKED); the symbolic codes only appear
  // when a caller normalizes them, so accept both shapes.
  return error?.code === 'E_PUBLICATION_HELD'
    || error?.code === 'SQLITE_BUSY'
    || error?.code === 'SQLITE_LOCKED'
    || error?.errcode === 5
    || error?.errcode === 6;
}

export function publicationRetryDeferred(service, teamId, taskId) {
  return (service.adoptPublicationBackoff.get(`${teamId}:${taskId}`)?.retryAt ?? 0) > service.now();
}

export function recordPublicationWriteBlocked(service, teamId, taskId, error, { eventType = 'task.adopt_blocked', reason = 'publication_held' } = {}) {
  const key = `${teamId}:${taskId}`;
  const now = service.now();
  const previous = service.adoptPublicationBackoff.get(key);
  if (previous?.retryAt > now) return { retryAt: previous.retryAt, deferred: true };
  const attempts = (previous?.attempts ?? 0) + 1;
  const retryAt = now + Math.min(ADOPT_RETRY_MAX_MS,
    ADOPT_RETRY_BASE_MS * (2 ** Math.min(attempts - 1, 6)));
  service.adoptPublicationBackoff.set(key, { attempts, retryAt });
  if (!previous) {
    try {
      service.store.addEvent(teamId, eventType, {
        taskId, reason, error: error instanceof Error ? error.message : String(error), retryAt,
      });
    } catch (eventError) {
      if (!isRecoverableAdoptionWriteError(eventError)) throw eventError;
    }
  }
  return { retryAt, deferred: true };
}

export function recomputeTeamNeedsCaptain(service, teamId) {
  const team = service.store.getTeam(teamId);
  if (!team?.needsCaptain) return false;
  const tasks = service.store.listTasks(teamId);
  const taskNeedsCaptain = tasks.some((task) => task.needsCaptain === true
    || task.mergeState === 'blocked'
    || Boolean(task.hold)
    || task.closedLoop?.state === 'escalated'
    || task.redReviewEscalated === true || task.escalated === true);
  const unresolvedTeamAlert = team.escalated === true || team.control === 'escalated'
    || Boolean(team.publicationGuard || team.captainStopError)
    || team.captainSessionStart?.state === 'unknown'
    || (team.captainSessionConflicts ?? []).some((item) => item.state === 'unknown')
    || team.patrolPending?.state === 'unknown'
    || (team.patrolBacklog ?? []).some((item) => item.state === 'unknown')
    || (team.integrationConflicts ?? []).some((item) => item.state === 'unknown')
    || (team.workerSessionConflicts ?? []).some((item) => item.state === 'unknown')
    || service.store.listMembers(teamId).some((member) => member.sessionRecoveryState === 'unknown'
      || member.workerSessionStart?.state === 'unknown' || member.shadowState === 'stop_failed')
    || service.store.listContractors(teamId).some((contractor) => contractor.status === 'cleanup_error');
  if (taskNeedsCaptain || unresolvedTeamAlert) return false;
  service.store.updateTeam(teamId, { needsCaptain: false });
  return true;
}

export async function adoptPendingCandidates(service, { teamId = null } = {}) {
  const teams = teamId
    ? [service.store.getTeam(teamId)].filter(Boolean)
    : service.store.listTeams().filter((team) => team.control === 'active');
  if (teamId) {
    return service.withClosedLoopLock(teamId, () => service.adoptPendingCandidatesUnlocked(teams));
  }
  const results = [];
  for (const team of teams) {
    results.push(await service.withClosedLoopLock(team.id,
      () => service.adoptPendingCandidatesUnlocked([team])));
  }
  return results.reduce((total, result) => ({
    adopted: [...total.adopted, ...result.adopted],
    blocked: [...total.blocked, ...result.blocked],
    deferred: [...total.deferred, ...result.deferred],
  }), { adopted: [], blocked: [], deferred: [] });
}

export async function adoptPendingCandidatesUnlocked(service, teams) {
  const adopted = [];
  const blocked = [];
  const deferred = [];
  const publicationBlocked = (team, task, error) => {
    service.recordPublicationWriteBlocked(team.id, task.id, error);
    if (!blocked.includes(task.id)) blocked.push(task.id);
    if (!deferred.includes(task.id)) deferred.push(task.id);
  };
  const recordFailure = (team, task, { reason, error, eventType, forceTerminal = false, snapshot }) => {
    let result;
    try {
      service.store.transaction(() => {
        const current = service.store.getTask(task.id);
        if (!current || !sameAdoptionSnapshot(current, snapshot)) return;
        const attempts = Number(current.adoptAttempts) || 0;
        const retry = nextAdoptRetry(attempts, service.now(), forceTerminal);
        const terminalFailure = retry.terminal && reason !== 'adopt_dirty_requires_review';
        const blockReason = terminalFailure ? 'adopt_failed_terminal' : reason;
        const message = error instanceof Error ? error.message : error;
        service.store.updateTask(task.id, {
          mergeState: 'blocked',
          mergeBlockReason: blockReason,
          bindingState: 'blocked', legacyAdoptAttemptedAt: service.now(),
          adoptBlockedReason: blockReason,
          adoptAttempts: retry.attempts, adoptRetryAt: retry.retryAt,
          adoptError: message, needsCaptain: true,
        });
        service.store.updateTeam(team.id, { needsCaptain: true });
        service.store.addEvent(team.id, terminalFailure ? 'task.adopt_failed_terminal' : eventType, {
          taskId: task.id, reason, ...(message ? { error: message } : {}),
          attempts: retry.attempts, retryAt: retry.retryAt,
        });
        result = retry;
      });
    } catch (writeError) {
      if (isRecoverableAdoptionWriteError(writeError)) {
        publicationBlocked(team, task, writeError);
        return undefined;
      }
      throw writeError;
    }
    if (!result && !deferred.includes(task.id)) deferred.push(task.id);
    return result;
  };
  const stale = (taskId, snapshot) => !sameAdoptionSnapshot(service.store.getTask(taskId), snapshot);
  const releaseFence = async (team, taskId, fence) => {
    if (typeof fence?.release !== 'function') return;
    try {
      await fence.release();
    } catch (error) {
      service.store.addEvent(team.id, 'task.adopt_fence_release_failed', {
        taskId, error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  for (const team of teams) {
    if (!team || team.phase === 'archived' || team.control !== 'active') continue;
    for (const candidate of service.store.listTasks(team.id)) {
      const kind = candidate.kind ?? 'work';
      const integration = kind === 'integration';
      if (!['implementation', 'repair', 'integration'].includes(kind) || candidate.status !== 'completed') continue;
      if (service.publicationRetryDeferred(team.id, candidate.id)) {
        blocked.push(candidate.id);
        deferred.push(candidate.id);
        continue;
      }
      if (service.store.getPublicationGuard(team.id)) {
        publicationBlocked(team, candidate,
          Object.assign(new Error('team publication is in progress or requires reconciliation'), { code: 'E_PUBLICATION_HELD' }));
        continue;
      }
      if (candidate.mergeState && !ADOPT_BLOCK_REASONS.has(candidate.mergeBlockReason)) continue;
      const terminalAdopt = [
        'adopt_dirty_requires_review', 'missing_unit_inheritance', 'adopt_failed_terminal',
      ].includes(candidate.mergeBlockReason);
      const retryableAdoptBlock = ['adopt_worktree_missing', 'adopt_fence_unavailable', 'adopt_failed']
        .includes(candidate.mergeBlockReason);
      if (retryableAdoptBlock && typeof candidate.adoptRetryAt === 'number'
        && candidate.adoptRetryAt > service.now()) {
        blocked.push(candidate.id);
        deferred.push(candidate.id);
        continue;
      }
      if (integration) {
        if (!candidate.worktree || candidate.sourceCommit || candidate.mergeState === 'merged' || terminalAdopt) continue;
      } else if (candidate.mode !== 'bound' || !candidate.worktree || candidate.sourceCommit || candidate.legacyRepair === true
        || candidate.mergeState === 'merged' || terminalAdopt) continue;
      const candidateSnapshot = adoptionSnapshot(candidate);
      if (!integration && candidate.deliveryUnitId && candidate.kind === 'repair'
        && (!Number.isInteger(candidate.deliverySeq) || candidate.deliverySeq <= 0)) {
        try {
          service.store.transaction(() => {
            const current = service.store.getTask(candidate.id);
            if (!current || !sameAdoptionSnapshot(current, candidateSnapshot)) return;
            if (current.sourceCommit || current.status !== 'completed'
              || current.mergeState === 'merged' || current.mergeState === 'blocked'
                && current.mergeBlockReason !== 'missing_unit_inheritance') return;
            const alreadyRecorded = service.store.listEvents(team.id).some((event) => event.type === 'task.adopt_blocked'
              && event.taskId === candidate.id && event.reason === 'missing_unit_inheritance');
            service.store.updateTask(candidate.id, {
              mergeState: 'blocked', mergeBlockReason: 'missing_unit_inheritance',
              bindingState: 'blocked', adoptBlockedReason: 'missing_unit_inheritance',
              legacyAdoptAttemptedAt: service.now(), needsCaptain: true,
            });
            service.store.updateTeam(team.id, { needsCaptain: true });
            if (!alreadyRecorded) service.store.addEvent(team.id, 'task.adopt_blocked', {
              taskId: candidate.id, reason: 'missing_unit_inheritance', terminal: true,
            });
          });
        } catch (error) {
          if (!isRecoverableAdoptionWriteError(error)) throw error;
          publicationBlocked(team, candidate, error);
        }
        blocked.push(candidate.id);
        continue;
      }
      const task = service.store.getTask(candidate.id);
      if (!task || !sameAdoptionSnapshot(task, candidateSnapshot)) {
        deferred.push(candidate.id);
        continue;
      }
      let expectedSnapshot = candidateSnapshot;
      try {
        service.store.transaction(() => {
          const current = service.store.getTask(task.id);
          if (!current || !sameAdoptionSnapshot(current, candidateSnapshot)) return;
          if (current.sourceCommit || current.status !== 'completed' || current.mergeState === 'merged') return;
          const blockedReason = ADOPT_BLOCK_REASONS.has(current.mergeBlockReason)
            ? current.mergeBlockReason : undefined;
          if (current.adoptBlockedReason !== blockedReason) {
            service.store.updateTask(current.id, { adoptBlockedReason: blockedReason });
            expectedSnapshot = adoptionSnapshot({ ...current, adoptBlockedReason: blockedReason });
          }
        });
      } catch (error) {
        if (!isRecoverableAdoptionWriteError(error)) throw error;
        publicationBlocked(team, task, error);
        continue;
      }
      const adoptedTask = service.store.getTask(candidate.id);
      if (!sameAdoptionSnapshot(adoptedTask, expectedSnapshot)) {
        deferred.push(candidate.id);
        continue;
      }
      const snapshot = adoptionSnapshot(adoptedTask);
      const attemptId = adoptedTask.lastAttemptId;
      const base = adoptedTask.sourceBase ?? adoptedTask.worktreeBase;
      if (!existsSync(adoptedTask.worktree)) {
        recordFailure(team, adoptedTask, {
          reason: 'adopt_worktree_missing', error: 'worktree path does not exist',
          eventType: 'task.adopt_blocked', snapshot,
        });
        blocked.push(adoptedTask.id);
        continue;
      }
      let dirty;
      try {
        if (stale(adoptedTask.id, snapshot)) {
          deferred.push(adoptedTask.id);
          continue;
        }
        dirty = await worktreeDirty(adoptedTask.worktree);
        if (stale(adoptedTask.id, snapshot)) {
          deferred.push(adoptedTask.id);
          continue;
        }
      } catch (error) {
        if (stale(adoptedTask.id, snapshot)) {
          deferred.push(adoptedTask.id);
          continue;
        }
        if (isRecoverableAdoptionWriteError(error)) {
          publicationBlocked(team, adoptedTask, error);
          continue;
        }
        recordFailure(team, adoptedTask, {
          reason: 'adopt_failed', error: error instanceof Error ? error.message : String(error),
          eventType: 'task.adopt_failed', snapshot,
        });
        blocked.push(adoptedTask.id);
        continue;
      }
      if (dirty && !integration) {
        recordFailure(team, adoptedTask, {
          reason: 'adopt_dirty_requires_review', eventType: 'task.adopt_blocked',
          forceTerminal: true, snapshot,
        });
        blocked.push(adoptedTask.id);
        continue;
      }
      if (!attemptId || !base || typeof service.artifactFenceProvider?.acquire !== 'function') {
        recordFailure(team, adoptedTask, {
          reason: 'adopt_fence_unavailable', eventType: 'task.adopt_blocked',
          snapshot,
        });
        blocked.push(adoptedTask.id);
        continue;
      }
      try {
        if (stale(adoptedTask.id, snapshot)) {
          deferred.push(adoptedTask.id);
          continue;
        }
        const fence = await service.artifactFenceProvider.acquire({
          worktree: adoptedTask.worktree, base, teamId: team.id, taskId: adoptedTask.id, attemptId,
        });
        if (stale(adoptedTask.id, snapshot)) {
          await releaseFence(team, adoptedTask.id, fence);
          deferred.push(adoptedTask.id);
          continue;
        }
        const artifact = await commitArtifactBeforeReview({
          worktree: adoptedTask.worktree, base, inScope: adoptedTask.inScope ?? [], outOfScope: adoptedTask.outOfScope ?? [],
          teamId: team.id, taskId: adoptedTask.id, attemptId, fence,
        });
        if (stale(adoptedTask.id, snapshot)) {
          deferred.push(adoptedTask.id);
          continue;
        }
        let applied = false;
        service.store.transaction(() => {
          const current = service.store.getTask(adoptedTask.id);
          if (!current || !sameAdoptionSnapshot(current, snapshot)) return;
          const ownsBlock = current.mergeState === 'blocked'
            && current.adoptBlockedReason
            && ADOPT_BLOCK_REASONS.has(current.adoptBlockedReason)
            && current.mergeBlockReason === current.adoptBlockedReason;
          const hasOtherCaptainAlert = current.hold || current.closedLoop?.state === 'escalated'
            || current.redReviewEscalated === true || current.escalated === true
            || (current.mergeBlockReason && !ownsBlock) || current.bindingState === 'blocked' && !ownsBlock;
          const next = {
            ...artifact, legacyAdopted: true,
            bindingState: integration
              ? (current.bindingState === 'blocked' && !ownsBlock ? current.bindingState : 'not_applicable')
              : (ownsBlock ? 'ready' : current.bindingState),
            adoptBlockedReason: undefined, legacyAdoptAttemptedAt: undefined,
            adoptError: undefined, adoptAttempts: 0, adoptRetryAt: undefined,
            ...(ownsBlock ? { mergeState: undefined, mergeBlockReason: undefined } : {}),
            ...(ownsBlock && !hasOtherCaptainAlert && current.needsCaptain === true
              ? { needsCaptain: false } : {}),
          };
          service.store.updateTask(adoptedTask.id, next);
          service.store.addEvent(team.id, 'task.adopted', {
            taskId: adoptedTask.id, sourceCommit: artifact.sourceCommit,
          });
          // Clear the team alert in the same transaction as the task cleanup.
          // A concurrent publication guard must roll back both changes rather
          // than leaving an adopted task with a stale team-level alert.
          service.recomputeTeamNeedsCaptain(team.id);
          applied = true;
        });
        if (!applied) {
          deferred.push(adoptedTask.id);
          continue;
        }
        service.adoptPublicationBackoff.delete(`${team.id}:${adoptedTask.id}`);
        adopted.push(adoptedTask.id);
      } catch (error) {
        if (isRecoverableAdoptionWriteError(error)) {
          publicationBlocked(team, adoptedTask, error);
          deferred.push(adoptedTask.id);
          continue;
        }
        const message = error instanceof Error ? error.message : String(error);
        const deterministic = /^contract_error:|provenance_mismatch|illegal_or_out_of_scope|symlink|oversized_file|not_descendant|empty_commit/.test(message);
        recordFailure(team, adoptedTask, {
          reason: 'adopt_failed', error: message, eventType: 'task.adopt_failed',
          forceTerminal: deterministic, snapshot,
        });
        blocked.push(adoptedTask.id);
      }
    }
  }
  return { adopted, blocked, deferred };
}
