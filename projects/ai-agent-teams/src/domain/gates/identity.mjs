/** Deterministic task/finding identity, repair objectives, rounds and review generations. Pure logic; no I/O. */
import { rawFindingPaths } from '../repair-scope.mjs';

const MAX_TASK_ID_LENGTH = 128;

/** Stable 32-bit FNV-1a hash, used only when an id must be shortened. */
function shortHash(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

const PRIORITY_BY_SEVERITY = { blocker: 'P0', high: 'P1', medium: 'P2', low: 'P3' };

/** P-level of a finding: an explicit priority wins, then an inline P0/P1/P2 label, then severity. */
export function findingPriority(finding) {
  const declared = typeof finding?.priority === 'string' ? finding.priority.trim() : '';
  const match = declared.match(/^p?([0-3])$/i);
  if (match) return `P${match[1]}`;
  const text = `${finding?.problem ?? ''} ${finding?.requiredFix ?? ''}`;
  const inline = text.match(/\b(P[0-3])\b/);
  if (inline) return inline[1];
  return PRIORITY_BY_SEVERITY[finding?.severity] ?? 'P2';
}

function oneLine(value, limit = 600) {
  const text = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** `file:line` for a finding, taken from the normalized paths it cites. */
function findingLocation(finding) {
  const file = rawFindingPaths(finding)[0];
  if (!file) return '';
  const line = Number.isInteger(finding?.line) && finding.line > 0 ? `:${finding.line}` : '';
  return `${file}${line}`;
}

/**
 * Build the repair objective from the review findings. It carries priority,
 * location, problem and required fix so a repairer can act without reading the
 * review transcript, and it never copies the source implementation objective.
 * @param {Array<any>} findings
 * @param {{ sourceTaskId?: string, findingSourceTaskId?: string, round?: number, verdict?: string }} [context]
 * @returns {string}
 */
export function deriveRepairObjective(findings = [], context = {}) {
  const source = context.sourceTaskId ? ` for ${context.sourceTaskId}` : '';
  const review = context.findingSourceTaskId ? ` from ${context.findingSourceTaskId}` : '';
  const round = Number.isInteger(context.round) ? ` (round ${context.round})` : '';
  const lines = [`Repair the review findings${source}${review}${round}.`];
  const verdict = context.verdict ? `Verdict: ${context.verdict}. ` : '';
  lines.push(`${verdict}${findings.length} open finding(s) must be fixed and evidenced.`);
  findings.forEach((finding, index) => {
    const id = finding?.id ? ` (${finding.id})` : '';
    const head = `${index + 1}. [${findingPriority(finding)}/${finding?.severity ?? 'unknown'}]${id}`;
    const where = findingLocation(finding);
    lines.push(`${head} ${where ? `${where} — ` : ''}${oneLine(finding?.problem)}`);
    lines.push(`   Required fix: ${oneLine(finding?.requiredFix)}`);
  });
  return lines.join('\n');
}

/**
 * Stable sorted content fingerprint of a finding set, used to keep repair
 * planning idempotent. Each finding is JSON-encoded as a row so a field that
 * contains the row separator or a pipe cannot collide with field boundaries.
 */
export function findingsFingerprint(findings = []) {
  const rows = (findings ?? []).map((finding) => JSON.stringify([
    oneLine(finding?.problem).toLowerCase(),
    oneLine(finding?.requiredFix).toLowerCase(),
    (finding?.file ?? '').trim().toLowerCase(),
    Number.isInteger(finding?.line) ? finding.line : null,
    (finding?.severity ?? '').trim().toLowerCase(),
  ]));
  return `findings:${rows.sort().join('\n')}`;
}

/**
 * Deterministic closed-loop task id (`<prefix><seed>`), shortened with a
 * stable hash suffix when it would exceed the 128-character task id limit.
 * @param {string} prefix
 * @param {string} seed
 * @returns {string}
 */
export function closedLoopTaskId(prefix, seed) {
  const raw = `${prefix}${seed}`;
  if (raw.length <= MAX_TASK_ID_LENGTH) return raw;
  const suffix = shortHash(seed);
  const keep = MAX_TASK_ID_LENGTH - prefix.length - suffix.length - 1;
  return `${prefix}${seed.slice(0, Math.max(1, keep))}-${suffix}`;
}

/** @param {string} taskId */
export function closedLoopReviewTaskId(taskId) {
  return closedLoopTaskId('review-', String(taskId ?? ''));
}

/** @param {string} reviewTaskId */
export function closedLoopRepairTaskId(reviewTaskId) {
  return closedLoopTaskId('repair-', String(reviewTaskId ?? ''));
}

/** @param {string} taskId */
export function closedLoopVerificationTaskId(taskId) {
  return closedLoopTaskId('verify-', String(taskId ?? ''));
}

/** @param {string} taskId */
export function closedLoopKnownRepairTaskId(taskId) {
  return closedLoopTaskId('repair-known-', String(taskId ?? ''));
}

export function closedLoopRound(task) {
  return Number.isInteger(task?.round) && task.round > 0 ? task.round : 1;
}

/**
 * The review generation is the delivery root's epoch. Legacy reviews used to
 * omit it, which made every review created after a reopen/halt (epoch > 0)
 * permanently non-current. Walk to the root instead of trusting a missing
 * field, and only fall back to the task's own epoch for rootless rows.
 */
export function reviewDeliveryGeneration(task, tasks) {
  if (Number.isInteger(task?.deliveryGeneration)) return task.deliveryGeneration;
  let cursor = task;
  const seen = new Set();
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    const unit = cursor.deliveryUnitId ? tasks.find((item) => item.id === cursor.deliveryUnitId) : undefined;
    if (unit && !seen.has(unit.id)) return unit.taskEpoch ?? 0;
    if (!cursor.sourceTaskId) return cursor.taskEpoch ?? 0;
    cursor = tasks.find((item) => item.id === cursor.sourceTaskId);
  }
  return task?.taskEpoch ?? 0;
}
