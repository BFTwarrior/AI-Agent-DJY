import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoveryPathForWorkspace } from '../src/discovery.mjs';
import {
  clearActiveWorkspace, hasTeamConfig, listDiscoveries, readActiveWorkspace,
  readLiveDiscoveryForWorkspace, resolveWorkspaceTarget, workspaceSummary, writeActiveWorkspace,
} from '../src/workspace-target.mjs';

function workspaceWithTeam(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(dir, '.ai-agent-teams'), { recursive: true });
  return dir;
}

function discovery(workspace, port, startedAt) {
  return {
    port, token: `token-${port}`, pid: process.pid, version: '0.1.7',
    workspace, startedAt, apiVersion: 'v1',
  };
}

test('workspace target precedence: explicit, active, env, session, saved, recent', () => {
  const session = workspaceWithTeam('zat-session-');
  const active = workspaceWithTeam('zat-active-');
  const recent = workspaceWithTeam('zat-recent-');
  const bare = mkdtempSync(join(tmpdir(), 'zat-bare-'));
  const statePath = join(mkdtempSync(join(tmpdir(), 'zat-state-')), 'active.json');
  const discoveries = [discovery(recent, 8779, 2)];

  assert.deepEqual(
    resolveWorkspaceTarget({ explicit: active, active: session, startupWorkspace: bare, statePath, discoveries }),
    { workspace: active, source: 'explicit', fallback: false },
  );
  assert.deepEqual(
    resolveWorkspaceTarget({ active, envValue: session, startupWorkspace: bare, statePath, discoveries }),
    { workspace: active, source: 'active', fallback: false },
  );
  assert.deepEqual(
    resolveWorkspaceTarget({ envValue: session, startupWorkspace: bare, statePath, discoveries }),
    { workspace: session, source: 'env', fallback: false },
  );
  assert.deepEqual(
    resolveWorkspaceTarget({ startupWorkspace: session, statePath, discoveries }),
    { workspace: session, source: 'session', fallback: false },
  );
});

test('a workspace without team state falls back to the saved target then newest daemon', () => {
  const bare = mkdtempSync(join(tmpdir(), 'zat-bare-'));
  const saved = workspaceWithTeam('zat-saved-');
  const newest = workspaceWithTeam('zat-newest-');
  const older = workspaceWithTeam('zat-older-');
  const statePath = join(mkdtempSync(join(tmpdir(), 'zat-state-')), 'active.json');
  const discoveries = [discovery(newest, 8780, 300), discovery(older, 8779, 100)];

  writeActiveWorkspace(saved, statePath);
  assert.deepEqual(
    resolveWorkspaceTarget({ startupWorkspace: bare, statePath, discoveries }),
    { workspace: saved, source: 'saved', fallback: true },
  );

  clearActiveWorkspace(statePath);
  assert.deepEqual(
    resolveWorkspaceTarget({ startupWorkspace: bare, statePath, discoveries }),
    { workspace: newest, source: 'recent-daemon', fallback: true },
  );
  assert.deepEqual(
    resolveWorkspaceTarget({ startupWorkspace: bare, statePath, discoveries: [] }),
    { workspace: bare, source: 'startup', fallback: false },
  );
});

test('saved targets that no longer exist are ignored', () => {
  const bare = mkdtempSync(join(tmpdir(), 'zat-bare-'));
  const statePath = join(mkdtempSync(join(tmpdir(), 'zat-state-')), 'active.json');
  writeFileSync(statePath, JSON.stringify({ workspace: join(bare, 'removed') }), 'utf8');
  assert.equal(readActiveWorkspace(statePath), undefined);
  assert.deepEqual(
    resolveWorkspaceTarget({ startupWorkspace: bare, statePath, discoveries: [] }),
    { workspace: bare, source: 'startup', fallback: false },
  );
});

test('discoveries are deduped and sorted by start time', () => {
  const base = mkdtempSync(join(tmpdir(), 'zat-discovery-'));
  const first = workspaceWithTeam('zat-first-');
  const second = workspaceWithTeam('zat-second-');
  mkdirSync(join(base, 'workspaces', 'a'), { recursive: true });
  mkdirSync(join(base, 'workspaces', 'b'), { recursive: true });
  writeFileSync(join(base, 'workspaces', 'a', 'runtime.json'), JSON.stringify(discovery(first, 8779, 100)), 'utf8');
  writeFileSync(join(base, 'workspaces', 'b', 'runtime.json'), JSON.stringify(discovery(second, 8780, 200)), 'utf8');
  // The legacy mirror duplicates the newest daemon and must not win twice.
  writeFileSync(join(base, 'runtime.json'), JSON.stringify(discovery(second, 8780, 200)), 'utf8');

  const list = listDiscoveries({ baseDir: base });
  assert.equal(list.length, 2);
  assert.equal(list[0].workspace, second);
  assert.equal(list[1].workspace, first);
  assert.equal(list.find((item) => item.workspace === second).legacy, false);
});

test('a dead daemon is excluded when only live discoveries are requested', () => {
  const base = mkdtempSync(join(tmpdir(), 'zat-discovery-'));
  const workspace = workspaceWithTeam('zat-dead-');
  mkdirSync(join(base, 'workspaces', 'a'), { recursive: true });
  writeFileSync(join(base, 'workspaces', 'a', 'runtime.json'), JSON.stringify({ ...discovery(workspace, 8779, 1), pid: 999999 }), 'utf8');
  assert.equal(listDiscoveries({ baseDir: base }).length, 1);
  assert.equal(listDiscoveries({ baseDir: base, alive: true }).length, 0);
});

test('a stale discovery in the startup folder does not block fallback to a live daemon', () => {
  const base = mkdtempSync(join(tmpdir(), 'zat-discovery-'));
  const startup = mkdtempSync(join(tmpdir(), 'zat-startup-'));
  const live = workspaceWithTeam('zat-live-');
  const previous = process.env.AGENT_TEAMS_DISCOVERY_BASE;
  process.env.AGENT_TEAMS_DISCOVERY_BASE = base;
  try {
    const deadPath = discoveryPathForWorkspace(startup);
    const livePath = discoveryPathForWorkspace(live);
    mkdirSync(join(deadPath, '..'), { recursive: true });
    mkdirSync(join(livePath, '..'), { recursive: true });
    writeFileSync(deadPath, JSON.stringify({ ...discovery(startup, 8779, 300), pid: 999999 }), 'utf8');
    writeFileSync(livePath, JSON.stringify(discovery(live, 8780, 100)), 'utf8');
    const statePath = join(mkdtempSync(join(tmpdir(), 'zat-state-')), 'active.json');
    assert.deepEqual(
      resolveWorkspaceTarget({ startupWorkspace: startup, statePath }),
      { workspace: live, source: 'recent-daemon', fallback: true },
    );
  } finally {
    if (previous === undefined) delete process.env.AGENT_TEAMS_DISCOVERY_BASE;
    else process.env.AGENT_TEAMS_DISCOVERY_BASE = previous;
  }
});

test('an unrelated config/local.json is not a team config', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'zat-other-config-'));
  mkdirSync(join(workspace, 'config'), { recursive: true });
  writeFileSync(join(workspace, 'config', 'local.json'), JSON.stringify({ name: 'some other tool' }), 'utf8');
  assert.equal(hasTeamConfig(workspace), false);
  writeFileSync(join(workspace, 'config', 'local.json'), JSON.stringify({ teams: [{ id: 'alpha', name: 'Alpha' }] }), 'utf8');
  assert.equal(hasTeamConfig(workspace), false);
  writeFileSync(join(workspace, 'config', 'local.json'), JSON.stringify({
    $schema: './schema.json',
    version: 1,
    captain: { name: 'captain' },
    teams: [{ id: 'alpha', name: 'Alpha', lead: 'alpha-lead', maxMembers: 32 }],
  }), 'utf8');
  assert.equal(hasTeamConfig(workspace), true);
  writeFileSync(join(workspace, 'config', 'local.json'), JSON.stringify({
    $schema: 'https://example.com/other.json',
    version: 1,
    captain: {},
    teams: [{ id: 'alpha', name: 'Alpha', lead: 'alpha-lead', maxMembers: 32 }],
  }), 'utf8');
  assert.equal(hasTeamConfig(workspace), false);
  writeFileSync(join(workspace, 'config', 'local.json'), JSON.stringify({
    version: 1, captain: {}, teams: [{ id: 'some-other-tool', name: 'Other' }],
  }), 'utf8');
  assert.equal(hasTeamConfig(workspace), false);
  writeFileSync(join(workspace, 'config', 'local.json'), JSON.stringify({
    $schema: './schema.json',
    version: 1,
    captain: {},
    teams: Array.from({ length: 3 }, (_, index) => ({
      id: `team-${index}`, name: `Team ${index}`, lead: `lead-${index}`, maxMembers: 32,
    })),
  }), 'utf8');
  assert.equal(hasTeamConfig(workspace), false);
});

test('a stale per-workspace record falls back to a live legacy mirror', () => {
  const base = mkdtempSync(join(tmpdir(), 'zat-discovery-'));
  const workspace = workspaceWithTeam('zat-legacy-live-');
  const previous = process.env.AGENT_TEAMS_DISCOVERY_BASE;
  process.env.AGENT_TEAMS_DISCOVERY_BASE = base;
  try {
    const specific = discoveryPathForWorkspace(workspace);
    mkdirSync(join(specific, '..'), { recursive: true });
    writeFileSync(specific, JSON.stringify({ ...discovery(workspace, 8779, 1), pid: 999999 }), 'utf8');
    writeFileSync(join(base, 'runtime.json'), JSON.stringify(discovery(workspace, 8780, 2)), 'utf8');
    assert.equal(readLiveDiscoveryForWorkspace(workspace).port, 8780);
    assert.equal(workspaceSummary(workspace).daemon.port, 8780);
  } finally {
    if (previous === undefined) delete process.env.AGENT_TEAMS_DISCOVERY_BASE;
    else process.env.AGENT_TEAMS_DISCOVERY_BASE = previous;
  }
});

test('removing a discovery also removes a matching legacy mirror', async () => {
  const base = mkdtempSync(join(tmpdir(), 'zat-discovery-'));
  const workspace = workspaceWithTeam('zat-legacy-');
  // The base override must be in place before the path is resolved: computing
  // `discoveryPathForWorkspace()` first resolves against the real user HOME and
  // leaves an empty `~/.ai-agent-teams/workspaces/<hash>` directory behind.
  const previous = process.env.AGENT_TEAMS_DISCOVERY_BASE;
  process.env.AGENT_TEAMS_DISCOVERY_BASE = base;
  try {
    const specific = discoveryPathForWorkspace(workspace);
    const legacy = join(base, 'runtime.json');
    mkdirSync(join(specific, '..'), { recursive: true });
    const record = { ...discovery(workspace, 8779, 1), instanceId: 'instance-a' };
    writeFileSync(specific, JSON.stringify(record), 'utf8');
    writeFileSync(legacy, JSON.stringify(record), 'utf8');
    assert.ok(specific.startsWith(base), 'the discovery record must be written under the temp base');
    const { removeDiscovery } = await import('../src/discovery.mjs');
    assert.equal(removeDiscovery({ path: specific, pid: process.pid, instanceId: 'instance-a' }), true);
    assert.equal(listDiscoveries({ baseDir: base }).length, 0);
  } finally {
    if (previous === undefined) delete process.env.AGENT_TEAMS_DISCOVERY_BASE;
    else process.env.AGENT_TEAMS_DISCOVERY_BASE = previous;
  }
});
