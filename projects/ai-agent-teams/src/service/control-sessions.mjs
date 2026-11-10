import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { isDispatchBlocked, memberPermissionMode } from '../domain/scheduler.mjs';
import { buildShadowPrompt, SHADOW_START_MESSAGE } from './prompts.mjs';
import { ensureOwnedMemberHome } from '../session/worker-home.mjs';

export function withShadowLock(service, fn) {
  const run = service.shadowTransition.then(fn, fn);
  service.shadowTransition = run.catch(() => {});
  return run;
}
export function shadowStatus(service) {
  const member = service.findShadowMember();
  if (!member) {
    return { exists: false, status: 'stopped', active: false };
  }
  const status = member.shadowState ?? (member.sessionId ? 'active' : 'stopped');
  return {
    exists: true,
    status,
    active: status === 'active' && Boolean(member.sessionId),
    memberId: member.id,
    teamId: member.teamId,
    name: member.name,
    sessionId: member.sessionId,
    startedAt: member.shadowStartedAt,
    stoppedAt: member.shadowStoppedAt,
    lastActiveAt: member.shadowLastActiveAt,
    transitionAt: member.shadowTransitionAt,
    lastError: member.shadowLastError,
  };
}
export async function shadowAutoStopTick(service) {
  if (service.config?.shadow?.enabled === false) {
    return { ok: true, stopped: false, reason: 'disabled' };
  }
  const member = service.findShadowMember();
  if (!member) return { ok: true, stopped: false, reason: 'missing' };
  const status = member.shadowState ?? (member.sessionId ? 'active' : 'stopped');
  if (status !== 'active') return { ok: true, stopped: false, reason: `status:${status}` };
  const lastActive = Number(member.shadowLastActiveAt ?? member.shadowStartedAt ?? 0);
  if (!lastActive) return { ok: true, stopped: false, reason: 'missing-activity' };
  const idleMinutes = Number(service.config?.shadow?.idleStopMinutes ?? 30);
  if (!Number.isFinite(idleMinutes) || idleMinutes <= 0) {
    return { ok: true, stopped: false, reason: 'disabled' };
  }
  if (service.now() - lastActive < idleMinutes * 60000) {
    return { ok: true, stopped: false, reason: 'recent-activity' };
  }
  const teams = service.store.listTeams();
  const openTask = teams.some((team) => service.store.listTasks(team.id)
    .some((task) => ['pending', 'claimed', 'in_progress'].includes(task.status)
      && !isDispatchBlocked(task)));
  if (openTask) return { ok: true, stopped: false, reason: 'work-remaining' };
  const runningContractor = teams.some((team) => service.store.listContractors(team.id)
    .some((item) => ['queued', 'starting', 'running', 'cancelling', 'cleanup_error'].includes(item.status)));
  if (runningContractor) return { ok: true, stopped: false, reason: 'contractor-running' };
  const stopped = await service.stopShadow({ reason: 'idle-auto-stop' });
  return { ...stopped, autoStopped: true, idleMinutes };
}
export async function startShadow(service, { teamId } = {}) {
  // Phase 1 (locked): validate the seat and reserve the `starting` state.
  // The adapter create/send runs outside the lock so a stop request from the
  // shadow's first turn cannot deadlock behind a long CLI/container turn.
  const prepared = await service.withShadowLock(async () => {
    const existing = service.findShadowMember();
    let current = existing?.shadowState ?? (existing?.sessionId ? 'active' : 'stopped');
    if (existing && ['starting', 'stopping'].includes(current)) {
      // A start in this process owns the transition. Do not "recover" it by
      // elapsed time: a CLI/container create can legitimately run for
      // minutes, and a second start here would create a second live session.
      return { result: { ok: false, busy: true, shadow: service.shadowStatus() } };
    }
    if (existing && current === 'stop_failed' && existing.sessionId) {
      throw Object.assign(
        new Error('shadow has a live session from a failed stop; retry stop before starting'),
        { status: 409, code: 'E_SHADOW_STOP_FAILED' },
      );
    }
    if (existing && current === 'active' && existing.sessionId) {
      return { result: { ok: true, started: false, shadow: service.shadowStatus() } };
    }
    const existingTeam = existing ? service.store.getTeam(existing.teamId) : undefined;
    if (existingTeam && (existingTeam.phase === 'staged'
      || existingTeam.phase === 'archived'
      || existingTeam.control !== 'active')) {
      throw Object.assign(
        new Error(`shadow seat belongs to a non-running team: ${existingTeam.id} (${existingTeam.phase})`),
        { status: 409, code: 'E_SHADOW_TEAM_NOT_ACTIVE' },
      );
    }
    const requestedTeam = teamId ? service.store.getTeam(teamId) : undefined;
    if (teamId && !requestedTeam) {
      throw Object.assign(
        new Error(`unknown team: ${teamId}`),
        { status: 404, code: 'E_NOT_FOUND' },
      );
    }
    const team = existingTeam
      ?? requestedTeam
      ?? service.store.listTeams().find((item) => (
        item.phase !== 'staged' && item.phase !== 'archived' && item.control === 'active'
      ));
    if (!team || team.phase === 'staged' || team.phase === 'archived' || team.control !== 'active') {
      throw Object.assign(
        new Error('shadow needs a running, active team (staged/archived teams are refused)'),
        { status: 409, code: 'E_NO_ACTIVE_TEAM' },
      );
    }
    let member = existing;
    if (!member) {
      // A retired seat keeps its old name in the store, so `Shadow` may
      // collide with a removed row; generate the next free label instead.
      member = service.addMember(team.id, {
        name: service.nextMemberLabel(team.id, 'Shadow'),
        role: 'shadow',
      });
    }
    const home = join(service.memberHomeRoot(), member.teamId, member.id);
    const startId = randomUUID();
    service.store.transaction(() => {
      const latest = service.store.getMember(member.id);
      if (!latest || latest.sessionId || ['starting', 'stopping', 'active', 'stop_failed'].includes(latest.shadowState)) {
        throw Object.assign(new Error('shadow session state changed during start'), { status: 409, code: 'E_SHADOW_BUSY' });
      }
      if (!latest.sessionId) {
        service.assertControlBudget();
        service.assertWorkspaceSessionBudget();
      }
      service.store.updateMember(member.id, {
        shadowState: 'starting',
        shadowStartId: startId,
        shadowTransitionAt: service.now(),
        shadowLastError: undefined,
        home,
      });
    });
    return { member, team, home, prompt: buildShadowPrompt(team), startId, expectedLicenseId: member.licenseId };
  });
  if (prepared.result) return prepared.result;

  const { member, home, prompt, startId, expectedLicenseId } = prepared;
  let created;
  let failure;
  try {
    ensureOwnedMemberHome(home, service.cwd);
    const token = service.store.getMemberToken(member.id) ?? service.ensureMemberToken(member);
    const mode = memberPermissionMode({
      readOnly: false,
      isolation: service.config.isolation,
      zcode: service.config.zcode,
    });
    created = await service.adapter.create({
      teamId: member.teamId,
      memberName: member.name,
      memberId: member.id,
      licenseId: member.licenseId,
      cwd: service.cwd,
      prompt,
      token,
      mode,
      // The shadow coordinates; product-code writes stay with task
      // implementers so worktree/review/merge/delivery gates are not
      // bypassed by a control seat. Bash is part of the write barrier:
      // a shell in the main repository can edit files behind the gates.
      disallowedTools: service.memberDisallowedToolsFor(member),
      mcpMode: service.config.zcode.memberMcpServers ?? 'minimal',
      home,
      ephemeral: false,
      shadow: true,
    });
    if (service.adapter.kind === 'protocol' && typeof service.adapter.send === 'function') {
      // Protocol create only stores the prompt; the first `send` flushes
      // it. Without this call the shadow session exists but never works.
      const sent = await service.adapter.send({
        sessionId: created.sessionId,
        message: SHADOW_START_MESSAGE,
        delivery: 'queue',
        mode,
        disallowedTools: service.memberDisallowedToolsFor(member),
        home,
        token: service.store.getMemberToken(member.id),
        teamId: member.teamId,
        memberName: member.name,
      });
      if (sent?.ok === false) {
        throw new Error(sent.warning ?? 'shadow initial send failed');
      }
    }
  } catch (error) {
    failure = error;
  }

  // Phase 3 (locked): commit or clean up. A stop requested during phase 2
  // leaves shadowState=stopped, so the just-created session is closed here.
  const committed = await service.withShadowLock(async () => {
    const latest = service.store.getMember(member.id);
    if (failure) {
      if (created?.sessionId) {
        try { await service.adapter.stop({ sessionId: created.sessionId }); } catch { /* best effort */ }
        try { await service.adapter.close?.({ sessionId: created.sessionId }); } catch { /* best effort */ }
      }
      const message = failure instanceof Error ? failure.message : String(failure);
      // Only the generation that owns the current `starting` state may
      // write its failure. A stale start must not cancel a newer start.
      if (latest && latest.shadowState === 'starting' && latest.shadowStartId === startId) {
        service.store.updateMember(member.id, {
          sessionId: undefined,
          shadowState: 'stopped',
          shadowLastError: message,
          shadowTransitionAt: service.now(),
        });
      }
      service.store.addEvent(member.teamId, 'shadow.start_failed', {
        memberId: member.id, startId, error: message,
      });
      return { ok: false, error: failure };
    }
    if (!latest || latest.status === 'removed'
      || latest.shadowState !== 'starting'
      || latest.shadowStartId !== startId
      || !service.memberIsShadow(latest)
      || latest.licenseId !== expectedLicenseId) {
      // A stop/remove/halt or a newer start request won the race; do not
      // commit a live session for a stale or retired seat.
      if (created?.sessionId) {
        try { await service.adapter.stop({ sessionId: created.sessionId }); } catch { /* best effort */ }
        try { await service.adapter.close?.({ sessionId: created.sessionId }); } catch { /* best effort */ }
      }
      if (latest && latest.status !== 'removed' && latest.shadowStartId === startId) {
        service.store.updateMember(member.id, {
          sessionId: undefined,
          shadowState: 'stopped',
          shadowStoppedAt: service.now(),
          shadowTransitionAt: service.now(),
        });
      }
      return { ok: true, started: false, shadow: service.shadowStatus() };
    }
    const currentTeam = service.store.getTeam(member.teamId);
    if (!currentTeam || currentTeam.phase === 'staged'
      || currentTeam.phase === 'archived' || currentTeam.control !== 'active') {
      if (created?.sessionId) {
        try { await service.adapter.stop({ sessionId: created.sessionId }); } catch { /* best effort */ }
        try { await service.adapter.close?.({ sessionId: created.sessionId }); } catch { /* best effort */ }
      }
      if (latest && latest.status !== 'removed' && latest.shadowStartId === startId) {
        service.store.updateMember(member.id, {
          sessionId: undefined,
          shadowState: 'stopped',
          shadowStoppedAt: service.now(),
          shadowTransitionAt: service.now(),
        });
      }
      return { ok: true, started: false, shadow: service.shadowStatus() };
    }
    service.store.updateMember(member.id, {
      sessionId: created.sessionId,
      shadowState: 'active',
      shadowStartedAt: service.now(),
      shadowStoppedAt: undefined,
      shadowLastActiveAt: service.now(),
      shadowTransitionAt: service.now(),
      shadowLastError: undefined,
      status: 'idle',
      workState: 'available',
      residency: 'warm',
      home,
    });
    service.store.addEvent(member.teamId, 'shadow.started', {
      memberId: member.id, sessionId: created.sessionId,
    });
    return { ok: true, started: true, shadow: service.shadowStatus() };
  });
  if (committed.ok === false) throw committed.error;
  return committed;
}
export async function stopShadow(service, { reason } = {}) {
  return service.withShadowLock(async () => {
    const member = service.findShadowMember();
    if (!member) return { ok: true, stopped: false, shadow: service.shadowStatus() };
    if (member.shadowState === 'stopped' && !member.sessionId) {
      return { ok: true, stopped: false, shadow: service.shadowStatus() };
    }
    service.store.updateMember(member.id, {
      shadowState: 'stopping',
      shadowTransitionAt: service.now(),
    });
    if (!member.sessionId) {
      service.store.updateMember(member.id, {
        shadowState: 'stopped',
        shadowStoppedAt: service.now(),
        shadowLastActiveAt: undefined,
        shadowLastError: undefined,
        shadowTransitionAt: service.now(),
      });
      service.store.addEvent(member.teamId, 'shadow.stopped', {
        memberId: member.id, reason: reason ?? 'captain-stop',
      });
      return { ok: true, stopped: true, shadow: service.shadowStatus() };
    }
    let error;
    try {
      const result = await service.adapter.stop({ sessionId: member.sessionId });
      if (result?.ok === false) error = new Error(result.warning ?? 'adapter did not confirm stop');
    } catch (caught) { error = caught; }
    if (!error) {
      // Closing after a failed stop would delete the adapter's only handle
      // and make the next stop retry impossible. Keep it until stop succeeds.
      try {
        const result = await service.adapter.close?.({ sessionId: member.sessionId });
        if (result?.ok === false) error ??= new Error(result.warning ?? 'adapter did not confirm close');
      } catch (caught) { error ??= caught; }
    }
    if (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Keep sessionId: the session may still be alive, and a later stop
      // must be able to retry it.
      service.store.updateMember(member.id, {
        shadowState: 'stop_failed',
        shadowLastError: message,
        shadowTransitionAt: service.now(),
      });
      service.store.addEvent(member.teamId, 'shadow.stop_failed', { memberId: member.id, error: message });
      return { ok: false, error: message, shadow: service.shadowStatus() };
    }
    service.store.updateMember(member.id, {
      sessionId: undefined,
      shadowState: 'stopped',
      shadowStoppedAt: service.now(),
      shadowLastActiveAt: undefined,
      shadowLastError: undefined,
      shadowTransitionAt: service.now(),
      workState: 'cold',
      residency: 'cold',
    });
    service.store.addEvent(member.teamId, 'shadow.stopped', {
      memberId: member.id, reason: reason ?? 'captain-stop',
    });
    return { ok: true, stopped: true, shadow: service.shadowStatus() };
  });
}
export async function ensureCaptainSession(service, team, { onAdmissionRejected } = {}) {
  const pending = service.captainSessionStarts.get(team.id);
  if (pending) return pending;
  const operationId = randomUUID();
  const start = (async () => {
    let current;
    service.store.transaction(() => {
      current = service.store.getTeam(team.id);
      if (!current) throw new Error(`unknown team: ${team.id}`);
      if (current.captainSessionId) return;
      if (['starting', 'unknown'].includes(current.captainSessionStart?.state)) {
        throw new Error('captain session creation is unresolved; captain review is required');
      }
      try {
        service.assertControlBudget();
        service.assertWorkspaceSessionBudget();
      } catch (error) {
        if (['E_CONTROL_CAP', 'E_SESSION_CAP'].includes(error?.code)) onAdmissionRejected?.(error);
        throw error;
      }
      current = service.store.updateTeam(team.id, {
        captainSessionStart: { operationId, state: 'starting', createdAt: service.now() },
      });
      service.store.addEvent(team.id, 'captain.session_starting', { operationId });
    });
    if (current.captainSessionId) return current.captainSessionId;
    let sessionId;
    try {
      const created = await service.adapter.create({
        teamId: team.id,
        memberName: service.config.captain.name ?? 'captain',
        memberId: `captain:${team.id}`,
        cwd: service.cwd,
        prompt: service.captainPrompt(current),
        ephemeral: true,
      });
      sessionId = created?.sessionId;
      if (typeof sessionId !== 'string' || !sessionId) throw new Error('captain session create returned no session ID');
      service.store.transaction(() => {
        const latest = service.store.getTeam(team.id);
        if (latest?.captainSessionStart?.operationId !== operationId || latest.captainSessionId
          || latest.phase === 'archived' || latest.control !== 'active') {
          throw new Error('captain session creation changed before binding');
        }
        service.store.updateTeam(team.id, { captainSessionId: sessionId, captainSessionStart: undefined });
        service.store.addEvent(team.id, 'captain.session_started', { operationId, sessionId });
      });
      return sessionId;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const latest = service.store.getTeam(team.id);
      if (latest?.captainSessionStart?.operationId === operationId) {
        service.store.updateTeam(team.id, {
          captainSessionStart: { ...latest.captainSessionStart, state: 'unknown', sessionId, error: message },
          needsCaptain: true,
        });
        service.store.addEvent(team.id, 'captain.session_unknown', { operationId, sessionId, error: message });
      } else if (latest && sessionId) {
        const conflicts = Array.isArray(latest.captainSessionConflicts) ? latest.captainSessionConflicts : [];
        service.store.updateTeam(team.id, {
          captainSessionConflicts: [...conflicts, { operationId, sessionId, state: 'unknown', error: message }],
          needsCaptain: true,
        });
        service.store.addEvent(team.id, 'captain.session_conflict', { operationId, sessionId, error: message });
      }
      if (sessionId && latest && (latest.phase === 'archived' || latest.control !== 'active')) {
        try {
          const stopped = await service.adapter.stop({ sessionId });
          const closed = stopped?.ok === true ? await service.adapter.close({ sessionId }) : undefined;
          service.store.addEvent(team.id, 'captain.late_session_cleanup', {
            operationId, sessionId, stopAcknowledged: stopped?.ok === true, closeAcknowledged: closed?.ok === true,
          });
        } catch (cleanupError) {
          service.store.addEvent(team.id, 'captain.late_session_cleanup_failed', {
            operationId, sessionId, error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          });
        }
      }
      throw error;
    }
  })();
  service.captainSessionStarts.set(team.id, start);
  try {
    return await start;
  } finally {
    if (service.captainSessionStarts.get(team.id) === start) service.captainSessionStarts.delete(team.id);
  }
}
