import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { parse } from 'acorn';
import * as scheduler from '../src/domain/scheduler.mjs';
import * as validation from '../src/domain/task-graph-validation.mjs';
import * as policy from '../src/domain/task-graph-policy.mjs';

const schedulerUrl = new URL('../src/domain/scheduler.mjs', import.meta.url);
const validationUrl = new URL('../src/domain/task-graph-validation.mjs', import.meta.url);
const policyUrl = new URL('../src/domain/task-graph-policy.mjs', import.meta.url);
const parseModule = (url) => parse(readFileSync(url, 'utf8'), { ecmaVersion: 'latest', sourceType: 'module' });
const taskPolicyNames = ['TASK_KINDS', 'TASK_PRIORITIES', 'TASK_STATUSES', 'TERMINAL_STATUSES', 'RED_REVIEW_KIND'];

function declarationNames(node) {
  const declaration = node.declaration ?? node;
  if (declaration.type === 'FunctionDeclaration' || declaration.type === 'ClassDeclaration') {
    return declaration.id ? [declaration.id.name] : [];
  }
  if (declaration.type === 'VariableDeclaration') return declaration.declarations.map((item) => item.id.name);
  return [];
}

test('scheduler facade keeps validateTaskGraph as the direct implementation binding', () => {
  assert.strictEqual(scheduler.validateTaskGraph, validation.validateTaskGraph);
  const validatorReexports = parseModule(schedulerUrl).body.filter((node) => (
    node.type === 'ExportNamedDeclaration' && node.source?.value === './task-graph-validation.mjs'
  ));
  assert.equal(validatorReexports.length, 1);
  assert.deepEqual(validatorReexports[0].specifiers.map((item) => [item.local.name, item.exported.name]), [
    ['validateTaskGraph', 'validateTaskGraph'],
  ]);

  for (const name of taskPolicyNames) assert.strictEqual(scheduler[name], policy[name]);
  for (const name of ['TASK_KINDS', 'TASK_PRIORITIES', 'TASK_STATUSES']) {
    assert.strictEqual(policy[name], scheduler[name]);
    assert.equal(Object.isFrozen(scheduler[name]), false, `${name} must retain its mutable shared array`);
  }
});

test('task graph validation has one policy owner, remains pure, and has an acyclic import graph', () => {
  const owners = new Map();
  const domainFiles = readdirSync(new URL('../src/domain/', import.meta.url))
    .filter((name) => name.endsWith('.mjs'))
    .map((name) => new URL(`../src/domain/${name}`, import.meta.url));
  for (const url of domainFiles) {
    for (const node of parseModule(url).body) {
      for (const name of declarationNames(node)) {
        if (!taskPolicyNames.includes(name)) continue;
        assert.equal(owners.has(name), false, `duplicate owner for ${name}`);
        owners.set(name, url.href);
      }
    }
  }
  for (const name of taskPolicyNames) assert.equal(owners.get(name), policyUrl.href, `${name} owner`);

  const visited = new Set();
  function visit(url, stack = []) {
    assert.ok(!stack.includes(url.href), `import cycle: ${[...stack, url.href].join(' -> ')}`);
    if (visited.has(url.href)) return;
    for (const node of parseModule(url).body) {
      if (!['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) || !node.source) continue;
      const source = node.source.value;
      assert.ok(source.startsWith('.'), `validation dependency must be local and pure: ${source}`);
      const dependency = new URL(source, url);
      assert.notEqual(dependency.href, schedulerUrl.href, `${url.pathname} cannot import the facade`);
      if (url.href === validationUrl.href) assert.equal(dependency.href, policyUrl.href);
      if (url.href === policyUrl.href) assert.fail('policy constants must not import dependencies');
      visit(dependency, [...stack, url.href]);
    }
    visited.add(url.href);
  }
  visit(validationUrl);
  assert.ok(visited.has(validationUrl.href));
  assert.ok(visited.has(policyUrl.href));
});

test('task graph validation preserves default arguments, error order, deduplication, and verify requirements', () => {
  assert.deepEqual(validation.validateTaskGraph(), ['tasks must be an array']);
  assert.deepEqual(validation.validateTaskGraph([{
    id: 'bad id', teamId: '', dependencies: 'not-an-array', status: 'invalid',
    assignee: 7, assigneeRole: ' ', kind: 'implementation', priority: 'urgent',
    objective: ' ', acceptance: [], inScope: [], verify: [],
  }]), [
    'tasks[0].id must be a safe id (letters, digits, dot, underscore, dash)',
    'bad id: teamId is required',
    'bad id: dependencies must be an array',
    'bad id: invalid status invalid',
    'bad id: assignee must be a string',
    'bad id: assigneeRole must be a non-empty string',
    'bad id: priority must be critical|high|normal|low',
    'bad id: objective is required for implementation',
    'bad id: acceptance is required for implementation',
    'bad id: inScope is required for implementation',
    'bad id: verify is required for implementation',
  ]);

  const root = { id: 'root', teamId: 'alpha', kind: 'work', dependencies: [] };
  const findingsRepair = {
    id: 'findings-repair', teamId: 'alpha', kind: 'repair', contractSource: 'findings',
    objective: 'repair', acceptance: ['fixed'], inScope: ['src/'], verify: [],
    sourceTaskId: 'root', dependencies: ['root'],
  };
  assert.deepEqual(validation.validateTaskGraph([root, findingsRepair]), [],
    'findings-only repairs retain their baseline empty-verify exception');
  assert.deepEqual(validation.validateTaskGraph([{
    id: 'legacy-completed-root', teamId: 'alpha', kind: 'implementation', status: 'completed', mode: 'legacy',
    objective: 'works', acceptance: ['works'], inScope: ['src/'], verify: [], dependencies: [],
  }]), [], 'completed legacy implementation roots retain their baseline empty-verify exception');
  assert.deepEqual(validation.validateTaskGraph([root, {
    ...findingsRepair, id: 'ordinary-repair', contractSource: 'manual',
  }]), ['ordinary-repair: verify is required for repair']);
  assert.deepEqual(validation.validateTaskGraph([{
    id: 'repeated-unknown-source', teamId: 'alpha', kind: 'work', dependencies: [],
    findingSourceTaskIds: ['missing', 'missing'],
  }]), ['repeated-unknown-source: unknown findingSourceTaskId missing']);
});
