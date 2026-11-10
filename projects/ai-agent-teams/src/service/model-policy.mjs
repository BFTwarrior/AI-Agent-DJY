// Model policy: host follow, fixed pins and hot-apply.
//
// Extracted from SchedulerService so the resolution rules and the watcher's
// apply path stay together. Every function receives the service instance and
// uses only its public state (config, store, adapter, hostModel, modelPolicy).

function isNativeWorker(service, member) {
  return !member || (member.role !== 'captain' && member.license?.roleKey !== 'captain'
    && !service.memberIsShadow?.(member));
}

/** Read the native team-worker pin without changing policy or session state. */
export function readNativeWorkerModel(service, member) {
  if (!isNativeWorker(service, member) || !service.nativeAgentModel) return null;
  let snapshot;
  try {
    snapshot = service.nativeAgentModel();
  } catch (error) {
    if (typeof error?.code === 'string' && /^(E_NATIVE_|NATIVE_AGENT_)/u.test(error.code)) throw error;
    throw Object.assign(new Error('Native worker model selection could not be read', { cause: error }), {
      code: 'E_NATIVE_MODEL_READ', status: 409,
    });
  }
  if (snapshot?.source === 'inherit') return null;
  if (snapshot?.source !== 'native-agent' || typeof snapshot.model !== 'string' || !snapshot.model.trim()
    || typeof snapshot.modelSelection?.providerId !== 'string' || !snapshot.modelSelection.providerId.trim()
    || typeof snapshot.modelSelection?.modelId !== 'string' || !snapshot.modelSelection.modelId.trim()) {
    throw Object.assign(new Error('Native worker model selection is invalid'), { code: 'E_NATIVE_MODEL_INVALID', status: 409 });
  }
  return {
    model: snapshot.model, reasoning: snapshot.reasoning ?? null,
    source: 'native-agent', agentId: snapshot.agentId ?? null,
    modelSelection: structuredClone(snapshot.modelSelection),
    signature: snapshot.signature ?? JSON.stringify([snapshot.agentId, snapshot.modelSelection]),
  };
}

/** Explicit native pins must never be silently ignored by a session adapter. */
export function assertNativeModelSupported(adapter) {
  if (adapter?.supportsModelSwitch === false && adapter.kind !== 'fake') {
    throw Object.assign(new Error(`Native worker model selection is unsupported by the ${adapter.kind ?? 'selected'} adapter`), {
      code: 'E_NATIVE_MODEL_UNSUPPORTED', status: 409,
    });
  }
}

/**
 * The captain session's current model/reasoning. Falls back to the configured
 * defaults when the host log is unavailable or the daemon runs without a host.
 * @returns {{ model: string|null, reasoning: string|null, source: 'host'|'default'|'none', sessionId: string|null, sessionSource?: string }}
 */
export function currentHostModel(service) {
  if (service.hostModel) {
    try {
      const host = service.hostModel();
      if (host && typeof host === 'object') {
        const model = typeof host.model === 'string' && host.model.trim() ? host.model.trim() : null;
        const reasoning = typeof host.reasoning === 'string' && host.reasoning.trim() ? host.reasoning.trim() : null;
        // Keep the resolved session id even when the log has no model event
        // yet: status must distinguish "hook never ran" from "no model line".
        return {
          model,
          reasoning,
          source: model || reasoning ? (host.source ?? 'host') : 'none',
          sessionId: host.sessionId ?? null,
          sessionSource: host.sessionSource ?? 'none',
        };
      }
    } catch {
      // A malformed or unreadable host log must never block dispatch.
    }
  }
  const model = service.config.zcode?.defaultModel ?? null;
  const reasoning = service.config.zcode?.defaultReasoning ?? null;
  return { model, reasoning, source: model || reasoning ? 'default' : 'none', sessionId: null, sessionSource: 'none' };
}

/**
 * Resolve the model a member session should start with.
 * fixed: policy pin, then the member's explicit preference, then config defaults.
 * follow-host: a real host value wins; otherwise the member preference, the
 * (possibly defaulted) host value, and finally config defaults.
 * `member.modelOverride` keeps an add_member model from being lost when the
 * effective `member.model` is rewritten by a host switch.
 * @param {{ model?: string|null, reasoning?: string|null, modelOverride?: string|null, reasoningOverride?: string|null }} [member]
 * @returns {{ model: string|null, reasoning: string|null }}
 */
export function resolveModelForSpawn(service, member = {}) {
  const native = readNativeWorkerModel(service, member);
  if (native) {
    assertNativeModelSupported(service.adapter);
    return native;
  }
  const defaultModel = service.config.zcode?.defaultModel ?? null;
  const defaultReasoning = service.config.zcode?.defaultReasoning ?? null;
  const preferredModel = member.modelOverride ?? (member.nativeModelSignature ? member.nativeModelPrevious?.model : member.model) ?? null;
  const preferredReasoning = member.reasoningOverride ?? (member.nativeModelSignature ? member.nativeModelPrevious?.reasoning : member.reasoning) ?? null;
  if ((service.modelPolicy?.mode ?? 'follow-host') === 'fixed') {
    return {
      model: service.modelPolicy.model ?? preferredModel ?? defaultModel,
      reasoning: service.modelPolicy.reasoning ?? preferredReasoning ?? defaultReasoning,
    };
  }
  const host = service.currentHostModel();
  const hostIsReal = host.source === 'host';
  return {
    model: hostIsReal
      ? (host.model ?? preferredModel ?? defaultModel)
      : (preferredModel ?? host.model ?? defaultModel),
    reasoning: hostIsReal
      ? (host.reasoning ?? preferredReasoning ?? defaultReasoning)
      : (preferredReasoning ?? host.reasoning ?? defaultReasoning),
  };
}

/**
 * Serialize hot-applies: a watcher tick that read the host model before an
 * `agent_teams_model set` must not land after the pin and resurrect it.
 * @param {Parameters<TeamService['applyModelToActiveSessionsNow']>[0]} [input]
 */
export async function applyModelToActiveSessions(service, input = {}) {
  const run = () => service.applyModelToActiveSessionsNow(input);
  const pending = service.modelApplyChain.then(run, run);
  service.modelApplyChain = pending.then(() => undefined, () => undefined);
  return pending;
}

/**
 * Hot-apply a model to every member with a live session. A failed member is
 * recorded as an event and skipped; it never aborts the other members.
 * Adapters that cannot switch models (CLI/container) report `unsupported`
 * instead of failing, so the watcher does not retry forever.
 * @param {{ model?: string|null, reasoning?: string|null, reason?: string, expectedEpoch?: number }} [input]
 * @returns {Promise<{ applied: number, failed: Array<{ memberId: string, name: string, error: string }>, model: string|null, reasoning: string|null, skipped?: string }>}
 */
export async function applyModelToActiveSessionsNow(service, {
  model = null, reasoning = null, reason = 'model-policy', expectedEpoch,
  expectedPolicyMode = 'follow-host', expectedNativeSignature, nativeOnly = false,
} = {}) {
  const resolvedModel = model ?? service.config.zcode?.defaultModel ?? null;
  const resolvedReasoning = reasoning ?? service.config.zcode?.defaultReasoning ?? null;
  // A caller that captured an epoch promises "apply only if the policy has not
  // changed since"; a queued or retried follow must not resurrect the host
  // value after `set`. The watcher reads and queues in one turn, so this is a
  // contract for other callers rather than the watcher's primary path.
  if (expectedEpoch !== undefined
    && (expectedEpoch !== service.modelPolicyEpoch || service.modelPolicy.mode !== expectedPolicyMode)) {
    return { applied: 0, failed: [], model: resolvedModel, reasoning: resolvedReasoning, skipped: 'superseded' };
  }
  const native = readNativeWorkerModel(service);
  if (expectedNativeSignature !== undefined && expectedNativeSignature !== (native?.signature ?? 'inherit')) {
    return { applied: 0, failed: [], model: resolvedModel, reasoning: resolvedReasoning, skipped: 'superseded' };
  }
  if (native) assertNativeModelSupported(service.adapter);
  if (!resolvedModel && !native && !nativeOnly) {
    return { applied: 0, failed: [], model: null, reasoning: resolvedReasoning, skipped: 'no-model' };
  }
  if (service.adapter.supportsModelSwitch === false && !native) {
    return { applied: 0, failed: [], model: resolvedModel, reasoning: resolvedReasoning, skipped: 'unsupported' };
  }
  let applied = 0;
  const failed = [];
  for (const team of service.store.listTeams()) {
    for (const member of service.store.listMembers(team.id)) {
      if (member.status === 'removed' || !member.sessionId) continue;
      const worker = isNativeWorker(service, member);
      if (nativeOnly && !worker) continue;
      const pin = worker ? native : null;
      const restored = member.nativeModelPrevious;
      const fallback = nativeOnly && !pin ? resolveModelForSpawn(service, member) : null;
      const targetModel = pin?.model ?? fallback?.model ?? resolvedModel;
      const targetReasoning = pin ? pin.reasoning : fallback ? fallback.reasoning : resolvedReasoning;
      if (!targetModel) continue;
      try {
        const result = await service.adapter.setModel({
          sessionId: member.sessionId,
          model: targetModel,
          reasoning: targetReasoning,
          ...(pin ? { modelSelection: pin.modelSelection } : {}),
        });
        if (result && result.ok === false) {
          throw new Error(result.warning ?? 'session adapter rejected setModel');
        }
        const latest = service.store.getMember(member.id);
        if (!latest || latest.status === 'removed' || latest.sessionId !== member.sessionId) continue;
        service.store.updateMember(member.id, {
          model: targetModel, reasoning: targetReasoning,
          ...(pin ? {
            nativeModelSignature: pin.signature,
            nativeModelPrevious: restored ?? (member.nativeModelSignature ? undefined : { model: member.model ?? null, reasoning: member.reasoning ?? null }),
          } : member.nativeModelSignature ? { nativeModelPrevious: undefined, nativeModelSignature: undefined } : {}),
        });
        service.store.addEvent(team.id, 'model.followed', {
          memberId: member.id,
          name: member.name,
          sessionId: member.sessionId,
          model: targetModel,
          reasoning: targetReasoning,
          reason,
        });
        applied += 1;
      } catch (error) {
        const latest = service.store.getMember(member.id);
        if (pin && latest?.status !== 'removed' && latest?.sessionId === member.sessionId) {
          // A rejected reply does not prove the remote model stayed unchanged.
          service.store.updateMember(member.id, {
            nativeModelSignature: `unconfirmed:${pin.signature}`,
            nativeModelPrevious: restored ?? (member.nativeModelSignature ? undefined : { model: member.model ?? null, reasoning: member.reasoning ?? null }),
          });
        }
        const message = error instanceof Error ? error.message : String(error);
        failed.push({ memberId: member.id, name: member.name, error: message });
        service.store.addEvent(team.id, 'model.follow_failed', {
          memberId: member.id,
          name: member.name,
          sessionId: member.sessionId,
          model: targetModel,
          reasoning: targetReasoning,
          reason,
          error: message,
        });
      }
    }
  }
  return { applied, failed, model: resolvedModel, reasoning: resolvedReasoning };
}

/** Record that the watcher gave up on a host signature after repeated failures. */
export function noteModelFollowAbandoned(service, { model = null, reasoning = null, attempts = 0, failed = [] } = {}) {
  let teamsNotified = 0;
  for (const team of service.store.listTeams()) {
    const live = service.store.listMembers(team.id)
      .filter((member) => member.status !== 'removed' && member.sessionId);
    if (live.length === 0) continue;
    service.store.addEvent(team.id, 'model.follow_abandoned', {
      model,
      reasoning,
      attempts,
      failed: failed.map((item) => item.memberId),
    });
    teamsNotified += 1;
  }
  return teamsNotified;
}

/** Every policy change is an event (INV-043). */
export function recordPolicyChange(service, from, to, actor) {
  for (const team of service.store.listTeams()) {
    service.store.addEvent(team.id, 'model.policy_changed', {
      from: { ...from },
      to: { ...to },
      actor,
    });
  }
}

export function modelStatus(service) {
  const members = [];
  for (const team of service.store.listTeams()) {
    for (const member of service.store.listMembers(team.id)) {
      if (member.status === 'removed') continue;
      members.push({
        teamId: team.id,
        id: member.id,
        name: member.name,
        model: member.model ?? null,
        reasoning: member.reasoning ?? null,
        modelOverride: member.modelOverride ?? null,
        reasoningOverride: member.reasoningOverride ?? null,
        sessionId: member.sessionId ?? null,
        status: member.status ?? null,
      });
    }
  }
  return {
    policy: { ...service.modelPolicy },
    host: service.currentHostModel(),
    defaults: {
      model: service.config.zcode?.defaultModel ?? null,
      reasoning: service.config.zcode?.defaultReasoning ?? null,
    },
    members,
  };
}

/**
 * Pin a model for every member and hot-apply it to live sessions.
 * @param {{ model?: string, reasoning?: string|null, actor?: string }} [input]
 */
export async function setFixedModel(service, { model, reasoning = null, actor = 'captain' } = {}) {
  if (typeof model !== 'string' || !model.trim()) {
    throw new Error('model is required when action=set');
  }
  const normalizedReasoning = typeof reasoning === 'string' && reasoning.trim() ? reasoning.trim() : null;
  const previous = service.modelPolicy;
  service.modelPolicy = { mode: 'fixed', model: model.trim(), reasoning: normalizedReasoning };
  service.modelPolicyEpoch += 1;
  service.recordPolicyChange(previous, service.modelPolicy, actor);
  const applied = await service.applyModelToActiveSessions({
    model: service.modelPolicy.model,
    reasoning: service.modelPolicy.reasoning,
    reason: 'fixed',
  });
  return { ...service.modelStatus(), applied };
}

/**
 * Resume following the captain session and hot-apply the host model now.
 * @param {{ actor?: string }} [input]
 */
export async function followHostModel(service, { actor = 'captain' } = {}) {
  const previous = service.modelPolicy;
  service.modelPolicy = { mode: 'follow-host', model: null, reasoning: null };
  service.modelPolicyEpoch += 1;
  service.recordPolicyChange(previous, service.modelPolicy, actor);
  const host = service.currentHostModel();
  const applied = await service.applyModelToActiveSessions({
    model: host.model,
    reasoning: host.reasoning,
    reason: 'follow-host',
  });
  return { ...service.modelStatus(), applied };
}
