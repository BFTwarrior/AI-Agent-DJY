import { testHomeRoot } from './support/cleanup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { ensureOwnedMemberHome, reclaimMemberHomes } from '../src/session/worker-home.mjs';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { TeamService } from '../src/scheduler-service.mjs';
import { FakeSessionAdapter } from '../src/session/adapter.mjs';

function service(homeRoot = testHomeRoot()) {
  const { config } = loadConfig('config/example.two-teams.json');
  const store = new Store(':memory:');
  return new TeamService({ homeRoot, store, adapter: new FakeSessionAdapter(), config, cwd: process.cwd(), now: () => 1000 });
}

test('archiving refuses to delete a member home outside the managed roots', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-agent-teams-purge-'));
  try {
    const victim = join(root, 'must-survive');
    mkdirSync(victim);
    writeFileSync(join(victim, 'keep.txt'), 'keep');
    const svc = service();
    svc.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
    svc.store.addMember({ teamId: 'alpha', name: 'evil', home: victim });
    await svc.archive('alpha');
    assert.equal(existsSync(join(victim, 'keep.txt')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('member input cannot inject a home or session id', () => {
  const svc = service();
  svc.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  const member = svc.addMember('alpha', {
    name: 'Engineer 02',
    role: 'engineer',
    home: 'C:/somewhere/else',
    sessionId: 'sess_injected',
    licenseId: 'lic_injected',
  });
  assert.equal(member.home, undefined);
  assert.equal(member.sessionId, undefined);
  assert.notEqual(member.licenseId, 'lic_injected');
});

test('dispatch uses injected homes and does not create the member in user HOME', async () => {
  const svc = service();
  try {
    svc.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running', members: [{ name: 'one' }] });
    const member = svc.store.findMember('alpha', 'one');
    const realHome = join(homedir(), '.ai-agent-teams', 'homes', 'alpha', member.id);
    assert.equal(existsSync(realHome), false);
    svc.addTask('alpha', { id: 'home-task', subject: 'dispatch', assignee: 'one', kind: 'work' });
    await svc.tick('alpha');
    const expected = join(svc.memberHomeRoot(), 'alpha', member.id);
    assert.equal(svc.store.getMember(member.id).home, expected);
    assert.equal(existsSync(join(expected, 'tmp')), true);
    assert.equal(existsSync(realHome), false);
    assert.ok(svc.adapter.calls.some((call) => call.kind === 'create' && call.input.home === expected));
  } finally { svc.close(); svc.store.close(); }
});

test('retired legacy home without stored path is purged and replacement home survives', async () => {
  const svc = service();
  try {
    svc.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running', members: [{ name: 'old' }] });
    const old = svc.store.findMember('alpha', 'old');
    const oldHome = join(svc.memberHomeRoot(), 'alpha', old.id);
    ensureOwnedMemberHome(oldHome, svc.cwd);
    await svc.removeMember('alpha', old.id);
    const replacement = svc.materializeMember('alpha', { name: 'new', role: 'engineer' });
    const newHome = join(svc.memberHomeRoot(), 'alpha', replacement.id);
    ensureOwnedMemberHome(newHome, svc.cwd);
    assert.equal(existsSync(oldHome), false);
    assert.equal(existsSync(newHome), true);
    assert.equal(svc.store.listEvents('alpha').some((e) => e.type === 'member.home_cleanup_refused'), false);
    await svc.archive('alpha');
    assert.equal(existsSync(newHome), false);
  } finally { svc.close(); svc.store.close(); }
});

test('materialization retries removed member home cleanup without touching the new identity', () => {
  const svc = service();
  try {
    svc.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
    const old = svc.store.addMember({ teamId: 'alpha', name: 'retired', status: 'removed' });
    const home = join(svc.memberHomeRoot(), 'alpha', old.id);
    ensureOwnedMemberHome(home, svc.cwd);
    const member = svc.materializeMember('alpha', { role: 'engineer' });
    assert.notEqual(member.id, old.id);
    assert.equal(existsSync(home), false);
  } finally { svc.store.close(); }
});

test('owned orphan sweep preserves live, archived, foreign and unmarked homes and audits failures', () => {
  const svc = service(join(testHomeRoot(), 'sweep'));
  try {
    svc.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running', members: [{ name: 'live' }] });
    const live = svc.store.findMember('alpha', 'live');
    const liveHome = join(svc.memberHomeRoot(), 'alpha', live.id);
    ensureOwnedMemberHome(liveHome, svc.cwd);
    const paths = Array.from({ length: 5 }, () => join(svc.memberHomeRoot(), 'alpha', `member_${randomUUID()}`));
    for (const path of paths.slice(0, 4)) ensureOwnedMemberHome(path, svc.cwd);
    ensureOwnedMemberHome(paths[4], join(svc.cwd, 'foreign'));
    const unmarked = join(svc.memberHomeRoot(), 'alpha', `member_${randomUUID()}`);
    mkdirSync(unmarked);
    svc.store.updateTeam('alpha', { phase: 'archived' });
    const events = [];
    const report = reclaimMemberHomes({ root: svc.memberHomeRoot(), workspace: svc.cwd,
      hasMember: (id) => Boolean(svc.store.getMember(id)), onEvent: (...args) => events.push(args),
      remove: (path, options) => {
        if (path === paths[1]) throw new Error('injected removal failure');
        rmSync(path, options);
      },
    });
    assert.deepEqual(report.removed.sort(), [paths[0], paths[2], paths[3]].sort());
    for (const path of [paths[0], paths[2], paths[3]]) assert.equal(existsSync(path), false);
    assert.equal(report.errors.length, 1);
    assert.ok(events.some((e) => e[1] === 'member.home_cleanup_failed'));
    for (const path of [liveHome, paths[1], paths[4], unmarked]) assert.equal(existsSync(path), true);
    assert.equal(resolve(svc.memberHomeRoot()), svc.memberHomeRoot());
  } finally { svc.store.close(); }
});

test('member home creation refuses linked ancestors without writing to the target', () => {
  const root = join(testHomeRoot(), 'linked-test');
  const outside = join(testHomeRoot(), 'outside');
  mkdirSync(root); mkdirSync(outside);
  const linked = join(root, 'alpha');
  symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => ensureOwnedMemberHome(join(linked, `member_${randomUUID()}`), process.cwd()), /link/);
  assert.equal(existsSync(join(outside, 'tmp')), false);
});

test('archiving retains a home when the adapter cannot confirm stop', async () => {
  const svc = service();
  try {
    svc.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running', members: [{ name: 'busy' }] });
    const member = svc.store.findMember('alpha', 'busy');
    const home = join(svc.memberHomeRoot(), 'alpha', member.id);
    ensureOwnedMemberHome(home, svc.cwd);
    svc.store.updateMember(member.id, { sessionId: 'still-writing', home });
    svc.adapter.stop = async () => ({ ok: false, warning: 'still running' });
    await svc.archive('alpha');
    assert.equal(existsSync(home), true);
    assert.ok(svc.store.listEvents('alpha').some((event) => event.type === 'member.home_cleanup_deferred'));
  } finally { svc.store.close(); }
});

test('home owner identity follows platform workspace path comparison', () => {
  const root = join(testHomeRoot(), 'workspace-case');
  const home = join(root, 'alpha', `member_${randomUUID()}`);
  const workspace = join(testHomeRoot(), 'MixedCaseWorkspace');
  ensureOwnedMemberHome(home, workspace);
  const changedCase = workspace.toUpperCase();
  if (process.platform === 'win32') {
    assert.doesNotThrow(() => ensureOwnedMemberHome(home, changedCase));
    const report = reclaimMemberHomes({ root, workspace: changedCase, hasMember: () => false, onEvent: () => {} });
    assert.deepEqual(report.removed, [home]);
    assert.equal(existsSync(home), false);
  } else {
    assert.throws(() => ensureOwnedMemberHome(home, changedCase), /another workspace/);
  }
});

test('removed member home stays pinned when session termination is unconfirmed', async () => {
  const svc = service();
  try {
    svc.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running', members: [{ name: 'busy' }] });
    const member = svc.store.findMember('alpha', 'busy');
    const home = join(svc.memberHomeRoot(), 'alpha', member.id);
    ensureOwnedMemberHome(home, svc.cwd);
    svc.store.updateMember(member.id, { sessionId: 'unconfirmed', home });
    svc.adapter.stop = async () => { throw new Error('stop failed'); };
    await svc.removeMember('alpha', member.id);
    svc.materializeMember('alpha', { role: 'engineer' });
    assert.equal(existsSync(home), true);
    assert.equal(svc.store.getMember(member.id).homeCleanupDeferred, 'stop failed');
  } finally { svc.store.close(); }
});

test('removeMember alone purges the owned home without any materialize or archive fallback', async () => {
  // The sibling tests above let `materializeMember` and `archive` clean up after
  // them, so deleting the `purgeMemberHome` call inside `removeMember` stayed
  // green across the whole suite. This case isolates that call site: nothing
  // else runs afterwards, so only `removeMember` can remove the directory.
  const svc = service();
  try {
    svc.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running', members: [{ name: 'solo' }] });
    const member = svc.store.findMember('alpha', 'solo');
    const home = join(svc.memberHomeRoot(), 'alpha', member.id);
    ensureOwnedMemberHome(home, svc.cwd);
    svc.store.updateMember(member.id, { home, sessionId: 'stoppable' });
    assert.equal(existsSync(home), true, 'the home must exist before removal');
    await svc.removeMember('alpha', member.id);
    assert.equal(existsSync(home), false, 'removeMember must purge the home on its own');
    assert.equal(svc.store.listEvents('alpha').some((event) => event.type === 'member.home_cleanup_refused'), false);
    assert.equal(svc.store.listEvents('alpha').some((event) => event.type === 'member.home_cleanup_deferred'), false);
    // A later materialize must not resurrect the retired directory.
    svc.materializeMember('alpha', { role: 'engineer' });
    assert.equal(existsSync(home), false);
  } finally { svc.close(); svc.store.close(); }
});
