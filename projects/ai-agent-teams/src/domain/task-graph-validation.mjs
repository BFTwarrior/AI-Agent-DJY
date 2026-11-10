import {
  TASK_KINDS,
  TASK_PRIORITIES,
  TASK_STATUSES,
} from './task-graph-policy.mjs';

/**
 * Validate a task graph.
 * @param {Array<any>} tasks
 * @param {Array<string|{name:string}>} [members]
 * @returns {string[]} errors (empty when valid)
 */
export function validateTaskGraph(tasks, members = [], options = {}) {
  const errors = [];
  if (!Array.isArray(tasks)) return ['tasks must be an array'];

  const byId = new Map();
  const memberNames = new Set();
  const memberTeam = new Map();
  for (const member of members) {
    const name = typeof member === 'string' ? member : member?.name;
    if (!name) continue;
    memberNames.add(name);
    if (typeof member === 'object' && member?.teamId) memberTeam.set(name, member.teamId);
  }
  const teamIds = new Set(options.teamIds ?? []);
  const requiredReviewers = new Set(options.requiredReviewers ?? []);
  const allowUnassigned = options.allowUnassigned === true;

  tasks.forEach((task, index) => {
    if (!task || typeof task !== 'object') {
      errors.push(`tasks[${index}] must be an object`);
      return;
    }
    if (typeof task.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(task.id.trim())) {
      errors.push(`tasks[${index}].id must be a safe id (letters, digits, dot, underscore, dash)`);
    } else if (byId.has(task.id)) {
      errors.push(`duplicate task id: ${task.id}`);
    } else {
      byId.set(task.id, task);
    }
    if (typeof task.teamId !== 'string' || !task.teamId.trim()) {
      errors.push(`${task.id ?? index}: teamId is required`);
    } else if (teamIds.size > 0 && !teamIds.has(task.teamId)) {
      errors.push(`${task.id ?? index}: unknown teamId ${task.teamId}`);
    }
    if (!Array.isArray(task.dependencies)) errors.push(`${task.id ?? index}: dependencies must be an array`);
    if (task.status !== undefined && !TASK_STATUSES.includes(task.status)) {
      errors.push(`${task.id ?? index}: invalid status ${task.status}`);
    }
    if (task.assignee !== undefined && typeof task.assignee !== 'string') {
      errors.push(`${task.id ?? index}: assignee must be a string`);
    }
    if (task.assigneeRole !== undefined && (typeof task.assigneeRole !== 'string' || !task.assigneeRole.trim())) {
      errors.push(`${task.id ?? index}: assigneeRole must be a non-empty string`);
    }
    if (memberNames.size > 0 && task.assignee && !memberNames.has(task.assignee) && !allowUnassigned) {
      errors.push(`${task.id ?? index}: unknown assignee ${task.assignee}`);
    }
    if (task.assignee && memberTeam.has(task.assignee) && memberTeam.get(task.assignee) !== task.teamId) {
      errors.push(`${task.id ?? index}: assignee ${task.assignee} belongs to another team`);
    }

    const kind = task.kind ?? 'work';
    if (!TASK_KINDS.includes(kind)) errors.push(`${task.id ?? index}: invalid kind ${kind}`);
    if (task.priority !== undefined && !TASK_PRIORITIES.includes(String(task.priority).toLowerCase())) {
      errors.push(`${task.id ?? index}: priority must be ${TASK_PRIORITIES.join('|')}`);
    }
    if (kind !== 'work') {
      if (typeof task.objective !== 'string' || !task.objective.trim()) {
        errors.push(`${task.id ?? index}: objective is required for ${kind}`);
      }
      if (!Array.isArray(task.acceptance) || task.acceptance.length === 0) {
        errors.push(`${task.id ?? index}: acceptance is required for ${kind}`);
      }
    }
    if (kind === 'implementation' || kind === 'repair') {
      if (!Array.isArray(task.inScope) || task.inScope.length === 0) {
        errors.push(`${task.id ?? index}: inScope is required for ${kind}`);
      }
      const legacyCompletedRoot = kind === 'implementation' && task.status === 'completed'
        && task.mode === 'legacy';
      if ((!Array.isArray(task.verify) || task.verify.length === 0)
        && !(kind === 'repair' && task.contractSource === 'findings')
        && !legacyCompletedRoot) {
        errors.push(`${task.id ?? index}: verify is required for ${kind}`);
      }
    }
    if ((kind === 'verification' || kind === 'integration')
      && (!Array.isArray(task.verify) || task.verify.length === 0)) {
      errors.push(`${task.id ?? index}: verify is required for ${kind}`);
    }
    if (kind === 'review' && (typeof task.reviewedTaskId !== 'string' || !task.reviewedTaskId)) {
      errors.push(`${task.id ?? index}: reviewedTaskId is required for review`);
    }
    if (kind === 'repair' && (typeof task.sourceTaskId !== 'string' || !task.sourceTaskId)) {
      errors.push(`${task.id ?? index}: sourceTaskId is required for repair`);
    }
    const deps = Array.isArray(task.dependencies) ? task.dependencies : [];
    if (new Set(deps).size !== deps.length) errors.push(`${task.id ?? index}: dependencies must be unique`);
    for (const dep of deps) {
      if (dep === task.id) errors.push(`${task.id}: cannot depend on itself`);
    }
  });

  for (const task of tasks) {
    if (!task || !task.id) continue;
    for (const dep of Array.isArray(task.dependencies) ? task.dependencies : []) {
      if (!byId.has(dep)) {
        errors.push(`${task.id}: unknown dependency ${dep}`);
        continue;
      }
      if (byId.get(dep).teamId !== task.teamId) {
        errors.push(`${task.id}: cross-team dependency ${dep} is forbidden in v1`);
      }
    }
    if (task.kind === 'review') {
      if (task.reviewedTaskId === task.id) errors.push(`${task.id}: cannot review itself`);
      if (task.reviewedTaskId && !byId.has(task.reviewedTaskId)) {
        errors.push(`${task.id}: unknown reviewedTaskId ${task.reviewedTaskId}`);
      }
      if (task.reviewedTaskId && byId.has(task.reviewedTaskId)) {
        const reviewed = byId.get(task.reviewedTaskId);
        const sameMember = task.assigneeId && reviewed.assigneeId
          ? task.assigneeId === reviewed.assigneeId
          : Boolean(task.assignee && reviewed.assignee && task.assignee === reviewed.assignee);
        if (sameMember) {
          errors.push(`${task.id}: reviewer is the implementer of ${reviewed.id}`);
        }
        if (reviewed.assignee && requiredReviewers.has(reviewed.assignee)) {
          errors.push(`${task.id}: required reviewer ${reviewed.assignee} is the implementer`);
        }
      }
    }
    if (task.kind === 'repair' && task.sourceTaskId) {
      if (!byId.has(task.sourceTaskId)) errors.push(`${task.id}: unknown sourceTaskId ${task.sourceTaskId}`);
      else if (!(task.dependencies ?? []).includes(task.sourceTaskId)) {
        errors.push(`${task.id}: repair must depend on its source task ${task.sourceTaskId}`);
      }
    }
    for (const sourceId of task.findingSourceTaskIds ?? []) {
      if (!byId.has(sourceId)) errors.push(`${task.id}: unknown findingSourceTaskId ${sourceId}`);
    }
  }

  const state = new Map();
  const visit = (id, stack) => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) {
      errors.push(`dependency cycle: ${[...stack, id].join(' -> ')}`);
      return;
    }
    state.set(id, 1);
    const task = byId.get(id);
    for (const dep of task?.dependencies ?? []) visit(dep, [...stack, id]);
    state.set(id, 2);
  };
  for (const id of byId.keys()) visit(id, []);

  return [...new Set(errors)];
}
