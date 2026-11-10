import { invalidateAttempt } from '../domain/attempts.mjs';
import { assertNativeModelSupported, readNativeWorkerModel } from './model-policy.mjs';

function nativeError(code) {
  return Object.assign(new Error('Native worker model selection blocked dispatch.'), { code, status: 409 });
}

export function isNativeModelDispatchError(error) {
  return typeof error?.code === 'string' && /^(?:NATIVE_AGENT_|E_NATIVE_)[A-Z0-9_]+$/u.test(error.code);
}

/** Keep the pre-pin preference separate from the effective session model. */
export function nativeModelSpawnState(member, model) {
  return model.source === 'native-agent' ? {
    nativeModelSignature: model.signature,
    nativeModelPrevious: member.nativeModelPrevious ?? {
      model: member.model ?? null, reasoning: member.reasoning ?? null,
    },
  } : { nativeModelSignature: undefined, nativeModelPrevious: undefined };
}

function taskIsCurrent(service, context) {
  return service.isCurrentAttempt(context.taskId, context.attemptId, context.memberName);
}

function mailIsPending(service, context) {
  const message = service.store.getMessage(context.messageId);
  return message && message.teamId === context.teamId && message.to === context.memberName
    && !message.deliveredAt && !message.discardedAt
    && (!message.approvalState || ['approved', 'local'].includes(message.approvalState))
    && Number(message.deliveryRetryAt ?? 0) <= service.now();
}

function currentMember(service, context, deliveryIsCurrent) {
  const member = service.store.getMember(context.memberId);
  const team = service.store.getTeam(context.teamId);
  if (!deliveryIsCurrent(service, context)
      || !team || team.control === 'halted' || (team.controlEpoch ?? 0) !== context.controlEpoch
      || !member || member.status === 'removed' || !member.sessionId || member.sessionId !== context.sessionId
      || member.sessionRecoveryState === 'unknown' || member.workerSessionStart) {
    throw nativeError('E_NATIVE_DISPATCH_STALE');
  }
  return member;
}

async function applyAndSend(service, context, send, deliveryIsCurrent) {
  // A settings edit can arrive during setModel. Re-read after each await and
  // converge before sending; perpetual edits fail closed rather than guessing.
  for (let round = 0; round < 3; round += 1) {
    const member = currentMember(service, context, deliveryIsCurrent);
    const native = readNativeWorkerModel(service, member);
    if (!native && !member.nativeModelSignature) return send(member);
    assertNativeModelSupported(service.adapter);
    if (typeof service.adapter.setModel !== 'function') throw nativeError('E_NATIVE_MODEL_UNSUPPORTED');
    if (native && native.signature === member.nativeModelSignature) return send(member);
    const target = native ?? service.resolveModelForSpawn(member);
    if (!target.model) throw nativeError('E_NATIVE_MODEL_RESTORE_UNAVAILABLE');
    try {
      const applied = await service.adapter.setModel({
        sessionId: context.sessionId,
        model: target.model,
        reasoning: target.reasoning ?? null,
        ...(target.modelSelection ? { modelSelection: target.modelSelection } : {}),
      });
      if (applied === false || applied?.ok === false) throw nativeError('E_NATIVE_MODEL_APPLY_FAILED');
    } catch {
      // An error does not prove the remote model stayed unchanged. Retain an
      // unconfirmed marker so removing the pin still restores the old policy.
      const latest = currentMember(service, context, deliveryIsCurrent);
      service.store.updateMember(latest.id, {
        nativeModelPrevious: latest.nativeModelPrevious ?? {
          model: latest.model ?? null, reasoning: latest.reasoning ?? null,
        },
        nativeModelSignature: `unconfirmed:${target.signature ?? 'inherit'}`,
      });
      // Provider errors may contain URLs or credentials. Preserve neither their
      // message nor their cause in task state or public audit events.
      throw nativeError('E_NATIVE_MODEL_APPLY_FAILED');
    }
    const latest = currentMember(service, context, deliveryIsCurrent);
    service.store.updateMember(latest.id, {
      model: target.model, reasoning: target.reasoning ?? null,
      ...nativeModelSpawnState(latest, target),
    });
    const now = readNativeWorkerModel(service, latest);
    if ((now?.signature ?? 'inherit') === (target.source === 'native-agent' ? target.signature : 'inherit')) {
      return send(currentMember(service, context, deliveryIsCurrent));
    }
  }
  throw nativeError('E_NATIVE_MODEL_UNSTABLE');
}

/**
 * Serialize native reconciliation AND send with model-policy hot applies. The
 * callback must not enqueue another operation on modelApplyChain. Legacy
 * dispatch without a native choice/restoration keeps its existing execution path.
 */
function withNativeModelForSend(service, context, send, deliveryIsCurrent) {
  const member = service.store.getMember(context.memberId);
  if (!member) throw nativeError('E_NATIVE_DISPATCH_STALE');
  const native = readNativeWorkerModel(service, member);
  if (!native && !member.nativeModelSignature) return send(member);
  const run = () => applyAndSend(service, context, send, deliveryIsCurrent);
  const pending = service.modelApplyChain.then(run, run);
  service.modelApplyChain = pending.then(() => undefined, () => undefined);
  return pending;
}

export function withNativeModelForDispatch(service, context, send) {
  return withNativeModelForSend(service, context, send, taskIsCurrent);
}

/** Mail has a pending delivery, not a task attempt. Never manufacture one. */
export function withNativeModelForMail(service, context, send) {
  return withNativeModelForSend(service, context, send, mailIsPending);
}

/** Keep locally refused mail pending; provider delivery failure counters are unchanged. */
export function deferNativeModelMail(service, { teamId, message, error, retryInMs }) {
  const latest = service.store.getMessage(message.id);
  if (!latest || latest.deliveredAt || latest.discardedAt) return;
  const retryAt = service.now() + retryInMs;
  service.store.updateMessage(message.id, {
    deliveryRetryAt: retryAt, lastDeliveryError: error.code,
  });
  service.store.updateTeam(teamId, { needsCaptain: true });
  service.store.addEvent(teamId, 'message.delivery_failed', {
    messageId: message.id, to: latest.to, reason: 'native_model_selection',
    errorCode: error.code, retryAt, retryInMs,
  });
}

/** Local configuration refusals never spend the provider/turn failure budget. */
export function holdNativeModelDispatch(service, { teamId, task, member, started, error }) {
  service.store.transaction(() => {
    const attempt = service.store.getAttempt(started.attemptId);
    if (attempt && ['claimed', 'in_progress'].includes(attempt.status)) {
      service.store.updateAttempt(started.attemptId, {
        status: 'failed', endedAt: service.now(), error: 'native model selection blocked dispatch',
      });
    }
    const latest = service.store.getTask(task.id);
    if (!service.isCurrentAttempt(task.id, started.attemptId, member.name)) return;
    service.store.updateTask(task.id, {
      ...invalidateAttempt(latest, { assignee: latest.assignee }), reassigning: false,
      hold: { class: 'native_model_selection', reason: 'native_model_selection' }, needsCaptain: true,
    });
    service.store.updateTeam(teamId, { needsCaptain: true });
    const current = service.store.getMember(member.id);
    if (current && current.sessionId === member.sessionId && current.status !== 'removed') {
      service.store.updateMember(current.id, { status: 'idle' });
      service.refreshMemberState(teamId, current.id);
    }
    service.store.addEvent(teamId, 'task.dispatch_deferred', {
      taskId: task.id, attemptId: started.attemptId,
      reason: 'native_model_selection', errorCode: error.code,
    });
  });
  return false;
}
