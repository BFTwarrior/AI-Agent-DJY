import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyTaskWorktree, reclaimWorktrees, worktreeIsDirty } from '../src/git/worktree-reclaim.mjs';

const HOUR = 60 * 60 * 1000;

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Backdate a directory's mtime without shelling out (portable across CI). */
function backdate(path, ms) {
  const when = new Date(Date.now() - ms);
  utimesSync(path, when, when);
}

/** Minimal store double: only the methods the reclaimer calls. */
function fakeStore(tasksByTeam) {
  const tasks = tasksByTeam.flatMap(([teamId, rows]) => rows.map((row) => ({ teamId, ...row })));
  const teams = tasksByTeam.map(([id, , archived = false]) => ({ id, phase: archived ? 'archived' : 'running' }));
  const events = [];
  const updates = [];
  const store = {
    events,
    updates,
    tasks,
    listTeams: (includeArchived = false) => teams.filter((team) => includeArchived || team.phase !== 'archived'),
    listTasks: (teamId) => tasks.filter((task) => task.teamId === teamId).map((task) => ({ ...task })),
    getTask: (id) => {
      const task = tasks.find((row) => row.id === id);
      return task ? { ...task } : undefined;
    },
    updateTask: (id, patch) => {
      updates.push({ id, patch });
      const task = tasks.find((row) => row.id === id);
      if (task) Object.assign(task, patch);
    },
    beforeTransaction: undefined,
    transaction: (fn) => {
      store.beforeTransaction?.();
      store.beforeTransaction = undefined;
      return fn();
    },
    addEvent: (teamId, type, payload) => events.push({ teamId, type, payload }),
  };
  return store;
}

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'reclaim-test-'));
  const repo = join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  git(repo, 'config', 'user.name', 'Test');
  writeFileSync(join(repo, 'a.txt'), 'base\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  return { root, repo };
}

test('classifyTaskWorktree keeps live attempts and young terminal tasks', () => {
  const now = Date.now();
  assert.equal(classifyTaskWorktree({ status: 'in_progress', attemptId: 'a1', worktree: '/x' }, now).reason, 'attempt_open');
  assert.equal(classifyTaskWorktree({ status: 'completed', mergeState: 'merged', mergedAt: now - HOUR, worktree: '/x' }, now).reason, 'within_ttl');
  const old = classifyTaskWorktree({ status: 'completed', mergeState: 'merged', mergedAt: now - 30 * HOUR, worktree: '/x' }, now);
  assert.deepEqual(old, { reclaimable: true, reason: 'merged' });
});

test('classifyTaskWorktree keeps a completed task whose merge is pending forever', () => {
  const now = Date.now();
  // `completed + pending` is the steady state of a finished task sitting in the
  // merge queue. TTL expiry must not delete it: the checkout is the only copy of
  // an artifact that has not been published yet. This deliberately contrasts
  // with cancelled/failed rows, whose pending marker is a leftover from
  // dispatch and whose work is abandoned.
  const queued = classifyTaskWorktree({
    status: 'completed', mergeState: 'pending', completedAt: now - 100 * HOUR,
    sourceCommit: 'abc', worktree: '/x',
  }, now);
  assert.deepEqual(queued, { reclaimable: false, reason: 'still_needed' });
  const queuedNoCommit = classifyTaskWorktree({
    status: 'completed', mergeState: 'pending', completedAt: now - 100 * HOUR, worktree: '/x',
  }, now);
  assert.equal(queuedNoCommit.reclaimable, false, 'a pending merge pins even without a source commit');

  // The contrasting control: the same shape on a terminal-abandoned row is
  // reclaimable once the TTL expires, so the two rules cannot be swapped.
  assert.equal(classifyTaskWorktree({
    status: 'cancelled', mergeState: 'pending', cancelledAt: now - 100 * HOUR, worktree: '/x',
  }, now).reclaimable, true, 'expired cancelled pending is abandoned, not queued');
  assert.equal(classifyTaskWorktree({
    status: 'failed', mergeState: 'pending', failedAt: now - 100 * HOUR, worktree: '/x',
  }, now).reclaimable, true, 'expired failed pending is abandoned, not queued');
  assert.equal(classifyTaskWorktree({
    status: 'completed', mergeState: 'pending', completedAt: now - HOUR, worktree: '/x',
  }, now).reason, 'still_needed', 'a young completed pending row is pinned for the same reason, not TTL');
});

test('classifyTaskWorktree keeps a task waiting on a merge', () => {
  const now = Date.now();
  const verdict = classifyTaskWorktree({
    status: 'completed', mergeState: 'review_pending', sourceCommit: 'abc', worktree: '/x',
  }, now);
  assert.equal(verdict.reclaimable, false);
  assert.equal(classifyTaskWorktree({
    status: 'cancelled', mergeState: 'pending', cancelledAt: now - 48 * HOUR, worktree: '/x',
  }, now).reclaimable, true, 'expired cancelled pending merges become reclaimable');
  assert.equal(classifyTaskWorktree({
    status: 'failed', mergeState: 'pending', failedAt: now - HOUR, worktree: '/x',
  }, now).reason, 'within_ttl', 'young failed pending merges stay retained');
});

test('classifyTaskWorktree honours cleanupPending as a pin', () => {
  const now = Date.now();
  const verdict = classifyTaskWorktree({
    status: 'cancelled', cancelledAt: now - 48 * HOUR, cleanupPending: true, worktree: '/x',
  }, now);
  assert.equal(verdict.reclaimable, false);
  assert.equal(verdict.reason, 'cleanup_pending');
});

test('worktreeIsDirty is false for a clean checkout and true after an edit', async () => {
  const { root, repo } = makeRepo();
  const path = join(root, 'wt-clean');
  git(repo, 'worktree', 'add', '-q', '--detach', path, 'HEAD');
  assert.equal(await worktreeIsDirty(path), false);
  writeFileSync(join(path, 'a.txt'), 'changed\n');
  assert.equal(await worktreeIsDirty(path), true);
  rmSync(root, { recursive: true, force: true });
});

test('reclaimWorktrees removes a clean merged worktree and clears the task field', async () => {
  const { root, repo } = makeRepo();
  const cwd = join(root, 'ws');
  const path = join(cwd, '.agent-teams-worktrees', 'alpha', 'T1-1');
  mkdirSync(join(cwd, '.agent-teams-worktrees', 'alpha'), { recursive: true });
  git(repo, 'worktree', 'add', '-q', '--detach', path, 'HEAD');
  const store = fakeStore([['alpha', [{
    id: 'T1', status: 'completed', mergeState: 'merged', mergedAt: Date.now() - 48 * HOUR, worktree: path,
  }]]]);
  const report = await reclaimWorktrees({ repo, cwd, store });
  assert.equal(report.removed.length, 1);
  assert.equal(existsSync(path), false);
  assert.equal(store.updates.some((entry) => entry.id === 'T1' && entry.patch.worktree === undefined), true);
  assert.equal(store.events.some((event) => event.type === 'task.worktree_reclaimed'), true);
  rmSync(root, { recursive: true, force: true });
});

test('reclaimWorktrees keeps a dirty worktree and records why', async () => {
  const { root, repo } = makeRepo();
  const cwd = join(root, 'ws');
  const path = join(cwd, '.agent-teams-worktrees', 'alpha', 'T2-1');
  mkdirSync(join(cwd, '.agent-teams-worktrees', 'alpha'), { recursive: true });
  git(repo, 'worktree', 'add', '-q', '--detach', path, 'HEAD');
  writeFileSync(join(path, 'a.txt'), 'uncommitted work\n');
  const store = fakeStore([['alpha', [{
    id: 'T2', status: 'cancelled', cancelledAt: Date.now() - 48 * HOUR, worktree: path,
  }]]]);
  const report = await reclaimWorktrees({ repo, cwd, store });
  assert.equal(report.removed.length, 0);
  assert.equal(report.skipped.some((entry) => entry.reason === 'dirty'), true);
  assert.equal(report.active, 1, 'dirty surviving worktrees count as active');
  assert.equal(report.remaining, 1, 'remaining counts task-referenced directories on disk');
  assert.equal(existsSync(path), true, 'a dirty checkout must survive');
  assert.equal(store.events.some((event) => event.type === 'task.worktree_reclaim_skipped'), true);
  rmSync(root, { recursive: true, force: true });
});

test('reclaimWorktrees keeps worktrees owned by a live attempt', async () => {
  const { root, repo } = makeRepo();
  const cwd = join(root, 'ws');
  const path = join(cwd, '.agent-teams-worktrees', 'alpha', 'T3-1');
  mkdirSync(join(cwd, '.agent-teams-worktrees', 'alpha'), { recursive: true });
  git(repo, 'worktree', 'add', '-q', '--detach', path, 'HEAD');
  const store = fakeStore([['alpha', [{
    id: 'T3', status: 'in_progress', attemptId: 'a1', worktree: path,
  }]]]);
  const report = await reclaimWorktrees({ repo, cwd, store });
  assert.equal(report.removed.length, 0);
  assert.equal(report.active, 1);
  assert.equal(existsSync(path), true);
  rmSync(root, { recursive: true, force: true });
});

test('orphan sweep retains a registered worktree referenced by an archived team task', async () => {
  const { root, repo } = makeRepo();
  try {
    const cwd = join(root, 'ws');
    const teamDir = join(cwd, '.agent-teams-worktrees', 'archived');
    mkdirSync(teamDir, { recursive: true });
    const retainedBlocked = join(teamDir, 'BLOCKED');
    const retainedDiagnostic = join(teamDir, 'CONFLICT');
    for (const path of [retainedBlocked, retainedDiagnostic]) {
      git(repo, 'worktree', 'add', '-q', '--detach', path, 'HEAD');
      backdate(path, 48 * HOUR);
    }
    const store = fakeStore([['archived', [
      { id: 'blocked', status: 'failed', mergeState: 'blocked', worktree: retainedBlocked },
      { id: 'conflict', status: 'cancelled', mergeState: 'conflict', reviewWorktree: retainedDiagnostic },
    ], true]]);
    store.persistent = true;

    const report = await reclaimWorktrees({ repo, cwd, store, allowOrphanSweep: true, maxActive: 1 });

    assert.equal(report.removed.length, 0);
    assert.equal(existsSync(retainedBlocked), true, 'archived blocked task keeps its registered checkout');
    assert.equal(existsSync(retainedDiagnostic), true, 'archived diagnostic task keeps its registered checkout');
    assert.equal(report.active, 2);
    assert.equal(report.remaining, 2);
    assert.equal(report.overCapacity, true);
    assert.equal(report.pinned, 2);
    assert.equal(report.protected, 2);
    assert.equal(report.byTeam.archived.remaining, 2);
    assert.equal(report.byTeam.archived.active, 2);
    assert.equal(report.byTeam.archived.pinned, 2);
    assert.equal(report.byTeam.archived.pinnedOverGlobalCeiling, 1,
      'the per-team field measures the same global ceiling, not a team quota');
    assert.equal(report.pinnedOverCapacity, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reclaimWorktrees sweeps an unreferenced old directory but respects the TTL', async () => {
  const { root, repo } = makeRepo();
  const cwd = join(root, 'ws');
  const teamDir = join(cwd, '.agent-teams-worktrees', 'alpha');
  mkdirSync(teamDir, { recursive: true });
  const orphan = join(teamDir, 'OLD-1');
  git(repo, 'worktree', 'add', '-q', '--detach', orphan, 'HEAD');
  const store = fakeStore([['alpha', []]]);
  store.persistent = true; // a durable store may opt into orphan sweeping
  const fresh = await reclaimWorktrees({ repo, cwd, store, allowOrphanSweep: true });
  assert.equal(fresh.removed.length, 0, 'a young orphan stays for the TTL');
  // Backdate the directory so it looks older than the TTL.
  backdate(orphan, 48 * HOUR);
  const report = await reclaimWorktrees({ repo, cwd, store, allowOrphanSweep: true });
  assert.equal(report.removed.length, 1);
  assert.equal(existsSync(orphan), false);
  rmSync(root, { recursive: true, force: true });
});

test('reclaimWorktrees is a no-op without a repo, cwd or store', async () => {
  const report = await reclaimWorktrees({});
  assert.deepEqual(report.removed, []);
  assert.equal(report.active, 0);
});

test('classifyTaskWorktree reclaims completed review work that never produced a commit', () => {
  const now = Date.now();
  // A review task has no `sourceCommit`; without the kind allow-list its
  // checkout was pinned forever, which is how review directories accumulated.
  for (const kind of ['review', 'verification', 'requirements', 'red-auto-review']) {
    const verdict = classifyTaskWorktree({
      kind, status: 'completed', completedAt: now - 48 * HOUR, mergeState: 'not_applicable', worktree: '/x',
    }, now);
    assert.equal(verdict.reclaimable, true, `${kind} should be reclaimable`);
    assert.equal(verdict.reason, `${kind}_completed`);
  }
  // A completed implementation task with no commit is still pinned: the work
  // may exist only in the checkout.
  const uncommitted = classifyTaskWorktree({
    kind: 'implementation', status: 'completed', completedAt: now - 48 * HOUR, worktree: '/x',
  }, now);
  assert.deepEqual(uncommitted, { reclaimable: false, reason: 'still_needed' });
});

test('reclaimWorktrees expires clean cancelled pending tasks but keeps young and dirty checkouts', async () => {
  const { root, repo } = makeRepo();
  try {
    const cwd = join(root, 'ws');
    const teamDir = join(cwd, '.agent-teams-worktrees', 'alpha');
    mkdirSync(teamDir, { recursive: true });
    const paths = Object.fromEntries(['EXPIRED', 'YOUNG', 'DIRTY'].map((name) => [name, join(teamDir, name)]));
    for (const path of Object.values(paths)) git(repo, 'worktree', 'add', '-q', '--detach', path, 'HEAD');
    backdate(paths.EXPIRED, 48 * HOUR);
    backdate(paths.DIRTY, 48 * HOUR);
    writeFileSync(join(paths.DIRTY, 'a.txt'), 'local changes\n');
    const now = Date.now();
    const store = fakeStore([['alpha', [
      { id: 'expired', status: 'cancelled', mergeState: 'pending', cancelledAt: now - 48 * HOUR, worktree: paths.EXPIRED },
      { id: 'young', status: 'failed', mergeState: 'pending', failedAt: now - HOUR, worktree: paths.YOUNG },
      { id: 'dirty', status: 'cancelled', mergeState: 'pending', cancelledAt: now - 48 * HOUR, worktree: paths.DIRTY },
    ]]]);

    const report = await reclaimWorktrees({ repo, cwd, store, now });

    assert.deepEqual(report.removed, [paths.EXPIRED]);
    assert.equal(existsSync(paths.EXPIRED), false);
    assert.equal(existsSync(paths.YOUNG), true);
    assert.equal(existsSync(paths.DIRTY), true);
    assert.equal(report.remaining, 2);
    assert.equal(report.active, 2);
    assert.equal(report.pinnedOverCapacity, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('classifyTaskWorktree keeps every diagnostic merge failure regardless of age', () => {
  const now = Date.now();
  for (const mergeState of [
    'blocked', 'conflict', 'rejected', 'review_pending_internal', 'review_stale', 'ff_exhausted', 'revert_failed', 'publication_unknown',
  ]) {
    const verdict = classifyTaskWorktree({
      status: 'completed', mergeState, sourceCommit: 'abc',
      completedAt: now - 100 * HOUR, worktree: '/x',
    }, now);
    assert.equal(verdict.reclaimable, false, `${mergeState} must remain diagnosable`);
  }
  const cancelledBlocked = classifyTaskWorktree({
    status: 'cancelled', mergeState: 'blocked', cancelledAt: now - 100 * HOUR, worktree: '/x',
  }, now);
  assert.deepEqual(cancelledBlocked, { reclaimable: false, reason: 'merge_blocked' });
});

test('unknown merge states fail closed', () => {
  const now = Date.now();
  assert.deepEqual(classifyTaskWorktree({
    status: 'cancelled', mergeState: 'future_state', cancelledAt: now - 100 * HOUR, worktree: '/x',
  }, now), { reclaimable: false, reason: 'still_needed' });
});

test('capacity pressure never deletes pinned or not-yet-delivered work', async () => {
  const { root, repo } = makeRepo();
  const cwd = join(root, 'ws');
  const teamDir = join(cwd, '.agent-teams-worktrees', 'alpha');
  mkdirSync(teamDir, { recursive: true });
  const paths = {};
  for (const name of ['BLOCKED', 'REVIEW-PENDING', 'NO-COMMIT', 'MERGED']) {
    paths[name] = join(teamDir, name);
    git(repo, 'worktree', 'add', '-q', '--detach', paths[name], 'HEAD');
    backdate(paths[name], 100 * HOUR);
  }
  const now = Date.now();
  const store = fakeStore([['alpha', [
    { id: 'blocked', status: 'completed', mergeState: 'blocked', sourceCommit: 'abc', completedAt: now - 100 * HOUR, worktree: paths.BLOCKED },
    { id: 'review-pending', status: 'completed', mergeState: 'review_pending', sourceCommit: 'abc', completedAt: now - 100 * HOUR, worktree: paths['REVIEW-PENDING'] },
    { id: 'no-commit', status: 'completed', kind: 'implementation', completedAt: now - 100 * HOUR, worktree: paths['NO-COMMIT'] },
    { id: 'merged', status: 'completed', mergeState: 'merged', mergedAt: now - 100 * HOUR, worktree: paths.MERGED },
  ]]]);
  const report = await reclaimWorktrees({ repo, cwd, store, now, maxActive: 1 });
  assert.equal(report.overCapacity, true);
  assert.equal(report.removed.length, 1);
  assert.equal(existsSync(paths.MERGED), false);
  for (const name of ['BLOCKED', 'REVIEW-PENDING', 'NO-COMMIT']) {
    assert.equal(existsSync(paths[name]), true, `${name} must survive capacity pressure`);
  }
  assert.equal(report.active, 3, 'only surviving protected directories count as active');
  assert.equal(report.remaining, 3, 'remaining counts the three surviving on-disk references');
  assert.equal(report.pinnedOverCapacity, 2, 'only protected directories contribute to pinned overflow');
  rmSync(root, { recursive: true, force: true });
});

test('phantom task rows do not create capacity pressure or delete a young checkout', async () => {
  const { root, repo } = makeRepo();
  const cwd = join(root, 'ws');
  const teamDir = join(cwd, '.agent-teams-worktrees', 'alpha');
  mkdirSync(teamDir, { recursive: true });
  const young = join(teamDir, 'YOUNG');
  git(repo, 'worktree', 'add', '-q', '--detach', young, 'HEAD');
  const now = Date.now();
  const phantom = join(teamDir, 'MISSING');
  const store = fakeStore([['alpha', [
    { id: 'young', status: 'cancelled', cancelledAt: now - HOUR, worktree: young },
    ...Array.from({ length: 6 }, (_, index) => ({
      id: `phantom-${index}`, status: 'completed', mergeState: 'merged', mergedAt: now - 100 * HOUR, worktree: `${phantom}-${index}`,
    })),
  ]]]);
  const report = await reclaimWorktrees({ repo, cwd, store, now, maxActive: 6 });
  assert.equal(report.overCapacity, false);
  assert.equal(report.removed.length, 0);
  assert.equal(existsSync(young), true);
  rmSync(root, { recursive: true, force: true });
});

test('reclaim preserves a new task path and records a stale decision after deletion', async () => {
  const { root, repo } = makeRepo();
  try {
    const cwd = join(root, 'ws');
    const teamDir = join(cwd, '.agent-teams-worktrees', 'alpha');
    mkdirSync(teamDir, { recursive: true });
    const oldPath = join(teamDir, 'RACE-OLD');
    const newPath = join(teamDir, 'RACE-NEW');
    git(repo, 'worktree', 'add', '-q', '--detach', oldPath, 'HEAD');
    git(repo, 'worktree', 'add', '-q', '--detach', newPath, 'HEAD');
    backdate(oldPath, 48 * HOUR);
    backdate(newPath, 48 * HOUR);
    const store = fakeStore([['alpha', [{
      id: 'race', status: 'cancelled', cancelledAt: Date.now() - 48 * HOUR,
      attempt: 1, taskEpoch: 3, worktree: oldPath,
    }]]]);
    store.beforeTransaction = () => {
      store.updateTask('race', {
        status: 'pending', attempt: 2, taskEpoch: 4, attemptId: 'new-attempt',
        worktree: newPath, reviewWorktree: oldPath,
      });
    };

    const report = await reclaimWorktrees({ repo, cwd, store });

    assert.equal(existsSync(oldPath), false);
    assert.equal(existsSync(newPath), true, 'newly dispatched checkout must survive');
    assert.equal(store.getTask('race').worktree, newPath, 'new path must not be overwritten');
    assert.equal(store.getTask('race').reviewWorktree, undefined, 'only the deleted old path reference is cleared');
    assert.ok(report.errors.some((error) => error.stage === 'stale_decision'));
    assert.equal(report.remaining, 1);
    assert.equal(report.active, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reclaim matches a task path and its symlinked alias as one reference', async () => {
  // `collectReferences` groups by realpath. If the post-removal compare used a
  // raw path on one side it would look like a different reference, report a
  // stale decision, and leave the old pointer behind on the freed directory.
  const { root, repo } = makeRepo();
  try {
    const cwd = join(root, 'ws');
    const teamDir = join(cwd, '.agent-teams-worktrees', 'alpha');
    mkdirSync(teamDir, { recursive: true });
    const path = join(teamDir, 'ALIASED');
    const alias = join(root, 'alias-to-checkout');
    git(repo, 'worktree', 'add', '-q', '--detach', path, 'HEAD');
    backdate(path, 48 * HOUR);
    try {
      symlinkSync(path, alias, 'junction');
    } catch {
      return; // symlink creation needs a privilege this runner may not have
    }
    const store = fakeStore([['alpha', [{
      id: 'aliased', status: 'completed', kind: 'review', mergeState: 'not_applicable',
      completedAt: Date.now() - 48 * HOUR, worktree: path, reviewWorktree: alias,
    }]]]);

    const report = await reclaimWorktrees({ repo, cwd, store });

    assert.equal(report.removed.length, 1);
    assert.equal(existsSync(path), false, 'the real path is removed exactly once');
    assert.equal(store.getTask('aliased').worktree, undefined);
    assert.equal(store.getTask('aliased').reviewWorktree, undefined,
      'the aliased pointer names the same directory and is cleared with it');
    assert.equal(report.errors.some((error) => error.stage === 'stale_decision'), false,
      'one directory is one reference, not a stale decision');
    assert.equal(store.events.filter((event) => event.type === 'task.worktree_reclaimed').length, 1,
      'a single reclaim event covers both fields of the same task');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reclaim report survives store update and event failures after filesystem deletion', async () => {
  const { root, repo } = makeRepo();
  const cwd = join(root, 'ws');
  const teamDir = join(cwd, '.agent-teams-worktrees', 'alpha');
  mkdirSync(teamDir, { recursive: true });
  const path = join(teamDir, 'STORE-FAIL');
  git(repo, 'worktree', 'add', '-q', '--detach', path, 'HEAD');
  const store = fakeStore([['alpha', [{
    id: 'store-fail', status: 'completed', kind: 'review', mergeState: 'not_applicable',
    completedAt: Date.now() - 48 * HOUR, worktree: path,
  }]]]);
  store.updateTask = () => { throw new Error('publication held'); };
  store.addEvent = () => { throw new Error('event store unavailable'); };
  const report = await reclaimWorktrees({ repo, cwd, store });
  assert.equal(existsSync(path), false);
  assert.equal(report.removed.length, 1);
  assert.ok(report.errors.some((error) => error.stage === 'store_update'));
  assert.doesNotThrow(() => report.errors.map((error) => error.error));
  rmSync(root, { recursive: true, force: true });
});

test('byTeam distinguishes directories from tasks for shared worktrees', async () => {
  const { root, repo } = makeRepo();
  const cwd = join(root, 'ws');
  const teamDir = join(cwd, '.agent-teams-worktrees', 'alpha');
  mkdirSync(teamDir, { recursive: true });
  const path = join(teamDir, 'SHARED');
  git(repo, 'worktree', 'add', '-q', '--detach', path, 'HEAD');
  const store = fakeStore([['alpha', [
    { id: 'shared-1', status: 'completed', kind: 'review', mergeState: 'not_applicable', completedAt: Date.now() - 48 * HOUR, worktree: path },
    { id: 'shared-2', status: 'completed', kind: 'review', mergeState: 'not_applicable', completedAt: Date.now() - 48 * HOUR, worktree: path },
  ]]]);
  const report = await reclaimWorktrees({ repo, cwd, store });
  assert.equal(report.removed.length, 1);
  assert.equal(report.byTeam.alpha.removedDirs, 1);
  assert.equal(report.byTeam.alpha.removedTasks, 2);
  rmSync(root, { recursive: true, force: true });
});

test('every byTeam bucket carries the full numeric contract including pinnedOverGlobalCeiling', async () => {
  const { root, repo } = makeRepo();
  const cwd = join(root, 'ws');
  const teamDir = join(cwd, '.agent-teams-worktrees', 'alpha');
  mkdirSync(teamDir, { recursive: true });
  const young = join(teamDir, 'YOUNG');
  git(repo, 'worktree', 'add', '-q', '--detach', young, 'HEAD');
  const store = fakeStore([['alpha', [{
    id: 'young', status: 'in_progress', attemptId: 'a1', worktree: young,
  }]]]);
  const report = await reclaimWorktrees({ repo, cwd, store });
  const keys = [
    'removedDirs', 'removedTasks', 'skippedDirs', 'skippedTasks', 'errors',
    'pinned', 'protected', 'active', 'remaining', 'pinnedOverGlobalCeiling',
  ];
  for (const key of keys) {
    assert.equal(typeof report.byTeam.alpha[key], 'number', `byTeam.alpha.${key} must be a number`);
  }
  assert.equal(report.byTeam.alpha.pinnedOverGlobalCeiling, 0,
    'a team under the global ceiling reports 0 rather than omitting the field');
  assert.equal(Object.hasOwn(report.byTeam.alpha, 'pinnedOverCapacity'), false,
    'the misleading per-team alias is gone');
  rmSync(root, { recursive: true, force: true });
});

test('a durable store without allowOrphanSweep never sweeps unreferenced directories', async () => {
  const { root, repo } = makeRepo();
  const cwd = join(root, 'ws');
  const teamDir = join(cwd, '.agent-teams-worktrees', 'alpha');
  mkdirSync(teamDir, { recursive: true });
  const orphan = join(teamDir, 'OLD-2');
  git(repo, 'worktree', 'add', '-q', '--detach', orphan, 'HEAD');
  backdate(orphan, 48 * HOUR);
  const store = fakeStore([['alpha', []]]);
  store.persistent = true; // durable, but the caller did not opt in
  const report = await reclaimWorktrees({ repo, cwd, store });
  assert.equal(report.removed.length, 0);
  assert.equal(existsSync(orphan), true);
  rmSync(root, { recursive: true, force: true });
});

test('a directory git does not register is reported, never deleted', async () => {
  // A half-finished `git worktree add`, a rescued copy, or a stray folder:
  // `git status` inside resolves to the parent repo, so the dirty check says
  // nothing about it. It must be reported instead of removed.
  const { root, repo } = makeRepo();
  const cwd = join(root, 'ws');
  const teamDir = join(cwd, '.agent-teams-worktrees', 'alpha');
  const stray = join(teamDir, 'STRAY-1');
  mkdirSync(stray, { recursive: true });
  writeFileSync(join(stray, 'notes.txt'), 'someone put this here\n');
  backdate(stray, 48 * HOUR);
  const store = fakeStore([['alpha', []]]);
  store.persistent = true;
  const report = await reclaimWorktrees({ repo, cwd, store, allowOrphanSweep: true });
  assert.equal(report.removed.length, 0);
  assert.equal(report.skipped.some((entry) => entry.reason === 'unregistered'), true);
  assert.equal(existsSync(join(stray, 'notes.txt')), true);
  rmSync(root, { recursive: true, force: true });
});

test('an in-memory store cannot trigger an orphan sweep of the real workspace', async () => {
  // Regression for a P0: a test harness builds a service with
  // `new Store(':memory:')` and `cwd: process.cwd()`. With an empty task list
  // an unscoped orphan sweep treated every real checkout as garbage and deleted
  // the operator's worktrees during `npm test`.
  const { root, repo } = makeRepo();
  const cwd = join(root, 'ws');
  const teamDir = join(cwd, '.agent-teams-worktrees', 'alpha');
  mkdirSync(teamDir, { recursive: true });
  const real = join(teamDir, 'REAL-1');
  git(repo, 'worktree', 'add', '-q', '--detach', real, 'HEAD');
  backdate(real, 48 * HOUR);

  const store = fakeStore([['alpha', []]]);
  store.persistent = false; // stands in for `new Store(':memory:')`

  // Even an explicit opt-in is refused while the store is not durable.
  const refused = await reclaimWorktrees({ repo, cwd, store, allowOrphanSweep: true });
  assert.equal(refused.removed.length, 0);
  assert.equal(refused.orphanSweepBlocked, 'in_memory_store');
  assert.equal(existsSync(real), true, 'a real checkout must survive a test harness');

  // Without an explicit opt-in the sweep never runs at all.
  const notOptedIn = await reclaimWorktrees({ repo, cwd, store });
  assert.equal(notOptedIn.removed.length, 0);
  assert.equal(existsSync(real), true);

  // A durable store that opts in does reclaim the same directory.
  store.persistent = true;
  const swept = await reclaimWorktrees({ repo, cwd, store, allowOrphanSweep: true });
  assert.equal(swept.removed.length, 1);
  assert.equal(existsSync(real), false);
  rmSync(root, { recursive: true, force: true });
});
