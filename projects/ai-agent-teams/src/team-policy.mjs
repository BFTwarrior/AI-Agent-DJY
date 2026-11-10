/**
 * Deterministic auto-team routing. The host model supplies its best estimates
 * for a request; this module decides whether the work should run as a team or
 * on a single thread. Kept pure so the same rule is testable and can be reused
 * by the MCP tool, the CLI and future entry points.
 */

export const DEFAULT_TEAM_POLICY = Object.freeze({
  // Two or more independent subtasks can run in parallel.
  minIndependentSubtasks: 2,
  // Two or more review perspectives justify independent reviewers.
  minReviewAngles: 2,
  // A single thread expected to exceed this many minutes gets a team.
  longTaskMinutes: 10,
  // A code change touching this many files is treated as multi-file work.
  minCodeFiles: 3,
});

function asCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function asMinutes(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

/**
 * @param {{
 *   description?: string,
 *   independentSubtasks?: number,
 *   reviewAngles?: number,
 *   estimatedMinutes?: number,
 *   changedFiles?: number,
 *   codeTask?: boolean,
 *   simpleTest?: boolean,
 * }} input
 * @param {typeof DEFAULT_TEAM_POLICY} [policy]
 * @returns {{ mode: 'team'|'direct', reasons: string[], signals: object, rule: object }}
 */
export function routeTask(input = {}, policy = DEFAULT_TEAM_POLICY) {
  const subtasks = asCount(input.independentSubtasks);
  const reviewAngles = asCount(input.reviewAngles);
  const minutes = asMinutes(input.estimatedMinutes);
  const files = asCount(input.changedFiles);
  const codeTask = input.codeTask !== false;
  const simpleTest = input.simpleTest === true;
  const signals = { subtasks, reviewAngles, minutes, files, codeTask, simpleTest };

  // An explicit simple test / one-shot request always stays single-threaded,
  // even if a caller over-estimates its size.
  if (simpleTest) {
    return {
      mode: 'direct',
      reasons: ['explicit simple test or one-shot request'],
      signals,
      rule: policy,
    };
  }

  const reasons = [];
  if (subtasks >= policy.minIndependentSubtasks) {
    reasons.push(`${subtasks} independent subtasks (>= ${policy.minIndependentSubtasks})`);
  }
  if (reviewAngles >= policy.minReviewAngles) {
    reasons.push(`${reviewAngles} review perspectives (>= ${policy.minReviewAngles})`);
  }
  if (minutes > policy.longTaskMinutes) {
    reasons.push(`estimated ${minutes} minutes (> ${policy.longTaskMinutes})`);
  }
  if (codeTask && files >= policy.minCodeFiles) {
    reasons.push(`${files} code files (>= ${policy.minCodeFiles})`);
  }

  return {
    mode: reasons.length > 0 ? 'team' : 'direct',
    reasons: reasons.length > 0 ? reasons : ['no team trigger: work fits one thread'],
    signals,
    rule: policy,
  };
}

/**
 * Human-readable one-liner used in MCP instructions and logs.
 * @param {ReturnType<typeof routeTask>} decision
 */
export function describeRoute(decision) {
  return decision.mode === 'team'
    ? `team: ${decision.reasons.join('; ')}`
    : `direct: ${decision.reasons.join('; ')}`;
}
