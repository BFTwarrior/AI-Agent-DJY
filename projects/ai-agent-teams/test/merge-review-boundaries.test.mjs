import test from 'node:test';
import assert from 'node:assert/strict';
import { testHomeRoot } from './support/cleanup.mjs';
import { loadConfig } from '../src/config.mjs';
import { FakeSessionAdapter } from '../src/session/adapter.mjs';
import { TeamService } from '../src/scheduler-service.mjs';
import { isBoundMergeReview, parseMergeReviewResult } from '../src/service/merge-review-result.mjs';
import { Store } from '../src/store.mjs';

function makeService() {
  const { config } = loadConfig('config/example.v06.json');
  return new TeamService({
    homeRoot: testHomeRoot(),
    store: new Store(':memory:'),
    adapter: new FakeSessionAdapter(),
    config,
    cwd: process.cwd(),
  });
}

test('merge review result parsing owns only pure parsing and evidence coverage', () => {
  const task = Object.freeze({
    id: 'bound-review-source',
    mode: 'bound',
    kind: 'implementation',
    acceptance: Object.freeze(['works']),
    verify: Object.freeze(['npm test']),
  });
  const result = JSON.stringify({
    verdict: 'pass', evidence: 'Verified.', findings: [], overall: 4.8, code: 4.7,
    acceptanceResults: [{ criterion: 'works', status: 'passed' }],
    commandsRun: [{ command: 'npm test', status: 'passed' }],
  });

  assert.equal(isBoundMergeReview(task), true);
  assert.equal(parseMergeReviewResult(task, result).verdict, 'pass');
  assert.equal(parseMergeReviewResult(task, JSON.stringify({
    verdict: 'pass', evidence: 'Verified.', findings: [], overall: 4.8, code: 4.7,
    acceptanceResults: [], commandsRun: [{ command: 'npm test', status: 'passed' }],
  })), undefined, 'a pass without full acceptance evidence remains invalid');
  assert.deepEqual(task.acceptance, ['works']);
  assert.deepEqual(task.verify, ['npm test']);
});

test('merge review result planner retains legacy parser and bound-selection semantics', () => {
  const legacy = { mode: 'legacy', sourceCommit: 'commit', kind: 'work' };
  const implicitBound = { mode: undefined, sourceCommit: 'commit', kind: 'implementation' };
  assert.equal(isBoundMergeReview(legacy), false);
  assert.equal(isBoundMergeReview(implicitBound), true);
  assert.equal(parseMergeReviewResult(legacy, '{"verdict":"pass","evidence":"ok"}').verdict, 'pass');
  assert.equal(parseMergeReviewResult(implicitBound, 'verdict: pass'), undefined);
});

test('reviewMerge dynamically delegates through the facade seam and serializes same-key calls', async () => {
  const service = makeService();
  const calls = [];
  let invocation = 0;
  let finishFirst;
  service.reviewMergeUnlocked = async (teamId, taskId) => {
    calls.push(`start:${taskId}`);
    invocation += 1;
    if (invocation === 1) await new Promise((resolve) => { finishFirst = resolve; });
    calls.push(`end:${taskId}`);
    return { ok: true, taskId, teamId };
  };

  const first = service.reviewMerge('alpha', 'same-task');
  await new Promise((resolve) => setImmediate(resolve));
  const second = service.reviewMerge('alpha', 'same-task');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['start:same-task'], 'the facade must serialize the dynamically dispatched seam');

  finishFirst();
  assert.deepEqual(await Promise.all([first, second]), [
    { ok: true, taskId: 'same-task', teamId: 'alpha' },
    { ok: true, taskId: 'same-task', teamId: 'alpha' },
  ]);
  assert.deepEqual(calls, ['start:same-task', 'end:same-task', 'start:same-task', 'end:same-task']);
  assert.equal(service.mergeReviewLocks.size, 0);
  service.store.close();
});

test('reviewMergeUnlocked parses the completed contractor result before persisting its verdict', async () => {
  const service = makeService();
  const { store } = service;
  service.config.quality.postMergeReview = 'contractor';
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  store.addTask({
    id: 'bound-review', teamId: 'alpha', subject: 'implementation', kind: 'implementation',
    status: 'completed', mode: 'bound', sourceCommit: 'source-commit', mergeCommit: 'merge-commit',
    mergeState: 'review_pending', acceptance: ['works'], verify: ['npm test'],
  });

  const order = [];
  let artifactChecked = false;
  let mergeReviewPersisted = false;
  const getTask = store.getTask.bind(store);
  store.getTask = (taskId) => {
    const task = getTask(taskId);
    if (taskId === 'bound-review' && order.includes('contractor-completed') && !artifactChecked) {
      artifactChecked = true;
      order.push('post-contractor-claim-artifact-check');
      assert.equal(task.postMergeClaim.state, 'claimed');
      assert.equal(task.mergeCommit, 'merge-commit');
    }
    return task;
  };
  const addEvent = store.addEvent.bind(store);
  store.addEvent = (teamId, type, payload) => {
    if (type === 'merge.review_claimed') order.push(type);
    return addEvent(teamId, type, payload);
  };
  const addMergeReview = store.addMergeReview.bind(store);
  store.addMergeReview = (review) => {
    if (store.inTransaction) {
      order.push(`merge-review:${review.status}`);
      mergeReviewPersisted = true;
    }
    return addMergeReview(review);
  };
  service.currentMergeReview = () => {
    assert.equal(mergeReviewPersisted, true, 'parsed review is persisted before publication review lookup');
    return { required: true, review: undefined };
  };
  service.spawnContractor = async ({ teamId, slot, purpose }) => {
    const claimed = store.getTask('bound-review');
    assert.equal(teamId, 'alpha');
    assert.equal(slot, 'merge');
    assert.equal(purpose, 'post_merge_review:bound-review');
    assert.equal(claimed.postMergeClaim.state, 'claimed');
    assert.equal(claimed.postMergeClaim.mergeCommit, 'merge-commit');
    order.push('contractor-completed');
    return {
      id: 'contractor-1', status: 'completed', result: JSON.stringify({
        verdict: 'pass', evidence: 'Reviewed.', findings: [], overall: 4.8, code: 4.7,
        acceptanceResults: [{ criterion: 'works', status: 'passed' }],
        commandsRun: [{ command: 'npm test', status: 'passed' }],
      }),
    };
  };

  const result = await service.reviewMergeUnlocked('alpha', 'bound-review');
  assert.deepEqual(order, [
    'merge.review_claimed',
    'contractor-completed',
    'post-contractor-claim-artifact-check',
    'merge-review:pass',
  ]);
  assert.deepEqual(result, {
    ok: false,
    verdict: 'pass',
    needsCaptain: true,
    error: 'delivery review changed before publication',
  });
  assert.equal(store.listMergeReviews('alpha', 'bound-review')[0].status, 'pass');
  assert.equal(store.getTask('bound-review').mergeState, 'review_stale');
  assert.equal(store.getTask('bound-review').postMergeClaim.state, 'claimed');
  store.close();
});
