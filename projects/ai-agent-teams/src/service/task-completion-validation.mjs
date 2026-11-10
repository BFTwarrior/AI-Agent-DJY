import { assertAttempt } from '../domain/attempts.mjs';
import { parseBoundPostMergeReview } from '../domain/gates.mjs';

export function prepareTaskCompletion({ service, teamId, taskId, attemptId, update, actor, terminalStatuses }) {
  const task = service.store.getTask(taskId);
  if (!task || task.teamId !== teamId) throw new Error(`unknown task: ${taskId}`);
  if (terminalStatuses.has(task.status)) throw new Error('task is already terminal');
  // Ownership precedes attempt resolution so a non-assignee gets 403, not a stale-attempt error.
  if (actor?.role === 'member' && task.assignee !== actor.name && !service.canManageTeam(teamId, actor)) {
    throw Object.assign(new Error('member may only update its own task'), { status: 403, code: 'E_FORBIDDEN' });
  }
  assertAttempt(task, attemptId);
  service.assertAttemptEpoch(task, attemptId);
  return { task, attemptId, safeUpdate: sanitizeCompletionUpdate(update) };
}

export function persistInProgressCompletion({ service, teamId, taskId, attemptId, safeUpdate }) {
  const next = service.store.updateTask(taskId, { ...safeUpdate, status: 'in_progress' });
  service.store.updateAttempt(attemptId, { status: 'in_progress', leaseExpiresAt: next.leaseExpiresAt });
  service.store.addEvent(teamId, 'task.updated', { taskId, status: 'in_progress', attemptId });
  return { ok: true, task: next };
}

const COMPLETION_FIELDS = new Set([
  'status', 'output', 'verdict', 'scores', 'findings', 'changedPaths',
  'acceptanceResults', 'commandsRun', 'evidence_note', 'reviewResult',
]);

export function sanitizeCompletionUpdate(update) {
  const safeUpdate = Object.fromEntries(Object.entries(update ?? {}).filter(([key]) => COMPLETION_FIELDS.has(key)));
  if (!safeUpdate.status || !['in_progress', 'completed', 'failed', 'cancelled'].includes(safeUpdate.status)) {
    throw Object.assign(new Error('task update requires status in_progress|completed|failed|cancelled'), {
      status: 400, code: 'E_INVALID',
    });
  }
  return safeUpdate;
}

export function normalizeReviewCompletion(task, safeUpdate, reviewedTask) {
  if (task.kind !== 'review' || safeUpdate.reviewResult === undefined) return { ...safeUpdate };

  let parsed;
  try {
    parsed = parseBoundPostMergeReview(JSON.stringify(safeUpdate.reviewResult), { codeTask: reviewedTask?.kind !== 'work' });
  } catch {
    parsed = undefined;
  }
  if (!parsed) {
    return {
      status: 'failed',
      disposition: 'contract_error',
      reviewResultValid: false,
      needsCaptain: true,
      findings: [],
      verdict: undefined,
    };
  }
  return {
    ...safeUpdate,
    status: parsed.verdict === 'pass' ? 'completed' : 'failed',
    verdict: parsed.verdict,
    disposition: parsed.verdict,
    findings: parsed.findings,
    scores: parsed.scores,
    acceptanceResults: parsed.acceptanceResults,
    commandsRun: parsed.commandsRun,
    evidence_note: parsed.evidence,
    reviewResultValid: true,
  };
}
