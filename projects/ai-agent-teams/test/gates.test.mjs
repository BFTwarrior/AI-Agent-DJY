import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyChangedPath,
  deliveryAudit,
  deriveRepairScope,
  pathMatchesScope,
  planFollowUp,
  parseBoundPostMergeReview,
  planFailedReviewFollowUp,
  validateCompletion,
  validateFindings,
} from '../src/domain/gates.mjs';
import { repairAttemptLimit } from '../src/domain/gates/policy.mjs';

test('repair attempt limit uses the shared default only for invalid policies', () => {
  for (const policy of [undefined, {}, { maxRepairAttempts: 0 }, { maxRepairAttempts: -1 },
    { maxRepairAttempts: 1.5 }, { maxRepairAttempts: Number.NaN }, { maxRepairAttempts: Number.POSITIVE_INFINITY }]) {
    assert.equal(repairAttemptLimit(policy), 2, `invalid policy: ${String(policy?.maxRepairAttempts)}`);
  }
  for (const maxRepairAttempts of [1, 2, 7]) {
    assert.equal(repairAttemptLimit({ maxRepairAttempts }), maxRepairAttempts);
  }
});

test('scope globs fail closed on unsupported syntax and avoid overlapping literals', () => {
  assert.equal(pathMatchesScope('src/presuf/file.ts', 'src/pre*middle*suf/file.ts'), false);
  assert.equal(pathMatchesScope('src/pre-middle-suf/file.ts', 'src/pre*middle*suf/file.ts'), false);
  assert.equal(pathMatchesScope('src/abc/file.ts', 'src/abc*bc/file.ts'), false);
  assert.equal(pathMatchesScope('src/abcbc/file.ts', 'src/abc*bc/file.ts'), true);
  assert.equal(pathMatchesScope('src/ax/file.ts', 'src/a.*x/file.ts'), false);
  assert.equal(pathMatchesScope('src/a.x/file.ts', 'src/a.*x/file.ts'), true);
  assert.equal(pathMatchesScope('src/file.ts', 'src/**/file.ts'), true);
  assert.equal(pathMatchesScope('src/private/file.ts', 'src/*/'), false);
  assert.equal(pathMatchesScope('src/private/nested/file.ts', 'src/**/'), false);
  assert.equal(classifyChangedPath('src/private/file.ts', ['src/'], ['src/*/']), 'illegal');
  for (const invalid of ['/src/', '../src/', 'src\\private/', 'src/*/ ', 'C:/', 'C:relative']) {
    assert.equal(classifyChangedPath('src/private/file.ts', ['src/'], [invalid]), 'illegal');
  }
  assert.equal(pathMatchesScope(`src/${'dir/'.repeat(60)}file.ts`, `src/${'**/'.repeat(25)}file.ts`), true);
  assert.equal(pathMatchesScope(`src/${'dir/'.repeat(60)}other.ts`, `src/${'**/'.repeat(25)}file.ts`), false);
  assert.equal(classifyChangedPath('src/pre-middle-suf/file.ts', ['src/'], ['src/pre*middle*suf/file.ts']), 'illegal');
});

const impl = {
  id: 'impl',
  teamId: 'alpha',
  kind: 'implementation',
  status: 'in_progress',
  assignee: 'bob',
  acceptance: ['works'],
  verify: ['npm test'],
  inScope: ['src/'],
  dependencies: [],
};

const review = {
  id: 'review',
  teamId: 'alpha',
  kind: 'review',
  status: 'in_progress',
  assignee: 'reviewer',
  acceptance: ['quality'],
  reviewedTaskId: 'impl',
  dependencies: ['impl'],
  round: 1,
};

test('failed delivery root requires the latest reviewed repair and a matching merge receipt', () => {
  const root = { ...impl, status: 'failed', deliveryUnitId: 'impl', deliverySeq: 0, taskEpoch: 0 };
  const repair = { ...impl, id: 'repair', kind: 'repair', status: 'completed', assignee: 'builder',
    sourceTaskId: 'impl', deliveryUnitId: 'impl', deliverySeq: 1, deliveryGeneration: 0, sourceCommit: 'source',
    acceptanceResults: [{ criterion: 'works', status: 'passed' }],
    commandsRun: [{ command: 'npm test', status: 'passed' }], changedPaths: ['src/a.ts'] };
  const pass = { ...review, id: 'repair-review', status: 'completed', verdict: 'pass', reviewedTaskId: 'repair',
    deliveryGeneration: 0, reviewMode: 'bound', unitReviewSeq: 1,
    scores: { overall: 4.5, code: 4.5 },
    binding: { deliveryUnitId: 'impl', deliverySeq: 1, sourceCommit: 'source' },
    acceptanceResults: [{ criterion: 'works', status: 'passed' }] };
  const audit = (r = repair, p = pass, extra = []) => deliveryAudit({ tasks: [root, r, p, ...extra] });
  assert.match(audit().blockers.join('\n'), /unit_not_merged/);
  assert.match(audit({ ...repair, mergeState: 'merged', mergeCommit: 'source' }).blockers.join('\n'), /unit_not_merged/);
  assert.match(audit({ ...repair, mergeState: 'merged', mergeCommit: 'old', mergedCommit: 'applied' }).blockers.join('\n'), /unit_not_merged/);
  const delivered = { ...repair, mergeState: 'merged', mergeCommit: 'source', mergedCommit: 'applied' };
  assert.equal(audit(delivered).ok, true);
  assert.match(audit(delivered, { ...pass, acceptanceResults: [] }).blockers.join('\n'), /root acceptance not covered/);
  assert.match(audit(delivered, pass, [{ ...pass, id: 'newer', unitReviewSeq: 2, archived: true }]).blockers.join('\n'), /review_required/);
  assert.match(audit({ ...delivered, deliveryUnitId: 'other', sourceTaskId: root.id }).blockers.join('\n'), /review_required|review_delivery_mismatch/);
  assert.match(audit({ ...delivered, deliveryGeneration: 1 }).blockers.join('\n'), /review_delivery_mismatch/);
  assert.match(audit({ ...delivered, deliverySeq: 2 }).blockers.join('\n'), /review_delivery_mismatch/);
  assert.match(audit({ ...delivered, sourceTaskId: 'other' }).blockers.join('\n'), /review_delivery_mismatch/);
});

test('review pass cannot leave an open high finding', () => {
  const task = { ...review, findings: [{ id: 'f1', severity: 'high', problem: 'x', requiredFix: 'y' }] };
  const result = validateCompletion(task, { status: 'completed', verdict: 'pass' }, impl);
  assert.equal(result.ok, false);
  assert.match(result.error, /unresolved high/);
});

test('review cannot complete without verdict=pass', () => {
  const result = validateCompletion(review, { status: 'completed' }, impl);
  assert.equal(result.ok, false);
  assert.match(result.error, /without verdict=pass/);
});

test('bound review cannot pass without the V15 review score thresholds', () => {
  const boundReview = { ...review, reviewMode: 'bound', assignee: 'reviewer' };
  const reviewed = { ...impl, status: 'completed', assignee: 'bob' };
  assert.equal(validateCompletion(boundReview, { status: 'completed', verdict: 'pass' }, reviewed).ok, false);
  assert.equal(validateCompletion(boundReview, { status: 'completed', verdict: 'pass', scores: { overall: 4.5, code: 4.0 } }, reviewed).ok, false);
  assert.equal(validateCompletion(boundReview, { status: 'completed', verdict: 'pass', scores: { overall: '4.5', code: '4.5' } }, reviewed).ok, false);
  assert.equal(validateCompletion(boundReview, { status: 'completed', verdict: 'pass', scores: { overall: 5.1, code: 4.5 } }, reviewed).ok, false);
  assert.equal(validateCompletion(boundReview, { status: 'completed', verdict: 'pass', scores: { overall: 4.5, code: 4.5 } }, reviewed).ok, true);
  assert.equal(validateCompletion(boundReview, { status: 'completed', verdict: 'pass', scores: { overall: 4.5 } }, { ...reviewed, kind: 'work' }).ok, true);
});

test('bound post-merge review requires structured verdicts, scores, and actionable findings', () => {
  assert.equal(parseBoundPostMergeReview('pass'), undefined);
  assert.equal(parseBoundPostMergeReview(JSON.stringify({ verdict: 'pass', evidence: 'ok', findings: [] })), undefined);
  assert.equal(parseBoundPostMergeReview(JSON.stringify({ verdict: 'pass', evidence: 'ok', findings: [], overall: 4.5, code: 4.5 })), undefined);
  assert.equal(parseBoundPostMergeReview(JSON.stringify({ verdict: 'pass', evidence: 'ok', findings: [], acceptanceResults: [], commandsRun: [], overall: 4.5, code: 4.5 })).verdict, 'pass');
  assert.equal(parseBoundPostMergeReview(JSON.stringify({ verdict: 'pass', evidence: 'ok', findings: [], acceptanceResults: [], commandsRun: [], overall: 4.5 }), { codeTask: false }).verdict, 'pass');
  assert.equal(parseBoundPostMergeReview(JSON.stringify({ verdict: 'reject', evidence: 'bad', findings: [] })), undefined);
  assert.equal(parseBoundPostMergeReview(JSON.stringify({ verdict: 'reject', evidence: 'bad', findings: [
    { severity: 'P1', file: 'src/a.ts', problem: 'bug', requiredFix: 'fix it' }] })), undefined);
  const parsed = parseBoundPostMergeReview(JSON.stringify({ verdict: 'needs_revision', evidence: 'bad',
    findings: [{ severity: 'P1', file: 'src/a.ts', line: 1, problem: 'bug', requiredFix: 'fix it' }] }));
  assert.equal(parsed.findings[0].severity, 'high');
  assert.equal(parsed.findings[0].id, 'F-1');
});

test('needs_revision must carry at least one finding', () => {
  const result = validateCompletion(review, { status: 'failed', verdict: 'needs_revision', findings: [] }, impl);
  assert.equal(result.ok, false);
  assert.match(result.error, /requires at least one finding/);
});

test('implementation completion requires acceptance evidence', () => {
  const result = validateCompletion(impl, {
    status: 'completed',
    commandsRun: [{ command: 'npm test', status: 'passed' }],
    changedPaths: ['src/a.ts'],
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /acceptanceResults/);
});

test('implementation completion with full evidence passes', () => {
  const result = validateCompletion(impl, {
    status: 'completed',
    acceptanceResults: [{ criterion: 'works', status: 'passed' }],
    commandsRun: [{ command: 'npm test', status: 'passed' }],
    changedPaths: ['src/a.ts'],
  });
  assert.equal(result.ok, true);
});

test('changed path outside scope is rejected', () => {
  const result = validateCompletion(impl, {
    status: 'completed',
    acceptanceResults: [{ criterion: 'works', status: 'passed' }],
    commandsRun: [{ command: 'npm test', status: 'passed' }],
    changedPaths: ['docs/a.md'],
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /undeclared/);
});

test('needs_revision review creates repair plus next review', () => {
  const failed = {
    ...review,
    status: 'failed',
    verdict: 'needs_revision',
    findings: [{ id: 'f1', severity: 'high', file: 'src/a.ts', problem: 'x', requiredFix: 'fix src/a.ts' }],
  };
  const result = planFollowUp(failed, [{ ...impl, status: 'completed' }, failed], { codeMaxRounds: 3, maxRepairAttempts: 2 });
  assert.equal(result.escalated, undefined);
  assert.equal(result.created.length, 2);
  const [repair, recheck] = result.created;
  assert.equal(repair.kind, 'repair');
  assert.equal(repair.sourceTaskId, 'impl');
  assert.deepEqual(repair.findingSourceTaskIds, ['review']);
  assert.equal(recheck.kind, 'review');
  assert.equal(recheck.reviewedTaskId, repair.id);
});

test('failed-review repair uses the shared default when maxRepairAttempts is invalid', () => {
  const failed = {
    ...review,
    status: 'failed',
    verdict: 'needs_revision',
    findings: [{ id: 'f1', severity: 'high', file: 'src/a.ts', problem: 'x', requiredFix: 'fix src/a.ts' }],
  };
  const priorRepair = { id: 'repair-prior', kind: 'repair', sourceTaskId: impl.id, status: 'completed' };
  const result = planFailedReviewFollowUp({
    task: failed,
    tasks: [{ ...impl, status: 'completed' }, failed, priorRepair],
    policy: { maxRepairAttempts: 0 },
  });
  assert.equal(result.action, 'repair');
});

test('reject escalates instead of auto-repairing', () => {
  const failed = { ...review, status: 'failed', verdict: 'reject', findings: [{ id: 'f1', severity: 'blocker', problem: 'x', requiredFix: 'y' }] };
  const result = planFollowUp(failed, [impl, failed], {});
  assert.equal(result.escalated, true);
  assert.equal(result.created.length, 0);
});

test('delivery audit blocks a completed implementation without a passing review', () => {
  const team = {
    phase: 'running',
    control: 'active',
    tasks: [{ ...impl, status: 'completed', changedPaths: ['src/a.ts'] }],
  };
  const result = deliveryAudit(team);
  assert.equal(result.ok, false);
  assert.match(result.blockers.join('\n'), /no passing review/);
});

test('delivery audit passes with a passing review', () => {
  const team = {
    phase: 'running',
    control: 'active',
    tasks: [
      {
        ...impl,
        status: 'completed',
        assignee: 'bob',
        changedPaths: ['src/a.ts'],
        acceptanceResults: [{ criterion: 'works', status: 'passed' }],
        commandsRun: [{ command: 'npm test', status: 'passed' }],
      },
      { ...review, status: 'completed', verdict: 'pass', assignee: 'reviewer' },
    ],
  };
  const result = deliveryAudit(team);
  assert.equal(result.ok, true, result.blockers.join('; '));
});

test('path classification covers scope, default exclusions, and illegal paths', () => {
  assert.equal(classifyChangedPath('src/a.ts', ['src/'], []), 'in_scope');
  assert.equal(classifyChangedPath('docs/a.md', ['src/'], []), 'undeclared');
  assert.equal(classifyChangedPath('src/a.ts', ['src/'], ['src/a.ts']), 'out_of_scope');
  assert.equal(classifyChangedPath('.env', ['src/'], []), 'illegal');
  assert.equal(classifyChangedPath('C:/secret.txt', ['src/'], []), 'illegal');
});

test('repair scope uses finding paths and drops default exclusions', () => {
  const scope = deriveRepairScope([
    { file: 'src/a.ts', requiredFix: 'edit docs/b.md and .env' },
  ], ['src/fallback.ts']);
  assert.deepEqual(scope.sort(), ['docs/b.md', 'src/a.ts'].sort());
});

test('repair scope ignores prose slashes and strips line ranges', () => {
  const scope = deriveRepairScope([
    { requiredFix: '修复 src/mcp/shell.mjs:548-599 的映射并转发/等待问题，并补 test/mcp-shell.test.mjs' },
  ], ['src/fallback.ts']);
  assert.deepEqual(scope, ['src/mcp/shell.mjs', 'test/mcp-shell.test.mjs']);
});


test('self-review is rejected', () => {
  const implBob = { ...impl, status: 'completed', assignee: 'bob' };
  const reviewBob = { ...review, assignee: 'bob' };
  const result = validateCompletion(reviewBob, { status: 'completed', verdict: 'pass' }, implBob);
  assert.equal(result.ok, false);
  assert.match(result.error, /independent/);
});

test('delivery audit rejects self-review', () => {
  const implBob = {
    ...impl,
    status: 'completed',
    assignee: 'bob',
    changedPaths: ['src/a.ts'],
    acceptanceResults: [{ criterion: 'works', status: 'passed' }],
    commandsRun: [{ command: 'npm test', status: 'passed' }],
  };
  const reviewBob = { ...review, status: 'completed', verdict: 'pass', assignee: 'bob' };
  const result = deliveryAudit({ phase: 'running', control: 'active', tasks: [implBob, reviewBob] });
  assert.equal(result.ok, false);
  assert.match(result.blockers.join('\n'), /not independent/);
});

test('delivery audit rejects a pass with an open high finding', () => {
  const implBob = {
    ...impl,
    status: 'completed',
    assignee: 'bob',
    changedPaths: ['src/a.ts'],
    acceptanceResults: [{ criterion: 'works', status: 'passed' }],
    commandsRun: [{ command: 'npm test', status: 'passed' }],
  };
  const reviewBob = {
    ...review,
    status: 'completed',
    verdict: 'pass',
    assignee: 'reviewer',
    findings: [{ id: 'f1', severity: 'high', problem: 'x', requiredFix: 'y' }],
  };
  const result = deliveryAudit({ phase: 'running', control: 'active', tasks: [implBob, reviewBob] });
  assert.equal(result.ok, false);
  assert.match(result.blockers.join('\n'), /open high\/blocker/);
});

test('delivery audit rejects artifact drift', () => {
  const implBob = {
    ...impl,
    status: 'completed',
    assignee: 'bob',
    changedPaths: ['src/a.ts'],
    acceptanceResults: [{ criterion: 'works', status: 'passed' }],
    commandsRun: [{ command: 'npm test', status: 'passed' }],
    reviewedDuringDrift: ['src/a.ts'],
  };
  const reviewBob = { ...review, status: 'completed', verdict: 'pass', assignee: 'reviewer' };
  const result = deliveryAudit({ phase: 'running', control: 'active', tasks: [implBob, reviewBob] });
  assert.equal(result.ok, false);
  assert.match(result.blockers.join('\n'), /drift/);
});

test('delivery audit rejects a review bound to an older attempt', () => {
  const implBob = {
    ...impl,
    status: 'completed',
    assignee: 'bob',
    attempt: 2,
    changedPaths: ['src/a.ts'],
    acceptanceResults: [{ criterion: 'works', status: 'passed' }],
    commandsRun: [{ command: 'npm test', status: 'passed' }],
  };
  const reviewBob = {
    ...review,
    status: 'completed',
    verdict: 'pass',
    assignee: 'reviewer',
    reviewedAttempt: 1,
  };
  const result = deliveryAudit({ phase: 'running', control: 'active', tasks: [implBob, reviewBob] });
  assert.equal(result.ok, false);
  assert.match(result.blockers.join('\n'), /reviewed impl attempt 1/);
});

test('delivery audit accepts a review bound to the current attempt', () => {
  const implBob = {
    ...impl,
    status: 'completed',
    assignee: 'bob',
    attempt: 2,
    changedPaths: ['src/a.ts'],
    acceptanceResults: [{ criterion: 'works', status: 'passed' }],
    commandsRun: [{ command: 'npm test', status: 'passed' }],
  };
  const reviewBob = {
    ...review,
    status: 'completed',
    verdict: 'pass',
    assignee: 'reviewer',
    reviewedAttempt: 2,
  };
  const result = deliveryAudit({ phase: 'running', control: 'active', tasks: [implBob, reviewBob] });
  assert.equal(result.ok, true);
});

test('invalid finding severity is rejected', () => {
  const errors = validateFindings([{ id: 'f1', severity: 'critical', problem: 'x', requiredFix: 'y' }]);
  assert.match(errors.join('\n'), /severity/);
});

test('all findings on default-excluded paths escalate', () => {
  const failed = {
    ...review,
    status: 'failed',
    verdict: 'needs_revision',
    findings: [{ id: 'f1', severity: 'high', file: '.env', problem: 'x', requiredFix: 'edit .env' }],
  };
  const result = planFollowUp(failed, [{ ...impl, status: 'completed' }, failed], {});
  assert.equal(result.escalated, true);
  assert.equal(result.created.length, 0);
});

test('Windows scope matching is case-insensitive', { skip: process.platform !== 'win32' }, () => {
  assert.equal(classifyChangedPath('SRC/a.ts', ['src/'], []), 'in_scope');
});

test('pending cannot jump directly to completed', () => {
  const task = { ...impl, status: 'pending' };
  const result = validateCompletion(task, { status: 'completed' });
  assert.equal(result.ok, false);
  assert.match(result.error, /cannot move/);
});

test('a failed verify command forces failed', () => {
  const result = validateCompletion(impl, {
    status: 'completed',
    acceptanceResults: [{ criterion: 'works', status: 'passed' }],
    commandsRun: [{ command: 'npm test', status: 'failed' }],
    changedPaths: ['src/a.ts'],
  });
  assert.equal(result.ok, false);
  assert.equal(result.requiredStatus, 'failed');
});

test('review round ceiling escalates', () => {
  const failed = {
    ...review,
    status: 'failed',
    verdict: 'needs_revision',
    round: 3,
    findings: [{ id: 'f1', severity: 'high', file: 'src/a.ts', problem: 'x', requiredFix: 'fix src/a.ts' }],
  };
  const result = planFollowUp(failed, [{ ...impl, status: 'completed' }, failed], { codeMaxRounds: 3 });
  assert.equal(result.escalated, true);
});

test('delivery audit rejects artifact gaps', () => {
  const implBob = {
    ...impl,
    status: 'completed',
    assignee: 'bob',
    changedPaths: ['src/a.ts'],
    acceptanceResults: [{ criterion: 'works', status: 'passed' }],
    commandsRun: [{ command: 'npm test', status: 'passed' }],
    reviewedGaps: ['src/'],
  };
  const reviewBob = { ...review, status: 'completed', verdict: 'pass', assignee: 'reviewer' };
  const result = deliveryAudit({ phase: 'running', control: 'active', tasks: [implBob, reviewBob] });
  assert.equal(result.ok, false);
  assert.match(result.blockers.join(String.fromCharCode(10)), /incomplete artifact audit/);
});

test('required reviewers are enforced per implementation', () => {
  const implBob = {
    ...impl,
    status: 'completed',
    assignee: 'bob',
    changedPaths: ['src/a.ts'],
    acceptanceResults: [{ criterion: 'works', status: 'passed' }],
    commandsRun: [{ command: 'npm test', status: 'passed' }],
  };
  const aliceReview = { ...review, status: 'completed', verdict: 'pass', assignee: 'alice' };
  const ok = deliveryAudit({ phase: 'running', control: 'active', tasks: [implBob, aliceReview], requiredReviewers: ['alice'] });
  assert.equal(ok.ok, true, ok.blockers.join('; '));
  const bad = deliveryAudit({ phase: 'running', control: 'active', tasks: [implBob, aliceReview], requiredReviewers: ['carol'] });
  assert.equal(bad.ok, false);
  assert.match(bad.blockers.join(String.fromCharCode(10)), /required reviewer carol/);
});

test('delivery audit rejects all-cancelled work', () => {
  const result = deliveryAudit({
    phase: 'running',
    control: 'active',
    tasks: [{ id: 'x', teamId: 'alpha', kind: 'work', status: 'cancelled' }],
  });
  assert.equal(result.ok, false);
  assert.match(result.blockers.join(String.fromCharCode(10)), /all work was cancelled/);
});

test('delivery audit excludes historical rows across both review passes and warns', () => {
  const implBob = {
    ...impl,
    status: 'completed',
    changedPaths: ['src/a.ts'],
    acceptanceResults: [{ criterion: 'works', status: 'passed' }],
    commandsRun: [{ command: 'npm test', status: 'passed' }],
  };
  const passingReview = { ...review, status: 'completed', verdict: 'pass', assignee: 'alice' };
  const historical = [
    { id: 'archived', kind: 'implementation', status: 'in_progress', archived: true },
    { id: 'historical', kind: 'review', status: 'failed', historical: true },
    { id: 'superseded', kind: 'review', status: 'in_progress', superseded: true },
    { id: 'legacy-repair', kind: 'repair', status: 'failed', legacyRepair: true, historical: true },
    { id: 'legacy-unbound', kind: 'review', status: 'failed', legacyUnbound: true, quarantinedAt: 1 },
    { id: 'old-pass', kind: 'review', status: 'completed', verdict: 'pass', reviewedTaskId: 'impl', assignee: 'bob', legacyUnbound: true, historical: true },
  ];
  const result = deliveryAudit({ phase: 'running', control: 'active', tasks: [implBob, passingReview, ...historical] });
  assert.equal(result.ok, true, result.blockers.join('; '));
  assert.equal(result.warnings.length, historical.length);
  assert.ok(result.warnings.every((warning) => warning.includes('historical')));
});

test('legacy flags alone or on newly originated repairs cannot bypass audit', () => {
  for (const repairOrigin of [undefined, 'planner', 'manual', 'postmerge']) {
    for (const flag of ['legacyRepair', 'legacyUnbound']) {
      const task = { ...impl, id: `${repairOrigin}-${flag}`, kind: 'repair', status: 'completed', [flag]: true, repairOrigin };
      if (repairOrigin) task.quarantinedAt = 1;
      const result = deliveryAudit({ tasks: [task] });
      assert.match(result.blockers.join('; '), /incomplete acceptanceResults/, task.id);
      assert.equal(result.warnings.length, 0, task.id);
    }
  }
});

test('empty, historical-only and cancelled active work remain blocked', () => {
  const historical = { id: 'old', kind: 'work', status: 'completed', historical: true };
  for (const tasks of [[], [historical]]) {
    const result = deliveryAudit({ phase: 'staged', control: 'halted', tasks });
    assert.match(result.blockers.join('; '), /team has no tasks/);
    assert.match(result.blockers.join('; '), /awaiting approval/);
    assert.match(result.blockers.join('; '), /control is halted/);
    assert.equal(result.warnings.length, tasks.length);
  }
  const result = deliveryAudit({ tasks: [historical, { id: 'cancelled', kind: 'work', status: 'cancelled' }] });
  assert.match(result.blockers.join('; '), /all work was cancelled/);
  assert.equal(result.warnings.length, 1);
});

test('cancelled repair cannot satisfy failed review follow-up', () => {
  const failed = { id: 'failed-review', kind: 'review', status: 'failed', reviewedTaskId: 'impl' };
  const repair = { id: 'repair', kind: 'repair', status: 'cancelled', findingSourceTaskIds: [failed.id] };
  const result = deliveryAudit({ tasks: [failed, repair] });
  assert.match(result.blockers.join('; '), /failed without a follow-up repair/);
});

test('legacyUnbound false rows still require current task evidence', () => {
  const legacyBound = {
    ...impl,
    status: 'completed',
    legacyUnbound: false,
  };
  const result = deliveryAudit({ phase: 'running', control: 'active', tasks: [legacyBound] });
  assert.equal(result.ok, false);
  assert.match(result.blockers.join(String.fromCharCode(10)), /incomplete acceptanceResults/);
});

test('review-only delivery requires an existing reviewed task', () => {
  const reviewOnly = {
    id: 'review-only', teamId: 'alpha', kind: 'review', status: 'completed',
    verdict: 'pass', assignee: 'reviewer', reviewedTaskId: 'missing',
    acceptance: ['quality'], dependencies: [],
  };
  const result = deliveryAudit({ phase: 'running', control: 'active', tasks: [reviewOnly] });
  assert.equal(result.ok, false);
  assert.match(result.blockers.join(String.fromCharCode(10)), /references missing task/);
});

test('verification completion requires evidence', () => {
  const verifyTask = {
    id: 'verify', teamId: 'alpha', kind: 'verification', status: 'completed',
    acceptance: ['works'], verify: ['npm test'], dependencies: [],
  };
  const result = deliveryAudit({ phase: 'running', control: 'active', tasks: [verifyTask] });
  assert.equal(result.ok, false);
  assert.match(result.blockers.join(String.fromCharCode(10)), /incomplete acceptanceResults/);
});

test('drift on the review task blocks delivery', () => {
  const implBob = {
    ...impl,
    status: 'completed',
    changedPaths: ['src/a.ts'],
    acceptanceResults: [{ criterion: 'works', status: 'passed' }],
    commandsRun: [{ command: 'npm test', status: 'passed' }],
  };
  const reviewWithDrift = {
    ...review,
    status: 'completed',
    verdict: 'pass',
    reviewedDuringDrift: ['src/a.ts'],
  };
  const result = deliveryAudit({ phase: 'running', control: 'active', tasks: [implBob, reviewWithDrift] });
  assert.equal(result.ok, false);
  assert.match(result.blockers.join(String.fromCharCode(10)), /drift/);
});

test('a failed verification uses its dependency as repair source', () => {
  const verification = {
    id: 'verify', teamId: 'alpha', kind: 'verification', status: 'failed',
    acceptance: ['works'], verify: ['npm test'], dependencies: ['impl'],
    findings: [{ id: 'f1', severity: 'high', file: 'src/a.ts', problem: 'x', requiredFix: 'fix src/a.ts' }],
    verdict: undefined,
  };
  const result = planFollowUp(verification, [{ ...impl, status: 'completed' }, verification], {});
  assert.equal(result.created.length, 2);
  assert.equal(result.created[0].sourceTaskId, 'impl');
});

test('verification repair uses the shared default when maxRepairAttempts is invalid', () => {
  const source = { ...impl, status: 'completed' };
  const verification = {
    id: 'verify-limit', teamId: 'alpha', kind: 'verification', status: 'failed',
    acceptance: ['works'], verify: ['npm test'], dependencies: ['impl'],
    findings: [{ id: 'f1', severity: 'high', file: 'src/a.ts', problem: 'x', requiredFix: 'fix src/a.ts' }],
  };
  const priorRepair = { id: 'repair-prior', kind: 'repair', sourceTaskId: source.id, status: 'completed' };
  const result = planFollowUp(verification, [source, verification, priorRepair], { maxRepairAttempts: 0 });
  assert.equal(result.escalated, undefined);
  assert.equal(result.created[0].kind, 'repair');
});

test('verification repair still obeys a valid maxRepairAttempts cap', () => {
  const source = { ...impl, status: 'completed' };
  const verification = {
    id: 'verify-cap', teamId: 'alpha', kind: 'verification', status: 'failed',
    acceptance: ['works'], verify: ['npm test'], dependencies: ['impl'],
    findings: [{ id: 'f1', severity: 'high', file: 'src/a.ts', problem: 'x', requiredFix: 'fix src/a.ts' }],
  };
  const priorRepair = { id: 'repair-prior', kind: 'repair', sourceTaskId: source.id, status: 'completed' };
  const result = planFollowUp(verification, [source, verification, priorRepair], { maxRepairAttempts: 1 });
  assert.equal(result.escalated, true);
  assert.deepEqual(result.created, []);
});

test('verification repair cannot widen its source authorization', () => {
  const source = { ...impl, status: 'completed', outOfScope: ['src/private/'] };
  const verification = {
    id: 'verify-scope', teamId: 'alpha', kind: 'verification', status: 'failed',
    acceptance: ['works'], verify: ['npm test'], dependencies: ['impl'],
    findings: [{ id: 'f1', severity: 'high', file: 'test/outside.js', problem: 'x', requiredFix: 'fix test/outside.js' }],
  };
  const rejected = planFollowUp(verification, [source, verification], {});
  assert.equal(rejected.escalated, true);
  assert.deepEqual(rejected.created, []);
  verification.findings[0] = { ...verification.findings[0], file: 'src/a.ts', requiredFix: 'fix src/a.ts' };
  const allowed = planFollowUp(verification, [source, verification], {});
  assert.deepEqual(allowed.created[0].outOfScope, ['src/private/']);
});

test('a pending merge state blocks delivery', () => {
  const implBob = {
    ...impl,
    status: 'completed',
    changedPaths: ['src/a.ts'],
    acceptanceResults: [{ criterion: 'works', status: 'passed' }],
    commandsRun: [{ command: 'npm test', status: 'passed' }],
    mergeState: 'pending',
  };
  const reviewBob = { ...review, status: 'completed', verdict: 'pass' };
  const result = deliveryAudit({ phase: 'running', control: 'active', tasks: [implBob, reviewBob] });
  assert.equal(result.ok, false);
  assert.match(result.blockers.join(String.fromCharCode(10)), /not cleanly merged/);
});
