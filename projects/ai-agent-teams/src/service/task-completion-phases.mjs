export async function collectCompletionEvidence({ service, task, attemptId, safeUpdate, workdir }) {
  let effectiveUpdate = service.normalizeCompletionUpdate(task, safeUpdate);
  const verification = await service.runCompletionVerification({ task, attemptId, workdir, effectiveUpdate });
  if (verification.ok === false) return verification;
  effectiveUpdate = verification.effectiveUpdate;

  if (task.kind === 'review' && effectiveUpdate.status === 'completed') {
    const reviewedTask = service.store.getTask(task.reviewedTaskId);
    const snapshot = await service.bindCompletionReviewSnapshot({
      task, attemptId, effectiveUpdate, reviewedTask, workdir,
    });
    if (snapshot.ok === false) return snapshot;
    effectiveUpdate = snapshot.effectiveUpdate;
  }

  const changedPaths = await service.deriveCompletionChangedPaths({
    teamId: task.teamId, task, attemptId, effectiveUpdate,
  });
  if (changedPaths.ok === false) return changedPaths;
  return { effectiveUpdate: changedPaths.effectiveUpdate };
}
