import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shellRoot = resolve(root, 'src/mcp');
const shellEntry = resolve(shellRoot, 'shell.mjs');
const modulesRoot = resolve(shellRoot, 'shell');

function readModule(path) {
  return readFileSync(path, 'utf8');
}

function parseModule(path) {
  return parse(readModule(path), { ecmaVersion: 'latest', sourceType: 'module' });
}

function classDeclaration(ast, name) {
  const declaration = ast.body.find((node) => node.type === 'ExportNamedDeclaration'
    && node.declaration?.type === 'ClassDeclaration'
    && node.declaration.id.name === name)?.declaration;
  assert.ok(declaration, `expected exported class ${name}`);
  return declaration;
}

function methodsOf(classNode) {
  return new Map(classNode.body.body
    .filter((node) => node.type === 'MethodDefinition')
    .map((node) => [node.key.name, node]));
}

function sourceLineCount(path, node) {
  return readModule(path).slice(node.start, node.end).split('\n').length;
}

function moduleFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => entry.isDirectory()
      ? moduleFiles(resolve(directory, entry.name))
      : entry.isFile() && entry.name.endsWith('.mjs') ? [resolve(directory, entry.name)] : []);
}

test('MCP shell facade keeps its stable exports and returned control surface', () => {
  const ast = parseModule(shellEntry);
  const namedExports = ast.body
    .filter((node) => node.type === 'ExportNamedDeclaration')
    .flatMap((node) => node.declaration?.type === 'FunctionDeclaration'
      ? [node.declaration.id.name]
      : (node.specifiers ?? []).map((specifier) => specifier.exported.name));
  assert.deepEqual(namedExports, ['RUNTIME_API_VERSION', 'DEFAULT_RUNTIME_ENTRY', 'createMcpShell', 'runShell']);

  const factory = ast.body.find((node) => node.type === 'ExportNamedDeclaration'
    && node.declaration?.id?.name === 'createMcpShell').declaration;
  const returned = factory.body.body.find((node) => node.type === 'ReturnStatement').argument;
  assert.deepEqual(returned.properties.map((property) => property.key.name), [
    'pluginRoot', 'pointerPath', 'handleMessage', 'reload', 'whenIdle', 'close', 'status', 'resolveWorkspace',
  ]);
});

test('shell modules assign protocol, lifecycle, target and watcher state to separate owners', () => {
  const protocolSource = readModule(resolve(modulesRoot, 'protocol.mjs'));
  const protocol = methodsOf(classDeclaration(parseModule(resolve(modulesRoot, 'protocol.mjs')), 'ShellProtocol'));
  const lifecycle = methodsOf(classDeclaration(parseModule(resolve(modulesRoot, 'runtime-supervisor.mjs')), 'RuntimeSupervisor'));
  const targets = methodsOf(classDeclaration(parseModule(resolve(modulesRoot, 'runtime-target.mjs')), 'RuntimeTargets'));
  const watcher = methodsOf(classDeclaration(parseModule(resolve(modulesRoot, 'pointer-watcher.mjs')), 'PointerWatcher'));
  const lifecycleSource = readModule(resolve(modulesRoot, 'runtime-supervisor.mjs'));
  const targetsSource = readModule(resolve(modulesRoot, 'runtime-target.mjs'));
  const watcherSource = readModule(resolve(modulesRoot, 'pointer-watcher.mjs'));

  assert.match(protocolSource, /this\.pending = new Map\(\)/);
  assert.match(protocolSource, /this\.hostRequests = new Map\(\)/);
  assert.match(protocolSource, /this\.hostRequestResponses = new Map\(\)/);
  assert.match(protocolSource, /this\.pending\.set\(key, entry\)/);
  assert.match(protocolSource, /this\.hostRequests\.set\(key, entry\)/);
  assert.match(protocolSource, /this\.hostRequestResponses\.set\(entry\.wireKey, entry\)/);
  assert.match(protocolSource, /const key = pendingKey\(record, message\.id\)/);
  assert.match(protocolSource, /MAX_PENDING_HOST_REQUESTS = 1000/);
  assert.doesNotMatch(protocolSource, /hostRequestQueues|retired/);
  assert.match(protocolSource, /pendingRequestCount: 0/);
  assert.match(protocolSource, /record\.pendingRequestCount \+= 1/);
  assert.match(protocolSource, /entry\.record\.pendingRequestCount -= 1/);
  assert.doesNotMatch(protocolSource, /record\.pending\.(?:add|delete)\(/);
  assert.ok(protocol.has('handleRuntimeLine'));
  assert.ok(protocol.has('handleRuntimeRequest'));
  assert.ok(protocol.has('routeHostResponse'));
  assert.ok(protocol.has('forwardHostNotification'));
  assert.ok(protocol.has('warmRuntime'));
  const maxProtocolMethodLines = Math.max(...[...protocol.values()].map((method) =>
    sourceLineCount(resolve(modulesRoot, 'protocol.mjs'), method.value)));
  assert.ok(maxProtocolMethodLines < 90, `protocol method maximum is ${maxProtocolMethodLines} lines`);
  const maxSupervisorMethodLines = Math.max(...[...lifecycle.values()].map((method) =>
    sourceLineCount(resolve(modulesRoot, 'runtime-supervisor.mjs'), method.value)));
  assert.ok(maxSupervisorMethodLines < 90, `supervisor method maximum is ${maxSupervisorMethodLines} lines`);
  const maxTargetMethodLines = Math.max(...[...targets.values()].map((method) =>
    sourceLineCount(resolve(modulesRoot, 'runtime-target.mjs'), method.value)));
  assert.ok(maxTargetMethodLines < 90, `target method maximum is ${maxTargetMethodLines} lines`);

  assert.match(lifecycleSource, /this\.retiring = new Set\(\)/);
  assert.match(lifecycleSource, /this\.runtimes = new Set\(\)/);
  assert.match(lifecycleSource, /this\.crashCounts = new Map\(\)/);
  assert.doesNotMatch(lifecycleSource, /this\.(?:pending|hostRequests) = new (?:Map|Set)\(/);
  for (const name of ['scheduleRestart', 'ensureRuntime', 'performReload', 'publishCandidate', 'drainAndStop', 'close', 'status']) {
    assert.ok(lifecycle.has(name), `supervisor retains lifecycle phase ${name}`);
  }

  assert.ok(targets.has('resolveRuntimeTarget'));
  assert.ok(targets.has('materializeRuntime'));
  const resolveTargetBody = targetsSource.slice(targets.get('resolveRuntimeTarget').value.start, targets.get('resolveRuntimeTarget').value.end);
  const validationOrder = [
    '!isInside(this.pluginRoot, entry)',
    'fsp.lstat(entry)',
    'fsp.realpath(this.pluginRoot)',
    'fsp.realpath(entry)',
    'sha256File(realEntry)',
    'actual !== sha256',
    'this.materializeRuntime(realEntry, sha256)',
  ].map((marker) => resolveTargetBody.indexOf(marker));
  assert.ok(validationOrder.every((position) => position >= 0), 'runtime target retains all validation stages');
  assert.deepEqual(validationOrder, [...validationOrder].sort((left, right) => left - right), 'pointer validation order remains containment → lstat → realpath → digest → materialization');
  assert.doesNotMatch(targetsSource, /this\.[A-Za-z]+ = new (?:Map|Set)\(/);
  assert.ok(watcher.has('checkPointer'));
  assert.ok(watcher.has('startWatching'));
  assert.ok(watcher.has('stopWatching'));
  assert.doesNotMatch(watcherSource, /this\.[A-Za-z]+ = new (?:Map|Set)\(/);
});

test('shell module imports remain acyclic and protocol state is not re-created elsewhere', () => {
  const files = [shellEntry, ...moduleFiles(modulesRoot)];
  const known = new Set(files);
  const edges = new Map();
  for (const file of files) {
    const ast = parseModule(file);
    const imports = ast.body.filter((node) => node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration')
      .flatMap((node) => node.source ? [node.source.value] : []);
    edges.set(file, imports
      .filter((specifier) => specifier.startsWith('.'))
      .map((specifier) => resolve(dirname(file), specifier))
      .filter((target) => known.has(target)));
  }

  const visiting = new Set();
  const visited = new Set();
  function visit(file) {
    if (visiting.has(file)) assert.fail(`circular shell import includes ${file}`);
    if (visited.has(file)) return;
    visiting.add(file);
    for (const target of edges.get(file) ?? []) visit(target);
    visiting.delete(file);
    visited.add(file);
  }
  for (const file of files) visit(file);

  const protocolSource = readModule(resolve(modulesRoot, 'protocol.mjs'));
  const supervisorSource = readModule(resolve(modulesRoot, 'runtime-supervisor.mjs'));
  assert.equal((protocolSource.match(/this\.pending = new Map\(\)/g) ?? []).length, 1);
  assert.equal((protocolSource.match(/this\.hostRequests = new Map\(\)/g) ?? []).length, 1);
  assert.doesNotMatch(supervisorSource, /(?:pending|hostRequests) = new (?:Map|Set)\(/);
});
