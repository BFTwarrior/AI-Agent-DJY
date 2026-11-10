import { invalidateAttempt } from '../domain/attempts.mjs';
import { resolveRevertReceipt } from '../git/merge-queue.mjs';

const ACTIVE_STATUSES = new Set(['claimed', 'in_progress']);

export async function reconcileAfterRestart(service) {
    const tasks = [];
    const members = [];
    const loops = [];
    const recovered = [];
    for (const team of service.store.listTeams()) {
      if (team.publicationGuard) {
        // A publication guard is an in-memory/DB lock around one process. It
        // cannot survive a daemon death as a permanent global lock. Release it
        // on startup, keep the affected task escalated and make the recovery
        // visible instead of freezing every later write.
        const guard = team.publicationGuard;
        const guardBase = service.config.teams.find((item) => item.id === team.id)?.baseBranch ?? 'main';
        service.store.transaction(() => {
          const affected = guard.taskId ? service.store.getTask(guard.taskId) : undefined;
          if (affected) {
            service.store.updateTask(guard.taskId, {
              needsCaptain: true,
              publicationRecoveryState: 'guard_released_after_restart',
              // The team guard is released so other writes are not frozen, but
              // the task keeps its own receipt. reconcilePublication reads this
              // record after a restart, when the team guard no longer exists.
              publicationRecovery: {
                operationId: guard.operationId, expectedCommit: guard.expectedCommit ?? null,
                state: guard.state ?? null, targetBranch: guardBase, recordedAt: service.now(),
              },
              ...(guard.state === 'unknown'
                ? (affected.integrationCommit
                  ? { mergeState: 'ff_failed', mergeReviewError: 'publication outcome unknown after daemon restart' }
                  : { mergeState: 'publication_unknown', needsCaptain: true,
                    mergeReviewError: 'publication outcome unknown after daemon restart' })
                : guard.state === 'publishing' ? { mergeState: 'publication_unknown', needsCaptain: true,
                  mergeReviewError: 'the target branch may already contain this publication; captain confirmation required' }
                  : {}),
            }, { publicationOwner: guard.operationId });
          }
          service.store.updateTeam(team.id, {
            publicationGuard: undefined,
            needsCaptain: true,
          }, { publicationOwner: guard.operationId });
          service.store.addEvent(team.id, 'merge.publication_guard_released', {
            taskId: guard.taskId, operationId: guard.operationId, state: guard.state,
          });
        });
      }
    }
    // The publication guard is repository-wide, not team-local. Clear every
    // surviving guard before touching task rows; otherwise a task write for
    // team A would hit team B's still-live guard and throw E_PUBLICATION_HELD.
    for (const team of service.store.listTeams()) {
      const recoveryBase = service.config.teams.find((item) => item.id === team.id)?.baseBranch ?? 'main';
      for (const task of service.store.listTasks(team.id)) {
        if (task.negativeMergeIntent?.phase !== 'prepared') continue;
        const intent = task.negativeMergeIntent;
        const receipt = await resolveRevertReceipt({
          repo: service.repo, key: intent.operationId, target: recoveryBase, appliedCommit: intent.mergeCommit,
        });
        if (receipt.status === 'found') {
          if (intent.revertReceiptFound !== true) {
            service.store.updateTask(task.id, {
              negativeMergeIntent: { ...intent, revertCommit: receipt.commit, revertReceiptFound: true },
            });
            service.store.addEvent(team.id, 'merge.negative_receipt_found', {
              taskId: task.id, operationId: intent.operationId, revertCommit: receipt.commit,
            });
          }
        } else if (receipt.status === 'error') {
          // The lookup itself failed (git error, IO, permissions). That is not
          // "no receipt": replaying the side effect would double-apply it.
          const reason = 'revert_receipt_unreadable';
          service.store.updateTask(task.id, {
            needsCaptain: true, mergeBlockReason: reason,
            negativeMergeIntent: {
              ...intent, receiptStatus: 'error', receiptError: receipt.error ?? 'unknown lookup error',
            },
          });
          service.store.updateTeam(team.id, { needsCaptain: true });
          service.store.addEvent(team.id, 'merge.negative_receipt_unreadable', {
            taskId: task.id, operationId: intent.operationId, error: receipt.error,
          });
          continue;
        } else if (receipt.status !== 'none') {
          // A trailer exists but does not prove it reverts this merge on the
          // target branch. Never guess; hold it for a human.
          service.store.updateTask(task.id, {
            needsCaptain: true, mergeBlockReason: 'ambiguous_revert_receipt',
            negativeMergeIntent: { ...intent, receiptStatus: receipt.status, receiptCommits: receipt.commits },
          });
          service.store.updateTeam(team.id, { needsCaptain: true });
          service.store.addEvent(team.id, 'merge.negative_receipt_ambiguous', {
            taskId: task.id, operationId: intent.operationId, status: receipt.status,
            commits: receipt.commits ?? (receipt.commit ? [receipt.commit] : []),
          });
          continue;
        }
        if (task.needsCaptain === true && task.mergeBlockReason === 'negative_merge_outcome_unknown') continue;
        service.store.updateTask(task.id, { needsCaptain: true, mergeBlockReason: 'negative_merge_outcome_unknown' });
        service.store.updateTeam(team.id, { needsCaptain: true });
        service.store.addEvent(team.id, 'merge.negative_recovery_held', { taskId: task.id,
          operationId: intent.operationId, revertCommit: receipt.status === 'found' ? receipt.commit : undefined });
      }
      for (const task of service.store.listTasks(team.id)) {
        if (task.integrationIntent?.state === 'prepared') {
          await service.reconcileIntegrationIntent(team.id, task);
        }
        if (task.postMergeClaim && task.mergeState === 'review_pending' && !task.postMergeReview) {
          // The daemon that held the claim is gone. The post-merge review has
          // not produced a verdict, so releasing the claim lets the next tick
          // review the same artifact instead of leaving it claimed forever.
          service.store.updateTask(task.id, {
            postMergeClaim: undefined,
            mergeReviewError: undefined,
            needsCaptain: false,
            publicationRecoveryState: 'post_merge_claim_released',
          });
          service.store.addEvent(team.id, 'merge.review_claim_released', {
            taskId: task.id, operationId: task.postMergeClaim.operationId,
          });
        }
      }
      // A dead daemon does not prove that provider sessions or process trees
      // have stopped. Retain their identity and capacity until reconciliation.
      for (const member of service.store.listMembers(team.id)) {
        if (!member.sessionId) {
          if (service.memberIsShadow(member) && ['starting', 'stopping'].includes(member.shadowState)) {
            service.store.transaction(() => {
              service.store.updateMember(member.id, {
                shadowLastError: 'session transition outcome unknown after daemon restart',
                shadowTransitionAt: service.now(),
                sessionRecoveryState: 'unknown',
              });
              service.store.revokeMemberToken(member.id);
            });
            service.store.updateTeam(team.id, { needsCaptain: true });
            members.push(member.id);
          }
          if (member.workerSessionStart?.state === 'starting') {
            service.store.transaction(() => {
              service.store.updateMember(member.id, { workerSessionStart: { ...member.workerSessionStart, state: 'unknown' }, sessionRecoveryState: 'unknown', workState: 'busy' });
              service.store.revokeMemberToken(member.id);
            });
            service.store.updateTeam(team.id, { needsCaptain: true });
            members.push(member.id);
          }
          continue;
        }
        service.store.transaction(() => {
          service.store.updateMember(member.id, {
            sessionRecoveryState: 'unknown',
            status: 'working',
            workState: 'busy',
            ...(service.memberIsShadow(member)
              ? { shadowState: 'stop_failed', shadowLastError: 'session outcome unknown after daemon restart', shadowTransitionAt: service.now() }
              : {}),
          });
          service.store.revokeMemberToken(member.id);
        });
        service.store.updateTeam(team.id, { needsCaptain: true });
        members.push(member.id);
      }
      for (const task of service.store.listTasks(team.id)) {
        if (!ACTIVE_STATUSES.has(task.status) || !task.attemptId) continue;
        try {
          service.store.updateAttempt(task.attemptId, {
            status: 'orphaned',
            endedAt: service.now(),
            error: 'orphaned after daemon restart',
          });
        } catch {
          // The attempt may already be missing; the task is still recoverable.
        }
        service.store.updateTask(task.id, {
          ...invalidateAttempt(task, { assignee: task.assignee }),
          reassigning: false,
          stalled: true,
          stalledAt: service.now(),
          hold: { class: 'restart_session_unknown', attemptId: task.attemptId },
          needsCaptain: true,
        });
        service.store.updateTeam(team.id, { needsCaptain: true });
        service.store.addEvent(team.id, 'task.recovered_after_restart', {
          taskId: task.id,
          oldAttemptId: task.attemptId,
        });
        tasks.push(task.id);
      }
      // A chain that was mid-flight when the daemon died still needs its
      // review/repair rows; the deterministic ids make this a no-op when the
      // rows already exist. Halted teams keep their state until resume.
      if (team.control === 'active') service.reconcilePostMergeRepairs(team.id);
      const loop = team.control === 'active'
        ? await service.reconcileClosedLoop(team.id)
        : { created: 0, escalated: 0, skipped: 'team-not-active' };
      if (loop.created > 0 || loop.escalated > 0) loops.push({ teamId: team.id, ...loop });
    }
    return { tasks, members, loops, recovered };
  }

export async function reconcileContractors(service) {
    const orphaned = [];
    const held = [];
    for (const contractor of service.store.listAllContractors()) {
      if (!contractor.slot) {
        const purpose = String(contractor.purpose ?? 'task');
        const slot = /^(post_merge_review|merge_verify|merge_review|merge)(?::|$)/.test(purpose) ? 'merge' : 'patrol';
        service.store.updateContractor(contractor.id, { slot });
      }
      const stale = ['starting', 'running', 'cancelling', 'cleanup_error'].includes(contractor.status)
        || (contractor.status === 'orphaned' && contractor.sessionId);
      if (!stale) continue;
      const cleanupError = contractor.sessionId
        ? await service.cleanupContractor(service.contractorAdapter ?? service.adapter, contractor.id, contractor.sessionId)
        : 'contractor session identity unavailable after restart';
      const record = service.store.updateContractor(contractor.id, {
        status: cleanupError ? 'cleanup_error' : 'orphaned',
        sessionId: cleanupError ? contractor.sessionId : undefined, endedAt: service.now(),
        error: 'orphaned after daemon restart', cleanupError,
      });
      service.store.addEvent(contractor.teamId, 'contractor.orphaned', {
        contractorId: contractor.id, slot: contractor.slot, cleanupError,
      });
      if (cleanupError) service.store.addEvent(contractor.teamId, 'contractor.cleanup_failed', {
        contractorId: contractor.id, slot: contractor.slot, error: cleanupError,
      });
      if (cleanupError) service.store.updateTeam(contractor.teamId, { needsCaptain: true });
      if (cleanupError) held.push(record);
      else orphaned.push(record);
    }
    service.pumpContractors();
    return { orphaned: orphaned.length, held: held.length, queued: service.store.listAllContractors('queued').length };
  }

