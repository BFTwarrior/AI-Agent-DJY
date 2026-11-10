import { testHomeRoot } from './support/cleanup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/http/server.mjs';
import { loadConfig } from '../src/config.mjs';
import { createMcpHandler } from '../src/mcp/handler.mjs';
import { FakeSessionAdapter } from '../src/session/adapter.mjs';
import { TeamService } from '../src/scheduler-service.mjs';
import { normalizeRole, roleDefaults, LEAD_CAPABILITY, SHADOW_CAPABILITY } from '../src/service/roles.mjs';
import { Store } from '../src/store.mjs';
import { listenForFetch } from './support/listen.mjs';

function fixture({ withShadow = true, now = () => 1000, adapter: provided } = {}) {
  const { config } = loadConfig('config/example.v06.json');
  const store = new Store(':memory:');
  const adapter = provided ?? new FakeSessionAdapter();
  const service = new TeamService({ homeRoot: testHomeRoot(), store, adapter, config, cwd: process.cwd(), now });
  service.createTeam({
    id: 'alpha', name: 'Alpha', phase: 'running',
    members: [
      ...(withShadow ? [{ name: 'shadow', role: 'shadow' }] : []),
      { name: 'alpha-eng', role: 'engineer' },
    ],
  });
  service.createTeam({
    id: 'beta', name: 'Beta', phase: 'running',
    members: [{ name: 'beta-eng', role: 'engineer' }],
  });
  return { config, store, adapter, service };
}

test('the shadow is a distinct control role, not the lead alias', () => {
  assert.equal(normalizeRole('小队长'), 'shadow');
  assert.equal(normalizeRole('deputy'), 'shadow');
  const defaults = roleDefaults('shadow');
  assert.ok(defaults.capabilities.includes(SHADOW_CAPABILITY));
  assert.equal(defaults.control, true);
  assert.equal(defaults.scope, 'global');
  assert.deepEqual(defaults.kinds, [], 'the shadow must not be assignable as a delivery worker');
  assert.notEqual(normalizeRole('lead'), 'shadow');
});

test('there is at most one shadow seat in the workspace', () => {
  const { store, service } = fixture();
  try {
    assert.throws(
      () => service.addMember('beta', { name: 'shadow-2', role: 'shadow' }),
      (error) => error.code === 'E_SHADOW_EXISTS',
    );
    const shadow = store.findMember('alpha', 'shadow');
    const lead = service.addMember('alpha', { name: 'lead', role: 'lead' });
    assert.equal(service.memberIsShadow(shadow), true);
    assert.equal(service.memberIsShadow(lead), false);
  } finally {
    store.close();
  }
});

test('the shadow acts with captain authority on both teams but cannot edit its own seat', async () => {
  const { store, service } = fixture();
  const app = createApp({ store, service, token: 'admin' });
  const port = await listenForFetch(app);
  const base = `http://127.0.0.1:${port}/api/v1`;
  const shadow = store.findMember('alpha', 'shadow');
  const eng = store.findMember('alpha', 'alpha-eng');
  const shadowHeaders = {
    authorization: `Bearer ${store.getMemberToken(shadow.id)}`,
    'content-type': 'application/json',
  };
  const engHeaders = {
    authorization: `Bearer ${store.getMemberToken(eng.id)}`,
    'content-type': 'application/json',
  };
  try {
    const teams = await fetch(`${base}/teams`, { headers: shadowHeaders });
    assert.equal(teams.status, 200, 'the shadow can read the global team list');

    const crossTeamTask = await fetch(`${base}/teams/beta/tasks`, {
      method: 'POST', headers: shadowHeaders,
      body: JSON.stringify({ id: 'shadow-task', subject: 'created by shadow', kind: 'work', assignee: 'beta-eng' }),
    });
    assert.equal(crossTeamTask.status, 201);

    const addMember = await fetch(`${base}/teams/beta/members`, {
      method: 'POST', headers: shadowHeaders,
      body: JSON.stringify({ name: 'beta-eng-2', role: 'engineer' }),
    });
    assert.equal(addMember.status, 201);

    const plainMember = await fetch(`${base}/teams/alpha/tasks`, {
      method: 'POST', headers: engHeaders,
      body: JSON.stringify({ id: 'eng-task', subject: 'not allowed', kind: 'work', assignee: 'alpha-eng' }),
    });
    assert.equal(plainMember.status, 403);

    const selfRelicense = await fetch(`${base}/teams/alpha/members/${shadow.id}/relicense`, {
      method: 'POST', headers: shadowHeaders,
      body: JSON.stringify({ label: 'shadow-renamed' }),
    });
    assert.equal(selfRelicense.status, 403);

    const selfDelete = await fetch(`${base}/teams/alpha/members/${shadow.id}`, {
      method: 'DELETE', headers: shadowHeaders,
    });
    assert.equal(selfDelete.status, 403);

    const selfRelicenseByName = await fetch(`${base}/teams/alpha/members/${shadow.name}/relicense`, {
      method: 'POST', headers: shadowHeaders,
      body: JSON.stringify({ label: 'shadow-renamed' }),
    });
    assert.equal(selfRelicenseByName.status, 403, 'a member name must not bypass self-protection');

    const selfDeleteByName = await fetch(`${base}/teams/alpha/members/${shadow.name}`, {
      method: 'DELETE', headers: shadowHeaders,
    });
    assert.equal(selfDeleteByName.status, 403, 'a member name must not bypass self-delete protection');

    const capabilityInjection = await fetch(`${base}/teams/alpha/members/${eng.id}/relicense`, {
      method: 'POST', headers: shadowHeaders,
      body: JSON.stringify({ capabilities: ['captain:delegate'] }),
    });
    assert.equal(capabilityInjection.status, 400, 'delegate capability is reserved for the shadow role');

    const leadInjection = await fetch(`${base}/teams/alpha/members/${eng.id}/relicense`, {
      method: 'POST', headers: shadowHeaders,
      body: JSON.stringify({ capabilities: ['team:lead'] }),
    });
    assert.equal(leadInjection.status, 400, 'lead capability is reserved for the lead role');
    assert.equal((await leadInjection.json()).error.code, 'E_LEAD_CAPABILITY');
    assert.equal(store.getMember(eng.id).role, 'engineer');
    assert.equal(service.memberHasCapability(store.getMember(eng.id), LEAD_CAPABILITY), false);

    const secondShadow = await fetch(`${base}/teams/alpha/members/${eng.id}/relicense`, {
      method: 'POST', headers: shadowHeaders,
      body: JSON.stringify({ role: 'shadow' }),
    });
    assert.equal(secondShadow.status, 409);
    assert.equal((await secondShadow.json()).error.code, 'E_SHADOW_EXISTS');

    const captainMail = await fetch(`${base}/teams/alpha/captain/message`, {
      method: 'POST', headers: shadowHeaders,
      body: JSON.stringify({ content: 'impersonation attempt' }),
    });
    assert.equal(captainMail.status, 403);

    const otherRelicense = await fetch(`${base}/teams/alpha/members/${eng.id}/relicense`, {
      method: 'POST', headers: shadowHeaders,
      body: JSON.stringify({ label: 'alpha-eng-renamed' }),
    });
    assert.equal(otherRelicense.status, 200);

    const events = store.listEvents('beta').filter((event) => event.type === 'shadow.action');
    assert.ok(events.some((event) => event.memberId === shadow.id));
  } finally {
    await app.close();
    store.close();
  }
});

test('shadow initial protocol send carries the Bash/write denylist', async () => {
  const { store, adapter, service } = fixture();
  try {
    adapter.kind = 'protocol';
    await service.startShadow();
    const send = adapter.calls.find((call) => call.kind === 'send' && call.input?.sessionId);
    assert.ok(send, 'the protocol shadow must flush its initial prompt');
    assert.ok(send.input.disallowedTools.includes('Bash'));
    assert.ok(send.input.disallowedTools.includes('Edit'));
  } finally {
    store.close();
  }
});

test('lead and shadow roles always carry their authority capability', async () => {
  const { store, service } = fixture();
  try {
    const shadow = store.findMember('alpha', 'shadow');    const roleShadow = await service.relicenseMember('alpha', shadow.id, {
      role: 'shadow', capabilities: [],
    });
    assert.equal(roleShadow.member.role, 'shadow');
    assert.ok(roleShadow.member.license.capabilities.includes(SHADOW_CAPABILITY));
    assert.equal(service.memberIsShadow(roleShadow.member), true);
    assert.equal(
      store.listMembers('alpha').filter((member) => member.role === 'shadow').length,
      1,
      'a role=shadow seat cannot exist without the shadow capability',
    );
    const started = await service.startShadow();
    assert.equal(started.shadow.memberId, shadow.id, 'starting must reuse the existing shadow seat');

    const eng = store.findMember('alpha', 'alpha-eng');
    assert.equal(service.rosterMembers('alpha').length, 1);
    const roleLead = await service.relicenseMember('alpha', eng.id, {
      role: 'lead', capabilities: [],
    });
    assert.equal(roleLead.member.role, 'lead');
    assert.ok(roleLead.member.license.capabilities.includes(LEAD_CAPABILITY));
    assert.equal(service.memberIsControl(roleLead.member), true);
    assert.equal(service.rosterMembers('alpha').length, 0, 'a lead must not consume a delivery roster slot');
  } finally {
    store.close();
  }
});

test('the delivery roster cap excludes control seats', () => {
  const { config, store, service } = fixture();
  try {
    config.teams.find((team) => team.id === 'alpha').maxMembers = 8;
    const fill = () => {
      while (service.rosterMembers('alpha').length < 8) {
        const index = service.rosterMembers('alpha').length + 1;
        service.addMember('alpha', { name: `filler-${index}`, role: 'engineer' });
      }
    };
    fill();
    assert.equal(service.rosterMembers('alpha').length, 8);
    service.addMember('alpha', { name: 'alpha-lead', role: 'lead' });
    assert.equal(service.rosterMembers('alpha').length, 8, 'a lead must not consume a roster slot');
    assert.throws(
      () => service.addMember('alpha', { name: 'overflow', role: 'engineer' }),
      /member cap/,
    );
  } finally {
    store.close();
  }
});

test('a shadow cannot be assigned a delivery task even with licenses disabled', () => {
  const { config } = loadConfig('config/example.v06.json');
  config.features.licenses = false;
  const store = new Store(':memory:');
  const service = new TeamService({ homeRoot: testHomeRoot(),
    store, adapter: new FakeSessionAdapter(), config, cwd: process.cwd(), now: () => 1000,
  });
  try {
    service.createTeam({
      id: 'alpha', name: 'Alpha', phase: 'running',
      members: [{ name: 'shadow', role: 'shadow' }, { name: 'alpha-eng', role: 'engineer' }],
    });
    assert.throws(
      () => service.addTask('alpha', { subject: 'shadow work', kind: 'work', assignee: 'shadow' }),
      /shadow .*cannot execute delivery kind work/,
    );
  } finally {
    store.close();
  }
});

test('startShadow is idempotent for an already active shadow seat', async () => {
  const { store, service } = fixture();
  try {
    const shadow = store.findMember('alpha', 'shadow');
    store.updateMember(shadow.id, {
      shadowState: 'active', sessionId: 'sess_persisted', shadowStartedAt: 900, shadowLastActiveAt: 900,
    });
    const started = await service.startShadow();
    assert.equal(started.started, false);
    assert.equal(started.shadow.status, 'active');
    assert.equal(started.shadow.sessionId, 'sess_persisted');
    assert.equal(store.listMembers('alpha').filter((member) => member.role === 'shadow').length, 1);
  } finally {
    store.close();
  }
});

test('restart reconciliation retains an unverified shadow session and its seat', async () => {
  const { store, service } = fixture();
  try {
    const shadow = store.findMember('alpha', 'shadow');
    store.updateMember(shadow.id, {
      shadowState: 'active', sessionId: 'sess_before_restart', shadowStartedAt: 900, shadowLastActiveAt: 900,
    });
    await service.reconcileAfterRestart();
    assert.equal(store.getMember(shadow.id).shadowState, 'stop_failed');
    assert.equal(store.getMember(shadow.id).sessionId, 'sess_before_restart');
    await assert.rejects(() => service.startShadow(), (error) => error.code === 'E_SHADOW_STOP_FAILED');
    assert.equal(store.listMembers('alpha').filter((member) => member.role === 'shadow').length, 1);
  } finally {
    store.close();
  }
});

test('auto-stop waits while a contractor is still running', async () => {
  const { store, service } = fixture({ withShadow: false });
  try {
    const started = await service.startShadow();
    store.updateMember(started.shadow.memberId, {
      shadowLastActiveAt: 1000 - 31 * 60 * 1000,
    });
    store.addContractor({
      id: 'ctr_running', teamId: 'alpha', slot: 'patrol', purpose: 'task', status: 'running', queuedAt: 1,
    });
    const tick = await service.shadowAutoStopTick();
    assert.equal(tick.stopped, false);
    assert.equal(tick.reason, 'contractor-running');
    assert.ok(store.getMember(started.shadow.memberId).sessionId);
  } finally {
    store.close();
  }
});

test('shadow MCP sessions see the captain catalog; ordinary members do not', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ ok: true, data: {} }) });
  const normal = createMcpHandler({
    fetchImpl, baseUrl: 'http://daemon', token: 't', defaultMember: 'alpha-eng',
  });
  const shadow = createMcpHandler({
    fetchImpl, baseUrl: 'http://daemon', token: 't', defaultMember: 'shadow', shadowMember: true,
  });
  const normalList = await normal({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const shadowList = await shadow({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(normalList.result.tools.some((tool) => tool.name === 'agent_teams_workspace'), false);
  assert.equal(shadowList.result.tools.some((tool) => tool.name === 'agent_teams_workspace'), true);
  assert.equal(normalList.result.tools.some((tool) => tool.name === 'agent_teams_shadow_start'), false);
  assert.equal(shadowList.result.tools.some((tool) => tool.name === 'agent_teams_shadow_start'), false);
  assert.equal(shadowList.result.tools.some((tool) => tool.name === 'agent_teams_shadow_stop'), true);
  assert.equal(shadowList.result.tools.some((tool) => tool.name === 'agent_teams_view'), false);
  assert.ok(shadowList.result.tools.length > normalList.result.tools.length);
});

test('an idle shadow auto-stops after the configured window, but not while work remains', async () => {
  let clock = 1000;
  const { config, store, service } = fixture({ withShadow: false, now: () => clock });
  config.shadow.idleStopMinutes = 1;
  try {
    await service.startShadow();
    clock += 30000;
    const early = await service.shadowAutoStopTick();
    assert.equal(early.stopped, false);
    assert.equal(early.reason, 'recent-activity');

    service.addTask('alpha', {
      id: 'still-open', subject: 'unfinished work', kind: 'work', assignee: 'alpha-eng',
    });
    clock += 60000;
    const busy = await service.shadowAutoStopTick();
    assert.equal(busy.stopped, false);
    assert.equal(busy.reason, 'work-remaining');

    store.updateTask('still-open', { status: 'completed' });
    const stopped = await service.shadowAutoStopTick();
    assert.equal(stopped.autoStopped, true);
    assert.equal(stopped.shadow.status, 'stopped');
  } finally {
    store.close();
  }
});

test('the single shadow can be started on demand, stopped, and restarted without a second seat', async () => {
  const { store, service } = fixture({ withShadow: false });
  try {
    const first = await service.startShadow();
    assert.equal(first.ok, true);
    assert.equal(first.started, true);
    assert.equal(first.shadow.status, 'active');
    const memberId = first.shadow.memberId;

    const second = await service.startShadow();
    assert.equal(second.started, false);
    assert.equal(second.shadow.memberId, memberId);

    const stopped = await service.stopShadow({ reason: 'work complete' });
    assert.equal(stopped.ok, true);
    assert.equal(stopped.shadow.status, 'stopped');
    assert.equal(store.getMember(memberId).sessionId, undefined);

    const restarted = await service.startShadow();
    assert.equal(restarted.ok, true);
    assert.equal(restarted.shadow.memberId, memberId, 'restart reuses the single shadow seat');
    assert.equal(store.listMembers('alpha').filter((item) => service.memberIsShadow(item)).length, 1);
  } finally {
    store.close();
  }
});

test('a rejected shadow relicense leaves the old license and session intact', async () => {
  const { store, service } = fixture();
  const eng = store.findMember('alpha', 'alpha-eng');
  store.updateMember(eng.id, { sessionId: 'sess_live' });
  const before = store.getMember(eng.id);
  try {
    await assert.rejects(
      () => service.relicenseMember('alpha', eng.id, { role: 'shadow' }),
      (error) => error.code === 'E_SHADOW_EXISTS',
    );
    const after = store.getMember(eng.id);
    assert.equal(after.sessionId, 'sess_live');
    assert.equal(after.license.id, before.license.id);
    const active = store.listLicenses('alpha', eng.id).filter((license) => license.status === 'active');
    assert.equal(active.length, 1);
    assert.equal(active[0].roleKey, 'engineer');
  } finally {
    store.close();
  }
});

test('the shadow can continue a failed task on the other team', async () => {
  const { store, service } = fixture();
  const shadow = store.findMember('alpha', 'shadow');
  try {
    service.addTask('beta', { id: 'beta-failed', subject: 'failed elsewhere', kind: 'work', assignee: 'beta-eng' });
    store.updateTask('beta-failed', { status: 'failed' });
    assert.equal(
      service.canContinueTask('beta', { role: 'member', memberId: shadow.id, name: shadow.name }),
      true,
    );
  } finally {
    store.close();
  }
});

test('a retired shadow seat can be replaced without a duplicate-name failure', async () => {
  const { store, service } = fixture({ withShadow: false });
  try {
    const first = await service.startShadow();
    await service.stopShadow({ reason: 'retire' });
    await service.removeMember('alpha', first.shadow.memberId);
    const second = await service.startShadow();
    assert.equal(second.ok, true);
    assert.notEqual(second.shadow.memberId, first.shadow.memberId);
  } finally {
    store.close();
  }
});

test('lifecycle ticks never sleep a control shadow', async () => {
  const { store, service } = fixture({ withShadow: false });
  try {
    const started = await service.startShadow();
    const id = started.shadow.memberId;
    store.updateMember(id, { lastActiveAt: 0, joinedAt: 0, shadowLastActiveAt: 0 });
    const result = await service.lifecycleTick('alpha', { force: true });
    assert.equal(result.slept, 0);
    assert.ok(store.getMember(id).sessionId);
  } finally {
    store.close();
  }
});

test('stopShadow reports adapter failure and keeps the session id', async () => {
  const adapter = new FakeSessionAdapter();
  adapter.stop = async () => ({ ok: false, warning: 'still running' });
  const { store, service } = fixture({ withShadow: false, adapter });
  try {
    const started = await service.startShadow();
    const stopped = await service.stopShadow();
    assert.equal(stopped.ok, false);
    assert.equal(stopped.shadow.status, 'stop_failed');
    assert.equal(store.getMember(started.shadow.memberId).sessionId, started.shadow.sessionId);
  } finally {
    store.close();
  }
});

test('a protocol shadow receives its initial prompt through send', async () => {
  const adapter = new FakeSessionAdapter();
  adapter.kind = 'protocol';
  let sent;
  const original = adapter.send.bind(adapter);
  adapter.send = async (input) => {
    sent = input;
    return original(input);
  };
  const { store, service } = fixture({ withShadow: false, adapter });
  try {
    await service.startShadow();
    assert.equal(sent?.message, 'Begin your shadow coordination duties.');
    assert.ok(sent?.sessionId);
  } finally {
    store.close();
  }
});

test('a staged team cannot start the shadow', async () => {
  const { store, service } = fixture({ withShadow: false });
  try {
    store.updateTeam('alpha', { phase: 'staged', control: 'halted' });
    await assert.rejects(
      () => service.startShadow({ teamId: 'alpha' }),
      (error) => error.code === 'E_NO_ACTIVE_TEAM',
    );
  } finally {
    store.close();
  }
});

test('a stop during a slow start is not blocked and cleans the new session', async () => {
  const adapter = new FakeSessionAdapter();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const originalCreate = adapter.create.bind(adapter);
  adapter.create = async (input) => {
    await gate;
    return originalCreate(input);
  };
  const { store, service } = fixture({ withShadow: false, adapter });
  try {
    const starting = service.startShadow();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const stopped = await service.stopShadow({ reason: 'cancel slow start' });
    assert.equal(stopped.ok, true);
    assert.equal(stopped.shadow.status, 'stopped');
    release();
    const result = await starting;
    assert.equal(result.started, false);
    assert.equal(store.getMember(result.shadow.memberId).sessionId, undefined);
  } finally {
    store.close();
  }
});

test('shadow start respects the control-session budget', async () => {
  const { config, store, service } = fixture({ withShadow: false });
  config.scheduler.maxControlSessions = 0;
  try {
    await assert.rejects(
      () => service.startShadow(),
      (error) => error.code === 'E_CONTROL_CAP',
    );
  } finally {
    store.close();
  }
});

test('archiving a team clears the shadow session and refuses to restart it there', async () => {
  const { store, service } = fixture({ withShadow: false });
  try {
    const started = await service.startShadow();
    const shadowId = started.shadow.memberId;
    await service.archive('alpha');
    assert.equal(store.getMember(shadowId).sessionId, undefined);
    assert.equal(service.shadowStatus().status, 'stopped');
    await assert.rejects(
      () => service.startShadow({ teamId: 'alpha' }),
      (error) => error.code === 'E_SHADOW_TEAM_NOT_ACTIVE',
    );
  } finally {
    store.close();
  }
});

function gatedAdapter() {
  const adapter = new FakeSessionAdapter();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const originalCreate = adapter.create.bind(adapter);
  adapter.create = async (input) => {
    await gate;
    return originalCreate(input);
  };
  return { adapter, release };
}

async function waitForStarting(service) {
  for (let index = 0; index < 100; index += 1) {
    if (service.shadowStatus().status === 'starting') return service.shadowStatus();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('shadow did not enter starting');
}

test('a second start during a slow create is rejected as busy', async () => {
  const { adapter, release } = gatedAdapter();
  const { store, service } = fixture({ withShadow: false, adapter });
  try {
    const first = service.startShadow();
    await waitForStarting(service);
    const second = await service.startShadow();
    assert.equal(second.busy, true);
    release();
    const result = await first;
    assert.equal(result.started, true);
    assert.equal(adapter.sessions.size, 1);
  } finally {
    store.close();
  }
});

test('removing the shadow during a slow create does not resurrect the seat', async () => {
  const { adapter, release } = gatedAdapter();
  const { store, service } = fixture({ withShadow: false, adapter });
  try {
    const starting = service.startShadow();
    const status = await waitForStarting(service);
    await service.removeMember('alpha', status.memberId);
    release();
    const result = await starting;
    assert.equal(result.started, false);
    assert.equal(store.getMember(status.memberId).status, 'removed');
    assert.equal(service.shadowStatus().exists, false);
  } finally {
    store.close();
  }
});

test('halting the team during a slow create does not activate the shadow', async () => {
  const { adapter, release } = gatedAdapter();
  const { store, service } = fixture({ withShadow: false, adapter });
  try {
    const starting = service.startShadow();
    await waitForStarting(service);
    await service.halt('alpha', 'stop now');
    release();
    const result = await starting;
    assert.equal(result.started, false);
    assert.equal(service.shadowStatus().status, 'stopped');
    assert.equal(store.getTeam('alpha').control, 'halted');
  } finally {
    store.close();
  }
});

test('a stop_failed shadow refuses a new start until stop is retried', async () => {
  const adapter = new FakeSessionAdapter();
  adapter.stop = async () => ({ ok: false, warning: 'still running' });
  const { store, service } = fixture({ withShadow: false, adapter });
  try {
    await service.startShadow();
    const stopped = await service.stopShadow();
    assert.equal(stopped.shadow.status, 'stop_failed');
    await assert.rejects(
      () => service.startShadow(),
      (error) => error.code === 'E_SHADOW_STOP_FAILED',
    );
  } finally {
    store.close();
  }
});

test('restart reconciliation retains a persisted starting shadow session', async () => {
  const { store, service } = fixture({ withShadow: false });
  try {
    const started = await service.startShadow();
    const id = started.shadow.memberId;
    store.updateMember(id, { shadowState: 'starting', shadowStartId: 'stale-start' });
    await service.reconcileAfterRestart();
    assert.equal(store.getMember(id).shadowState, 'stop_failed');
    assert.ok(store.getMember(id).sessionId);
  } finally {
    store.close();
  }
});

test('the memory high-watermark path never sleeps a control shadow', async () => {
  const { store, service, adapter } = fixture({ withShadow: false });
  try {
    const started = await service.startShadow();
    const id = started.shadow.memberId;
    const result = await service.lifecycleTick('alpha', {
      force: true,
      memoryUsage: () => ({ rssBytes: 95, budgetBytes: 100 }),
    });
    assert.equal(result.slept, 0);
    const sessionId = store.getMember(id).sessionId;
    assert.ok(sessionId);
    assert.notEqual(adapter.sessions.get(sessionId)?.status, 'stopped', 'the shadow session must remain live');
  } finally {
    store.close();
  }
});

test('a lead cannot sleep the shadow through sleepMember', async () => {
  const { store, service, adapter } = fixture();
  try {
    const started = await service.startShadow();
    const shadow = store.getMember(started.shadow.memberId);
    const lead = service.addMember('alpha', { name: 'alpha-lead', role: 'lead' });
    await assert.rejects(
      () => service.sleepMember('alpha', shadow.id, {
        reason: 'lead attempt',
        actor: { role: 'member', memberId: lead.id, name: lead.name },
      }),
      (error) => error.code === 'E_CONTROL_SEAT',
    );
    assert.ok(store.getMember(shadow.id).sessionId, 'the shadow session must remain live');
    assert.notEqual(adapter.sessions.get(shadow.sessionId)?.status, 'stopped', 'the shadow session must remain live');
  } finally {
    store.close();
  }
});

test('relicensing the shadow during a slow start does not produce an orphan session', async () => {
  const { adapter, release } = gatedAdapter();
  const { store, service } = fixture({ withShadow: true, adapter });
  const shadow = store.findMember('alpha', 'shadow');
  try {
    const starting = service.startShadow();
    await waitForStarting(service);
    const relicensed = await service.relicenseMember('alpha', shadow.id, { role: 'engineer' });
    assert.equal(relicensed.ok, true);
    release();
    const result = await starting;
    assert.equal(result.started, false);
    assert.equal(store.getMember(shadow.id).license.roleKey, 'engineer');
    assert.equal(service.shadowStatus().exists, false);
    const live = [...adapter.sessions.values()].filter((session) => session.status !== 'stopped');
    assert.equal(live.length, 0, 'the stale session must be stopped');
  } finally {
    store.close();
  }
});

test('a stale start failure cannot cancel a newer start generation', async () => {
  const adapter = new FakeSessionAdapter();
  let call = 0;
  let releaseFirst;
  let releaseSecond;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const secondGate = new Promise((resolve) => { releaseSecond = resolve; });
  const originalCreate = adapter.create.bind(adapter);
  adapter.create = async (input) => {
    call += 1;
    if (call === 1) {
      await firstGate;
      throw new Error('first start failed');
    }
    await secondGate;
    return originalCreate(input);
  };
  const { store, service } = fixture({ withShadow: false, adapter });
  try {
    const first = service.startShadow();
    await waitForStarting(service);
    await service.stopShadow({ reason: 'cancel first' });
    const second = service.startShadow();
    await waitForStarting(service);
    releaseFirst();
    await assert.rejects(() => first, /first start failed/);
    releaseSecond();
    const result = await second;
    assert.equal(result.started, true);
    assert.ok(store.getMember(result.shadow.memberId).sessionId);
  } finally {
    store.close();
  }
});

test('a stale successful start cannot clear a newer committed session', async () => {
  const adapter = new FakeSessionAdapter();
  let call = 0;
  let releaseFirst;
  let releaseSecond;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const secondGate = new Promise((resolve) => { releaseSecond = resolve; });
  const originalCreate = adapter.create.bind(adapter);
  adapter.create = async (input) => {
    call += 1;
    if (call === 1) {
      await firstGate;
      return originalCreate(input);
    }
    await secondGate;
    return originalCreate(input);
  };
  const { store, service } = fixture({ withShadow: false, adapter });
  try {
    const first = service.startShadow();
    await waitForStarting(service);
    await service.stopShadow({ reason: 'cancel first' });
    const second = service.startShadow();
    await waitForStarting(service);
    releaseSecond();
    const committed = await second;
    assert.equal(committed.started, true);
    const committedSession = store.getMember(committed.shadow.memberId).sessionId;
    releaseFirst();
    const stale = await first;
    assert.equal(stale.started, false);
    assert.equal(store.getMember(committed.shadow.memberId).sessionId, committedSession);
    assert.ok(
      [...adapter.sessions.values()].some((session) => session.sessionId === committedSession),
      'the newer session must stay alive',
    );
  } finally {
    store.close();
  }
});

test('a lead control session counts against the shadow start budget', async () => {
  const { config, store, service } = fixture();
  try {
    const lead = service.addMember('alpha', { name: 'alpha-lead', role: 'lead' });
    store.updateMember(lead.id, { sessionId: 'sess_lead' });
    config.scheduler.maxControlSessions = 1;
    await assert.rejects(
      () => service.startShadow(),
      (error) => error.code === 'E_CONTROL_CAP',
    );
  } finally {
    store.close();
  }
});

test('relicensing a member to lead respects the control-session budget', async () => {
  const { config, store, service, adapter } = fixture();
  try {
    const started = await service.startShadow();
    assert.ok(store.getMember(started.shadow.memberId).sessionId, 'the shadow session occupies the budget');
    const eng = store.findMember('alpha', 'alpha-eng');
    config.scheduler.maxControlSessions = 1;
    await assert.rejects(
      () => service.relicenseMember('alpha', eng.id, { role: 'lead' }),
      (error) => error.code === 'E_CONTROL_CAP',
    );
    assert.equal(store.getMember(eng.id).role, 'engineer', 'a rejected relicense must leave the old role intact');
    assert.notEqual(adapter.sessions.get(started.shadow.sessionId)?.status, 'stopped', 'the shadow session must stay live');
  } finally {
    store.close();
  }
});

test('lead uniqueness is enforced for materialize and relicense', async () => {
  const { store, service } = fixture();
  try {
    service.addMember('alpha', { name: 'alpha-lead', role: 'lead' });
    const eng = store.findMember('alpha', 'alpha-eng');
    assert.throws(
      () => service.materializeMember('alpha', { role: 'lead' }),
      (error) => error.code === 'E_LEAD_EXISTS',
    );
    await assert.rejects(
      () => service.relicenseMember('alpha', eng.id, { role: 'lead' }),
      (error) => error.code === 'E_LEAD_EXISTS',
    );
  } finally {
    store.close();
  }
});
