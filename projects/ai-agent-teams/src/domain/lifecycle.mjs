import { deliveryAudit, pathMatchesScope } from './gates.mjs';

/**
 * v0.6 lifecycle helpers: presets, work states, settlement and summaries.
 * Pure functions only; persistence and sessions live in the service.
 */

export const WORK_STATES = ['busy', 'waiting', 'available', 'settled', 'archived'];
export const RESIDENCY_STATES = ['hot', 'warm', 'cold', 'archived'];

/**
 * Resolve a conservative/balanced preset. Inputs are active workers, not roster rows.
 * Config currently supports two teams; the single-team branch is kept for future use.
 * @param {{ memoryGb?: number, mode?: 'conservative'|'balanced', teams?: number }} [input]
 * @returns {{ preset: string, memoryGb: number, activeWorkerSlots: number, maxActivePerTeam: number, minActivePerTeam: number, maxControlSessions: number, maxContractors: number, maxTotalSessions: number }}
 */
export function recommendPreset(input = {}) {
  const memoryGb = Number(input.memoryGb ?? 16);
  const mode = input.mode === 'balanced' ? 'balanced' : 'conservative';
  const teams = Number(input.teams ?? 2) >= 2 ? 2 : 1;

  let active;
  let perTeam;
  let control;
  let contractors;
  if (memoryGb < 24) {
    active = teams === 1 ? (mode === 'balanced' ? 16 : 8) : (mode === 'balanced' ? 16 : 12);
    perTeam = teams === 1 ? active : (mode === 'balanced' ? 8 : 6);
    control = 5;
    contractors = 2;
  } else if (memoryGb < 48) {
    active = teams === 1 ? 16 : (mode === 'balanced' ? 20 : 16);
    perTeam = teams === 1 ? 16 : (mode === 'balanced' ? 10 : 8);
    control = 5;
    contractors = 2;
  } else {
    active = teams === 1 ? (mode === 'balanced' ? 32 : 24) : (mode === 'balanced' ? 32 : 24);
    perTeam = teams === 1 ? active : (mode === 'balanced' ? 16 : 12);
    control = 5;
    contractors = 2;
  }
  const minActivePerTeam = teams === 1 ? 1 : 6;
  const maxTotalSessions = Math.min(64, active + control + contractors);
  return {
    preset: `${mode}-${memoryGb < 24 ? '16' : memoryGb < 48 ? '32' : '64'}gb`,
    memoryGb,
    activeWorkerSlots: active,
    maxActivePerTeam: perTeam,
    minActivePerTeam,
    maxControlSessions: control,
    maxContractors: contractors,
    maxTotalSessions,
  };
}

/**
 * Work state is independent from residency. A member waiting on a dependency is
 * `waiting` even while its session is warm or cold.
 * @param {any} member
 * @param {Array<any>} tasks
 * @returns {'busy'|'waiting'|'available'|'settled'|'archived'}
 */
export function workStateOf(member, tasks = []) {
  if (!member) return 'archived';
  if (member.status === 'removed' || member.archivedAt || member.workState === 'archived') return 'archived';
  const owned = tasks.filter((task) => task.assignee === member.name || task.assigneeId === member.id);
  const open = owned.filter((task) => !['completed', 'failed', 'cancelled'].includes(task.status));
  if (member.status === 'working') return 'busy';
  if (open.length > 0) return 'waiting';
  return 'available';
}

/**
 * Reasons a member cannot be re-licensed. The caller must also check filesystem
 * cleanliness when it has git available.
 * @param {{ member: any, tasks?: Array<any>, attempts?: Array<any>, findings?: Array<any> }} input
 * @returns {string[]}
 */
export function settlementBlockers({ member, tasks = [], attempts = [], findings = [] }) {
  if (!member) return ['unknown member'];
  const blockers = [];
  if (member.status === 'working') blockers.push('member is running a turn');
  const owned = tasks.filter((task) => task.assignee === member.name || task.assigneeId === member.id);
  for (const task of owned) {
    if (!['completed', 'failed', 'cancelled'].includes(task.status)) {
      blockers.push(`task ${task.id} is ${task.status}`);
    }
    if (task.status === 'completed' && task.worktree && task.mergeState !== 'merged') {
      blockers.push(`task ${task.id} is not merged`);
    }
    // A cancelled/failed task is closed without a merge. Its stale mergeState
    // must not keep the member unsettled (and block a re-license) forever.
    if (!['cancelled', 'failed'].includes(task.status)
      && ['pending', 'review_pending', 'rejected', 'conflict', 'failed'].includes(task.mergeState)) {
      blockers.push(`task ${task.id} merge state is ${task.mergeState}`);
    }
    if (task.kind === 'implementation' && task.status === 'failed'
      && (task.deliveryUnitId === task.id || task.deliverySeq === 0)) {
      const hasUnitPass = tasks.some((item) => item.kind === 'review' && item.status === 'completed'
        && item.verdict === 'pass' && !item.archived && !item.historical && !item.superseded
        && (item.binding?.deliveryUnitId === task.id || tasks.some((repair) => repair.id === item.reviewedTaskId
          && repair.kind === 'repair' && repair.sourceTaskId === task.id)));
      if (hasUnitPass) {
        for (const reason of deliveryAudit({ tasks }).blockers.filter((item) => item.startsWith(`${task.id}: `))) {
          blockers.push(`task ${reason}`);
        }
      }
    }
  }
  for (const attempt of attempts) {
    if ((attempt.assignee === member.name || attempt.assigneeId === member.id)
      && ['claimed', 'in_progress'].includes(attempt.status)) {
      blockers.push(`attempt ${attempt.id} is still ${attempt.status}`);
    }
  }
  for (const task of tasks) {
    if (task.kind !== 'review' || ['completed', 'failed', 'cancelled'].includes(task.status)) continue;
    const reviewed = owned.find((item) => item.id === task.reviewedTaskId);
    if (reviewed) blockers.push(`review ${task.id} is still open for task ${reviewed.id}`);
  }
  for (const finding of findings) {
    if (finding.status !== 'closed' && (finding.memberId === member.id || finding.member === member.name)) {
      blockers.push(`finding ${finding.id} is open`);
    }
  }
  return [...new Set(blockers)];
}

/**
 * Structured summary used for warm/cold transitions. Never include credentials.
 * @param {{ member: any, tasks?: Array<any>, messages?: Array<any>, now?: number }} input
 * @returns {any}
 */
export function buildMemberSummary({ member, tasks = [], messages = [], now = Date.now() }) {
  const owned = tasks.filter((task) => task.assignee === member.name || task.assigneeId === member.id);
  return {
    name: member.name,
    role: member.role,
    workState: member.workState,
    summaryAt: now,
    tasks: owned.slice(-20).map((task) => ({
      id: task.id,
      subject: task.subject,
      status: task.status,
      kind: task.kind ?? 'work',
      changedPaths: task.changedPaths ?? [],
      mergeState: task.mergeState ?? 'none',
      output: typeof task.output === 'string' ? task.output.slice(0, 1000) : undefined,
      openFindings: (task.findings ?? []).filter((finding) => !finding.resolved).length,
    })),
    messageCount: messages.length,
    nextStep: 'Re-read the worktree before editing. The summary may be stale.',
  };
}

/**
 * Parse a contractor's structured verdict. Accept fenced JSON or a plain line.
 * @param {string} text
 * @returns {{ verdict: 'pass'|'reject'|'needs_revision', evidence?: string, raw: string } | undefined}
 */
export function parseContractorVerdict(text) {
  const raw = String(text ?? '');
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : raw).trim();
  try {
    const parsed = JSON.parse(candidate);
    if (['pass', 'reject', 'needs_revision'].includes(parsed?.verdict)) {
      return { verdict: parsed.verdict, evidence: parsed.evidence ?? parsed.reason, raw };
    }
  } catch {
    // fall through to a line match
  }
  const match = raw.match(/\b(needs_revision|reject)\b/i);
  if (match) return { verdict: match[1].toLowerCase(), raw };
  return undefined;
}

/**
 * A compact patrol report from deterministic signals. The LLM patrol may add to
 * this, but these checks never require a model.
 * @param {{ member: any, tasks?: Array<any> }} input
 * @returns {Array<{ severity: string, code: string, message: string, taskId?: string }>}
 */
export function deterministicPatrolFindings({ member, tasks = [] }) {
  const findings = [];
  const owned = tasks.filter((task) => task.assignee === member.name || task.assigneeId === member.id);
  for (const task of owned) {
    if (!['claimed', 'in_progress'].includes(task.status)) continue;
    const scope = task.inScope ?? [];
    const changed = task.changedPaths ?? [];
    if (scope.length > 0) {
      const outside = changed.filter((path) => !scope.some((pattern) => pathMatchesScope(path, pattern)));
      if (outside.length > 0) {
        findings.push({
          severity: 'high',
          code: 'scope_drift',
          taskId: task.id,
          message: `changed paths outside contract scope: ${outside.slice(0, 5).join(', ')}`,
        });
      }
    }
  }
  return findings;
}
