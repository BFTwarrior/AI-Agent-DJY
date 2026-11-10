import { closeAttempt } from '../domain/attempts.mjs';

export function persistTaskCompletion({ service, teamId, taskId, attemptId, currentTask, effectiveUpdate }) {
  const closed = closeAttempt(currentTask, effectiveUpdate.status, effectiveUpdate);
  // Delivery identity is not an attempt result: it must survive a retry and
  // is written by the daemon only after the frozen artifact commit.
  for (const field of ['sourceBase', 'sourceCommit', 'diffHash', 'bindingState']) {
    if (effectiveUpdate[field] !== undefined) closed[field] = effectiveUpdate[field];
  }
  if (effectiveUpdate.status === 'completed') {
    // A completed task ends the failure episode; the next red state starts fresh.
    Object.assign(closed, {
      redContinueCount: 0,
      redContinueSessionId: undefined,
      redReviewEscalated: false,
    });
  }
  service.store.transaction(() => {
    service.store.updateTask(taskId, closed);
    service.store.updateAttempt(attemptId, { status: effectiveUpdate.status, endedAt: service.now() });
    const member = service.store.findMember(teamId, currentTask.assignee);
    if (member) {
      service.store.updateMember(member.id, { status: 'idle', lastActiveAt: service.now() });
      service.refreshMemberState(teamId, member.id);
    }
    service.store.addEvent(teamId, 'task.updated', { taskId, status: effectiveUpdate.status, attemptId });
  });
  return closed;
}
