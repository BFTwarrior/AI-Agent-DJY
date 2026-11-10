/** Actor identity and independent, least-loaded follow-up member selection. Pure logic; no I/O. */
import { TERMINAL } from './policy.mjs';

/** Compare task actors by stable member id, falling back to legacy names. */
export function sameActor(left, right) {
  if (left?.assigneeId && right?.assigneeId) return left.assigneeId === right.assigneeId;
  return Boolean(left?.assignee && right?.assignee && left.assignee === right.assignee);
}

function usableMembers(members = []) {
  return (Array.isArray(members) ? members : [])
    .filter((member) => member && member.status !== 'removed' && member.workState !== 'archived');
}

function memberRoleKey(member) {
  return member?.license?.roleKey ?? member?.role ?? '';
}

function memberAllowsKind(member, kind) {
  const kinds = member?.license?.allowedTaskKinds;
  return Array.isArray(kinds) ? kinds.includes(kind) : false;
}

function memberLoad(member, tasks = []) {
  return tasks.filter((task) => (
    task && !TERMINAL.includes(task.status)
    && (task.assigneeId || task.assignee)
    && (member.id && task.assigneeId
      ? task.assigneeId === member.id
      : Boolean(member.name && task.assignee === member.name))
  )).length;
}

/**
 * Least-loaded first, then least-recently-used (fairness), then the warmest
 * reusable session, then a stable id order. A member already holding an open
 * task is never picked while a free member exists, which is what keeps two
 * follow-ups of one completion on two different members.
 * @param {Array<any>} candidates
 * @param {Array<any>} [tasks]
 */
function rankMemberCandidates(candidates, tasks = []) {
  const residencyRank = { hot: 0, warm: 1, cold: 2 };
  return [...candidates].sort((left, right) => {
    const loadLeft = memberLoad(left, tasks);
    const loadRight = memberLoad(right, tasks);
    const busyLeft = loadLeft > 0 || !['available', 'settled'].includes(left.workState ?? 'available') ? 1 : 0;
    const busyRight = loadRight > 0 || !['available', 'settled'].includes(right.workState ?? 'available') ? 1 : 0;
    return loadLeft - loadRight
      || busyLeft - busyRight
      || (left.lastTaskAt ?? 0) - (right.lastTaskAt ?? 0)
      || (residencyRank[left.residency] ?? 3) - (residencyRank[right.residency] ?? 3)
      || String(left.id ?? left.name).localeCompare(String(right.id ?? right.name));
  });
}

function isSameActor(member, task) {
  if (!member || !task) return false;
  if (member.id && task.assigneeId) return member.id === task.assigneeId;
  return Boolean(member.name && task.assignee && member.name === task.assignee);
}

function isFreeMember(member, tasks = []) {
  return memberLoad(member, tasks) === 0
    && ['available', 'settled'].includes(member.workState ?? 'available');
}

export function pickReviewAssignee(members, reviewed, requiredReviewers = [], tasks = []) {
  const pool = usableMembers(members).filter((member) => !isSameActor(member, reviewed));
  for (const name of Array.isArray(requiredReviewers) ? requiredReviewers : []) {
    const preferred = pool.find((member) => member.name === name);
    if (preferred) return { assignee: preferred.name, assigneeId: preferred.id };
  }
  const reviewers = pool.filter((member) => (
    memberAllowsKind(member, 'review')
    && (memberRoleKey(member) === 'reviewer' || memberRoleKey(member) === 'auditor')
    && isFreeMember(member, tasks)
  ));
  const [chosen] = rankMemberCandidates(reviewers, tasks);
  return chosen ? { assignee: chosen.name, assigneeId: chosen.id } : {};
}

/**
 * The verification pool: any free license that allows the kind, minus the
 * implementer and minus whoever the same fan-out already claimed. Analysts
 * rank before reviewers so a review and its verification land on two people.
 * When every verifier is busy the row stays unassigned so the pool can grow.
 */
export function pickVerifierAssignee(members, reviewed, tasks = [], exclude = []) {
  const claimed = new Set(exclude.filter(Boolean));
  const pool = usableMembers(members)
    .filter((member) => !isSameActor(member, reviewed))
    .filter((member) => !claimed.has(member.name) && !claimed.has(member.id))
    .filter((member) => memberAllowsKind(member, 'verification'))
    .filter((member) => isFreeMember(member, tasks));
  const analysts = pool.filter((member) => memberRoleKey(member) === 'analyst');
  const [chosen] = rankMemberCandidates(analysts.length > 0 ? analysts : pool, tasks);
  return chosen ? { assignee: chosen.name, assigneeId: chosen.id } : {};
}

/**
 * Repair dispatch: a free engineer by least load by default. The original
 * implementer is only preferred when the repair explicitly depends on their
 * context (`repairContinuity`), they are free, and this is the first repair
 * round. A busy original, a mechanical fix, or a second failed round switches
 * to another engineer immediately; when nobody is free the row stays
 * unassigned so a new engineer can be materialized instead of queueing.
 */
export function pickRepairAssignee(members, source, { tasks = [], round = 1, findings = [], continuity } = {}) {
  const pool = usableMembers(members);
  const original = source?.assignee
    ? pool.find((member) => isSameActor(member, source))
    : undefined;
  const mechanical = findings.length > 0 && findings.every((finding) => (
    finding?.mechanical === true || ['low', 'medium'].includes(finding?.severity)
  ));
  const keepOriginal = Boolean(continuity && source?.repairContinuity === true)
    && round <= 1
    && !mechanical
    && original
    && memberAllowsKind(original, 'repair')
    && isFreeMember(original, tasks);
  if (keepOriginal) return { assignee: original.name, assigneeId: original.id };
  const engineers = pool.filter((member) => (
    memberAllowsKind(member, 'repair')
    && memberRoleKey(member) === 'engineer'
    && member !== original
    && isFreeMember(member, tasks)
  ));
  const [chosen] = rankMemberCandidates(engineers, tasks);
  if (chosen) return { assignee: chosen.name, assigneeId: chosen.id };
  // No other engineer is free. A free original is still the least-loaded
  // engineer in the pool, which is different from preferring them: the switch
  // above already happened whenever an alternative existed.
  if (original && memberAllowsKind(original, 'repair') && isFreeMember(original, tasks)) {
    return { assignee: original.name, assigneeId: original.id };
  }
  return {};
}
