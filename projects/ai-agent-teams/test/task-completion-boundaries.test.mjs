import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
import { TeamService } from '../src/scheduler-service.mjs';
import { deriveImplementationChangedPaths, validateCompletionEvidence } from '../src/service/task-completion-evidence.mjs';
import { persistTaskCompletion } from '../src/service/task-completion-closeout.mjs';
import { runTaskCompletionFollowUps } from '../src/service/task-completion-follow-up.mjs';
import { Store } from '../src/store.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const servicePath = resolve(root, 'src/scheduler-service.mjs');
const serviceSource = readFileSync(servicePath, 'utf8');
const completionRoot = resolve(root, 'src/service');
const completionFiles = [
  'task-completion-validation.mjs',
  'task-completion-evidence.mjs',
  'task-completion-phases.mjs',
  'task-completion-closeout.mjs',
  'task-completion-follow-up.mjs',
].map((name) => resolve(completionRoot, name));
const parseModule = (source) => parse(source, { ecmaVersion: 'latest', sourceType: 'module' });

function completionMethod(source) {
  const ast = parseModule(source);
  const serviceClass = ast.body.find((node) => node.type === 'ExportNamedDeclaration'
    && node.declaration?.type === 'ClassDeclaration' && node.declaration.id.name === 'TeamService')?.declaration;
  assert.ok(serviceClass, 'TeamService remains the owner of its public methods');
  const method = serviceClass.body.body.find((node) => node.type === 'MethodDefinition' && node.key.name === 'completeTask');
  assert.ok(method, 'completeTask public method remains available');
  return method.value;
}

function delegatedStages(source) {
  const method = completionMethod(source);
  const calls = [];
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression'
      && node.callee.object.type === 'ThisExpression' && node.callee.property.type === 'Identifier') {
      calls.push(node.callee.property.name);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  }
  visit(method.body);
  return calls.filter((name) => [
    'prepareTaskCompletion', 'persistInProgressCompletion', 'collectCompletionEvidence',
    'validateCompletionEvidence', 'commitCompletionArtifact', 'isCurrentCompletion', 'currentCompletionTask',
    'persistTaskCompletion', 'runTaskCompletionFollowUps',
  ].includes(name));
}

function assertCompletionFlowBoundary(source) {
  const stages = delegatedStages(source);
  const expected = [
    'prepareTaskCompletion',
    'collectCompletionEvidence',
    'validateCompletionEvidence',
    'commitCompletionArtifact',
    'isCurrentCompletion',
    'persistTaskCompletion',
    'runTaskCompletionFollowUps',
  ];
  let cursor = -1;
  for (const name of expected) {
    const next = stages.indexOf(name, cursor + 1);
    assert.notEqual(next, -1, `completion stage uses the dynamic service.${name} seam`);
    cursor = next;
  }
  assert.ok(source.includes('this.persistInProgressCompletion('), 'in-progress update keeps its own service seam');
}

function completionDependencyGraph(overrides = new Map()) {
  const knownFiles = new Set(completionFiles);
  const edges = new Map();
  for (const path of completionFiles) {
    const source = overrides.get(path) ?? readFileSync(path, 'utf8');
    const imports = parseModule(source).body
      .filter((node) => node.type === 'ImportDeclaration' && node.source.value.startsWith('.'))
      .map((node) => resolve(dirname(path), node.source.value))
      .filter((target) => knownFiles.has(target));
    edges.set(path, imports);
  }
  return edges;
}

function assertNoDuplicatedServiceState(source) {
  const duplicate = /(?:this|service)\.(?:store|closedLoopLocks|taskLocks)\s*=\s*new\s+(?:Map|Set)\(|\b(?:const|let)\s+\w*(?:store|state|locks?)\w*\s*=\s*new\s+(?:Map|Set)\(|\b(?:store|state|locks?)\s*:\s*new\s+(?:Map|Set)\(/i;
  assert.equal(duplicate.test(source), false, 'completion modules must not allocate copies of service-owned state');
}

function assertAcyclic(edges) {
  const active = new Set();
  const complete = new Set();
  function visit(path) {
    assert.equal(active.has(path), false, `completion import cycle includes ${path}`);
    if (complete.has(path)) return;
    active.add(path);
    for (const target of edges.get(path) ?? []) visit(target);
    active.delete(path);
    complete.add(path);
  }
  for (const path of edges.keys()) visit(path);
}

function declarationLengths(path) {
  const source = readFileSync(path, 'utf8');
  const ast = parseModule(source);
  return ast.body.flatMap((statement) => {
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
    if (declaration?.type === 'FunctionDeclaration') return [{ name: declaration.id.name, lines: source.slice(declaration.start, declaration.end).split('\n').length }];
    if (declaration?.type === 'VariableDeclaration') return declaration.declarations
      .filter((item) => item.init?.type === 'ArrowFunctionExpression' || item.init?.type === 'FunctionExpression')
      .map((item) => ({ name: item.id.name, lines: source.slice(item.init.start, item.init.end).split('\n').length }));
    return [];
  });
}

test('completeTask exposes a short stage flow and completion modules have cohesive owners', () => {
  const method = completionMethod(serviceSource);
  const methodLines = serviceSource.slice(method.start, method.end).split('\n').length;
  assert.ok(methodLines < 50, `public flow is ${methodLines} lines, not a policy implementation`);
  assertCompletionFlowBoundary(serviceSource);

  const sizes = completionFiles.flatMap((path) => declarationLengths(path));
  assert.ok(sizes.length >= 12, 'semantic behavior is split across named phase helpers');
  const largest = Math.max(...sizes.map((entry) => entry.lines));
  assert.ok(largest < 85, `largest completion helper is ${largest} lines`);
  assert.equal(readdirSync(completionRoot).some((name) => /^taskCompletionContext/i.test(name)), false,
    'completion modules do not hide shared service state in a generic context');
  const evidenceSource = readFileSync(completionFiles[1], 'utf8');
  assert.equal((evidenceSource.match(/service\.currentCompletionTask\(/g) ?? []).length, 4,
    'verify, review snapshot, changed-path and pre-persist reads use the dynamic stale-task seam');
  assert.equal((evidenceSource.match(/service\.isCurrentCompletion\(/g) ?? []).length, 0);
  for (const path of completionFiles) assertNoDuplicatedServiceState(readFileSync(path, 'utf8'));
  assertAcyclic(completionDependencyGraph());
});

test('completion phase boundaries reject flattened helpers and non-dynamic orchestration', () => {
  const flattened = serviceSource.replace('this.collectCompletionEvidence(', 'collectCompletionEvidence(');
  assert.throws(() => assertCompletionFlowBoundary(flattened), { name: 'AssertionError' });
  const persistenceCall = 'this.persistTaskCompletion({ teamId, taskId, attemptId, currentTask, effectiveUpdate })';
  assert.equal(serviceSource.split(persistenceCall).length - 1, 1);
  const withoutPersistence = serviceSource.replace(persistenceCall, 'currentTask');
  assert.throws(() => assertCompletionFlowBoundary(withoutPersistence), { name: 'AssertionError' });
});

test('artifact commit is followed by a dynamic stale-attempt check before persistence', async () => {
  const service = Object.create(TeamService.prototype);
  const task = {
    id: 'task-1', teamId: 'alpha', kind: 'implementation', status: 'in_progress',
    attemptId: 'attempt-1', worktree: 'isolated-worktree', mode: 'bound',
  };
  const order = [];
  const add = (name, result) => function (...args) {
    assert.strictEqual(this, service, `${name} preserves the TeamService receiver`);
    order.push(name);
    return result(...args);
  };
  service.useWorktrees = true;
  service.prepareTaskCompletion = add('prepare', () => ({
    task, attemptId: 'attempt-1', safeUpdate: { status: 'completed' },
  }));
  service.collectCompletionEvidence = add('evidence', () => Promise.resolve({ effectiveUpdate: { status: 'completed' } }));
  service.validateCompletionEvidence = add('validate', () => ({ ok: true, currentTask: task }));
  service.commitCompletionArtifact = add('artifact-commit', () => Promise.resolve({ ok: true, artifact: {} }));
  service.isCurrentCompletion = add('stale-check', () => false);
  service.persistTaskCompletion = add('persist', () => assert.fail('stale completion must not persist'));
  service.runTaskCompletionFollowUps = add('follow-up', () => assert.fail('stale completion must not run follow-ups'));

  const result = await TeamService.prototype.completeTask.call(service, {
    teamId: 'alpha', taskId: 'task-1', attemptId: 'attempt-1', update: { status: 'completed' },
  });
  assert.deepEqual(order, ['prepare', 'evidence', 'validate', 'artifact-commit', 'stale-check']);
  assert.deepEqual(result, { ok: false, error: 'stale attempt: task changed during artifact commit' });
});

test('completion architecture rejects state copies and circular module boundaries', () => {
  const duplicateStatePath = completionFiles[0];
  const duplicateStateSource = readFileSync(duplicateStatePath, 'utf8');
  const stateMutation = `${duplicateStateSource}\nconst copiedState = { store: new Map() };\n`;
  assert.throws(() => assertNoDuplicatedServiceState(stateMutation), { name: 'AssertionError' });

  const cycle = new Map([
    [completionFiles[0], `import './task-completion-evidence.mjs';\n${duplicateStateSource}`],
    [completionFiles[1], `import './task-completion-validation.mjs';\n${readFileSync(completionFiles[1], 'utf8')}`],
  ]);
  assert.throws(() => assertAcyclic(completionDependencyGraph(cycle)), { name: 'AssertionError' });
});

test('completeTask invokes service phase seams with the original receiver and in business order', async () => {
  const service = Object.create(TeamService.prototype);
  const task = { id: 'task-1', teamId: 'alpha', kind: 'work', status: 'in_progress', attemptId: 'attempt-1' };
  const order = [];
  const add = (name, result) => function (...args) {
    assert.strictEqual(this, service, `${name} preserves the TeamService receiver`);
    order.push(name);
    return result(...args);
  };
  service.prepareTaskCompletion = add('prepare', () => ({
    task, attemptId: 'attempt-1', safeUpdate: { status: 'completed' },
  }));
  service.collectCompletionEvidence = add('evidence', () => Promise.resolve({ effectiveUpdate: { status: 'completed' } }));
  service.validateCompletionEvidence = add('validate', () => ({ ok: true, currentTask: task }));
  service.persistTaskCompletion = add('persist', () => ({ ...task, status: 'completed' }));
  service.runTaskCompletionFollowUps = add('follow-up', () => Promise.resolve({ ok: true, task }));
  const result = await TeamService.prototype.completeTask.call(service, {
    teamId: 'alpha', taskId: 'task-1', attemptId: 'attempt-1', update: { status: 'completed' },
  });
  assert.deepEqual(order, ['prepare', 'evidence', 'validate', 'persist', 'follow-up']);
  assert.deepEqual(result, { ok: true, task });
});

test('completion evidence dynamically orders verify, snapshot, and changed-path seams', async () => {
  const { collectCompletionEvidence } = await import('../src/service/task-completion-phases.mjs');
  const order = [];
  const task = { id: 'review-1', teamId: 'alpha', kind: 'review', status: 'in_progress', reviewMode: 'bound' };
  const effectiveUpdate = { status: 'completed' };
  const service = {
    store: { getTask: () => ({ id: 'implementation-1', attempt: 1 }) },
    normalizeCompletionUpdate: () => effectiveUpdate,
    runCompletionVerification: async (args) => {
      assert.equal(args.task, task);
      order.push('verify');
      return { effectiveUpdate };
    },
    bindCompletionReviewSnapshot: async (args) => {
      assert.equal(args.effectiveUpdate, effectiveUpdate);
      order.push('snapshot');
      return { effectiveUpdate };
    },
    deriveCompletionChangedPaths: async (args) => {
      assert.equal(args.effectiveUpdate, effectiveUpdate);
      order.push('changed-path');
      return { effectiveUpdate };
    },
  };
  const evidence = await collectCompletionEvidence({
    service, task, attemptId: 'attempt-1', safeUpdate: { status: 'completed' }, workdir: 'worktree',
  });
  assert.deepEqual(order, ['verify', 'snapshot', 'changed-path']);
  assert.equal(evidence.effectiveUpdate, effectiveUpdate);
});

test('changed-path derivation failure cannot fall back to caller-reported paths', async () => {
  const events = [];
  const service = {
    currentCompletionTask: () => ({ id: 'task-1', attemptId: 'attempt-1' }),
    store: { addEvent: (...args) => events.push(args) },
  };
  const result = await deriveImplementationChangedPaths({
    service,
    teamId: 'alpha',
    task: { id: 'task-1', kind: 'implementation', worktree: 'D:/missing-completion-worktree' },
    attemptId: 'attempt-1',
    effectiveUpdate: { status: 'completed', changedPaths: ['src/reported.js'] },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /unable to prove actual changed paths/);
  assert.deepEqual(events.map(([, type]) => type), ['task.changed_paths_failed']);
});

test('artifact commit paths are revalidated for task and license scope before persistence', async () => {
  const service = Object.create(TeamService.prototype);
  const task = {
    id: 'task-1', teamId: 'alpha', kind: 'implementation', status: 'in_progress',
    attemptId: 'attempt-1', worktree: 'isolated-worktree', mode: 'bound',
    inScope: ['src/'], outOfScope: ['src/private/'], acceptance: ['done'], verify: ['verify'],
  };
  const order = [];
  service.useWorktrees = true;
  service.features = { licenses: true };
  service.config = { quality: { requireIndependentReview: false } };
  service.store = {
    findMember: () => ({ license: { pathScope: ['src/**'] } }),
  };
  service.currentCompletionTask = () => task;
  service.prepareTaskCompletion = () => ({ task, attemptId: 'attempt-1', safeUpdate: { status: 'completed' } });
  service.collectCompletionEvidence = async () => ({ effectiveUpdate: {
    status: 'completed', acceptanceResults: [{ criterion: 'done', status: 'passed' }],
    commandsRun: [{ command: 'verify', status: 'passed' }], changedPaths: ['src/reported.js'],
  } });
  service.validateCompletionEvidence = (args) => {
    order.push(`validate:${args.effectiveUpdate.changedPaths.join(',')}`);
    return validateCompletionEvidence({ service, ...args });
  };
  service.commitCompletionArtifact = async () => {
    order.push('commit');
    return { ok: true, artifact: {
      sourceBase: 'base', sourceCommit: 'commit', diffHash: 'hash', changedPaths: ['test/escaped.js'],
    } };
  };
  service.isCurrentCompletion = () => { order.push('authorize'); return true; };
  service.persistTaskCompletion = () => assert.fail('out-of-scope committed path must not persist');
  service.runTaskCompletionFollowUps = () => assert.fail('rejected completion must not run follow-ups');

  const result = await TeamService.prototype.completeTask.call(service, {
    teamId: 'alpha', taskId: 'task-1', attemptId: 'attempt-1', update: { status: 'completed' },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /outside license scope: test\/escaped\.js/);
  assert.deepEqual(order, [
    'validate:src/reported.js', 'commit', 'authorize', 'validate:test/escaped.js',
  ]);
});

test('artifact commit task-scope validation rejects paths accepted by the member license', async () => {
  const service = Object.create(TeamService.prototype);
  const task = {
    id: 'task-1', teamId: 'alpha', kind: 'implementation', status: 'in_progress',
    attemptId: 'attempt-1', worktree: 'isolated-worktree', mode: 'bound',
    inScope: ['src/'], outOfScope: ['src/private/'], acceptance: ['done'], verify: ['verify'],
  };
  const order = [];
  service.useWorktrees = true;
  service.features = { licenses: true };
  service.config = { quality: { requireIndependentReview: false } };
  service.store = { findMember: () => ({ license: { pathScope: ['**'] } }) };
  service.currentCompletionTask = () => task;
  service.prepareTaskCompletion = () => ({ task, attemptId: 'attempt-1', safeUpdate: { status: 'completed' } });
  service.collectCompletionEvidence = async () => ({ effectiveUpdate: {
    status: 'completed', acceptanceResults: [{ criterion: 'done', status: 'passed' }],
    commandsRun: [{ command: 'verify', status: 'passed' }], changedPaths: ['src/public.js'],
  } });
  service.validateCompletionEvidence = (args) => {
    order.push(`validate:${args.effectiveUpdate.changedPaths.join(',')}`);
    return validateCompletionEvidence({ service, ...args });
  };
  service.commitCompletionArtifact = async () => {
    order.push('commit');
    return { ok: true, artifact: {
      sourceBase: 'base', sourceCommit: 'commit', diffHash: 'hash', changedPaths: ['src/private/escaped.js'],
    } };
  };
  service.isCurrentCompletion = () => { order.push('authorize'); return true; };
  service.persistTaskCompletion = () => assert.fail('out-of-task-scope path must not persist');
  service.runTaskCompletionFollowUps = () => assert.fail('rejected completion must not run follow-ups');

  const result = await TeamService.prototype.completeTask.call(service, {
    teamId: 'alpha', taskId: 'task-1', attemptId: 'attempt-1', update: { status: 'completed' },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /implementation cannot complete: src\/private\/escaped\.js is out_of_scope/);
  assert.deepEqual(order, [
    'validate:src/public.js', 'commit', 'authorize', 'validate:src/private/escaped.js',
  ]);
});

test('closeout writes task, attempt, member, and event in one synchronous transaction', () => {
  const store = new Store(':memory:');
  store.createTeam({ id: 'alpha', phase: 'running' });
  store.addMember({ id: 'member-1', teamId: 'alpha', name: 'Engineer', status: 'working' });
  store.addTask({ id: 'task-1', teamId: 'alpha', kind: 'work', status: 'in_progress', assignee: 'Engineer', attemptId: 'attempt-1' });
  store.addAttempt({ id: 'attempt-1', teamId: 'alpha', taskId: 'task-1', status: 'in_progress' });
  const order = [];
  let now = 100;
  const original = {
    updateTask: store.updateTask.bind(store), updateAttempt: store.updateAttempt.bind(store),
    findMember: store.findMember.bind(store), updateMember: store.updateMember.bind(store), addEvent: store.addEvent.bind(store),
  };
  store.updateTask = (...args) => { assert.equal(store.inTransaction, true); order.push('task'); return original.updateTask(...args); };
  store.updateAttempt = (...args) => { assert.equal(store.inTransaction, true); order.push('attempt'); return original.updateAttempt(...args); };
  store.findMember = (...args) => { order.push('find-member'); return original.findMember(...args); };
  store.updateMember = (...args) => { assert.equal(store.inTransaction, true); order.push('member'); return original.updateMember(...args); };
  store.addEvent = (...args) => { assert.equal(store.inTransaction, true); order.push('event'); return original.addEvent(...args); };
  const service = Object.create(TeamService.prototype);
  service.store = store;
  service.now = () => { order.push('now'); return ++now; };
  service.refreshMemberState = (teamId, memberId) => {
    assert.equal(store.inTransaction, true);
    order.push('refresh');
    return TeamService.prototype.refreshMemberState.call(service, teamId, memberId);
  };
  const closed = persistTaskCompletion({
    service, teamId: 'alpha', taskId: 'task-1', attemptId: 'attempt-1',
    currentTask: store.getTask('task-1'), effectiveUpdate: { status: 'completed' },
  });
  assert.equal(closed.status, 'completed');
  assert.deepEqual(order, ['task', 'now', 'attempt', 'find-member', 'now', 'member', 'refresh', 'member', 'event']);
  assert.equal(store.getAttempt('attempt-1').endedAt, 101);
  assert.equal(store.getMember('member-1').lastActiveAt, 102);
  assert.equal(store.inTransaction, false);
  store.close();
});

test('closeout transaction failure rolls back task, attempt, member, and event together', () => {
  const store = new Store(':memory:');
  store.createTeam({ id: 'alpha', phase: 'running' });
  store.addMember({ id: 'member-1', teamId: 'alpha', name: 'Engineer', status: 'working' });
  store.addTask({ id: 'task-1', teamId: 'alpha', kind: 'work', status: 'in_progress', assignee: 'Engineer', attemptId: 'attempt-1' });
  store.addAttempt({ id: 'attempt-1', teamId: 'alpha', taskId: 'task-1', status: 'in_progress' });
  const beforeEvents = store.listEvents('alpha').length;
  let now = 200;
  const failure = new Error('injected refresh failure');
  const service = {
    store,
    now: () => ++now,
    refreshMemberState: () => { throw failure; },
  };
  assert.throws(() => persistTaskCompletion({
    service, teamId: 'alpha', taskId: 'task-1', attemptId: 'attempt-1',
    currentTask: store.getTask('task-1'), effectiveUpdate: { status: 'failed' },
  }), (error) => error === failure);
  assert.equal(store.getTask('task-1').status, 'in_progress');
  assert.equal(store.getAttempt('attempt-1').status, 'in_progress');
  assert.equal(store.getAttempt('attempt-1').endedAt, undefined);
  assert.equal(store.getMember('member-1').status, 'working');
  assert.equal(store.getMember('member-1').lastActiveAt, undefined);
  assert.equal(store.listEvents('alpha').length, beforeEvents);
  assert.equal(store.inTransaction, false);
  store.close();
});

test('failed completion calls its hook when closed-loop succeeds and preserves planner failures', async () => {
  let hookCalls = 0;
  const task = { id: 'failed-task', kind: 'work', status: 'failed' };
  const service = {
    store: { listTasks: () => [], getTask: () => task },
    applyClosedLoop: async () => ({ created: [] }),
    onTaskFailed: () => { hookCalls += 1; },
  };
  const success = await runTaskCompletionFollowUps({
    service, teamId: 'alpha', taskId: task.id, task, closed: task, status: 'failed',
  });
  assert.equal(success.ok, true);
  assert.equal(hookCalls, 1);

  const plannerFailure = new Error('closed-loop failed');
  service.applyClosedLoop = async () => { throw plannerFailure; };
  await assert.rejects(runTaskCompletionFollowUps({
    service, teamId: 'alpha', taskId: task.id, task, closed: task, status: 'failed',
  }), (error) => error === plannerFailure);
  assert.equal(hookCalls, 2);

  const hookFailure = new Error('failed hook failed');
  service.onTaskFailed = () => { hookCalls += 1; throw hookFailure; };
  await assert.rejects(runTaskCompletionFollowUps({
    service, teamId: 'alpha', taskId: task.id, task, closed: task, status: 'failed',
  }), (error) => error === plannerFailure && error.taskFailedHookError === hookFailure);
  assert.equal(hookCalls, 3, 'failed hook is invoked once even when both phases throw');

  service.applyClosedLoop = async () => ({ created: [] });
  await assert.rejects(runTaskCompletionFollowUps({
    service, teamId: 'alpha', taskId: task.id, task, closed: task, status: 'failed',
  }), (error) => error === hookFailure);
  assert.equal(hookCalls, 4, 'hook error propagates when the planner succeeds');
});

test('completed follow-up propagates closed-loop failure without calling failed hook', async () => {
  const plannerFailure = new Error('closed-loop failed');
  let hookCalls = 0;
  const task = { id: 'completed-task', kind: 'work', status: 'completed' };
  const service = {
    store: { listTasks: () => [], getTask: () => task },
    applyClosedLoop: async () => { throw plannerFailure; },
    onTaskFailed: () => { hookCalls += 1; },
  };
  await assert.rejects(runTaskCompletionFollowUps({
    service, teamId: 'alpha', taskId: task.id, task, closed: task, status: 'completed',
  }), (error) => error === plannerFailure);
  assert.equal(hookCalls, 0);
});
