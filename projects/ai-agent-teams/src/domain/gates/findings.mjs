/** Finding schema and score validation; structured post-merge verdict parsing. Pure logic; no I/O. */

/**
 * @param {Array<any>} [findings]
 * @returns {Array<any>}
 */
export function openHighFindings(findings = []) {
  return findings.filter((finding) => !finding?.resolved
    && (finding?.severity === 'high' || finding?.severity === 'blocker'));
}

/**
 * Validate the finding record schema.
 * @param {unknown} findings
 * @returns {string[]}
 */
export function validateFindings(findings = []) {
  if (!Array.isArray(findings)) return ['findings must be an array'];
  const errors = [];
  const ids = new Set();
  findings.forEach((finding, index) => {
    if (!finding || typeof finding !== 'object') {
      errors.push(`findings[${index}] must be an object`);
      return;
    }
    if (typeof finding.id !== 'string' || !finding.id.trim()) {
      errors.push(`findings[${index}].id must be a non-empty string`);
    } else if (ids.has(finding.id)) {
      errors.push(`duplicate finding id: ${finding.id}`);
    } else {
      ids.add(finding.id);
    }
    if (!['low', 'medium', 'high', 'blocker'].includes(finding.severity)) {
      errors.push(`findings[${index}].severity must be low|medium|high|blocker`);
    }
    if (typeof finding.problem !== 'string' || !finding.problem.trim()) {
      errors.push(`findings[${index}].problem must be non-empty`);
    }
    if (typeof finding.requiredFix !== 'string' || !finding.requiredFix.trim()) {
      errors.push(`findings[${index}].requiredFix must be non-empty`);
    }
    if (finding.line !== undefined && (!Number.isInteger(finding.line) || finding.line < 0)) {
      errors.push(`findings[${index}].line must be a non-negative integer`);
    }
    if (finding.resolved !== undefined && typeof finding.resolved !== 'boolean') {
      errors.push(`findings[${index}].resolved must be boolean`);
    }
  });
  return errors;
}

export const REVIEW_SCORE_MIN_OVERALL = 4.5;

export const REVIEW_SCORE_MIN_CODE = 4.0;

/**
 * The 4.5/4.0 bar is only machine-enforced when a review reports scores.
 * A provided but malformed score object fails closed.
 * @param {any} scores
 * @returns {boolean}
 */
export function reviewScoresSatisfied(scores) {
  if (!scores || typeof scores !== 'object' || Array.isArray(scores)) return false;
  const overall = Number(scores.overall);
  const code = Number(scores.code);
  return Number.isFinite(overall) && Number.isFinite(code)
    && overall >= REVIEW_SCORE_MIN_OVERALL
    && code >= REVIEW_SCORE_MIN_CODE;
}

export function boundReviewScoresSatisfied(scores) {
  return boundOverallScoreSatisfied(scores) && typeof scores?.code === 'number'
    && Number.isFinite(scores.code) && scores.code >= 4.5 && scores.code <= 5;
}

export function boundOverallScoreSatisfied(scores) {
  return typeof scores?.overall === 'number' && Number.isFinite(scores.overall)
    && scores.overall >= 4.5 && scores.overall <= 5;
}

/** Parse a bound post-merge verdict without inferring approval from prose. */
export function parseBoundPostMergeReview(text, { codeTask = true } = {}) {
  const raw = String(text ?? '').trim();
  const fenced = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  let value;
  try { value = JSON.parse(fenced ? fenced[1] : raw); } catch { return undefined; }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !['pass', 'needs_revision', 'reject'].includes(value.verdict)
    || typeof value.evidence !== 'string' || !value.evidence.trim()
    || !Array.isArray(value.findings)) return undefined;
  const severity = { P0: 'blocker', P1: 'high', P2: 'medium', P3: 'low' };
  const findings = value.findings.map((finding, index) => ({ ...finding,
    id: finding?.id ?? `F-${index + 1}`, severity: severity[finding?.severity] ?? finding?.severity }));
  if (validateFindings(findings).length > 0) return undefined;
  if (value.verdict === 'pass') {
    const scoreOk = codeTask ? boundReviewScoresSatisfied({ overall: value.overall, code: value.code })
      : typeof value.overall === 'number' && Number.isFinite(value.overall) && value.overall >= 4.5 && value.overall <= 5;
    if (!scoreOk || openHighFindings(findings).length
      || !Array.isArray(value.acceptanceResults) || !Array.isArray(value.commandsRun)) return undefined;
  } else if (!findings.length || findings.some((finding) => !finding.file || !finding.problem || !finding.requiredFix
    || !Number.isSafeInteger(finding.line) || finding.line < 1)) return undefined;
  return { verdict: value.verdict, evidence: value.evidence, findings,
    scores: { overall: value.overall, code: value.code },
    acceptanceResults: value.acceptanceResults, commandsRun: value.commandsRun, raw };
}

export function unresolvedFindings(findings = []) {
  return (Array.isArray(findings) ? findings : []).filter((finding) => !finding?.resolved);
}
