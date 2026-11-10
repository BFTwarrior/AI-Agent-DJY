import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
import { TeamService } from '../src/scheduler-service.mjs';
import {
  armTurnWatcher,
  continueDueTurns,
  continueOneTask,
  deferContinue,
  handleTurnFailure,
} from '../src/service/turn-recovery.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const schedulerPath = resolve(root, 'src/scheduler-service.mjs');
const recoveryPath = resolve(root, 'src/service/turn-recovery.mjs');
const tickPath = resolve(root, 'src/service/tick-workflow.mjs');
const schedulerSource = readFileSync(schedulerPath, 'utf8');
const recoverySource = readFileSync(recoveryPath, 'utf8');
const tickSource = readFileSync(tickPath, 'utf8');

function classMethods(source) {
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const service = ast.body.find((node) => node.type === 'ExportNamedDeclaration'
    && node.declaration?.type === 'ClassDeclaration'
    && node.declaration.id.name === 'TeamService')?.declaration;
  assert.ok(service, 'expected TeamService declaration');
  return new Map(service.body.body
    .filter((node) => node.type === 'MethodDefinition')
    .map((node) => [node.key.name, node.value]));
}

function exportedFunctions(source) {
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  return new Map(ast.body
    .filter((node) => node.type === 'ExportNamedDeclaration'
      && node.declaration?.type === 'FunctionDeclaration')
    .map((node) => [node.declaration.id.name, node.declaration]));
}

function bodyText(source, node) {
  return source.slice(node.body.start, node.body.end).replaceAll('\r\n', '\n');
}

const methodNames = [
  'armTurnWatcher',
  'handleTurnFailure',
  'continueDueTurns',
  'deferContinue',
  'continueOneTask',
];

test('turn-recovery methods remain public facades with the original signatures', () => {
  const methods = classMethods(schedulerSource);
  const functions = exportedFunctions(recoverySource);
  for (const name of methodNames) {
    assert.ok(methods.has(name), `TeamService retains ${name}`);
    assert.ok(functions.has(name), `turn-recovery exports ${name}`);
  }
  const expectedParams = {
    armTurnWatcher: ['{ teamId, taskId, attemptId, member, sessionId, afterSeq }'],
    handleTurnFailure: ['{ teamId, taskId, attemptId, memberId, sessionId: attemptSessionId, message, code, type, retryable, retryAfterMs, turnFailure = false, correlationId = randomUUID(), causedBy }'],
    continueDueTurns: ['teamId', 'now'],
    deferContinue: ['teamId', 'task', 'attemptId', 'reason', 'details = {}'],
    continueOneTask: ['teamId', 'task'],
  };
  for (const name of methodNames) {
    const method = methods.get(name);
    assert.deepEqual(method.params.map((param) => schedulerSource.slice(param.start, param.end)), expectedParams[name]);
  }
  assert.match(bodyText(schedulerSource, methods.get('armTurnWatcher')), /armTurnWatcherFrom\(this, \{ teamId, taskId, attemptId, member, sessionId, afterSeq \}, TERMINAL_STATUSES\)/);
  assert.match(bodyText(schedulerSource, methods.get('handleTurnFailure')), /handleTurnFailureFrom\(this, \{ teamId, taskId, attemptId, memberId, sessionId: attemptSessionId/);
  assert.match(bodyText(schedulerSource, methods.get('continueDueTurns')), /continueDueTurnsFrom\(this, teamId, now\)/);
  assert.match(bodyText(schedulerSource, methods.get('deferContinue')), /deferContinueFrom\(this, teamId, task, attemptId, reason, details\)/);
  assert.match(bodyText(schedulerSource, methods.get('continueOneTask')), /continueOneTaskFrom\(this, teamId, task\)/);
  assert.deepEqual([...functions.keys()], methodNames);
  assert.doesNotMatch(recoverySource, /(?:turnWatchers|continueInFlight)\s*=\s*new\s+(?:Map|Set)/);
  assert.match(schedulerSource, /this\.turnWatchers = new Map\(\)/);
  assert.match(schedulerSource, /this\.continueInFlight = new Set\(\)/);
});

test('turn recovery keeps dynamic service seams, attempt ordering and native-model send edge', () => {
  assert.doesNotMatch(recoverySource, /\bthis\s*\./);
  assert.match(recoverySource, /service\.handleTurnFailure\(/);
  assert.match(recoverySource, /service\.continueOneTask\(/);
  assert.match(recoverySource, /service\.deferContinue\(/);
  assert.match(recoverySource, /service\.onTaskFailed\(/);
  assert.match(recoverySource, /service\.refreshMemberState\(/);
  assert.match(recoverySource, /service\.resetMemberSession\(/);
  assert.match(recoverySource, /withNativeModelForDispatch\(service,/);
  assert.match(recoverySource, /service\.adapter\.send\(/);
  assert.match(schedulerSource, /async continueTask\(teamId, taskId, options = \{\}\)/);
  assert.match(tickSource, /service\.continueDueTurns\(teamId, service\.now\(\)\)/);

  const failure = bodyText(recoverySource, exportedFunctions(recoverySource).get('handleTurnFailure'));
  assert.ok(failure.indexOf('service.store.updateAttempt(') < failure.indexOf("service.store.addEvent(teamId, 'task.turn_failed'"));
  assert.ok(failure.indexOf('service.store.updateTask(task.id, {') < failure.indexOf('service.store.addAttempt({'));
  const due = bodyText(recoverySource, exportedFunctions(recoverySource).get('continueDueTurns'));
  assert.ok(due.indexOf('service.continueInFlight.add(task.id)') < due.indexOf('await service.continueOneTask(teamId, task)'));
  assert.ok(due.indexOf('await service.continueOneTask(teamId, task)') < due.indexOf('service.continueInFlight.delete(task.id)'));
  const continuation = bodyText(recoverySource, exportedFunctions(recoverySource).get('continueOneTask'));
  assert.ok(continuation.indexOf('withNativeModelForDispatch(service,') < continuation.indexOf("service.store.addEvent(teamId, 'task.continued'"));
  assert.ok(continuation.indexOf("service.store.addEvent(teamId, 'task.continued'") < continuation.indexOf('service.armTurnWatcher({'));
});

test('TeamService recovery facade dispatches through the same instance state and overrides', async () => {
  const service = Object.create(TeamService.prototype);
  const task = { id: 'task-1', autoContinue: true, status: 'in_progress', attemptId: 'attempt-1', retryNotBefore: 10 };
  const calls = [];
  service.store = {
    listTasks: (teamId) => { calls.push(['listTasks', teamId]); return [task]; },
  };
  service.continueInFlight = new Set();
  service.continueOneTask = async (teamId, row) => {
    calls.push(['continueOneTask', teamId, row.id]);
    assert.equal(service.continueInFlight.has(row.id), true);
    return 1;
  };
  const count = await TeamService.prototype.continueDueTurns.call(service, 'alpha', 10);
  assert.equal(count, 1);
  assert.deepEqual(calls, [['listTasks', 'alpha'], ['continueOneTask', 'alpha', 'task-1']]);
  assert.equal(service.continueInFlight.has(task.id), false);
  assert.equal(armTurnWatcher instanceof Function, true);
  assert.equal(handleTurnFailure instanceof Function, true);
  assert.equal(deferContinue instanceof Function, true);
  assert.equal(continueOneTask instanceof Function, true);
  assert.equal(continueDueTurns instanceof Function, true);
});
