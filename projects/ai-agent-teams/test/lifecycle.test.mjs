import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deterministicPatrolFindings,
  parseContractorVerdict,
  recommendPreset,
  settlementBlockers,
  workStateOf,
} from '../src/domain/lifecycle.mjs';

test('preset matrix separates 16/32/64GB and conservative/balanced', () => {
  assert.deepEqual(
    { active: recommendPreset({ memoryGb: 16, mode: 'conservative' }).activeWorkerSlots, per: recommendPreset({ memoryGb: 16, mode: 'conservative' }).maxActivePerTeam },
    { active: 12, per: 6 },
  );
  assert.equal(recommendPreset({ memoryGb: 16, mode: 'balanced' }).maxActivePerTeam, 8);
  assert.equal(recommendPreset({ memoryGb: 32, mode: 'conservative' }).maxActivePerTeam, 8);
  assert.equal(recommendPreset({ memoryGb: 32, mode: 'balanced' }).maxActivePerTeam, 10);
  assert.equal(recommendPreset({ memoryGb: 64, mode: 'conservative' }).maxActivePerTeam, 12);
  assert.equal(recommendPreset({ memoryGb: 64, mode: 'balanced' }).maxActivePerTeam, 16);
  assert.equal(recommendPreset({ memoryGb: 64, mode: 'balanced' }).minActivePerTeam, 6);
});

test('work state distinguishes waiting from available and settled', () => {
  const member = { id: 'm1', name: 'Engineer 01', status: 'idle' };
  assert.equal(workStateOf(member, []), 'available');
  assert.equal(workStateOf(member, [{ id: 't1', assignee: 'Engineer 01', status: 'pending' }]), 'waiting');
  assert.equal(workStateOf(member, [{ id: 't1', assignee: 'Engineer 01', status: 'in_progress' }]), 'waiting');
  assert.equal(workStateOf({ ...member, status: 'working' }, [{ id: 't1', assignee: 'Engineer 01', status: 'in_progress' }]), 'busy');
  assert.equal(workStateOf({ ...member, status: 'working' }, []), 'busy');
  assert.equal(workStateOf({ ...member, status: 'removed' }, []), 'archived');
});

test('settlement blocks open tasks, attempts, reviews, merges and findings', () => {
  const member = { id: 'm1', name: 'Engineer 01', status: 'idle' };
  const tasks = [
    { id: 'impl', assignee: 'Engineer 01', status: 'completed', worktree: '/tmp/w', mergeState: 'review_pending' },
    { id: 'review', kind: 'review', assignee: 'Reviewer 01', status: 'pending', reviewedTaskId: 'impl' },
  ];
  const blockers = settlementBlockers({
    member,
    tasks,
    attempts: [{ id: 'a1', assignee: 'Engineer 01', status: 'claimed' }],
    findings: [{ id: 'f1', memberId: 'm1', status: 'open' }],
  });
  assert.ok(blockers.some((item) => item.includes('review_pending')));
  assert.ok(blockers.some((item) => item.includes('review')));
  assert.ok(blockers.some((item) => item.includes('attempt')));
  assert.ok(blockers.some((item) => item.includes('finding')));
  assert.equal(settlementBlockers({ member, tasks: [], attempts: [], findings: [] }).length, 0);
  assert.equal(settlementBlockers({
    member,
    tasks: [
      { id: 'cancelled', assignee: 'Engineer 01', status: 'cancelled', mergeState: 'pending' },
      { id: 'failed', assignee: 'Engineer 01', status: 'failed', mergeState: 'conflict' },
    ],
  }).length, 0);
});

test('contractor verdict parser accepts fenced JSON and plain text', () => {
  assert.equal(parseContractorVerdict('```json\n{"verdict":"pass","evidence":"tests"}\n```').verdict, 'pass');
  assert.equal(parseContractorVerdict('needs_revision: missing test').verdict, 'needs_revision');
  assert.equal(parseContractorVerdict('nothing useful'), undefined);
  assert.equal(parseContractorVerdict('I cannot pass this: broken tests'), undefined);
  assert.equal(parseContractorVerdict('tests pass but I reject').verdict, 'reject');
});

test('settlement of a failed root with a passing repair review requires its merge receipt', () => {
  const member = { id: 'm1', name: 'Engineer 01', status: 'idle' };
  const root = { id: 'root', kind: 'implementation', status: 'failed', assignee: member.name,
    deliveryUnitId: 'root', deliverySeq: 0, taskEpoch: 0, acceptance: ['works'] };
  const repair = { id: 'repair', kind: 'repair', status: 'completed', assignee: 'other', sourceTaskId: 'root',
    deliveryUnitId: 'root', deliverySeq: 1, deliveryGeneration: 0, sourceCommit: 'source' };
  const review = { id: 'review', kind: 'review', status: 'completed', verdict: 'pass', reviewedTaskId: 'repair',
    assignee: 'reviewer', reviewMode: 'bound', deliveryGeneration: 0, unitReviewSeq: 1,
    binding: { deliveryUnitId: 'root', deliverySeq: 1, sourceCommit: 'source' },
    scores: { overall: 4.5, code: 4.5 }, acceptanceResults: [{ criterion: 'works', status: 'passed' }] };
  assert.match(settlementBlockers({ member, tasks: [root, repair, review] }).join(';'), /unit_not_merged/);
  const merged = { ...repair, mergeState: 'merged', mergeCommit: 'source', mergedCommit: 'applied' };
  assert.equal(settlementBlockers({ member, tasks: [root, merged, review] }).length, 0);
});

test('deterministic patrol detects out-of-scope changes', () => {
  const findings = deterministicPatrolFindings({
    member: { id: 'm1', name: 'Engineer 01' },
    tasks: [{
      id: 't1', assignee: 'Engineer 01', status: 'in_progress',
      inScope: ['src/web/'], changedPaths: ['src/web/a.js', 'README.md'],
    }],
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, 'scope_drift');
  assert.match(findings[0].message, /README\.md/);
});
