import { randomUUID } from 'node:crypto';
import { deterministicPatrolFindings } from '../domain/lifecycle.mjs';
import { buildPatrolReport, createPatrolRun, isExecutingMember, withPatrolCancelDeadline } from './patrol-run.mjs';

export function isDefinitelyUnsentProtocolLimit(error) {
  return error?.code === 'E_PROTOCOL_PENDING_LIMIT'
    && error.requestWritten === false
    && error.method === 'session/send';
}

function deferPatrolBeforeSend(service, teamId, pending, claimId, error) {
  const retryAt = service.now() + 30000;
  service.store.transaction(() => {
    const current = service.store.getTeam(teamId);
    if (current?.patrolPending?.reportId !== pending.reportId
      || current.patrolPending.claimId !== claimId || current.patrolPending.state !== 'sending') {
      throw new Error('patrol report changed before send; delivery claim must be reconciled');
    }
    service.store.updateTeam(teamId, {
      patrolPending: {
        ...pending,
        state: 'queued',
        claimId: undefined,
        attempts: (pending.attempts ?? 0) + 1,
        retryAt,
        lastDeferredReason: error?.code ?? 'session-admission',
      },
    });
    service.store.addEvent(teamId, 'patrol.deferred', {
      reportId: pending.reportId,
      reason: error?.code ?? 'session-admission',
      retryAt,
    });
  });
  return { ran: false, reason: 'patrol-admission-deferred', reportId: pending.reportId, retryAt };
}

export async function patrol(service, teamId, { enforceTrigger = false } = {}) {
  if (!service.config.patrol?.enabled) return { ran: false, reason: 'disabled' };
  if (service.patrolCancelPending.has(teamId)) {
    // The previous deadline could not cancel its send/contractor. Retry the
    // cancellation; a new patrol is only allowed after it succeeds.
    const cancel = service.patrolCancelPending.get(teamId);
    try {
      await withPatrolCancelDeadline(cancel, service.patrolCancelTimeoutMs);
      if (service.patrolCancelPending.get(teamId) === cancel) {
        service.patrolCancelPending.delete(teamId);
        service.patrolInFlight.delete(teamId);
        service.patrolStartedAt.delete(teamId);
      }
    } catch (error) {
      return {
        ran: false,
        reason: 'patrol-cancel-failed',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  if (service.patrolInFlight.has(teamId)) {
    // A provider send can hang for the whole provider timeout. Do not start
    // another captain/contractor container for the same team on every tick.
    return { ran: false, reason: 'patrol-in-flight' };
  }
  service.patrolInFlight.add(teamId);
  const startedAt = service.now();
  service.patrolStartedAt.set(teamId, startedAt);
  const run = createPatrolRun((options) => service.patrolOnce(teamId, { ...options, enforceTrigger }));
  let cancelPending = false;
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), service.patrolTimeoutMs);
  });
  try {
    // Bound the caller wait while retaining ownership of the original run.
    // A hung cancellation or unsettled action keeps the guard across ticks.
    const result = await Promise.race([
      run.result,
      deadline,
    ]);
    if (result?.timedOut) {
      let cancelled = false;
      let cancelError;
      try {
        await withPatrolCancelDeadline(run.cancel, service.patrolCancelTimeoutMs);
        cancelled = true;
      } catch (error) {
        cancelError = error instanceof Error ? error.message : String(error);
        cancelPending = true;
        service.patrolCancelPending.set(teamId, run.cancel);
      }
      service.store.addEvent(teamId, 'patrol.stalled', {
        startedAt, timeoutMs: service.patrolTimeoutMs, kind: run.kind, cancelled, ...(cancelError ? { cancelError } : {}),
      });
      const marked = service.patrolLastAt.get(teamId);
      if (marked) service.store.updateTeam(teamId, { lastPatrolAt: marked });
      service.patrolLastAt.set(teamId, service.now());
      return {
        ran: false,
        reason: cancelPending ? 'patrol-cancel-failed' : 'patrol-timeout',
        cancelled,
        kind: run.kind,
        ...(cancelError ? { error: cancelError } : {}),
      };
    }
    service.patrolCancelPending.delete(teamId);
    if (!result.ran && ['no-active-work', 'no-active-execution', 'team-not-active'].includes(result.reason)) {
      // Idle teams do not need a full patrol check on every daemon tick.
      service.patrolLastAt.set(teamId, service.now());
    }
    return result;
  } finally {
    clearTimeout(timer);
    if (!cancelPending) {
      service.patrolInFlight.delete(teamId);
      service.patrolStartedAt.delete(teamId);
    }
  }
}

export function markPatrol(service, teamId) {
  service.lastPatrolAt = service.now();
  service.patrolLastAt.set(teamId, service.lastPatrolAt);
  service.store.updateTeam(teamId, { lastPatrolAt: service.lastPatrolAt });
}

export async function patrolOnce(service, teamId, { onExternal, signal, enforceTrigger = false } = {}, activeStatuses, terminalStatuses) {
  signal?.throwIfAborted();
  const team = service.store.getTeam(teamId);
  if (!team) throw new Error(`unknown team: ${teamId}`);
  if (team.phase !== 'running' || team.control !== 'active') return { ran: false, reason: 'team-not-active' };
  const tasks = service.store.listTasks(teamId);
  const visibleTasks = tasks.filter((task) => task.hidden !== true);
  const members = service.store.listMembers(teamId);
  const unfinished = visibleTasks.filter((task) => !terminalStatuses.has(task.status));
  if (unfinished.length === 0) return { ran: false, reason: 'no-active-work' };
  const captainName = service.config.captain.name ?? 'captain';
  if (enforceTrigger && !members.some((member) => member.name !== captainName && isExecutingMember(member))) {
    // Scheduled patrols only report while someone is actually executing.
    // A fully idle team is skipped instead of burning a captain turn.
    return { ran: false, reason: 'no-active-execution' };
  }
  const findings = [];
  for (const member of members) {
    for (const finding of deterministicPatrolFindings({ member, tasks: visibleTasks })) {
      const duplicate = service.store.listFindings(teamId, 'open', member.id)
        .some((item) => item.code === finding.code && item.taskId === finding.taskId);
      if (duplicate) continue;
      findings.push(service.store.addFinding({
        id: `finding_${randomUUID()}`, teamId, memberId: member.id, member: member.name,
        status: 'open', createdAt: service.now(), ...finding,
      }));
    }
  }
  const intervalMinutes = Math.max(1, Number(service.config.patrol.intervalMinutes) || 15);
  const intervalMs = intervalMinutes * 60000;
  const now = service.now();
  const lastAt = Number(service.patrolLastAt.get(teamId)) || 0;
  // The report window is the previous window when it is still 15 minutes
  // wide; after a longer gap (daemon down) show the last 15 minutes instead
  // of a misleading multi-hour window.
  const windowStart = lastAt > 0 && lastAt <= now && now - lastAt <= intervalMs
    ? lastAt
    : now - intervalMs;
  const report = buildPatrolReport({
    team,
    tasks: visibleTasks,
    members,
    attempts: service.store.listAttempts(teamId),
    now,
    windowStart,
    intervalMinutes,
    quota: Number(service.config.scheduler.maxActivePerTeam) || Number(service.config.scheduler.activeWorkerSlots) || 0,
    taskTimeoutMinutes: Number(service.config.scheduler.taskTimeoutMinutes) || 120,
    captainName,
    locale: service.config.zcode.locale,
    timeZone: service.config.zcode.timezone,
  });
  const active = tasks.filter((task) => activeStatuses.has(task.status) || (task.assignee && !terminalStatuses.has(task.status)));
  const captainBusy = team.captainBusy === true || active.some((task) => task.assignee === captainName);
  const mode = service.config.patrol.whenCaptainBusy ?? 'queue';
  let result;
  if (captainBusy && mode === 'one-shot-contractor') {
    if (!service.features.contractors || !service.config.contractors.enabled
      || service.contractorSlotCap('patrol') === 0
      || !service.contractorSlotAllows('patrol', 'patrol')) {
      service.store.addEvent(teamId, 'patrol.deferred', { reason: 'patrol contractor slot unavailable' });
      return { ran: false, reason: 'patrol-contractor-slot-unavailable' };
    }
    service.markPatrol(teamId);
    result = await service.spawnContractor({
      teamId,
      slot: 'patrol',
      purpose: 'patrol',
      prompt: service.patrolPrompt(team, tasks, findings),
    }, {
      signal,
      onSubmitted: (contractor) => onExternal?.({
        type: 'contractor',
        id: contractor.id,
        cancel: async () => {
          const killed = await service.killContractor(teamId, contractor.id);
          if (killed?.status === 'cleanup_error') {
            throw new Error(killed.cleanupError ?? 'contractor cleanup failed');
          }
          await service.contractorRuns.get(contractor.id);
          await service.contractorSends.get(contractor.id);
          const current = service.store.getContractor(contractor.id);
          if (!['killed', 'cancelled', 'completed', 'failed', 'orphaned'].includes(current?.status)) {
            throw new Error(`contractor cancellation pending: ${current?.status}`);
          }
          return current;
        },
      }),
    });
    signal?.throwIfAborted();
    service.store.addEvent(teamId, 'patrol.contractor', { contractorId: result.id, status: result.status });
  } else if (captainBusy && mode === 'wait') {
    service.store.addEvent(teamId, 'patrol.deferred', { reason: 'captain busy' });
    return { ran: false, reason: 'captain-busy' };
  } else {
    // The outbox must exist before the first external side effect. A crash
    // after this point can recover the same report without inventing a new one.
    const queued = service.queuePatrolReport(teamId, report, 'scheduled', captainBusy, { immediate: true });
    const sent = await service.flushPatrolPending(teamId, { signal, onExternal });
    if (!sent?.ran || sent.reportId !== queued.reportId) return sent ?? queued;
    result = { ok: true, sessionId: sent.sessionId };
  }
  return {
    ran: true, findings: findings.length, captainBusy, conclusion: report.conclusion, report: report.text, result,
  };
}

export function patrolPrompt(service, team, tasks, findings, terminalStatuses) {
  return [
    `Captain patrol for team ${team.name}.`,
    `Active tasks: ${JSON.stringify(tasks.filter((task) => !terminalStatuses.has(task.status)).slice(0, 30).map((task) => ({ id: task.id, status: task.status, assignee: task.assignee, kind: task.kind, inScope: task.inScope })))}`,
    `Deterministic findings: ${JSON.stringify(findings.map((finding) => ({ code: finding.code, taskId: finding.taskId, member: finding.member, message: finding.message })))}`,
    'Report drift, required action, and whether to nudge/pause/escalate. Do not edit files or merge.',
  ].join('\n');
}

/**
 * Keep a report whose captain session is mid-turn. It is stored on the team
 * row and re-sent by the daemon (with backoff) instead of accumulating
 * mailbox rows that no delivery path reads.
 * @param {string} teamId
 * @param {{ text: string, conclusion: string }} report
 * @param {string} reason
 * @param {boolean} captainBusy
 * @returns {any}
 */
export function queuePatrolReport(service, teamId, report, reason, captainBusy, { unknown = false, immediate = false } = {}) {
  const now = service.now();
  const pending = {
    reportId: randomUUID(),
    text: report.text,
    conclusion: report.conclusion,
    createdAt: now,
    attempts: immediate ? 0 : 1,
    retryAt: immediate ? now : now + 30000,
    state: unknown ? 'unknown' : 'queued',
  };
  service.store.transaction(() => {
    const team = service.store.getTeam(teamId);
    if (!team) throw new Error(`unknown team: ${teamId}`);
    if (team.patrolPending) {
      if (team.patrolBacklog !== undefined && !Array.isArray(team.patrolBacklog)) {
        throw new Error('patrol backlog is invalid; existing reports require recovery');
      }
      service.store.updateTeam(teamId, { patrolBacklog: [...(team.patrolBacklog ?? []), pending], ...(immediate ? { lastPatrolAt: now } : {}), ...(unknown ? { needsCaptain: true } : {}) });
    } else {
      service.store.updateTeam(teamId, { patrolPending: pending, ...(immediate ? { lastPatrolAt: now } : {}), ...(unknown ? { needsCaptain: true } : {}) });
    }
    service.store.addEvent(teamId, 'patrol.queued', {
      reportId: pending.reportId,
      conclusion: report.conclusion,
      reason,
      attempts: pending.attempts,
      retryAt: pending.retryAt,
    });
  });
  if (immediate) {
    service.lastPatrolAt = now;
    service.patrolLastAt.set(teamId, now);
  }
  return {
    ran: false, reason: unknown ? 'patrol-delivery-unknown' : 'captain-busy-queued', error: reason,
    captainBusy: Boolean(captainBusy), conclusion: report.conclusion,
    reportId: pending.reportId, retryAt: pending.retryAt, ...(unknown ? { needsCaptain: true } : {}),
  };
}

/**
 * Re-send a queued patrol report once its backoff is due.
 * @param {string} teamId
 * @returns {Promise<any|null>} null when no report is queued
 */
export async function flushPatrolPending(service, teamId, { signal, onExternal } = {}) {
  let team = service.store.getTeam(teamId);
  let pending = team?.patrolPending;
  if (!pending) return null;
  if (service.patrolFlushInFlight.has(teamId)) return { ran: false, reason: 'patrol-pending-wait' };
  if (pending.state === 'unknown' || pending.state === 'sending') {
    // A different service may still own a live sending claim. Do not replace
    // its state: only its owner can settle it, and restart needs reconciliation.
    return { ran: false, reason: 'patrol-delivery-unknown', needsCaptain: true };
  }
  const now = service.now();
  if (Number(pending.retryAt ?? 0) > now) {
    return { ran: false, reason: 'patrol-pending-wait', conclusion: pending.conclusion };
  }
  service.patrolFlushInFlight.add(teamId);
  try {
    const claimId = randomUUID();
    let claimed = false;
    service.store.transaction(() => {
      team = service.store.getTeam(teamId);
      const current = team?.patrolPending;
      if (!current || current.reportId !== pending.reportId
        || ![undefined, 'queued'].includes(current.state) || Number(current.retryAt ?? 0) > service.now()) return;
      pending = { ...current, reportId: current.reportId ?? randomUUID(), state: 'sending', claimId };
      team = service.store.updateTeam(teamId, { patrolPending: pending });
      service.store.addEvent(teamId, 'patrol.sending', { reportId: pending.reportId, claimId });
      claimed = true;
    });
    if (!claimed) return { ran: false, reason: 'patrol-pending-wait' };
    let sessionId;
    let admissionError;
    try {
      sessionId = await service.ensureCaptainSession(team, {
        onAdmissionRejected: (error) => { admissionError = error; },
      });
    } catch (error) {
      if (error === admissionError) return deferPatrolBeforeSend(service, teamId, pending, claimId, error);
      throw error;
    }
    signal?.throwIfAborted();
    onExternal?.({ type: 'send', sessionId, cancel: async () => {
      const stopped = await service.adapter.stop({ sessionId });
      if (stopped?.ok !== true) throw new Error(stopped?.warning ?? 'stop was not acknowledged');
      return stopped;
    } });
    let sent;
    try {
      sent = await service.adapter.send({
        sessionId,
        message: pending.text,
        cwd: service.cwd,
        delivery: 'queue',
        ephemeral: true,
        signal,
      });
    } catch (error) {
      if (isDefinitelyUnsentProtocolLimit(error)) {
        return deferPatrolBeforeSend(service, teamId, pending, claimId, error);
      }
      throw error;
    }
    if (sent?.ok !== true) throw new Error(sent?.warning ?? 'send failed');
    signal?.throwIfAborted();
    service.store.transaction(() => {
      const current = service.store.getTeam(teamId);
      if (current?.patrolPending?.reportId !== pending.reportId || current.patrolPending.claimId !== claimId
        || current.patrolPending.state !== 'sending') {
        throw new Error('patrol report changed while sending; delivery must be reconciled');
      }
      if (current.patrolBacklog !== undefined && !Array.isArray(current.patrolBacklog)) {
        throw new Error('patrol backlog is invalid; delivery must be reconciled');
      }
      const backlog = current.patrolBacklog ?? [];
      service.store.updateTeam(teamId, { patrolPending: backlog[0], patrolBacklog: backlog.slice(1) });
      service.store.addEvent(teamId, 'patrol.captain', {
        reportId: pending.reportId, findings: 0, sessionId, conclusion: pending.conclusion, queued: true,
      });
    });
    return {
      ran: true, findings: 0, captainBusy: true, conclusion: pending.conclusion,
      sessionId, queued: true, reportId: pending.reportId,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    service.store.transaction(() => {
      const current = service.store.getTeam(teamId);
      if (current?.patrolPending?.reportId === pending.reportId && current.patrolPending.claimId === pending.claimId
        && current.patrolPending.state === 'sending') {
        service.store.updateTeam(teamId, { patrolPending: { ...pending, state: 'unknown', error: message, retryAt: service.now() + 30000 }, needsCaptain: true });
        service.store.addEvent(teamId, 'patrol.delivery_unknown', { reportId: pending.reportId, error: message });
      }
    });
    if (signal?.aborted) throw error;
    return {
      ran: false, reason: 'patrol-delivery-unknown', error: message,
      captainBusy: true, conclusion: pending.conclusion, needsCaptain: true,
    };
  } finally {
    service.patrolFlushInFlight.delete(teamId);
  }
}

export async function patrolTickAll(service) {
  if (!service.config.patrol?.enabled) return [];
  const intervalMs = Math.max(1, Number(service.config.patrol.intervalMinutes) || 15) * 60000;
  const now = service.now();
  // Per-team cursor: one busy team must not reset every other team's interval.
  const teams = service.store.listTeams().filter((team) => {
    const pending = team.patrolPending;
    if (pending) return Number(pending.retryAt ?? 0) <= now;
    return now - (service.patrolLastAt.get(team.id) ?? 0) >= intervalMs;
  });
  if (teams.length === 0) return [];
  const settled = await Promise.allSettled(teams.map(async (team) => {
    const flushed = await service.flushPatrolPending(team.id);
    if (flushed) return { teamId: team.id, ...flushed };
    // Scheduled reports require unfinished work AND a member executing it.
    return { teamId: team.id, ...(await service.patrol(team.id, { enforceTrigger: true })) };
  }));
  return settled.map((entry, index) => {
    if (entry.status === 'fulfilled') return entry.value;
    const teamId = teams[index].id;
    const error = entry.reason instanceof Error ? entry.reason.message : String(entry.reason);
    // Isolate failures: one team must not cancel the patrol of the others.
    service.store.addEvent(teamId, 'patrol.failed', { error });
    return { teamId, ran: false, reason: 'error', error };
  });
}

