import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = resolve(root, 'src/scheduler-service.mjs');
const helperPath = resolve(root, 'src/service/control-sessions.mjs');
const source = readFileSync(sourcePath, 'utf8');
const helper = readFileSync(helperPath, 'utf8');
const names = [
  'withShadowLock',
  'shadowStatus',
  'shadowAutoStopTick',
  'startShadow',
  'stopShadow',
  'ensureCaptainSession',
];

function classMethods(text, className) {
  const ast = parse(text, { ecmaVersion: 'latest', sourceType: 'module' });
  const classNode = ast.body.find((node) => node.type === 'ExportNamedDeclaration'
    && node.declaration?.type === 'ClassDeclaration'
    && node.declaration.id.name === className)?.declaration;
  assert.ok(classNode, `expected ${className} declaration`);
  return new Map(classNode.body.body
    .filter((node) => node.type === 'MethodDefinition')
    .map((node) => [node.key.name, node]));
}

function exportedFunctions(text) {
  const ast = parse(text, { ecmaVersion: 'latest', sourceType: 'module' });
  return new Map(ast.body
    .filter((node) => node.type === 'ExportNamedDeclaration'
      && node.declaration?.type === 'FunctionDeclaration')
    .map((node) => [node.declaration.id.name, node.declaration]));
}

function bodyText(text, node) {
  return text.slice(node.body.start, node.body.end).replaceAll('\r\n', '\n');
}

test('TeamService keeps the six control-session methods as thin public facades', () => {
  const methods = classMethods(source, 'TeamService');
  for (const name of names) assert.ok(methods.has(name), `TeamService retains ${name}`);
  const expectedCalls = {
    withShadowLock: 'withShadowLockFrom(this, fn)',
    shadowStatus: 'shadowStatusFrom(this)',
    shadowAutoStopTick: 'shadowAutoStopTickFrom(this)',
    startShadow: 'startShadowFrom(this, { teamId })',
    stopShadow: 'stopShadowFrom(this, { reason })',
    ensureCaptainSession: 'ensureCaptainSessionFrom(this, team, { onAdmissionRejected })',
  };
  for (const name of names) {
    const facade = methods.get(name);
    assert.deepEqual(facade.value.params.map((param) => source.slice(param.start, param.end)), {
      withShadowLock: ['fn'],
      shadowStatus: [],
      shadowAutoStopTick: [],
      startShadow: ['{ teamId } = {}'],
      stopShadow: ['{ reason } = {}'],
      ensureCaptainSession: ['team', '{ onAdmissionRejected } = {}'],
    }[name], `${name} retains its public parameter shape`);
    assert.equal(bodyText(source, facade.value).trim(), `{\n    return ${expectedCalls[name]};\n  }`, `${name} remains a direct delegation`);
  }
});

test('control-session helpers share TeamService state and preserve lifecycle ordering', () => {
  const functions = exportedFunctions(helper);
  assert.deepEqual([...functions.keys()], names);
  assert.match(helper, /service\.shadowTransition\.then\(fn, fn\)/);
  assert.match(helper, /service\.shadowTransition = run\.catch\(\(\) => \{\}\)/);
  assert.match(source, /this\.shadowTransition = Promise\.resolve\(\)/);
  assert.match(source, /this\.captainSessionStarts = new Map\(\)/);
  assert.doesNotMatch(helper, /\bthis\s*\./);
  assert.doesNotMatch(helper, /(?:shadowTransition|captainSessionStarts)\s*=\s*new\s+(?:Map|Set|Promise)/);
  assert.match(helper, /service\.captainSessionStarts\.get\(team\.id\)/);
  assert.match(helper, /service\.captainSessionStarts\.set\(team\.id, start\)/);
  assert.match(helper, /service\.assertControlBudget\(\)/);
  assert.match(helper, /service\.assertWorkspaceSessionBudget\(\)/);

  const start = bodyText(helper, functions.get('startShadow'));
  assert.match(start, /service\.store\.transaction\(\(\) => \{/);
  assert.match(start, /shadowStartId: startId/);
  assert.match(start, /latest\.shadowStartId !== startId/);
  assert.match(start, /service\.adapter\.kind === 'protocol'/);
  assert.match(start, /await service\.adapter\.send\(/);
  assert.match(start, /service\.store\.addEvent\(member\.teamId, 'shadow\.started'/);
  assert.ok(start.indexOf('await service.adapter.stop(') < start.indexOf('await service.adapter.close?.('),
    'late start cleanup stops before closing');

  const stop = bodyText(helper, functions.get('stopShadow'));
  assert.ok(stop.indexOf('await service.adapter.stop(') < stop.indexOf('await service.adapter.close?.('),
    'normal stop closes only after stop completes');
  assert.match(stop, /shadowState: 'stop_failed'/);
  assert.match(stop, /sessionId: member\.sessionId/);
  assert.match(stop, /service\.store\.addEvent\(member\.teamId, 'shadow\.stop_failed'/);

  const captain = bodyText(helper, functions.get('ensureCaptainSession'));
  assert.match(captain, /state: 'unknown'/);
  assert.match(captain, /captain\.session_unknown/);
  assert.match(captain, /captain\.session_conflict/);
  assert.match(captain, /captain\.session_starting/);
  assert.match(captain, /captain\.session_started/);
});
