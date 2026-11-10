import { runVerify } from '../gates/verify.mjs';
import { pathMatchesScope, validateCompletion } from '../domain/gates.mjs';
import { deriveChangedPaths } from '../domain/changes.mjs';
import { detectDrift, snapshotScope } from '../domain/artifacts.mjs';
import { headCommit, worktreeDirty } from '../git/merge-queue.mjs';
import { nextReady } from '../domain/scheduler.mjs';

export function completionIsCurrent(service, taskId, attemptId) {
  const current = service.store.getTask(taskId);
  return current?.attemptId === attemptId && !['completed', 'failed', 'cancelled'].includes(current.status)
    ? current : undefined;
}

export async function runCompletionVerification({ service, task, attemptId, workdir, effectiveUpdate }) {
  if (effectiveUpdate.status !== 'completed'
    || !['implementation', 'repair', 'verification', 'integration'].includes(task.kind)
    || !Array.isArray(task.verify) || task.verify.length === 0) return { effectiveUpdate };

  const results = await runVerify({ cwd: workdir, commands: task.verify });
  if (!service.currentCompletionTask(task.id, attemptId)) {
    return { ok: false, error: 'stale attempt: task changed during verify' };
  }
  const verifiedUpdate = { ...effectiveUpdate, commandsRun: results };
  if (results.some((result) => result.status === 'failed')) verifiedUpdate.status = 'failed';
  return { effectiveUpdate: verifiedUpdate };
}

export async function bindReviewSnapshot({ service, task, attemptId, effectiveUpdate, reviewedTask, workdir }) {
  if (task.kind !== 'review' || effectiveUpdate.status !== 'completed') return { effectiveUpdate };
  const reviewDir = task.reviewMode === 'bound' ? task.reviewWorktree : (reviewedTask?.worktree ?? workdir);
  if (task.reviewMode === 'bound' && (!reviewDir || !task.binding?.sourceCommit
    || reviewedTask?.sourceCommit !== task.binding.sourceCommit
    || await headCommit(reviewDir) !== task.binding.sourceCommit || await worktreeDirty(reviewDir))) {
    return { ok: false, error: 'bound review artifact changed or worktree is dirty' };
  }
  const scope = reviewedTask?.inScope ?? [];
  const snapshot = snapshotScope(reviewDir, scope);
  if (!service.currentCompletionTask(task.id, attemptId)) {
    return { ok: false, error: 'stale attempt: task changed during review snapshot' };
  }
  return {
    effectiveUpdate: {
      ...effectiveUpdate,
      reviewedArtifacts: snapshot.artifacts,
      reviewedScope: scope,
      reviewedGaps: snapshot.gaps,
      reviewedDuringDrift: detectDrift(task.verdictStartSnapshot?.artifacts ?? [], snapshot.artifacts),
      // The verdict is bound to the attempt the reviewer actually saw, not merely identical files.
      reviewedAttempt: reviewedTask?.attempt ?? null,
      reviewedAttemptId: reviewedTask?.attemptId ?? reviewedTask?.lastAttemptId ?? null,
    },
  };
}

export async function deriveImplementationChangedPaths({ service, teamId, task, attemptId, effectiveUpdate }) {
  if (!task.worktree || !['implementation', 'repair'].includes(task.kind) || effectiveUpdate.status !== 'completed') {
    return { effectiveUpdate };
  }
  try {
    const changedPaths = await deriveChangedPaths({ worktree: task.worktree, baseRef: task.worktreeBase });
    if (!service.currentCompletionTask(task.id, attemptId)) {
      return { ok: false, error: 'stale attempt: task changed during changed-path derivation' };
    }
    return { effectiveUpdate: { ...effectiveUpdate, changedPaths } };
  } catch (error) {
    service.store.addEvent(teamId, 'task.changed_paths_failed', {
      taskId: task.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      ok: false,
      error: `unable to prove actual changed paths: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function validateCompletionEvidence({ service, teamId, taskId, attemptId, effectiveUpdate }) {
  const currentTask = service.currentCompletionTask(taskId, attemptId);
  if (!currentTask) return { ok: false, error: 'stale attempt: task changed before completion' };

  if ((currentTask.kind === 'review' && currentTask.reviewMode === 'bound')
    || (currentTask.kind === 'repair' && currentTask.mode === 'bound')) {
    const rows = service.store.listTasks(teamId).map((row) => row.id === taskId ? { ...row, status: 'pending' } : row);
    if (!nextReady(rows, service.now()).some((row) => row.id === taskId)) {
      return { ok: false, error: 'delivery binding changed before completion' };
    }
  }
  if (service.features.licenses && effectiveUpdate.changedPaths?.length) {
    const member = service.store.findMember(teamId, currentTask.assignee);
    const scope = member?.license?.pathScope ?? ['**'];
    if (!scope.includes('**')) {
      const outside = effectiveUpdate.changedPaths.filter((path) => !scope.some((pattern) => pathMatchesScope(path, pattern)));
      if (outside.length > 0) {
        return { ok: false, error: `changed paths outside license scope: ${outside.slice(0, 5).join(', ')}` };
      }
    }
  }
  const reviewedTask = currentTask.kind === 'review' ? service.store.getTask(currentTask.reviewedTaskId) : undefined;
  const validation = validateCompletion(currentTask, effectiveUpdate, reviewedTask, {
    allowSelfReview: !service.config.quality.requireIndependentReview,
  });
  if (!validation.ok) return validation;
  return { ok: true, currentTask };
}
