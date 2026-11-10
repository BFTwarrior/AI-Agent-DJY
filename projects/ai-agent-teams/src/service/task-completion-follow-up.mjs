import { planFollowUp } from '../domain/gates.mjs';

export async function runTaskCompletionFollowUps({ service, teamId, taskId, task, closed, status }) {
  if (status === 'failed' && ['requirements', 'verification'].includes(task.kind)) {
    const follow = planFollowUp(closed, service.store.listTasks(teamId), service.config.quality.reviewPolicy);
    if (follow.escalated) {
      service.store.updateTeam(teamId, { control: 'escalated', escalated: true });
      service.store.addEvent(teamId, 'gate.escalated', { taskId, reason: follow.reason });
    }
    for (const warning of follow.warnings ?? []) {
      service.store.addEvent(teamId, 'gate.repair_warning', { taskId, warning });
    }
    if (follow.deduplicated) {
      service.store.addEvent(teamId, 'gate.repair_deduplicated', { taskId, reason: follow.reason });
    }
    for (const created of follow.created) {
      try {
        service.store.addTask(created);
        service.store.addEvent(teamId, 'gate.repair', {
          taskId: created.id,
          sourceTaskId: created.sourceTaskId ?? taskId,
          ...(created.scopeSource ? { scopeSource: created.scopeSource } : {}),
        });
      } catch (error) {
        service.store.addEvent(teamId, 'gate.repair_failed', {
          taskId: created.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  // Review pass auditing precedes the closed-loop planner, as before.
  if (status === 'completed' && task.kind === 'review') {
    service.store.addEvent(teamId, 'loop.passed', {
      taskId,
      sourceTaskId: task.reviewedTaskId,
      round: task.round ?? 1,
    });
  }
  let closedLoop;
  let closedLoopError;
  let closedLoopFailed = false;
  try {
    closedLoop = await service.applyClosedLoop(teamId, service.store.getTask(taskId));
  } catch (error) {
    closedLoopFailed = true;
    closedLoopError = error;
  }

  let failedHookError;
  if (status === 'failed') {
    try {
      service.onTaskFailed(teamId, taskId);
    } catch (error) {
      failedHookError = error;
    }
  }
  if (closedLoopFailed) {
    // Preserve the planner's original rejection; retain a secondary hook error
    // when the original error can safely carry diagnostic context.
    if (failedHookError && typeof closedLoopError === 'object' && Object.isExtensible(closedLoopError)) {
      try {
        closedLoopError.taskFailedHookError = failedHookError;
      } catch {
        // The original planner error remains authoritative if annotation fails.
      }
    }
    throw closedLoopError;
  }
  if (failedHookError) throw failedHookError;
  return { ok: true, task: service.store.getTask(taskId), closedLoop };
}
