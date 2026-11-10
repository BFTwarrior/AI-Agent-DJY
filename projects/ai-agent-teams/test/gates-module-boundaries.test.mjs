import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { parse } from 'acorn';
import * as gates from '../src/domain/gates.mjs';
import * as policy from '../src/domain/gates/policy.mjs';

const facadeUrl = new URL('../src/domain/gates.mjs', import.meta.url);
const directory = new URL('./gates/', facadeUrl);
const moduleUrls = readdirSync(directory).filter((name) => name.endsWith('.mjs'))
  .map((name) => new URL(name, directory));
const parseModule = (text) => parse(text, { ecmaVersion: 'latest', sourceType: 'module' });
const publicNames = [
  'QUALITY_KINDS', 'TERMINAL', 'TRANSITIONS', 'REVIEW_SCORE_MIN_OVERALL', 'REVIEW_SCORE_MIN_CODE',
  'openHighFindings', 'validateFindings', 'transitionError', 'acceptanceCovered', 'commandsCovered',
  'validateCompletion', 'findingPriority', 'deriveRepairObjective', 'findingsFingerprint',
  'closedLoopTaskId', 'closedLoopReviewTaskId', 'closedLoopRepairTaskId', 'closedLoopVerificationTaskId',
  'closedLoopKnownRepairTaskId', 'reviewScoresSatisfied', 'boundReviewScoresSatisfied',
  'parseBoundPostMergeReview', 'planCompletionReview', 'planCompletionFanOut', 'evidenceBackedCompletion',
  'planFailedReviewFollowUp', 'planFollowUp', 'deliveryAudit', 'normalizeWorkspacePath',
  'isDefaultExcludedPath', 'pathMatchesScope', 'classifyChangedPath', 'repairScopeReport', 'deriveRepairScope',
];

test('gate facade preserves all public names as identical direct bindings', async () => {
  assert.deepEqual(Object.keys(gates).sort(), publicNames.sort());
  for (const node of parseModule(readFileSync(facadeUrl, 'utf8')).body) {
    assert.equal(node.type, 'ExportNamedDeclaration');
    assert.ok(node.source, 'the facade must not wrap or duplicate implementations');
    const target = await import(new URL(node.source.value, facadeUrl));
    for (const specifier of node.specifiers) {
      assert.strictEqual(gates[specifier.exported.name], target[specifier.local.name]);
    }
  }
  for (const name of ['QUALITY_KINDS', 'TERMINAL', 'TRANSITIONS']) {
    assert.strictEqual(gates[name], policy[name]);
    assert.equal(Object.isFrozen(gates[name]), false, `${name} remains mutable, not cloned or frozen`);
  }
});

test('gate internals have one declaration owner, no facade back-edge, no import cycle or new I/O dependency', () => {
  const owners = new Map();
  for (const url of moduleUrls) {
    for (const statement of parseModule(readFileSync(url, 'utf8')).body) {
      const node = statement.declaration ?? statement;
      if (node.type === 'ImportDeclaration') continue;
      assert.ok(['VariableDeclaration', 'FunctionDeclaration'].includes(node.type), url.href);
      const names = node.id ? [node.id.name] : node.declarations.map((item) => item.id.name);
      for (const name of names) {
        assert.equal(owners.has(name), false, `duplicate rule ${name}`);
        owners.set(name, url.href);
      }
    }
  }
  const visited = new Set();
  function visit(url, stack = []) {
    assert.ok(!stack.includes(url.href), `cycle: ${[...stack, url.href].join(' -> ')}`);
    if (visited.has(url.href)) return;
    for (const node of parseModule(readFileSync(url, 'utf8')).body) {
      if (!node.source) continue;
      const source = node.source.value;
      if (!source.startsWith('.')) {
        // The unchanged changes.mjs also owns Git/filesystem helpers, but gates
        // import only its pure path operations. No new module may import I/O.
        const allowed = url.href === new URL('./changes.mjs', facadeUrl).href
          ? ['node:crypto', 'node:child_process', 'node:fs/promises', 'node:path', 'node:util']
          : url.href === new URL('./delivery-review.mjs', facadeUrl).href ? ['node:crypto'] : [];
        assert.ok(allowed.includes(source), `${url.href}: unexpected external dependency ${source}`);
        continue;
      }
      const dependency = new URL(source, url);
      if (dependency.href === new URL('./changes.mjs', facadeUrl).href) {
        const purePaths = ['normalizeWorkspacePath', 'isDefaultExcludedPath', 'classifyChangedPath', 'pathMatchesScope'];
        for (const specifier of node.specifiers) assert.ok(purePaths.includes(specifier.imported.name));
      }
      assert.notEqual(dependency.href, facadeUrl.href, 'internals cannot import the facade');
      assert.ok(dependency.href.startsWith(new URL('./', facadeUrl).href), 'domain boundary');
      visit(dependency, [...stack, url.href]);
    }
    visited.add(url.href);
  }
  moduleUrls.forEach((url) => visit(url));
  assert.ok(visited.size >= moduleUrls.length);
});

function fixture() {
  const finding = { id: 'F-1', severity: 'high', file: 'src/a.mjs', line: 1, problem: 'incorrect result', requiredFix: 'fix src/a.mjs' };
  const source = { id: 'impl', teamId: 'alpha', kind: 'implementation', status: 'completed',
    assignee: 'builder', assigneeId: 'builder-id', acceptance: ['works'], verify: ['npm test'],
    inScope: ['src/'], outOfScope: ['src/private/'], taskEpoch: 2, deliveryUnitId: 'impl', deliverySeq: 0,
    sourceCommit: 'commit', sourceBase: 'base', diffHash: 'digest', lastAttemptId: 'attempt-2' };
  const review = { id: 'review', teamId: 'alpha', kind: 'review', status: 'failed', verdict: 'needs_revision',
    reviewedTaskId: source.id, assignee: 'reviewer', assigneeId: 'reviewer-id', round: 1, findings: [finding] };
  return { finding, source, review };
}

function checkBoundaries(api) {
  const { finding, source, review } = fixture();
  const planned = api.planCompletionReview({ task: source, tasks: [source] });
  assert.equal(planned.task.deliveryGeneration, 2);
  const repaired = { ...source, id: 'repaired', kind: 'repair', sourceTaskId: source.id, taskEpoch: 0 };
  assert.equal(api.planCompletionReview({ task: repaired, tasks: [source, repaired] }).task.deliveryGeneration, 2);
  assert.strictEqual(planned.task.acceptance, source.acceptance);
  const bound = api.planCompletionReview({ task: { ...source, mode: 'bound' }, tasks: [source] }).task;
  assert.equal(bound.binding.sourceAttemptId, 'attempt-2');
  assert.deepEqual(bound.dependencies, ['impl']);
  assert.deepEqual(api.validateCompletion({ ...review, status: 'pending' }, {
    status: 'completed', findings: [null], verdict: 'pass',
  }, source), { ok: false, error: 'task status cannot move from "pending" to "completed"' });
  assert.equal(api.boundReviewScoresSatisfied({ overall: 4.5, code: 4.49 }), false);
  assert.equal(api.boundReviewScoresSatisfied({ overall: 4.5, code: 4.5 }), true);
  assert.equal(api.reviewScoresSatisfied({ overall: '4.5', code: '4.0' }), true);
  const repair = api.planFailedReviewFollowUp({ task: review, tasks: [source, review] });
  assert.equal(repair.action, 'repair');
  assert.deepEqual(repair.task.dependencies, [source.id]);
  assert.deepEqual(repair.task.findingSourceTaskIds, [review.id]);
  assert.deepEqual(repair.task.outOfScope, source.outOfScope);
  const manual = { id: 'manual', kind: 'repair', status: 'pending', sourceTaskId: source.id };
  const capped = api.planFailedReviewFollowUp({ task: review, tasks: [source, review, manual], policy: { codeMaxRounds: 1 } });
  assert.equal(capped.action, 'escalate');
  assert.match(capped.reason, /round ceiling/);
  const repeated = { ...manual, closedLoop: { origin: 'closed-loop' }, findingsFingerprint: api.findingsFingerprint([finding]) };
  assert.equal(api.planFailedReviewFollowUp({ task: review, tasks: [source, review, repeated] }).deduplicated, true);
  const missingSource = api.planFailedReviewFollowUp({ task: review, tasks: [review, { ...manual, findingSourceTaskIds: [review.id] }] });
  assert.match(missingSource.reason, /missing source/);
  const requirements = api.planFollowUp({ ...review, kind: 'requirements' });
  assert.equal(requirements.created[0].kind, 'requirements');
  assert.deepEqual(requirements.created[0].dependencies, []);
  const verification = { ...review, kind: 'verification', sourceTaskId: source.id };
  const follow = api.planFollowUp(verification, [source, verification]);
  assert.deepEqual(follow.created.map((task) => task.kind), ['repair', 'verification']);
  assert.deepEqual(follow.created[1].dependencies, [follow.created[0].id]);
  assert.deepEqual(follow.created[0].findingSourceTaskIds, [verification.id]);
  assert.strictEqual(follow.created[0].verify, source.verify);
}

test('semantic stage boundaries preserve precedence, generation, causality and references', () => {
  checkBoundaries(gates);
});

test('fan-out preserves row order and independent distinct assignments without mutating inputs', () => {
  const { source, finding } = fixture();
  const members = [
    { id: 'builder-id', name: 'builder', role: 'reviewer', license: { allowedTaskKinds: ['review'] } },
    { id: 'reviewer-id', name: 'reviewer', role: 'reviewer', license: { allowedTaskKinds: ['review', 'verification'] } },
    { id: 'analyst-id', name: 'analyst', role: 'analyst', license: { allowedTaskKinds: ['verification'] } },
    { id: 'engineer-id', name: 'engineer', role: 'engineer', license: { allowedTaskKinds: ['repair'] } },
  ];
  const input = { task: { ...source, findings: [finding], requiresVerification: true }, tasks: [source], members };
  const before = structuredClone(input);
  const result = gates.planCompletionFanOut(input);
  assert.deepEqual(input, before);
  assert.deepEqual(result.created.map((task) => task.kind), ['review', 'verification', 'repair']);
  assert.deepEqual(result.created.map((task) => task.assignee), ['reviewer', 'analyst', 'engineer']);
  for (const task of result.created) assert.deepEqual(task.dependencies, [source.id]);
});

test('audit phases preserve blocker and warning order, including stale attempts and independence', () => {
  const { source, review } = fixture();
  const result = gates.deliveryAudit({ phase: 'staged', control: 'halted', tasks: [
    { ...source, attempt: 2 },
    { ...review, status: 'completed', verdict: 'pass', findings: [], assignee: 'builder', assigneeId: 'builder-id', reviewedAttempt: 1 },
    { id: 'old', kind: 'work', status: 'failed', historical: true },
    { id: 'cancelled', kind: 'review', status: 'cancelled' },
  ], requiredReviewers: ['builder', 'absent'] });
  assert.deepEqual(result, { ok: false, blockers: [
    'team plan is awaiting approval', 'team control is halted',
    'impl has incomplete acceptanceResults', 'impl has incomplete commandsRun', 'impl has no changedPaths',
    'review reviewed impl attempt 1, but it is now attempt 2', 'impl review is not independent',
    'required reviewer builder is also the implementer of impl', 'required reviewer absent has no passing review for impl',
  ], warnings: ['old is historical and was excluded from delivery audit', 'cancelled was cancelled'] });
});

// Assemble an isolated in-memory module from AST declarations. No production
// file or shared imported constant is modified by the mutation probes.
function isolatedSource() {
  const imports = new Map();
  const declarations = [];
  for (const url of moduleUrls) {
    const source = readFileSync(url, 'utf8');
    for (const node of parseModule(source).body) {
      if (node.type !== 'ImportDeclaration') {
        declarations.push(source.slice(node.start, node.end));
      } else if (node.source.value.startsWith('../')) {
        const target = new URL(node.source.value, url).href;
        if (!imports.has(target)) imports.set(target, new Set());
        node.specifiers.forEach((specifier) => imports.get(target).add(specifier.local.name));
      }
    }
  }
  return [...imports].map(([url, names]) => `import { ${[...names].join(', ')} } from ${JSON.stringify(url)};`).join('\n')
    + '\n' + declarations.join('\n');
}

test('in-memory mutations are detected at generation, score and finding-causality boundaries', async () => {
  const source = isolatedSource();
  const load = (text) => import(`data:text/javascript;base64,${Buffer.from(text).toString('base64')}`);
  checkBoundaries(await load(source));
  for (const [before, after, expectedCount = 1] of [
    ['return unit.taskEpoch ?? 0', 'return 0'],
    ['scores.code >= 4.5', 'scores.code >= 4.0'],
    ['findingSourceTaskIds: [task.id]', 'findingSourceTaskIds: [sourceId]', 2],
  ]) {
    assert.equal(source.split(before).length - 1, expectedCount, before);
    let searchFrom = 0;
    for (let occurrence = 0; occurrence < expectedCount; occurrence += 1) {
      const start = source.indexOf(before, searchFrom);
      const mutant = source.slice(0, start) + after + source.slice(start + before.length);
      const isolated = await load(mutant);
      assert.throws(() => checkBoundaries(isolated), { name: 'AssertionError' }, `${before} occurrence ${occurrence + 1}`);
      searchFrom = start + before.length;
    }
  }
});
