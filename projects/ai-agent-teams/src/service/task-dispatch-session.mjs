// Freshness contract: keep attempt checks adjacent to async session boundaries;
// helpers must preserve the ordering of attempt-owned state and event writes.
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { memberPermissionMode } from '../domain/scheduler.mjs';
import { invalidateAttempt } from '../domain/attempts.mjs';
import { retryAfterMsFrom } from '../session/retry-after.mjs';
import { ensureOwnedMemberHome } from '../session/worker-home.mjs';
import { assertNativeModelSupported, readNativeWorkerModel } from './model-policy.mjs';
import {
  holdNativeModelDispatch, isNativeModelDispatchError, nativeModelSpawnState, withNativeModelForDispatch,
} from './native-model-dispatch.mjs';

/**
 * Read the session cursor with bounded retries, recording the existing
 * unavailable event before the caller performs its next attempt check.
 * @returns {Promise<{turnAfterSeq: number|undefined, cursorFailed: boolean}>}
 */
async function readTurnCursor(service, { teamId, task, member, attemptId }) {
  let turnAfterSeq;
  let cursorFailed = false;
  const cursorAttempts = 8;
  const cursorBudgetMs = 15000;
  const cursorStarted = Date.now();
  let cursorTries = 0;
  let cursorError;
  if (typeof service.adapter.turnCursor === 'function') {
    for (let attempt = 0; attempt < cursorAttempts; attempt += 1) {
      const remaining = cursorBudgetMs - (Date.now() - cursorStarted);
      if (remaining <= 0) break;
      cursorTries += 1;
      try {
        turnAfterSeq = await service.adapter.turnCursor({
          sessionId: member.sessionId,
          timeoutMs: Math.min(5000, Math.max(250, remaining)),
        });
        break;
      } catch (error) {
        cursorError = error;
        const message = error instanceof Error ? error.message : String(error);
        if (/session is not active|unknown (protocol )?session|session .*closed|session not found|unauthorized|forbidden|invalid/i.test(message)) break;
        const wait = Math.min(500 * cursorTries, Math.max(0, cursorBudgetMs - (Date.now() - cursorStarted)));
        if (wait > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, wait));
      }
    }
    if (turnAfterSeq === undefined) {
      cursorFailed = true;
      service.store.addEvent(teamId, 'task.turn_watch_unavailable', {
        taskId: task.id,
        attemptId,
        attempts: cursorTries,
        elapsedMs: Date.now() - cursorStarted,
        error: cursorError instanceof Error ? cursorError.message : String(cursorError ?? 'session/events cursor unavailable'),
      });
    }
  }
  return { turnAfterSeq, cursorFailed };
}

/**
 * Classify and record dispatch failures. Kept in the caller's catch path so
 * awaited session resets retain the original error boundary.
 * @returns {Promise<false>}
 */
async function handleDispatchFailure(service, { teamId, task, member, started, error, admissionRejected }) {
  if (isNativeModelDispatchError(error)) {
    return holdNativeModelDispatch(service, { teamId, task, member, started, error });
  }
  if (error?.code === 'E_SESSION_UNKNOWN'
    || (admissionRejected && (error?.code === 'E_SESSION_CAP' || error?.code === 'E_CONTROL_CAP'))) {
    service.store.updateAttempt(started.attemptId, { status: 'failed', endedAt: service.now(), error: error.message });
    const latestTask = service.store.getTask(task.id);
    if (latestTask?.attemptId === started.attemptId) {
      // Admission deferral keeps the same assignee; any explicit hold and the
      // member's session-recovery gate still prevent an unsafe redispatch.
      service.store.updateTask(task.id, { ...invalidateAttempt(latestTask, { assignee: member.name }), reassigning: false,
        ...(error.code === 'E_SESSION_UNKNOWN' ? {
          hold: { class: 'session_creation_unknown', reason: 'session_creation_unknown' }, needsCaptain: true,
        } : {}) });
    }
    service.store.addEvent(teamId, 'task.dispatch_deferred', { taskId: task.id, reason: error.code });
    return false;
  }
  if (!service.isCurrentAttempt(task.id, started.attemptId, member.name)) {
    service.store.updateAttempt(started.attemptId, { status: 'failed', endedAt: service.now() });
    service.refreshMemberState(teamId, member.id);
    return false;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/prompt is already running/i.test(message)) {
    // The previous turn has not released the session yet. This is a
    // transient scheduling race, not a task failure: keep the same task
    // pending and retry shortly without consuming the failure budget.
    service.store.updateAttempt(started.attemptId, { status: 'failed', endedAt: service.now(), error: message });
    const latestTask = service.store.getTask(task.id);
    service.store.updateTask(task.id, {
      ...invalidateAttempt(latestTask, { assignee: latestTask.assignee }),
      status: 'pending',
      reassigning: false,
      retryNotBefore: service.now() + 5000,
      lastTurnError: message,
    });
    service.store.addEvent(teamId, 'task.dispatch_deferred', {
      taskId: task.id,
      attemptId: started.attemptId,
      reason: 'prompt-already-running',
      retryInMs: 5000,
    });
    const busyMember = service.store.getMember(member.id);
    if (busyMember) {
      service.store.updateMember(busyMember.id, {
        status: 'idle', workState: 'waiting', residency: 'warm', lastActiveAt: service.now(),
      });
      service.refreshMemberState(teamId, busyMember.id);
    }
    return false;
  }
  const retryAfterMs = retryAfterMsFrom(error);
  service.store.addEvent(teamId, 'task.dispatch_failed', {
    taskId: task.id,
    error: message,
    errorCode: error?.code,
    errorType: error?.type,
    retryAfterMs,
  });
  if (/session is not active|unknown (protocol )?session|session .*closed|session not found/i.test(message)) {
    await service.resetMemberSession(teamId, member.id, member.sessionId);
  }
  service.handleTurnFailure({
    teamId,
    taskId: task.id,
    attemptId: started.attemptId,
    memberId: member.id,
    message,
    code: error?.code,
    type: error?.type,
    retryable: error?.retryable,
    retryAfterMs,
  });
  return false;
}

/**
 * Dispatch a task session, returning true only after a successful send and
 * dispatch bookkeeping; handled failures return false.
 * @returns {Promise<boolean>}
 */
export async function dispatchTaskSession(service, {
  teamId, team, task, member: initialMember, started, terminalStatuses, workdir: initialWorkdir,
}) {
  let member = initialMember;
  let workdir = initialWorkdir;
  let workerStartId;
  let workerCreatedSessionId;
  let workerCreateStarted = false;
  let admissionRejected = false;
  try {
    const nativeModel = readNativeWorkerModel(service, member);
    if (nativeModel) assertNativeModelSupported(service.adapter);
    const memberHome = join(service.memberHomeRoot(), teamId, member.id);
    ensureOwnedMemberHome(memberHome, service.cwd);
    if (member.home !== memberHome) {
      member = service.store.updateMember(member.id, { home: memberHome });
    }
    const memberPolicy = member.license?.toolPolicy ?? member.toolPolicy ?? 'workspace-write';
    const readOnlyMember = memberPolicy === 'read-only';
    // The plugin MCP server is still discovered by ZCode even when an
    // explicit member server is supplied. Deny its admin-token tool names
    // so the member can only use its own `agent-teams-member` server.
    // Reuse the shared policy so dispatch cannot drift from mail/continue.
    const memberDisallowedTools = service.memberDisallowedToolsFor(member);
    // Headless members cannot answer a permission prompt, so use the
    // worker permission mode (default yolo) instead of the controller's
    // interactive zcode.mode. Read-only licenses stay in plan mode.
    const memberMode = memberPermissionMode({
      readOnly: readOnlyMember,
      isolation: service.config.isolation,
      zcode: service.config.zcode,
    });
    if (member.sessionId && member.workdir && member.workdir !== workdir) {
      const retired = await service.retireMemberSession(teamId, member.id, member.sessionId, 'workdir-change');
      if (!retired.ok) throw Object.assign(new Error(retired.error), { code: 'E_SESSION_UNKNOWN' });
      if (!service.isCurrentAttempt(task.id, started.attemptId, member.name)) {
        service.store.updateAttempt(started.attemptId, { status: 'failed', endedAt: service.now(), error: 'stale attempt during session switch' });
        return false;
      }
      member = service.store.getMember(member.id);
    }
    if (!member.sessionId) {
      // Resolve before reserving capacity: invalid native settings are a known
      // configuration refusal, not an unknown external session creation.
      const spawnModel = service.resolveModelForSpawn(member);
      workerStartId = randomUUID();
      service.store.transaction(() => {
        const latestMember = service.store.getMember(member.id);
        if (!latestMember || latestMember.sessionId || latestMember.workerSessionStart) {
          throw Object.assign(new Error('worker session state requires reconciliation'), { code: 'E_SESSION_UNKNOWN' });
        }
        if (!service.isCurrentAttempt(task.id, started.attemptId, member.name)) {
          throw Object.assign(new Error('attempt changed before session reservation'), { code: 'E_STALE_ATTEMPT' });
        }
        try {
          if (service.memberIsControl(latestMember)) service.assertControlBudget();
          service.assertWorkspaceSessionBudget();
        } catch (error) {
          if (error?.code === 'E_SESSION_CAP' || error?.code === 'E_CONTROL_CAP') admissionRejected = true;
          throw error;
        }
        service.store.updateMember(member.id, { workerSessionStart: {
          operationId: workerStartId, state: 'starting', attemptId: started.attemptId, createdAt: service.now(),
        } });
        service.store.addEvent(teamId, 'member.session_starting', { memberId: member.id, taskId: task.id, operationId: workerStartId });
      });
      const memberContext = service.memberPrompt(team, member);
      workerCreateStarted = true;
      const memberToken = service.ensureMemberToken(member);
      const created = await service.adapter.create({
        teamId,
        memberName: member.name,
        memberId: member.id,
        licenseId: member.licenseId,
        cwd: workdir,
        prompt: service.adapter.kind === 'cli' ? 'Initialize team session. Reply READY. Do not start work yet.' : memberContext,
        model: spawnModel.model,
        ...(spawnModel.modelSelection ? { modelSelection: spawnModel.modelSelection } : {}),
        reasoning: spawnModel.reasoning,
        token: memberToken,
        mode: memberMode,
        disallowedTools: memberDisallowedTools,
        mcpMode: service.config.zcode.memberMcpServers ?? 'minimal',
        home: memberHome,
        ephemeral: false,
        shadow: service.memberIsShadow(member),
      });
      workerCreatedSessionId = created?.sessionId;
      if (typeof workerCreatedSessionId !== 'string' || !workerCreatedSessionId) throw new Error('worker session create returned no session ID');
      if (!service.isCurrentAttempt(task.id, started.attemptId, member.name)) {
        service.recordUnknownWorkerSession(teamId, member.id, workerStartId, started.attemptId, created.sessionId, 'attempt changed during session creation');
        try { await service.adapter.stop({ sessionId: created.sessionId }); } catch { /* best effort */ }
        try { await service.adapter.close?.({ sessionId: created.sessionId }); } catch { /* best effort */ }
        service.store.updateAttempt(started.attemptId, { status: 'failed', endedAt: service.now(), error: 'stale attempt after session creation' });
        return false;
      }
      service.store.transaction(() => {
        const latest = service.store.getMember(member.id);
        if (latest?.workerSessionStart?.operationId !== workerStartId || latest.sessionId || latest.sessionRecoveryState === 'unknown'
          || !service.isCurrentAttempt(task.id, started.attemptId, member.name)) throw new Error('worker session binding changed during creation');
        member = service.store.updateMember(member.id, {
          sessionId: created.sessionId,
          workerSessionStart: undefined,
          status: 'idle',
          model: spawnModel.model,
          reasoning: spawnModel.reasoning,
          ...nativeModelSpawnState(member, spawnModel),
        });
      });
      workerCreateStarted = false;
      workerStartId = undefined;
      workerCreatedSessionId = undefined;
    }
    member = service.store.updateMember(member.id, {
      status: 'working',
      workState: 'busy',
      residency: 'hot',
      workdir,
      lastActiveAt: service.now(),
      lastTaskAt: service.now(),
    });
    const { turnAfterSeq, cursorFailed } = await readTurnCursor(service, {
      teamId,
      task,
      member,
      attemptId: started.attemptId,
    });
    if (!service.isCurrentAttempt(task.id, started.attemptId, member.name)) {
      service.store.updateAttempt(started.attemptId, { status: 'failed', endedAt: service.now(), error: 'stale attempt before send' });
      return false;
    }
    if (cursorFailed) {
      await service.resetMemberSession(teamId, member.id, member.sessionId);
      service.handleTurnFailure({
        teamId,
        taskId: task.id,
        attemptId: started.attemptId,
        memberId: member.id,
        message: 'session/events cursor unavailable; refusing to leave the task on the long lease',
      });
      return false;
    }
    const sent = await withNativeModelForDispatch(service, {
      teamId, taskId: task.id, attemptId: started.attemptId,
      memberId: member.id, memberName: member.name, sessionId: member.sessionId,
      controlEpoch: team.controlEpoch ?? 0,
    }, (currentMember) => {
      member = currentMember;
      return service.adapter.send({
        sessionId: member.sessionId,
        message: service.adapter.kind === 'cli'
          ? `${service.memberPrompt(team, member)}

${service.taskPrompt(team, task, started.attemptId)}`
          : service.taskPrompt(team, task, started.attemptId),
        cwd: workdir,
        delivery: 'queue',
        ephemeral: false,
        mode: memberMode,
        disallowedTools: memberDisallowedTools,
        home: memberHome,
        token: service.store.getMemberToken(member.id),
        teamId,
        memberName: member.name,
      });
    });
    if (!sent.ok) {
      const failure = new Error(sent.warning ?? 'session rejected the task');
      if (sent.error && typeof sent.error === 'object') Object.assign(failure, sent.error);
      throw failure;
    }
    if (!service.isCurrentAttempt(task.id, started.attemptId, member.name)) {
      try { await service.adapter.stop({ sessionId: member.sessionId }); } catch { /* best effort */ }
      service.store.updateAttempt(started.attemptId, { status: 'failed', endedAt: service.now(), error: 'stale attempt after send' });
      service.refreshMemberState(teamId, member.id);
      return false;
    }
    let current = service.store.getTask(task.id);
    if (!terminalStatuses.has(current.status) && current.attemptId === started.attemptId) {
      service.store.updateTask(task.id, { status: 'in_progress' });
      current = service.store.getTask(task.id);
    } else {
      service.refreshMemberState(teamId, member.id);
    }
    service.store.addEvent(teamId, 'task.dispatched', { taskId: task.id, attemptId: started.attemptId, member: member.name });
    if (sent.usage) {
      service.store.recordUsage({
        teamId,
        memberId: member.id,
        taskId: task.id,
        sessionId: member.sessionId,
        ...sent.usage,
      });
    }
    if (turnAfterSeq !== undefined && typeof service.adapter.watchTurn === 'function'
      && service.isCurrentAttempt(task.id, started.attemptId, member.name)) {
      service.armTurnWatcher({
        teamId,
        taskId: task.id,
        attemptId: started.attemptId,
        member,
        sessionId: member.sessionId,
        afterSeq: turnAfterSeq,
      });
    }
    return true;
  } catch (error) {
    const startingMember = workerStartId && service.store.getMember(member.id);
    if (workerCreateStarted && startingMember?.workerSessionStart?.operationId !== workerStartId) {
      service.recordUnknownWorkerSession(teamId, member.id, workerStartId, started.attemptId, workerCreatedSessionId, 'session binding changed');
    }
    if (workerStartId && startingMember?.workerSessionStart?.operationId === workerStartId) {
      service.store.transaction(() => {
        const currentMember = service.store.getMember(member.id);
        if (currentMember?.workerSessionStart?.operationId !== workerStartId) return;
        service.store.updateMember(member.id, { workerSessionStart: { ...currentMember.workerSessionStart, state: 'unknown',
          ...(workerCreatedSessionId ? { sessionId: workerCreatedSessionId } : {}),
          error: error instanceof Error ? error.message : String(error) }, sessionRecoveryState: 'unknown', workState: 'busy' });
        service.store.revokeMemberToken(member.id);
        const latestTask = service.store.getTask(task.id);
        if (latestTask?.attemptId === started.attemptId && !terminalStatuses.has(latestTask.status)) {
          service.store.updateAttempt(started.attemptId, { status: 'orphaned', endedAt: service.now(), error: 'session creation outcome unknown' });
          service.store.updateTask(task.id, { ...invalidateAttempt(latestTask, { assignee: member.name }), reassigning: false,
            hold: { class: 'session_creation_unknown', reason: 'session_creation_unknown', operationId: workerStartId }, needsCaptain: true });
        }
        service.store.updateTeam(teamId, { needsCaptain: true });
        service.store.addEvent(teamId, 'member.session_start_unknown', { memberId: member.id, taskId: task.id, operationId: workerStartId });
      });
      return false;
    }
    return await handleDispatchFailure(service, { teamId, task, member, started, error, admissionRejected });
  }
}
