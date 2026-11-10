import { isDeepStrictEqual } from 'node:util';

const KINDS = new Set(['integration', 'publish', 'negative']);
const PHASES = new Set(['prepared', 'settled', 'blocked']);
const IDENTITY = ['taskId', 'teamId', 'taskEpoch', 'controlEpoch', 'deliveryGeneration',
  'reviewDigest', 'target', 'commit', 'artifact', 'authorizationMode'];

const validText = (value) => typeof value === 'string' && value.trim().length > 0;

function fail(code, message = code) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function identityOf(input) {
  const identity = Object.fromEntries(IDENTITY.map((key) => [key, input[key] ?? null]));
  for (const key of ['taskId', 'teamId', 'target', 'commit', 'artifact'])
    if (!validText(input[key])) fail('E_INTENT_IDENTITY_REQUIRED', `invalid ${key}`);
  for (const key of ['taskEpoch', 'controlEpoch', 'deliveryGeneration'])
    if (!Number.isSafeInteger(input[key]) || input[key] < 0) fail('E_INTENT_IDENTITY_REQUIRED', `invalid ${key}`);
  if (!Object.hasOwn(input, 'reviewDigest') || !(input.reviewDigest === null || validText(input.reviewDigest))) fail('E_INTENT_IDENTITY_REQUIRED', 'invalid reviewDigest');
  if (input.kind === 'publish' && (!['on', 'off'].includes(input.authorizationMode) ||
      (input.authorizationMode === 'on' && !validText(input.reviewDigest)) ||
      (input.authorizationMode === 'off' && input.reviewDigest !== null))) fail('E_INTENT_IDENTITY_REQUIRED', 'invalid authorizationMode or reviewDigest');
  if (input.kind !== 'publish' && input.authorizationMode != null && !['on', 'off'].includes(input.authorizationMode)) fail('E_INTENT_IDENTITY_REQUIRED', 'invalid authorizationMode');
  return identity;
}

function sameIdentity(a, b) {
  return IDENTITY.every((key) => a[key] === b[key]);
}

function readTask(store, identity) {
  const task = store.getTask(identity.taskId);
  if (!task) fail('E_INTENT_TASK_MISSING');
  if (task.teamId !== identity.teamId) fail('E_INTENT_TEAM_MISMATCH');
  const team = store.getTeam(identity.teamId);
  if (!team) fail('E_INTENT_TEAM_MISSING');
  const actual = {
    taskEpoch: task.taskEpoch,
    controlEpoch: team.controlEpoch,
    deliveryGeneration: task.deliveryGeneration,
  };
  for (const key of Object.keys(actual)) if (actual[key] !== identity[key]) fail('E_INTENT_CAS_STALE', `${key} changed`);
  return task;
}

function mutate(store, input, action) {
  if (!store?.transaction || !store?.getTask || !store?.getTeam || !store?.updateTask || !store?.addEvent) {
    fail('E_INTENT_STORE_API');
  }
  const kind = input.kind;
  if (!KINDS.has(kind)) fail('E_INTENT_KIND');
  const identity = identityOf(input);
  const operationId = input.id ?? input.operationId;
  if (!validText(operationId) || ['__proto__', 'constructor', 'prototype'].includes(operationId) ||
      (input.id != null && input.operationId != null && input.id !== input.operationId)) fail('E_INTENT_ID_REQUIRED');
  if (!validText(input.initiator) || !validText(input.executor)) fail('E_INTENT_ACTORS_REQUIRED');
  if (input.payload != null && (typeof input.payload !== 'object' || Array.isArray(input.payload))) fail('E_INTENT_PAYLOAD');
  for (const key of [...IDENTITY, 'id', 'kind', 'phase', 'initiator', 'executor', 'createdAt', 'updatedAt', 'outcome', 'resultDigest']) {
    if (input.payload && Object.hasOwn(input.payload, key)) fail('E_INTENT_IMMUTABLE_FIELD');
  }

  return store.transaction(() => {
    const task = readTask(store, identity);
    const records = task.deliveryIntents ?? { integration: {}, publish: {}, negative: {} };
    const bucket = records[kind] ?? {};
    const current = Object.hasOwn(bucket, operationId) ? bucket[operationId] : undefined;
    if (action.type === 'prepare') {
      if (current) {
        if (!sameIdentity(current, identity) || current.initiator !== input.initiator ||
            (input.payload && Object.entries(input.payload).some(([key, value]) => !isDeepStrictEqual(current[key], value)))) fail('E_INTENT_ID_CONFLICT');
        return { intent: current, duplicate: true };
      }
      if (kind === 'publish') {
        const staged = task.stagedDeliveryIntent;
        if (!staged) fail('E_INTENT_STAGED_MISSING');
        const expected = { id: operationId, taskEpoch: identity.taskEpoch, controlEpoch: identity.controlEpoch,
          deliveryGeneration: identity.deliveryGeneration, targetRef: identity.target,
          appliedCommit: identity.commit, artifactDigest: identity.artifact, mergeTargetId: identity.taskId,
          rootId: input.payload?.rootId, expectedOldHead: input.payload?.expectedOldHead, initiator: input.initiator };
        if (Object.entries(expected).some(([key, value]) => staged[key] !== value) ||
            !validText(input.payload?.rootId) || !validText(input.payload?.expectedOldHead) ||
            staged.publicationStarted !== false) fail('E_INTENT_STAGED_MISMATCH');
      }
      if (action.expectedPhase !== undefined) fail('E_INTENT_CAS_STALE');
      const intent = {
        id: operationId, kind, phase: 'prepared', ...identity,
        initiator: input.initiator, executor: input.executor,
        createdAt: Date.now(), updatedAt: Date.now(),
        ...(input.payload ?? {}),
      };
      // Payload may carry operational evidence but cannot shadow frozen identity or state.
      bucket[operationId] = intent;
      records[kind] = bucket;
      const patch = { deliveryIntents: records };
      if (kind === 'integration') patch.integrationIntent = intent;
      if (kind === 'publish') {
        patch.stagedDeliveryIntent = { ...task.stagedDeliveryIntent, publicationStarted: true };
        patch.publishIntent = intent;
      }
      if (kind === 'negative') patch.negativeMergeIntent = intent;
      store.updateTask(identity.taskId, patch);
      store.addEvent(identity.teamId, `delivery_intent.${kind}.prepared`, {
        opId: operationId, taskId: identity.taskId, initiator: intent.initiator,
        executor: intent.executor, taskEpoch: identity.taskEpoch, controlEpoch: identity.controlEpoch,
        deliveryGeneration: identity.deliveryGeneration,
      });
      return { intent, duplicate: false };
    }

    if (!current) fail('E_INTENT_NOT_FOUND');
    if (!sameIdentity(current, identity)) fail('E_INTENT_ID_CONFLICT');
    if (current.phase !== 'prepared') {
      if (current.phase === action.phase && isDeepStrictEqual(current.resultDigest, action.resultDigest ?? null) &&
          isDeepStrictEqual(current.outcome, action.outcome ?? null)) return { intent: current, duplicate: true };
      fail('E_INTENT_TERMINAL');
    }
    if (action.expectedPhase !== current.phase) fail('E_INTENT_CAS_STALE');
    if (!PHASES.has(action.phase) || action.phase === 'prepared') fail('E_INTENT_PHASE');
    const updated = { ...current, phase: action.phase, resultDigest: action.resultDigest ?? null,
      outcome: action.outcome ?? null, updatedAt: Date.now() };
    bucket[operationId] = updated;
    records[kind] = bucket;
    const patch = { deliveryIntents: records };
    if (kind === 'integration') patch.integrationIntent = updated;
    if (kind === 'publish') patch.publishIntent = updated;
    if (kind === 'negative') patch.negativeMergeIntent = updated;
    store.updateTask(identity.taskId, patch);
    store.addEvent(identity.teamId, `delivery_intent.${kind}.${action.phase}`, {
      opId: operationId, taskId: identity.taskId, initiator: current.initiator,
      executor: input.executor, taskEpoch: identity.taskEpoch, controlEpoch: identity.controlEpoch,
      deliveryGeneration: identity.deliveryGeneration, resultDigest: updated.resultDigest,
    });
    return { intent: updated, duplicate: false };
  });
}

export function prepareDeliveryIntent(store, input) { return mutate(store, input, { type: 'prepare' }); }

export function settleDeliveryIntent(store, input) {
  return mutate(store, input, { type: 'settle', expectedPhase: input.expectedPhase ?? 'prepared',
    phase: input.phase ?? 'settled', outcome: input.outcome, resultDigest: input.resultDigest });
}

export function getDeliveryIntent(store, taskId, kind, id) {
  if (!KINDS.has(kind)) fail('E_INTENT_KIND');
  const task = store.getTask(taskId);
  return task?.deliveryIntents?.[kind]?.[id];
}
