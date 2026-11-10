import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TEAM_POLICY, describeRoute, routeTask } from '../src/team-policy.mjs';

test('two independent subtasks start a team', () => {
  const decision = routeTask({ independentSubtasks: 2 });
  assert.equal(decision.mode, 'team');
  assert.match(decision.reasons.join('\n'), /independent subtasks/);
});

test('multi-perspective review starts a team', () => {
  const decision = routeTask({ reviewAngles: 2 });
  assert.equal(decision.mode, 'team');
  assert.match(decision.reasons.join('\n'), /review perspectives/);
});

test('more than ten minutes on one thread starts a team', () => {
  assert.equal(routeTask({ estimatedMinutes: 10 }).mode, 'direct');
  assert.equal(routeTask({ estimatedMinutes: 10.5 }).mode, 'team');
});

test('a multi-file code change starts a team; a small edit stays direct', () => {
  assert.equal(routeTask({ codeTask: true, changedFiles: 3 }).mode, 'team');
  assert.equal(routeTask({ codeTask: true, changedFiles: 2 }).mode, 'direct');
  assert.equal(routeTask({ codeTask: false, changedFiles: 10 }).mode, 'direct');
});

test('an explicit simple test always stays single-threaded', () => {
  const decision = routeTask({
    simpleTest: true,
    independentSubtasks: 8,
    reviewAngles: 4,
    estimatedMinutes: 120,
    changedFiles: 20,
  });
  assert.equal(decision.mode, 'direct');
  assert.match(decision.reasons.join('\n'), /simple test/);
});

test('missing signals stay direct and expose the rule', () => {
  const decision = routeTask({});
  assert.equal(decision.mode, 'direct');
  assert.deepEqual(decision.rule, DEFAULT_TEAM_POLICY);
  assert.match(describeRoute(decision), /^direct:/);
});

test('the policy can be overridden for a stricter or looser team', () => {
  const strict = { ...DEFAULT_TEAM_POLICY, longTaskMinutes: 60, minCodeFiles: 10 };
  assert.equal(routeTask({ estimatedMinutes: 30 }, strict).mode, 'direct');
  assert.equal(routeTask({ estimatedMinutes: 61 }, strict).mode, 'team');
});
