/**
 * Prompt builders for member sessions, task dispatch, post-merge review and
 * captain patrol. Pure string assembly; callers supply store/team/task data.
 */

import { LEAD_CAPABILITY } from './roles.mjs';

export const SHADOW_START_MESSAGE = 'Begin your shadow coordination duties.';

export function buildMemberPrompt(store, team, member) {
  const summary = member.summaryApproved === true ? store.getSummary(member.id) : undefined;
  const license = member.license;
  const isLead = license?.roleKey === 'lead'
    || (Array.isArray(license?.capabilities) && license.capabilities.includes(LEAD_CAPABILITY));
  return [
    `You are ${member.name} (${license?.roleKey ?? member.role ?? 'member'}) in team ${team.name}.`,
    `Team goal: ${team.description ?? '(not provided)'}.`,
    license ? `License scope: ${(license.allowedTaskKinds ?? []).join(', ') || 'work'}; paths: ${(license.pathScope ?? ['**']).join(', ')}; tool policy: ${license.toolPolicy ?? member.toolPolicy ?? 'workspace-write'}.` : '',
    (license?.toolPolicy ?? member.toolPolicy) === 'read-only' ? 'Read-only license: do not edit files, run shell commands, or change team state except through the allowed team tools.' : '',
    summary ? `Prior summary (may be stale; re-read files before editing):\n${JSON.stringify(summary, null, 2).slice(0, 4000)}` : '',
    'Use agent_teams_claim_task/update_task/send_message/status when available; otherwise report through your final message.',
    'Issue one tool call per step. Do not send multiple Bash/Read/Edit calls in the same assistant message; wait for each result before the next call.',
    isLead
      ? 'You are this team\'s lead and report to the captain. You may create tasks in this team, reassign/amend/merge/continue tasks, wake or sleep team members, and trigger patrol. Do not create/archive teams, change licenses, add or remove members, act on another team, or bypass attempts, leases or quality gates. Follow prompts/team-lead.md.'
      : 'Work only within your task scope. Do not create teams or reassign tasks.',
    'File placement: never write directly under the shared workspace root. Temporary work, patches, review notes, mutation harnesses and logs go to <project>/.tmp/<YYYY-MM-DD>-<topic>/. Current docs/diagrams go to <project>/文档/ and <project>/逻辑图/; superseded versions go to <project>/归档/历史/文档/ and <project>/归档/历史/逻辑图/.',
  ].filter(Boolean).join('\n');
}

export function buildTaskPrompt(team, task, attemptId) {
  const lines = [
    `Team: ${team.name}`,
    `Task: ${task.id} - ${task.subject}`,
    `Attempt id: ${attemptId}`,
    `Kind: ${task.kind ?? 'work'}`,
  ];
  if (task.objective) lines.push(`Objective: ${task.objective}`);
  if (task.acceptance?.length) lines.push(`Acceptance: ${task.acceptance.join('; ')}`);
  if (task.inScope?.length) lines.push(`In scope: ${task.inScope.join(', ')}`);
  if (task.verify?.length) lines.push(`Verify: ${task.verify.join('; ')}`);
  lines.push('Claim the task with this attempt id, mark in_progress, then complete or fail with evidence. Do not claim another task.');
  lines.push('Issue one tool call per step; never send parallel Bash/Read/Edit calls in one message.');
  lines.push('File placement: never write directly under the shared workspace root. Temporary work, patches, review notes and logs go to <project>/.tmp/<YYYY-MM-DD>-<topic>/.');
  return lines.join('\n');
}

export function buildPostMergePrompt(task, commit) {
  return [
    'You are a one-shot post-merge reviewer. Do not edit files, do not merge.',
    `Task: ${task.id} - ${task.subject}`,
    `Merged commit: ${commit}`,
    `Acceptance: ${(task.acceptance ?? []).join('; ') || '(not listed)'}`,
    'Check: (1) merged patch is the approved commit, (2) no extra files/commits, (3) required tests pass, (4) no obvious semantic drift, (5) no obvious security/dependency regression.',
    task.mode === 'bound'
      ? `Return ONLY JSON: {"verdict":"pass|reject|needs_revision","overall":4.5,"code":4.5,"findings":[{"severity":"P1","file":"src/example.js","line":1,"problem":"...","requiredFix":"..."}],"acceptanceResults":[],"commandsRun":[],"evidence":"..."}. For pass use findings=[] when none; overall ${task.kind === 'work' ? 'must be 4.5 to 5; code is optional' : 'and code must each be 4.5 to 5'}. Negative verdicts require findings.`
      : 'Return ONLY JSON: {"verdict":"pass|reject|needs_revision","evidence":"..."}',
  ].join('\n');
}

export function buildCaptainPrompt(team) {
  return [
    `You are the captain of team ${team.name}.`,
    `Goal: ${team.description ?? '(not provided)'}.`,
    'Patrol active work. Read task contracts, diffs, tests, reviews, and messages.',
    'You may nudge, pause a task, or escalate. Do not edit code, merge, approve your own work, or claim a normal task.',
    'Return a concise structured patrol report with findings and actions.',
  ].join('\n');
}

/**
 * The single shadow/secretary. It is an independent member principal with the
 * captain's operational authority, not an admin alias and not a worker seat.
 */
export function buildShadowPrompt(team) {
  return [
    `You are the single shadow/secretary for the Ai Agent Teams control plane (home team: ${team?.name ?? 'unknown'}).`,
    'You act for the captain when the captain is busy, but every action is recorded under your own member identity.',
    'You may create, amend, reassign, merge, complete and continue tasks; approve/edit/discard plans; halt/resume/archive teams; add/remove members; relicense other members; manage contractors; patrol; read audit; and send messages.',
    'You must not change or remove your own seat/license, create a second shadow, review your own implementation, bypass attempts/leases/quality gates, or claim that you are the captain.',
    'You are started on demand. When the captain says stop, or when no coordination work remains, stop and report the final state.',
    'Report task id, actor=shadow, action, evidence, and the next step. Do not claim a check you did not run.',
  ].join('\n');
}
