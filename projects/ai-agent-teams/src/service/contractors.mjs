// Contractor lifecycle: slots, submission, send loop, cancellation and proof.
//
// Extracted from SchedulerService. A contractor is an external one-shot session
// with its own capacity slot; cleanup only frees that slot after the adapter
// proves the session termination and side-effect revocation.
import { randomUUID } from 'node:crypto';
import {
  CONTINUE_CAPABILITY,
  CONTINUE_MESSAGE,
  continueBackoffMs,
  isRetryableTurnError,
} from '../domain/scheduler.mjs';
import { contractorExecutionPolicy, resolveContractorMode } from '../domain/team-tools.mjs';
import { cleanupContractorSession } from './contractor-cleanup.mjs';
import {
  activeContractors as activeContractorsFrom,
  contractorPools as contractorPoolsFrom,
  contractorSlotAllows as contractorSlotAllowsFrom,
  contractorSlotCap as contractorSlotCapFrom,
  resolveContractorSlot,
} from './contractor-slots.mjs';
import { withPatrolCancelDeadline } from './patrol-run.mjs';
import { hasRedReviewPurpose } from './red-review.mjs';
import { readNativeWorkerModel, assertNativeModelSupported } from './model-policy.mjs';

// Killing a process tree or removing a container can legitimately take longer
// than the patrol deadline. A too-short bound turns a slow success into a
// permanent cleanup_error, so cleanup gets its own named budget.
const CLEANUP_DEADLINE_MS = 15000;

export function contractorSlotFor(service, purpose, requestedSlot) {
  return resolveContractorSlot(purpose, requestedSlot, service.config.contractors.slots);
}

export function contractorSlotCap(service, slot) {
  return contractorSlotCapFrom(service.config.contractors.slots, slot);
}

export function contractorSlotAllows(service, slot, purpose) {
  return contractorSlotAllowsFrom(service.config.contractors.slots, slot, purpose);
}

export function activeContractors(service, slot) {
  return activeContractorsFrom(service.store, slot);
}

export function contractorPools(service, _teamId) {
  return contractorPoolsFrom(service.store, service.config.contractors.slots);
}

export async function cleanupContractor(service, adapter, contractorId, sessionId) {
  let error;
  try {
    // Cleanup may have to kill a process tree or remove a container; 3s was
    // too short on Windows and turned a slow-but-successful stop into a
    // permanent cleanup_error.
    await withPatrolCancelDeadline(async () => { error = await cleanupContractorSession(adapter, sessionId); },
      CLEANUP_DEADLINE_MS, 'contractor cleanup');
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  if (service.contractorSends.has(contractorId)) return error || 'contractor send has not settled';
  return error;
}

export async function submitContractor(service, { teamId, slot, purpose = 'task', prompt, mode, timeoutMs, model, reasoning, cwd = service.cwd }, { signal, onSubmitted } = {}) {
  signal?.throwIfAborted();
  if (!service.features.contractors || !service.config.contractors.enabled) throw Object.assign(new Error('contractors are disabled'), { status: 409, code: 'E_CONFLICT' });
  if (!prompt || !String(prompt).trim()) throw Object.assign(new Error('contractor prompt is required'), { status: 400, code: 'E_INVALID' });
  const team = service.store.getTeam(teamId);
  if (!team) {
    throw Object.assign(new Error(`unknown team: ${teamId}`), { status: 404, code: 'E_NOT_FOUND' });
  }
  const resolvedSlot = service.contractorSlotFor(purpose, slot);
  if (service.contractorSlotCap(resolvedSlot) === 0) {
    throw Object.assign(new Error(`contractor slot is disabled: ${resolvedSlot}`), { status: 409, code: 'E_CONFLICT' });
  }
  const permission = resolveContractorMode({
    purpose,
    requestedMode: mode,
    defaultPermission: service.config.contractors.defaultPermission ?? 'read-only',
  });
  const maxLifetimeMs = service.config.contractors.maxLifetimeMinutes * 60000;
  const requestedTimeout = Number(timeoutMs ?? maxLifetimeMs);
  if (!Number.isFinite(requestedTimeout) || requestedTimeout <= 0) {
    throw Object.assign(new Error('contractor timeoutMs must be positive'), { status: 400, code: 'E_INVALID' });
  }
  const lifetimeMs = Math.min(requestedTimeout, maxLifetimeMs);
  const native = hasRedReviewPurpose({ purpose }) ? null : readNativeWorkerModel(service);
  if (native) assertNativeModelSupported(service.contractorAdapter ?? service.adapter);
  const id = `ctr_${randomUUID()}`;
  const resolvedModel = native?.model ?? model ?? service.config.zcode.defaultModel ?? null;
  const resolvedReasoning = native ? native.reasoning : reasoning ?? service.config.zcode.defaultReasoning ?? null;
  const record = service.store.addContractor({
    id, teamId, slot: resolvedSlot, purpose, mode: permission, prompt,
    cwd, model: resolvedModel, reasoning: resolvedReasoning, status: 'queued', queuedAt: service.now(), timeoutMs: lifetimeMs,
    ...(native ? { modelSelection: native.modelSelection, nativeModelSignature: native.signature } : {}),
    // Least privilege: only the daemon's red-review contractor needs the
    // team-task continue capability. A one-shot contractor still retries
    // "继续" on its own session through the runner.
    capabilities: hasRedReviewPurpose({ purpose }) ? [CONTINUE_CAPABILITY] : [],
  });
  service.store.addEvent(teamId, 'contractor.queued', {
    contractorId: id, slot: resolvedSlot, purpose,
    queuedForSlot: service.contractorPools(teamId).find((item) => item.slot === resolvedSlot)?.queued ?? 0,
  });
  onSubmitted?.(record);
  signal?.throwIfAborted();
  service.pumpContractors();
  return service.store.getContractor(id) ?? record;
}

export function pumpContractors(service) {
  if (service.contractorPumping.has('global')) return;
  service.contractorPumping.add('global');
  try {
    const slotNames = Object.keys(service.config.contractors.slots ?? {});
    const totalCap = Math.max(0, Number(service.config.contractors.maxConcurrent ?? 0));
    const maxSessions = service.config.scheduler.maxTotalSessions ?? 32;
    for (const slot of slotNames) {
      const cap = service.contractorSlotCap(slot);
      while (service.activeContractors(slot).length < cap
        && service.activeContractors().length < totalCap) {
        const queued = service.store.listAllContractors('queued', slot)[0];
        if (!queued) break;
        let starting;
        service.store.transaction(() => {
          const current = service.store.getContractor(queued.id);
          if (!current || current.status !== 'queued'
            || service.activeContractors(slot).length >= cap || service.activeContractors().length >= totalCap
            || service.workspaceSessionCount() >= maxSessions) return;
          starting = service.store.updateContractor(current.id, { status: 'starting', startedAt: service.now() });
        });
        if (!starting) break;
        const run = service.runContractor(queued.teamId, starting)
          .catch((error) => {
            service.store.addEvent(queued.teamId, 'contractor.runner_error', {
              contractorId: queued.id, error: error instanceof Error ? error.message : String(error),
            });
          })
          .finally(() => {
            service.contractorRuns.delete(queued.id);
            service.pumpContractors();
          });
        service.contractorRuns.set(queued.id, run);
      }
    }
  } finally {
    service.contractorPumping.delete('global');
  }
}

export async function runContractor(service, teamId, contractor) {
  // The red-review contractor slot does not use a model session: its whole
  // job is sending "继续" to a red task, so it runs in the daemon.
  if (service.contractorCanRedReview(contractor) && hasRedReviewPurpose(contractor)) {
    return service.runContractorRedReview(teamId, contractor);
  }
  const id = contractor.id;
  // A protocol contractor gets its own contractor-scoped member server so the
  // declared task:continue capability is reachable through the tool. Every
  // other team tool stays denied (and the admin server can never be used).
  const contractorAdapter = service.contractorAdapter ?? service.adapter;
  if (contractor.nativeModelSignature) assertNativeModelSupported(contractorAdapter);
  const supportsMemberMcp = contractorAdapter.kind === 'protocol';
  const contractorToken = supportsMemberMcp ? service.ensureMemberToken({ id }) : undefined;
  // Read-only and review contractors keep the write barrier through the tool
  // denylist, but still run in the headless worker mode: `plan` would block
  // Bash behind an approval prompt that no headless session can answer.
  const headlessMode = service.config.isolation?.workerMode ?? service.config.zcode.mode;
  const execution = contractorExecutionPolicy({
    mode: contractor.mode,
    headlessMode,
    supportsMemberMcp,
  });
  // A patrol contractor only reports; a shell would let it write the main
  // repository behind the worktree/merge gates. Review and task contractors
  // keep Bash so they can run tests and diffs.
  const patrolPurpose = String(contractor.purpose ?? '').split(':')[0] === 'patrol';
  const disallowedTools = patrolPurpose
    ? [...new Set([...execution.disallowedTools, 'Bash'])]
    : execution.disallowedTools;
  let sessionId;
  let createStarted = false;
  try {
    if (service.dispatchLimiter) await service.dispatchLimiter.acquire();
    const latest = service.store.getContractor(id);
    if (!latest || ['killed', 'cancelled', 'orphaned'].includes(latest.status)) return latest;
    if (latest.status === 'cancelling' || latest.cancelRequested) {
      return service.store.updateContractor(id, { status: 'killed', endedAt: service.now(), sessionId: undefined });
    }
    service.store.updateContractor(id, { status: 'running', startedAt: service.now() });
    service.store.addEvent(teamId, 'contractor.started', { contractorId: id, slot: contractor.slot, purpose: contractor.purpose });
    const initialPrompt = contractorAdapter.kind === 'cli'
      ? 'Initialize contractor session. Reply READY. Do not edit files.'
      : contractorAdapter.kind === 'protocol' ? '' : contractor.prompt;
    const lifetimeMs = Number(contractor.timeoutMs) > 0 ? Number(contractor.timeoutMs) : 15 * 60000;
    createStarted = true;
    const created = await contractorAdapter.create({
      teamId,
      memberName: `contractor:${id}`,
      memberId: id,
      cwd: contractor.cwd ?? service.cwd,
      prompt: initialPrompt,
      model: contractor.model,
      reasoning: contractor.reasoning,
      ...(contractor.modelSelection ? { modelSelection: contractor.modelSelection } : {}),
      mode: execution.mode,
      disallowedTools,
      mcpMode: supportsMemberMcp ? (service.config.zcode.memberMcpServers ?? 'minimal') : 'none',
      token: contractorToken,
      ephemeral: true,
      // Creation happens before a session id exists. Bound it by the same
      // contractor lifetime so a hung CLI cannot sit in the 15-minute
      // adapter default and leave the contractor "running" forever.
      timeoutMs: lifetimeMs,
    });
    sessionId = created.sessionId;
    service.store.updateContractor(id, { sessionId });
    const afterCreate = service.store.getContractor(id);
    if (!afterCreate || afterCreate.cancelRequested || afterCreate.status === 'cancelling') {
      return await service.finishContractorCancellation(teamId, contractor, sessionId, 'cancelled during create', contractorAdapter);
    }
    let result;
    let attempt = 0;
    const maxContinues = Math.max(0, Number(service.turnRetry.maxAttempts) || 0);
    const deadline = Date.now() + lifetimeMs;
    const timeoutError = () => Object.assign(
      new Error(`contractor (${contractor.purpose ?? 'task'}) timed out after ${lifetimeMs}ms`),
      { code: 'E_CONTRACTOR_TIMEOUT' },
    );
    for (;;) {
      attempt += 1;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw timeoutError();
      let failure;
      try {
        result = await service.contractorSendTurn({
          contractorAdapter,
          contractor,
          sessionId,
          message: attempt === 1 ? contractor.prompt : CONTINUE_MESSAGE,
          executionMode: execution.mode,
          disallowedTools,
          timeoutMs: remaining,
        });
        if (!result.ok) {
          failure = new Error(result.warning ?? 'contractor rejected the task');
          if (result.error && typeof result.error === 'object') Object.assign(failure, result.error);
        }
      } catch (error) {
        failure = error;
      }
      const afterSend = service.store.getContractor(id);
      if (!afterSend || afterSend.cancelRequested || afterSend.status === 'cancelling') {
        return await service.finishContractorCancellation(teamId, contractor, sessionId, 'cancelled during send', contractorAdapter);
      }
      if (!failure) break;
      if (!service.shouldContinueContractor(failure, attempt, maxContinues, deadline)) throw failure;
      const delay = service.contractorContinueDelay(failure, attempt);
      service.store.addEvent(teamId, 'contractor.continue_scheduled', {
        contractorId: id,
        slot: contractor.slot,
        attempt,
        retryInMs: delay,
        error: failure instanceof Error ? failure.message : String(failure),
        errorCode: failure?.code,
        sessionId,
      });
      if (delay > 0) {
        await new Promise((resolvePromise) => {
          const timer = setTimeout(resolvePromise, delay);
          timer.unref?.();
        });
      }
    }
    if (result.usage) {
      service.store.recordUsage({ teamId, memberId: id, taskId: contractor.purpose, sessionId, ...result.usage });
    }
    const cleanupError = await service.cleanupContractor(contractorAdapter, id, sessionId);
    const current = service.store.getContractor(id);
    if (current?.status === 'killed') return current;
    if (cleanupError) {
      const blocked = service.store.updateContractor(id, {
        status: 'cleanup_error', result: result.response, usage: result.usage,
        endedAt: service.now(), cleanupError,
      });
      service.store.addEvent(teamId, 'contractor.cleanup_failed', { contractorId: id, slot: contractor.slot, error: cleanupError });
      return blocked;
    }
    const done = service.store.updateContractor(id, {
      status: 'completed', sessionId: undefined, result: result.response,
      usage: result.usage, endedAt: service.now(),
    });
    service.store.addEvent(teamId, 'contractor.completed', { contractorId: id, slot: contractor.slot, purpose: contractor.purpose });
    return done;
  } catch (error) {
    const rawError = error instanceof Error ? error.message : String(error);
    const timedOut = error?.code === 'E_CONTRACTOR_TIMEOUT' || /timed out/i.test(rawError);
    // Normalize both the send-timer timeout and the overall lifetime timeout
    // into one stable code/message so callers and the UI do not see a bare
    // "contractor timed out" with no purpose or limit.
    const failureMessage = timedOut
      ? `contractor (${contractor.purpose ?? 'task'}) timed out after ${contractor.timeoutMs}ms`
      : rawError;
    const failureCode = timedOut ? 'E_CONTRACTOR_TIMEOUT' : error?.code;
    const cleanupError = sessionId
      ? await service.cleanupContractor(contractorAdapter, id, sessionId)
      : createStarted ? 'contractor creation outcome unknown; session identity not available' : undefined;
    const current = service.store.getContractor(id);
    if (current?.cancelRequested || current?.status === 'cancelling') {
      if (cleanupError) {
        const blocked = service.store.updateContractor(id, {
          status: 'cleanup_error', endedAt: service.now(), cleanupError,
          error: failureMessage, errorCode: failureCode,
        });
        service.store.addEvent(teamId, 'contractor.cleanup_failed', { contractorId: id, slot: contractor.slot, error: cleanupError });
        return blocked;
      }
      const killed = service.store.updateContractor(id, {
        status: 'killed', sessionId: undefined, endedAt: service.now(),
        error: error instanceof Error ? error.message : String(error),
      });
      service.store.addEvent(teamId, 'contractor.killed', { contractorId: id, slot: contractor.slot });
      return killed;
    }
    if (['killed', 'cancelled', 'orphaned'].includes(current?.status)) return current;
    if (cleanupError) {
      const blocked = service.store.updateContractor(id, {
        status: 'cleanup_error', endedAt: service.now(), cleanupError,
        error: failureMessage, errorCode: failureCode,
      });
      service.store.addEvent(teamId, 'contractor.cleanup_failed', { contractorId: id, slot: contractor.slot, error: cleanupError });
      return blocked;
    }
    const failed = service.store.updateContractor(id, {
      status: 'failed', sessionId: undefined,
      error: failureMessage, errorCode: failureCode, endedAt: service.now(),
    });
    service.store.addEvent(teamId, 'contractor.failed', { contractorId: id, slot: contractor.slot, error: failed.error });
    return failed;
  }
}

/**
 * Send one contractor turn and wait for its protocol result. The runner
 * timeout does not prove that the underlying send ended, so the settled
 * promise stays registered until it really settles.
 */
export async function contractorSendTurn(service, { contractorAdapter, contractor, sessionId, message, executionMode, disallowedTools, timeoutMs }) {
  let timer;
  const send = contractorAdapter.send({
    sessionId,
    message,
    cwd: contractor.cwd ?? service.cwd,
    delivery: 'queue',
    ephemeral: true,
    mode: executionMode ?? service.config.zcode.mode,
    disallowedTools,
    wait: contractorAdapter.kind === 'protocol',
    timeoutMs,
  });
  let sendSettled;
  sendSettled = Promise.resolve(send).then(() => undefined, () => undefined)
    .finally(() => {
      if (service.contractorSends.get(contractor.id) === sendSettled) service.contractorSends.delete(contractor.id);
    });
  service.contractorSends.set(contractor.id, sendSettled);
  try {
    return await Promise.race([
      send,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('contractor timed out')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Whether a failed contractor turn may be continued on the same session. */
export function shouldContinueContractor(service, error, attempt, maxContinues, deadline) {
  if (!service.turnRetry.enabled) return false;
  if (attempt > maxContinues) return false;
  const retryable = isRetryableTurnError({
    message: error instanceof Error ? error.message : String(error),
    code: error?.code,
    type: error?.type,
    retryable: error?.retryable,
    retryAfterMs: error?.retryAfterMs,
  });
  if (!retryable) return false;
  return Date.now() + service.contractorContinueDelay(error, attempt) < deadline;
}

export function contractorContinueDelay(service, error, attempt) {
  const hint = Number(error?.retryAfterMs);
  if (Number.isFinite(hint) && hint > 0) return Math.min(3600000, hint);
  return continueBackoffMs(attempt, service.turnRetry);
}

export async function finishContractorCancellation(service, teamId, contractor, sessionId, reason, adapter) {
  const cleanupError = await service.cleanupContractor(adapter, contractor.id, sessionId);
  if (cleanupError) {
    const blocked = service.store.updateContractor(contractor.id, { status: 'cleanup_error', sessionId, endedAt: service.now(), cleanupError });
    service.store.addEvent(teamId, 'contractor.cleanup_failed', { contractorId: contractor.id, slot: contractor.slot, error: cleanupError });
    return blocked;
  }
  const killed = service.store.updateContractor(contractor.id, { status: 'killed', sessionId: undefined, endedAt: service.now() });
  service.store.addEvent(teamId, 'contractor.killed', { contractorId: contractor.id, slot: contractor.slot, reason });
  return killed;
}

export async function waitForContractor(service, id, waitMs = 120000) {
  const deadline = Date.now() + Math.max(1000, waitMs);
  while (true) {
    const contractor = service.store.getContractor(id);
    if (!contractor) throw new Error(`unknown contractor: ${id}`);
    // cleanup_error keeps the slot occupied, but callers must receive the
    // blocked result promptly instead of waiting for the overall deadline.
    if (['completed', 'failed', 'killed', 'cancelled', 'orphaned', 'cleanup_error'].includes(contractor.status)) return contractor;
    if (Date.now() >= deadline) {
      return service.killContractor(contractor.teamId, id);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// Backward-compatible blocking helper used by merge review and patrol.
export async function spawnContractor(service, input, { onSubmitted, signal } = {}) {
  signal?.throwIfAborted();
  let notified = false;
  const notify = (record) => { notified = true; onSubmitted?.(record); };
  const submitted = await service.submitContractor(input, { signal, onSubmitted: notify });
  // Expose the id as soon as the record exists so a patrol deadline can
  // cancel a contractor whose creation/send is still in flight.
  if (!notified) notify(submitted);
  signal?.throwIfAborted();
  const maxLifetimeMs = service.config.contractors.maxLifetimeMinutes * 60000;
  return service.waitForContractor(submitted.id, Math.max(30000, maxLifetimeMs * 3));
}

export async function killContractor(service, teamId, contractorId) {
  const contractor = service.store.getContractor(contractorId);
  if (!contractor || contractor.teamId !== teamId) throw Object.assign(new Error(`unknown contractor: ${contractorId}`), { status: 404, code: 'E_NOT_FOUND' });
  if (['completed', 'failed', 'killed', 'cancelled', 'orphaned'].includes(contractor.status)) return contractor;
  const unprovenCleanup = contractor.status === 'cleanup_error';
  if (contractor.status === 'cleanup_error' && !contractor.sessionId) {
    // Creation never produced a session identity, so no adapter query can
    // prove or disprove side effects. An explicit kill is the operator's
    // reconciliation: release the slot instead of blocking it forever.
    const released = service.store.updateContractor(contractorId, {
      status: 'orphaned', sessionId: undefined, endedAt: service.now(),
      releasedAt: service.now(), releaseReason: 'kill after unproven creation',
    });
    service.store.addEvent(teamId, 'contractor.orphaned', {
      contractorId, slot: contractor.slot, reason: 'kill after unproven creation',
    });
    service.pumpContractors();
    return released;
  }
  if (contractor.status === 'queued') {
    const killed = service.store.updateContractor(contractorId, {
      status: 'killed', sessionId: undefined, endedAt: service.now(),
    });
    service.store.addEvent(teamId, 'contractor.killed', { contractorId, slot: contractor.slot });
    service.pumpContractors();
    return killed;
  }
  // Keep the slot occupied while the in-flight create/send settles. The runner
  // observes cancelRequested, stops the new session and then releases the slot.
  const cancelling = service.store.updateContractor(contractorId, {
    status: 'cancelling', cancelRequested: true,
  });
  service.store.addEvent(teamId, 'contractor.cancelling', { contractorId, slot: contractor.slot });
  const cleanupError = cancelling.sessionId
    ? await service.cleanupContractor(service.contractorAdapter ?? service.adapter, contractorId, cancelling.sessionId)
    : (service.contractorRuns.has(contractorId) || hasRedReviewPurpose(contractor)
      ? undefined : 'contractor session identity unavailable; creation may still be active');
  if (cleanupError) {
    if (unprovenCleanup && !service.contractorRuns.has(contractorId)) {
      // The operator retried the cleanup with an explicit kill and it still
      // could not prove termination. Releasing the slot is an audited manual
      // decision, not an automatic success.
      const released = service.store.updateContractor(contractorId, {
        status: 'orphaned', sessionId: undefined, endedAt: service.now(), cleanupError,
        releasedAt: service.now(), releaseReason: 'kill after unproven cleanup',
      });
      service.store.addEvent(teamId, 'contractor.orphaned', {
        contractorId, slot: contractor.slot, reason: 'kill after unproven cleanup', error: cleanupError,
      });
      service.pumpContractors();
      return released;
    }
    const blocked = service.store.updateContractor(contractorId, {
      status: 'cleanup_error', cleanupError, cancelRequested: true,
    });
    service.store.addEvent(teamId, 'contractor.cleanup_failed', { contractorId, slot: contractor.slot, error: cleanupError });
    return blocked;
  }
  if (!service.contractorRuns.has(contractorId)) {
    const killed = service.store.updateContractor(contractorId, {
      status: 'killed', sessionId: undefined, endedAt: service.now(),
    });
    service.store.addEvent(teamId, 'contractor.killed', { contractorId, slot: contractor.slot });
    service.pumpContractors();
    return killed;
  }
  return service.store.getContractor(contractorId);
}
