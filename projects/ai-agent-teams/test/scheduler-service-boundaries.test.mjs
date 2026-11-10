import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
import { runInNewContext } from 'node:vm';
import { TeamService } from '../src/scheduler-service.mjs';
import { reassignTask } from '../src/service/task-transitions.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const schedulerSource = readFileSync(resolve(root, 'src/scheduler-service.mjs'), 'utf8');
const closedLoopSource = readFileSync(resolve(root, 'src/service/closed-loop.mjs'), 'utf8');
const restartRecoverySource = readFileSync(resolve(root, 'src/service/restart-recovery.mjs'), 'utf8');
const mergeWorkflowSource = readFileSync(resolve(root, 'src/service/merge-workflow.mjs'), 'utf8');
const tickWorkflowSource = readFileSync(resolve(root, 'src/service/tick-workflow.mjs'), 'utf8');
const taskTransitionsSource = readFileSync(resolve(root, 'src/service/task-transitions.mjs'), 'utf8');

function classMethods(source) {
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const service = ast.body.find((node) => node.type === 'ExportNamedDeclaration'
    && node.declaration?.type === 'ClassDeclaration'
    && node.declaration.id.name === 'TeamService')?.declaration;
  assert.ok(service, 'expected TeamService declaration');
  return new Map(service.body.body
    .filter((node) => node.type === 'MethodDefinition')
    .map((node) => [node.key.name, node]));
}

function exportedFunctions(source) {
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  return new Map(ast.body
    .filter((node) => node.type === 'ExportNamedDeclaration'
      && node.declaration?.type === 'FunctionDeclaration')
    .map((node) => [node.declaration.id.name, node.declaration]));
}

function methodText(source, method) {
  return source.slice(method.start, method.end);
}

function executableFacade(name, method, stub) {
  return runInNewContext(`({ ${methodText(schedulerSource, method)} })`, {
    [`${name}From`]: stub,
  });
}

function objectShape(expected) {
  return (actual) => {
    assert.ok(actual && typeof actual === 'object');
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort());
    for (const [key, value] of Object.entries(expected)) assert.strictEqual(actual[key], value);
  };
}

async function assertFacadeContract(name, method, { args, forwarded = args }) {
  const expectedResult = { resultFrom: name };
  const calls = [];
  const facade = executableFacade(name, method, (...values) => {
    calls.push(values);
    return expectedResult;
  });

  const result = facade[name](...args);
  if (method.value.async) assert.strictEqual(await result, expectedResult, `${name} returns the exact result`);
  else assert.strictEqual(result, expectedResult, `${name} returns the exact result`);
  assert.equal(calls.length, 1, `${name} dispatches once`);
  assert.strictEqual(calls[0][0], facade, `${name} forwards its service instance`);
  assert.equal(calls[0].length - 1, forwarded.length, `${name} forwards the complete argument list`);
  forwarded.forEach((expected, index) => {
    if (typeof expected === 'function') expected(calls[0][index + 1]);
    else assert.strictEqual(calls[0][index + 1], expected, `${name} argument ${index + 1} identity`);
  });

  const expectedError = new Error(`${name} failure`);
  const errorCalls = [];
  const errorFacade = executableFacade(name, method, (...values) => {
    errorCalls.push(values);
    throw expectedError;
  });
  await assert.rejects(Promise.resolve().then(() => errorFacade[name](...args)), (error) => error === expectedError);
  assert.equal(errorCalls.length, 1, `${name} propagates the same thrown error`);
  assert.strictEqual(errorCalls[0][0], errorFacade, `${name} forwards its service instance on failure`);
  assert.equal(errorCalls[0].length - 1, forwarded.length, `${name} forwards all arguments on failure`);
  forwarded.forEach((expected, index) => {
    if (typeof expected === 'function') expected(errorCalls[0][index + 1]);
    else assert.strictEqual(errorCalls[0][index + 1], expected, `${name} failure argument ${index + 1} identity`);
  });
}

test('all extracted TeamService facades preserve runtime forwarding contracts', async () => {
  const methods = classMethods(schedulerSource);
  const marker = (id) => ({ id });
  const team = marker('team');
  const task = marker('task');
  const plan = marker('plan');
  const planned = marker('planned');
  const anchor = marker('anchor');
  const action = marker('action');
  const error = marker('error');
  const memberName = marker('member');
  const attemptId = marker('attempt');
  const actor = marker('actor');
  const fields = marker('fields');
  const reason = marker('reason');
  const options = marker('options');
  const cases = [
    ['withClosedLoopLock', [team, action]],
    ['applyClosedLoop', [team, task]],
    ['supersedeLegacyReviews', [team, task, plan]],
    ['applyClosedLoopUnlocked', [team, task]],
    ['createLoopTasks', [team, planned, anchor]],
    ['loopEventFor', [task]],
    ['createLoopTask', [team, planned, marker('event-type'), anchor]],
    ['escalateClosedLoop', [team, task, { reason, round: 3, findings: plan }], [team, task, objectShape({ reason, round: 3, findings: plan })], [team, task], [team, task, objectShape({ reason: undefined, round: undefined, findings: undefined })]],
    ['reconcileClosedLoop', [team]],
    ['reconcileClosedLoopUnlocked', [team]],
    ['recoverEvidenceBackedTasks', [team]],
    ['reconcileAfterRestart', []],
    ['reconcileContractors', []],
    ['reviewMerge', [team, task]],
    ['reviewMergeUnlocked', [team, task]],
    ['mergeTask', [team, task, options], [team, task, options], [team, task], [team, task, objectShape({})]],
    ['mergeTaskUnlocked', [team, task, options], [team, task, options], [team, task], [team, task, objectShape({})]],
    ['deferTransientTick', [team, error]],
    ['tick', [team]],
    ['tickUnlocked', [team]],
    ['tickAll', []],
    ['continueTask', [team, task, options], [team, task, options], [team, task], [team, task, objectShape({})]],
    ['reassignTask', [team, task, memberName, reason], [team, task, memberName, reason], [team, task, memberName], [team, task, memberName, 'reassigned']],
    ['claimTask', [team, task, memberName, attemptId, actor]],
    ['heartbeatTask', [team, task, attemptId, actor]],
    ['amendTask', [team, task, fields, reason, actor]],
    ['releaseTaskHold', [team, task, { reason, expectedReason: plan, actor }], [team, task, objectShape({ reason, expectedReason: plan, actor })], [team, task], [team, task, objectShape({ reason: undefined, expectedReason: undefined, actor: undefined })]],
    ['cancelTask', [team, task, { reason, actor }], [team, task, objectShape({ reason, actor })], [team, task], [team, task, objectShape({ reason: undefined, actor: undefined })]],
    ['reopenTask', [team, task, { reason, actor }], [team, task, objectShape({ reason, actor })], [team, task], [team, task, objectShape({ reason: undefined, actor: undefined })]],
  ];

  for (const [name, args, forwarded = args, defaultArgs, defaultForwarded] of cases) {
    const method = methods.get(name);
    assert.ok(method, `TeamService retains ${name}`);
    await assertFacadeContract(name, method, { args, forwarded });
    if (defaultArgs) await assertFacadeContract(name, method, { args: defaultArgs, forwarded: defaultForwarded });
  }
});

test('closed-loop and restart methods remain TeamService facades with matching signatures', () => {
  const methods = classMethods(schedulerSource);
  const closedLoop = exportedFunctions(closedLoopSource);
  const restartRecovery = exportedFunctions(restartRecoverySource);
  const groups = [
    { functions: closedLoop, names: [
      'withClosedLoopLock', 'applyClosedLoop', 'supersedeLegacyReviews',
      'applyClosedLoopUnlocked', 'createLoopTasks', 'loopEventFor', 'createLoopTask',
      'escalateClosedLoop', 'reconcileClosedLoop', 'reconcileClosedLoopUnlocked',
      'recoverEvidenceBackedTasks',
    ] },
    { functions: restartRecovery, names: ['reconcileAfterRestart', 'reconcileContractors'] },
  ];

  for (const { functions, names } of groups) {
    for (const name of names) {
      const method = methods.get(name);
      const implementation = functions.get(name);
      assert.ok(method, `TeamService retains ${name}`);
      assert.ok(implementation, `service module exports ${name}`);
      assert.deepEqual(
        method.value.params.map((param) => schedulerSource.slice(param.start, param.end)),
        implementation.params.slice(1).map((param) => {
          const start = param.start;
          const end = param.end;
          return (name === 'reconcileAfterRestart' || name === 'reconcileContractors')
            ? restartRecoverySource.slice(start, end)
            : closedLoopSource.slice(start, end);
        }),
        `${name} facade preserves the implementation parameters`,
      );
      assert.match(methodText(schedulerSource, method), new RegExp(`${name}From\\(this`));
    }
  }
});

test('merge workflow methods remain TeamService facades with matching signatures', () => {
  const methods = classMethods(schedulerSource);
  const implementations = exportedFunctions(mergeWorkflowSource);
  for (const name of ['reviewMerge', 'reviewMergeUnlocked', 'mergeTask', 'mergeTaskUnlocked']) {
    const method = methods.get(name);
    const implementation = implementations.get(name);
    assert.ok(method, `TeamService retains ${name}`);
    assert.ok(implementation, `merge workflow module exports ${name}`);
    assert.deepEqual(
      method.value.params.map((param) => schedulerSource.slice(param.start, param.end)),
      implementation.params.slice(1).map((param) => mergeWorkflowSource.slice(param.start, param.end)),
      `${name} facade preserves the implementation parameters`,
    );
    assert.match(methodText(schedulerSource, method), new RegExp(`${name}From\\(this`));
  }
});

test('tick workflow methods remain TeamService facades with matching signatures', () => {
  const methods = classMethods(schedulerSource);
  const implementations = exportedFunctions(tickWorkflowSource);
  for (const name of ['deferTransientTick', 'tick', 'tickUnlocked', 'tickAll']) {
    const method = methods.get(name);
    const implementation = implementations.get(name);
    assert.ok(method, `TeamService retains ${name}`);
    assert.ok(implementation, `service module exports ${name}`);
    assert.deepEqual(
      method.value.params.map((param) => schedulerSource.slice(param.start, param.end)),
      implementation.params.slice(1).map((param) => tickWorkflowSource.slice(param.start, param.end)),
      `${name} facade preserves the implementation parameters`,
    );
    assert.match(methodText(schedulerSource, method), new RegExp(`${name}From\\(this`));
  }
});

test('task transition methods remain TeamService facades with matching signatures', () => {
  const methods = classMethods(schedulerSource);
  const implementations = exportedFunctions(taskTransitionsSource);
  const names = [
    'continueTask', 'reassignTask', 'claimTask', 'heartbeatTask',
    'amendTask', 'releaseTaskHold', 'cancelTask', 'reopenTask',
  ];
  for (const name of names) {
    const method = methods.get(name);
    const implementation = implementations.get(name);
    assert.ok(method, `TeamService retains ${name}`);
    assert.ok(implementation, `task-transitions exports ${name}`);
    assert.deepEqual(
      method.value.params.map((param) => schedulerSource.slice(param.start, param.end)),
      implementation.params.slice(1).map((param) => taskTransitionsSource.slice(param.start, param.end)),
      `${name} facade preserves the implementation parameters`,
    );
    assert.match(methodText(schedulerSource, method), new RegExp(`${name}From\\(this`));
  }
  assert.deepEqual([...implementations.keys()], names);
});

test('task transitions keep dynamic service seams and shared state ownership', () => {
  assert.doesNotMatch(taskTransitionsSource, /\bthis\s*\./);
  assert.match(taskTransitionsSource, /const ACTIVE_STATUSES = new Set\(/);
  assert.match(taskTransitionsSource, /const TERMINAL_STATUSES = new Set\(/);
  assert.match(taskTransitionsSource, /service\.store\./);
  assert.match(taskTransitionsSource, /service\.continueDueTurns\(teamId, service\.now\(\)\)/);
  assert.match(taskTransitionsSource, /service\.tick\(teamId\)/);
  assert.match(taskTransitionsSource, /service\.reclaimWorktrees\(\)/);
  assert.match(schedulerSource, /this\.store/);
  assert.doesNotMatch(schedulerSource, /this\.ACTIVE_STATUSES|this\.TERMINAL_STATUSES/);
});

test('task transition facade uses the same instance and dynamically dispatched tick seam', async () => {
  const service = Object.create(TeamService.prototype);
  const events = [];
  const task = { id: 'task', teamId: 'alpha', status: 'failed', assignee: 'engineer', attempt: 1 };
  service.canContinueTask = (teamId, actor) => teamId === 'alpha' && actor?.role === 'admin';
  service.now = () => 100;
  service.leaseMs = 20;
  service.tick = async (teamId) => { events.push(['tick', teamId]); };
  service.store = {
    getTask: (id) => { assert.equal(id, task.id); return { ...task }; },
    getTeam: (teamId) => ({ id: teamId, phase: 'running', control: 'active', controlEpoch: 0 }),
    findMember: (_teamId, name) => ({ id: 'member', name }),
    listTasks: () => [{ ...task }],
    updateTask: (id, update) => { events.push(['updateTask', id]); Object.assign(task, update); return { ...task }; },
    updateAttempt: () => events.push(['updateAttempt']),
    addAttempt: () => events.push(['addAttempt']),
    addEvent: (_teamId, name) => events.push(['event', name]),
  };
  const result = await TeamService.prototype.continueTask.call(service, 'alpha', 'task', {
    actor: { role: 'admin', name: 'captain' }, reason: 'recover',
  });
  assert.equal(result.ok, true);
  assert.equal(result.sent, false);
  assert.equal(result.task.status, 'pending');
  assert.deepEqual(events.map(([name]) => name), [
    'updateTask', 'addAttempt', 'event', 'updateAttempt', 'updateTask', 'event', 'tick',
  ]);
  assert.deepEqual(events.at(-1), ['tick', 'alpha']);
});

test('reassignment stops the old session before writes and refuses a concurrent task change', async () => {
  const events = [];
  const task = { id: 'task', teamId: 'alpha', status: 'in_progress', assignee: 'old', attemptId: 'attempt' };
  const member = { id: 'member', name: 'old', sessionId: 'session' };
  let changedDuringStop = false;
  const service = {
    config: { captain: { name: 'captain' } },
    features: {},
    adapter: { stop: async () => {
      events.push('stop');
      if (changedDuringStop) task.attemptId = 'new-attempt';
    } },
    store: {
      getTask: () => ({ ...task }),
      listTasks: () => [{ ...task }],
      findMember: () => member,
      updateAttempt: () => events.push('attempt'),
      updateTask: (_id, update) => { events.push('task'); Object.assign(task, update); return { ...task }; },
      addEvent: (_teamId, name) => events.push(name),
    },
    now: () => 100,
    tick: async () => { events.push('tick'); },
    refreshMemberState: () => events.push('refresh'),
  };

  const reassigned = await reassignTask(service, 'alpha', 'task', 'new', 'handoff');
  assert.equal(reassigned.assignee, 'new');
  assert.deepEqual(events, ['stop', 'attempt', 'task', 'refresh', 'task.reassigned', 'tick']);

  events.length = 0;
  task.assignee = 'old';
  task.status = 'in_progress';
  task.attemptId = 'attempt';
  changedDuringStop = true;
  const result = await reassignTask(service, 'alpha', 'task', 'new', 'handoff');
  assert.deepEqual(result, { ok: false, error: 'task changed during reassignment; refusing to overwrite it' });
  assert.deepEqual(events, ['stop']);
});

