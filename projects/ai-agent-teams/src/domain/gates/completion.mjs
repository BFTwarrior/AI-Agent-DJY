/** Completion transitions, task-kind evidence validation and evidence-backed recovery. Pure logic; no I/O. */
import { TRANSITIONS } from './policy.mjs';
import { validateFindings, boundOverallScoreSatisfied, boundReviewScoresSatisfied, reviewScoresSatisfied, REVIEW_SCORE_MIN_OVERALL, REVIEW_SCORE_MIN_CODE, openHighFindings } from './findings.mjs';
import { sameActor } from './members.mjs';
import { classifyChangedPath, normalizeWorkspacePath, isDefaultExcludedPath } from '../changes.mjs';

/**
 * @param {string} current
 * @param {string} next
 * @returns {string|undefined}
 */
export function transitionError(current, next) {
  if (current === next) return undefined;
  if (!TRANSITIONS[current]?.includes(next)) return `task status cannot move from "${current}" to "${next}"`;
  return undefined;
}

/**
 * @param {string[]} acceptance
 * @param {Array<any>} results
 * @returns {boolean}
 */
export function acceptanceCovered(acceptance = [], results = []) {
  if (!Array.isArray(results)) return false;
  return acceptance.every((criterion) => results.some((item) => item?.criterion === criterion && item?.status === 'passed'));
}

/**
 * @param {string[]} verify
 * @param {Array<any>} commands
 * @returns {boolean}
 */
export function commandsCovered(verify = [], commands = []) {
  if (!Array.isArray(commands)) return false;
  return verify.every((command) => commands.some((item) => item?.command === command && item?.status === 'passed'));
}

/**
 * Validate a completion/update payload against the task kind.
 * @param {any} task
 * @param {any} update
 * @param {any} [reviewedTask] required for an independent-review check
 * @param {{ requireIndependentReview?: boolean }} [options]
 * @returns {{ ok: boolean, error?: string, requiredStatus?: string }}
 */
export function validateCompletion(task, update = {}, reviewedTask, options = {}) {
  const next = update.status ?? task.status;
  const transition = transitionError(task.status, next);
  if (transition) return { ok: false, error: transition };

  const kind = task.kind ?? 'work';
  if (kind === 'work') return { ok: true };

  const verdict = update.verdict ?? task.verdict;
  const findings = update.findings ?? task.findings ?? [];
  const findingErrors = validateFindings(findings);
  if (findingErrors.length > 0) return { ok: false, error: findingErrors.join('; ') };

  if (kind === 'review' || kind === 'requirements') {
    if (next === 'failed' && verdict === 'pass') {
      return { ok: false, error: `${kind} cannot fail with verdict=pass` };
    }
    if (kind === 'review' && !(options.allowSelfReview ?? false)) {
      if (!reviewedTask) {
        return { ok: false, error: 'review completion requires the reviewed task for independence' };
      }
      if (!task.assignee || !reviewedTask.assignee || sameActor(task, reviewedTask)) {
        return { ok: false, error: 'review must be independent from the implementer' };
      }
    }
    if (next === 'completed') {
      if (verdict !== 'pass') return { ok: false, error: `${kind} cannot complete without verdict=pass` };
      if (kind === 'review') {
        const scores = update.scores ?? task.scores;
        if ((task.reviewMode === 'bound' || (!task.reviewMode && task.binding?.sourceCommit))
          && !(reviewedTask?.kind === 'work' ? boundOverallScoreSatisfied(scores) : boundReviewScoresSatisfied(scores))) {
          return { ok: false, error: 'bound review pass requires overall >= 4.5 and, for code, code >= 4.5' };
        }
        if (scores !== undefined && !((task.reviewMode === 'bound' || (!task.reviewMode && task.binding?.sourceCommit))
          && reviewedTask?.kind === 'work') && !reviewScoresSatisfied(scores)) {
          return {
            ok: false,
            error: `review pass requires overall >= ${REVIEW_SCORE_MIN_OVERALL} and code >= ${REVIEW_SCORE_MIN_CODE}`,
          };
        }
      }
      if (openHighFindings(findings).length > 0) {
        return { ok: false, error: `${kind} pass cannot leave unresolved high/blocker findings` };
      }
    }
    if (next === 'failed' && (verdict === 'needs_revision' || verdict === 'reject')) {
      if (!Array.isArray(findings) || findings.length === 0) {
        return { ok: false, error: `${kind} ${verdict} requires at least one finding` };
      }
    }
    return { ok: true };
  }

  if (['implementation', 'repair', 'verification', 'integration'].includes(kind)) {
    const commands = update.commandsRun ?? task.commandsRun ?? [];
    if (next === 'completed' && commands.some((item) => item?.status === 'failed')) {
      return { ok: false, error: 'verify failure must fail the task', requiredStatus: 'failed' };
    }
    if (next !== 'completed') return { ok: true };

    const acceptance = task.acceptance ?? [];
    const verify = task.verify ?? [];
    const findingsOnly = kind === 'repair' && task.contractSource === 'findings';
    if (acceptance.length === 0 || (verify.length === 0 && !findingsOnly)) {
      return { ok: false, error: `${kind} contract must declare acceptance and verify` };
    }
    const acceptanceResults = update.acceptanceResults ?? task.acceptanceResults;
    if (!acceptanceCovered(acceptance, acceptanceResults)) {
      return { ok: false, error: `${kind} completion requires passed acceptanceResults for every acceptance item` };
    }
    if (!commandsCovered(verify, commands)) {
      return { ok: false, error: `${kind} completion requires a passed commandsRun entry for every verify command` };
    }
    if (kind === 'implementation' || kind === 'repair') {
      const changed = update.changedPaths ?? task.changedPaths;
      if (!Array.isArray(changed) || changed.length === 0) {
        return { ok: false, error: `${kind} completion requires changedPaths` };
      }
      for (const path of changed) {
        const classification = classifyChangedPath(path, task.inScope ?? [], task.outOfScope ?? []);
        if (classification !== 'in_scope') {
          return { ok: false, error: `${kind} cannot complete: ${path} is ${classification}` };
        }
      }
    }
  }

  return { ok: true };
}

/**
 * Recover a task whose member session went idle or dropped after the work was
 * already evidenced. Completion is only inferred from recorded evidence:
 * every acceptance item passed, and (for implementation/repair) at least one
 * in-scope changed path. The daemon still runs the verify commands itself in
 * `completeTask`, so a recovered completion is held to the same gate.
 * @param {any} task
 * @returns {{ ok: boolean, update?: any, reason?: string }}
 */
export function evidenceBackedCompletion(task) {
  if (!task || !['claimed', 'in_progress'].includes(task.status)) {
    return { ok: false, reason: 'task-not-active' };
  }
  const kind = task.kind ?? 'work';
  if (!['implementation', 'repair', 'verification', 'integration'].includes(kind)) {
    return { ok: false, reason: 'kind-not-recoverable' };
  }
  const acceptanceResults = Array.isArray(task.acceptanceResults) ? task.acceptanceResults : [];
  if (!acceptanceCovered(task.acceptance ?? [], acceptanceResults)) {
    return { ok: false, reason: 'acceptance-not-evidenced' };
  }
  const update = { status: 'completed', acceptanceResults };
  if (Array.isArray(task.commandsRun) && task.commandsRun.length > 0) update.commandsRun = task.commandsRun;
  if (kind === 'implementation' || kind === 'repair') {
    const rawPaths = Array.isArray(task.changedPaths) ? task.changedPaths : [];
    if (rawPaths.length === 0) return { ok: false, reason: 'no-changed-paths' };
    const paths = rawPaths.map(normalizeWorkspacePath);
    if (paths.some((path) => !path || isDefaultExcludedPath(path))) {
      return { ok: false, reason: 'changed-paths-outside-scope' };
    }
    const scope = Array.isArray(task.inScope) ? task.inScope : [];
    const excluded = Array.isArray(task.outOfScope) ? task.outOfScope : [];
    if (!paths.every((path) => classifyChangedPath(path, scope, excluded) === 'in_scope')) {
      return { ok: false, reason: 'changed-paths-outside-scope' };
    }
    update.changedPaths = paths;
  }
  return { ok: true, update };
}
