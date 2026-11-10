import { testHomeRoot } from './support/cleanup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, isLoopbackAddress, writeSse } from '../src/http/server.mjs';
import { request as httpRequest } from 'node:http';
import { loadConfig } from '../src/config.mjs';
import { FakeSessionAdapter } from '../src/session/adapter.mjs';
import { TeamService } from '../src/scheduler-service.mjs';
import { Store } from '../src/store.mjs';
import { listenForFetch } from './support/listen.mjs';

test('loopback detection covers IPv4, IPv6 and mapped addresses', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('127.8.9.10'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('192.0.2.10'), false);
  assert.equal(isLoopbackAddress(undefined), false);
});

test('restart revokes the old member token and blocks unknown session credentials', async () => {
  const { config } = loadConfig('config/example.v06.json');
  const store = new Store(':memory:');
  const service = new TeamService({ homeRoot: testHomeRoot(), store, adapter: new FakeSessionAdapter(), config, cwd: process.cwd(), now: () => 1000 });
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  const member = service.addMember('alpha', { name: 'worker', role: 'engineer' });
  const oldToken = store.getMemberToken(member.id);
  store.updateMember(member.id, { sessionId: 'unknown-session' });
  const app = createApp({ store, service, token: 'admin-secret' });
  const port = await listenForFetch(app);
  const headers = { authorization: `Bearer ${oldToken}` };
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/v1/teams/alpha`, { headers })).status, 200);
    await service.reconcileAfterRestart();
    assert.equal(store.getMemberToken(member.id), undefined);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/v1/teams/alpha`, { headers })).status, 401);
    store.setMemberToken(member.id, 'replacement-token');
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/v1/teams/alpha`, {
      headers: { authorization: 'Bearer replacement-token' },
    })).status, 401);
  } finally {
    await app.close();
    store.close();
  }
});

test('HTTP API covers health, auth, teams, tasks, tick and complete', async () => {
  const { config } = loadConfig('config/example.two-teams.json');
  const store = new Store(':memory:');
  const adapter = new FakeSessionAdapter();
  const service = new TeamService({ homeRoot: testHomeRoot(), store, adapter, config, cwd: process.cwd(), now: () => 1000 });
  service.createTeam({
    id: 'alpha', name: 'Alpha', phase: 'running',
    members: [{ name: 'a1' }, { name: 'a2' }],
  });
  service.addTask('alpha', { id: 'a1', subject: 'first', assignee: 'a1', kind: 'work' });
  service.createTeam({ id: 'beta', name: 'Beta', phase: 'running', members: [{ name: 'b1' }] });
  const patrolCalls = [];
  service.patrol = async (teamId) => {
    patrolCalls.push(teamId);
    return { ran: true, teamId };
  };
  const app = createApp({ store, service, token: 'secret', uiToken: 'viewtoken', uiAccessKey: '' });
  const port = await listenForFetch(app);
  const root = `http://127.0.0.1:${port}`;
  const base = `${root}/api/v1`;
  try {
    const ui = await fetch(`${root}/ui`);
    assert.equal(ui.status, 200);
    assert.match(ui.headers.get('content-type') ?? '', /text\/html/);
    const setCookies = ui.headers.getSetCookie();
    const uiCookieHeader = setCookies.find((item) => item.startsWith(`agent_teams_ui_${port}=`));
    assert.ok(uiCookieHeader, 'GET /ui must issue the UI session cookie');
    assert.match(uiCookieHeader, new RegExp(`^agent_teams_ui_${port}=viewtoken;`));
    assert.match(uiCookieHeader, /HttpOnly/i);
    assert.match(uiCookieHeader, /SameSite=Strict/i);
    assert.match(uiCookieHeader, /Path=\/api\/v1\/ui(?:;|$)/i);
    assert.match(uiCookieHeader, /Max-Age=86400/);
    assert.doesNotMatch(uiCookieHeader, /;\s*Secure/i, 'loopback HTTP must not require Secure');
    const uiCookie = uiCookieHeader.split(';')[0];
    const alphaPatrolCookieHeader = setCookies.find((item) => item.startsWith(`agent_teams_patrol_${port}_YWxwaGE=`));
    const betaPatrolCookieHeader = setCookies.find((item) => item.startsWith(`agent_teams_patrol_${port}_YmV0YQ=`));
    assert.ok(alphaPatrolCookieHeader, 'GET /ui issues an alpha-only patrol cookie');
    assert.ok(betaPatrolCookieHeader, 'GET /ui issues a beta-only patrol cookie');
    assert.match(alphaPatrolCookieHeader, /HttpOnly/i);
    assert.match(alphaPatrolCookieHeader, /SameSite=Strict/i);
    assert.match(alphaPatrolCookieHeader, /Path=\/api\/v1\/teams\/alpha\/patrol(?:;|$)/i);
    assert.match(betaPatrolCookieHeader, /Path=\/api\/v1\/teams\/beta\/patrol(?:;|$)/i);
    const alphaPatrolCookie = alphaPatrolCookieHeader.split(';')[0];
    const betaPatrolCookie = betaPatrolCookieHeader.split(';')[0];
    const uiHtml = await ui.text();
    assert.match(uiHtml, /id="agent-teams-ui"/);
    assert.match(uiHtml, /Ai-Agent-Teams-Zcode/);
    assert.match(uiHtml, /window\.__AGENT_TEAMS_UI__/);
    assert.doesNotMatch(uiHtml, /"token":"viewtoken"/);
    assert.doesNotMatch(uiHtml, /"token":/);
    assert.equal(uiHtml.includes('viewtoken'), false, 'the UI token must never be inlined in HTML');
    assert.doesNotMatch(uiHtml, /<link rel="stylesheet" href="\.\/team-view/);
    assert.doesNotMatch(uiHtml, /<script src="\.\/team-view-/);
    assert.match(uiHtml, /html\[data-theme="dark"\] #agent-teams-ui/);
    assert.match(uiHtml, /html\[data-theme="light"\] #agent-teams-ui/);
    assert.match(uiHtml, /__setEdgeFlow/);
    assert.equal((uiHtml.match(/<style>/g) ?? []).length, 3);
    assert.equal((uiHtml.match(/<script>/g) ?? []).length, 7);

    const snapshot = await fetch(`${base}/ui/snapshot`, {
      headers: { authorization: 'Bearer viewtoken' },
    });
    assert.equal(snapshot.status, 200);
    const snapshotData = await snapshot.json();
    assert.equal(snapshotData.data.teams[0].id, 'alpha');
    assert.equal(snapshotData.data.teams[0].tasks[0].id, 'a1');
    assert.deepEqual(snapshotData.data.teams[0].contractors, []);
    assert.equal(JSON.stringify(snapshotData.data).includes('licenseId'), false);
    assert.equal(JSON.stringify(snapshotData.data).includes('prompt'), false);

    const cookieSnapshot = await fetch(`${base}/ui/snapshot`, { headers: { cookie: uiCookie } });
    assert.equal(cookieSnapshot.status, 200);
    assert.equal((await cookieSnapshot.json()).data.teams[0].id, 'alpha');

    const consoleResponse = await fetch(`${base}/ui/console`, {
      headers: { authorization: 'Bearer viewtoken' },
    });
    assert.equal(consoleResponse.status, 200);
    const consoleData = (await consoleResponse.json()).data;
    assert.equal(consoleData.teams[0].id, 'alpha');
    assert.equal(consoleData.teams[0].capacity.workerSlots, 6);
    assert.equal(consoleData.teams[0].members[0].hasSession, false);
    assert.equal(consoleData.teams[0].members[0].sessionId, undefined);
    assert.equal(consoleData.teams[0].tasks[0].mergeState, null);
    assert.equal(consoleData.teams[0].patrol.intervalMinutes, 15);
    assert.equal(JSON.stringify(consoleData).includes('licenseId'), false);
    assert.equal(JSON.stringify(consoleData).includes('viewtoken'), false);

    const cookieConsole = await fetch(`${base}/ui/console`, { headers: { cookie: uiCookie } });
    assert.equal(cookieConsole.status, 200);
    assert.equal((await cookieConsole.json()).data.teams[0].id, 'alpha');
    assert.equal((await fetch(`${base}/ui/console`)).status, 401);

    assert.equal((await fetch(`${base}/ui/snapshot`)).status, 401);

    const uiHeaders = { authorization: 'Bearer viewtoken', 'content-type': 'application/json' };
    assert.equal((await fetch(`${base}/teams/alpha`, { headers: uiHeaders })).status, 403);
    assert.equal((await fetch(`${base}/teams/alpha/tasks/a1/update`, {
      method: 'POST',
      headers: uiHeaders,
      body: JSON.stringify({ attemptId: 'noop', status: 'completed' }),
    })).status, 403);
    // The session cookie is read-only too: it can never reach a write route or
    // be promoted to admin.
    const cookieHeaders = { cookie: uiCookie, 'content-type': 'application/json' };
    const patrolHeaders = { cookie: alphaPatrolCookie, origin: root };
    const patrolResponse = await fetch(`${base}/teams/alpha/patrol`, { method: 'POST', headers: patrolHeaders });
    assert.equal(patrolResponse.status, 200, 'same-origin scoped patrol cookie starts the requested team patrol');
    assert.deepEqual((await patrolResponse.json()).data, { ran: true, teamId: 'alpha' });
    assert.deepEqual(patrolCalls, ['alpha']);
    assert.equal((await fetch(`${base}/teams/beta/patrol`, { method: 'POST', headers: patrolHeaders })).status, 401,
      'the alpha patrol cookie cannot authorize beta');
    assert.equal((await fetch(`${base}/teams/alpha/patrol`, {
      method: 'POST', headers: { cookie: alphaPatrolCookie, origin: 'https://attacker.example' },
    })).status, 403, 'cross-origin requests with the patrol cookie are rejected');
    assert.equal((await fetch(`${base}/teams/alpha/patrol`, { method: 'POST', headers: { cookie: uiCookie, origin: root } })).status, 403,
      'the read-only UI cookie cannot start patrol');
    assert.equal((await fetch(`${base}/teams/alpha/patrol`, {
      method: 'POST', headers: { cookie: betaPatrolCookie, origin: root },
    })).status, 401, 'the beta patrol cookie cannot authorize alpha');
    assert.equal((await fetch(`${base}/teams/alpha/halt`, { method: 'POST', headers: { cookie: alphaPatrolCookie, origin: root } })).status, 401,
      'the patrol cookie cannot authorize another write route');
    assert.deepEqual(patrolCalls, ['alpha'], 'only the authorized alpha patrol reached the service');
    assert.equal((await fetch(`${base}/teams/alpha`, { headers: cookieHeaders })).status, 403);
    assert.equal((await fetch(`${base}/teams`, {
      method: 'POST',
      headers: cookieHeaders,
      body: JSON.stringify({ id: 'beta', name: 'Beta' }),
    })).status, 403);
    assert.equal((await fetch(`${base}/teams/alpha/tasks/a1/update`, {
      method: 'POST',
      headers: cookieHeaders,
      body: JSON.stringify({ attemptId: 'noop', status: 'completed' }),
    })).status, 403);
    assert.equal((await fetch(`${base}/ui/stream`, {
      headers: { cookie: `agent_teams_ui_${port}=wrong` },
    })).status, 401);
    const wrongCookie = { cookie: `agent_teams_ui_${port}=wrong` };
    assert.equal((await fetch(`${base}/ui/snapshot`, { headers: wrongCookie })).status, 401);
    assert.equal((await fetch(`${base}/ui/console`, { headers: wrongCookie })).status, 401);
    assert.equal((await fetch(`${base}/ui/snapshot`, { headers: { authorization: 'Bearer secret' } })).status, 200);
    assert.equal((await fetch(`${base}/messages`, { headers: cookieHeaders })).status, 403);
    assert.equal((await fetch(`${base}/ui/stream?token=bad`)).status, 401);

    const uiStream = await fetch(`${base}/ui/stream?token=viewtoken`);
    assert.equal(uiStream.status, 200);
    assert.match(uiStream.headers.get('content-type') ?? '', /text\/event-stream/);
    const streamReader = uiStream.body.getReader();
    const firstChunk = await streamReader.read();
    assert.match(Buffer.from(firstChunk.value ?? []).toString('utf8'), /connected/);
    await streamReader.cancel();

    const cookieStream = await fetch(`${base}/ui/stream`, { headers: { cookie: uiCookie } });
    assert.equal(cookieStream.status, 200);
    assert.match(cookieStream.headers.get('content-type') ?? '', /text\/event-stream/);
    const cookieReader = cookieStream.body.getReader();
    const cookieChunk = await cookieReader.read();
    assert.match(Buffer.from(cookieChunk.value ?? []).toString('utf8'), /connected/);
    await cookieReader.cancel();

    const bearerStream = await fetch(`${base}/ui/stream`, { headers: { authorization: 'Bearer viewtoken' } });
    assert.equal(bearerStream.status, 200);
    const bearerReader = bearerStream.body.getReader();
    const bearerChunk = await bearerReader.read();
    assert.match(Buffer.from(bearerChunk.value ?? []).toString('utf8'), /connected/);
    await bearerReader.cancel();

    const uiHead = await fetch(`${root}/ui`, { method: 'HEAD' });
    assert.equal(uiHead.status, 200);
    assert.match(uiHead.headers.get('content-type') ?? '', /text\/html/);
    assert.equal((await uiHead.text()).length, 0);

    const uiPost = await fetch(`${root}/ui`, { method: 'POST' });
    assert.equal(uiPost.status, 405);

    const hostileStatus = await new Promise((resolvePromise, rejectPromise) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: '/ui', headers: { host: 'evil.example' } }, (res) => {
        res.resume();
        res.on('end', () => resolvePromise(res.statusCode));
      });
      req.on('error', rejectPromise);
      req.end();
    });
    assert.equal(hostileStatus, 403);
    const missingHostStatus = await new Promise((resolvePromise, rejectPromise) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: '/ui', setHost: false }, (res) => {
        res.resume();
        res.on('end', () => resolvePromise(res.statusCode));
      });
      req.on('error', rejectPromise);
      req.end();
    });
    assert.ok([400, 403].includes(missingHostStatus));

    const missingUi = createApp({
      store, service, token: 'secret', uiAccessKey: '',
      teamViewPath: new URL('./missing-team-view.html', import.meta.url),
    });
    const missingPort = await listenForFetch(missingUi);
    assert.equal((await fetch(`http://127.0.0.1:${missingPort}/ui`)).status, 404);
    await missingUi.close();

    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    const healthData = (await health.json()).data;
    assert.equal(healthData.status, 'ok');
    assert.equal(healthData.pid, process.pid);

    assert.equal((await fetch(`${base}/teams`)).status, 401);

    const headers = { authorization: 'Bearer secret', 'content-type': 'application/json' };
    const teams = await fetch(`${base}/teams`, { headers });
    assert.equal(teams.status, 200);
    assert.equal((await teams.json()).data[0].id, 'alpha');

    const tick = await fetch(`${base}/teams/alpha/tick`, { method: 'POST', headers, body: '{}' });
    assert.equal(tick.status, 200);
    assert.equal((await tick.json()).data.dispatched, 1);

    const tasks = await fetch(`${base}/teams/alpha/tasks`, { headers });
    const task = (await tasks.json()).data[0];
    assert.equal(task.status, 'in_progress');

    const complete = await fetch(`${base}/teams/alpha/tasks/a1/complete`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ attemptId: task.attemptId, status: 'completed', output: 'done' }),
    });
    assert.equal(complete.status, 200);

    const audit = await fetch(`${base}/teams/alpha/audit`, { headers });
    assert.equal((await audit.json()).data.ok, true);
  } finally {
    await app.close();
    store.close();
  }
});

function memberHeaders(store, teamId, name) {
  const member = store.findMember(teamId, name);
  return {
    authorization: `Bearer ${store.getMemberToken(member.id)}`,
    'content-type': 'application/json',
  };
}

function appFixture({ members = [{ name: 'a1' }], configPath = 'config/example.v06.json' } = {}) {
  const { config } = loadConfig(configPath);
  const store = new Store(':memory:');
  const service = new TeamService({ homeRoot: testHomeRoot(),
    store, adapter: new FakeSessionAdapter(), config, cwd: process.cwd(), now: () => 1000,
  });
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running', members });
  return { store, service };
}

test('POST /teams forces staged/active for a shadow but keeps the admin phase/control', async () => {
  const shadowFixture = appFixture({
    members: [{ name: 'shadow', role: 'shadow' }, { name: 'lead', role: 'lead' }, { name: 'eng' }],
  });
  const shadowApp = createApp({ store: shadowFixture.store, service: shadowFixture.service, token: 'secret' });
  const shadowPort = await listenForFetch(shadowApp);
  const shadowBase = `http://127.0.0.1:${shadowPort}/api/v1`;
  try {
    const created = await fetch(`${shadowBase}/teams`, {
      method: 'POST',
      headers: memberHeaders(shadowFixture.store, 'alpha', 'shadow'),
      body: JSON.stringify({
        id: 'beta', name: 'Beta', phase: 'running', control: 'active', members: [{ name: 'b1' }],
      }),
    });
    assert.equal(created.status, 201);
    const team = (await created.json()).data;
    assert.equal(team.phase, 'staged', 'a shadow must not start a running team');
    assert.equal(team.control, 'active');
    assert.equal(shadowFixture.store.getTeam('beta').phase, 'staged');

    // A shadow may create a staged plan but cannot approve the plan it
    // created (SPEC 2.3.1 / INV-027); the admin/captain path approves it.
    const selfApproved = await fetch(`${shadowBase}/teams/beta/plan/approve`, {
      method: 'POST',
      headers: memberHeaders(shadowFixture.store, 'alpha', 'shadow'),
      body: '{}',
    });
    assert.equal(selfApproved.status, 403);
    assert.equal(shadowFixture.store.getTeam('beta').phase, 'staged');
    const approved = await fetch(`${shadowBase}/teams/beta/plan/approve`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(approved.status, 200);
    assert.equal(shadowFixture.store.getTeam('beta').phase, 'running');
    const halted = await fetch(`${shadowBase}/teams/beta/halt`, {
      method: 'POST',
      headers: memberHeaders(shadowFixture.store, 'alpha', 'shadow'),
      body: JSON.stringify({ reason: 'shadow halt' }),
    });
    assert.equal(halted.status, 200);
    assert.equal(shadowFixture.store.getTeam('beta').control, 'halted');
    const resumed = await fetch(`${shadowBase}/teams/beta/resume`, {
      method: 'POST',
      headers: memberHeaders(shadowFixture.store, 'alpha', 'shadow'),
      body: JSON.stringify({ reason: 'shadow resume' }),
    });
    assert.equal(resumed.status, 200);
    assert.equal(shadowFixture.store.getTeam('beta').control, 'active');

    for (const name of ['lead', 'eng']) {
      const denied = await fetch(`${shadowBase}/teams`, {
        method: 'POST',
        headers: memberHeaders(shadowFixture.store, 'alpha', name),
        body: JSON.stringify({ id: 'beta', name: 'Beta', phase: 'running', control: 'active' }),
      });
      assert.equal(denied.status, 403, `${name} must not create teams`);
    }
  } finally {
    await shadowApp.close();
    shadowFixture.store.close();
  }

  const adminFixture = appFixture({
    members: [{ name: 'shadow', role: 'shadow' }],
  });
  const adminApp = createApp({ store: adminFixture.store, service: adminFixture.service, token: 'secret' });
  const adminPort = await listenForFetch(adminApp);
  const adminBase = `http://127.0.0.1:${adminPort}/api/v1`;
  try {
    const created = await fetch(`${adminBase}/teams`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'beta', name: 'Beta', phase: 'running', control: 'active', members: [{ name: 'b1' }],
      }),
    });
    assert.equal(created.status, 201);
    const team = (await created.json()).data;
    assert.equal(team.phase, 'running');
    assert.equal(team.control, 'active');
  } finally {
    await adminApp.close();
    adminFixture.store.close();
  }
});

test('member writes to staged, halted and archived teams return 409; admin writes still work', async () => {
  const { store, service } = appFixture({
    members: [{ name: 'a1' }, { name: 'lead', role: 'lead' }],
  });
  const app = createApp({ store, service, token: 'secret' });
  const port = await listenForFetch(app);
  const base = `http://127.0.0.1:${port}/api/v1`;
  const a1 = memberHeaders(store, 'alpha', 'a1');
  const lead = memberHeaders(store, 'alpha', 'lead');
  const admin = { authorization: 'Bearer secret', 'content-type': 'application/json' };
  try {
    assert.equal((await fetch(`${base}/teams/alpha`, { headers: a1 })).status, 200);

    store.updateTeam('alpha', { phase: 'staged' });
    const staged = await fetch(`${base}/teams/alpha/messages`, {
      method: 'POST', headers: a1, body: JSON.stringify({ to: 'a1', content: 'blocked' }),
    });
    assert.equal(staged.status, 409);
    assert.equal((await staged.json()).error.code, 'E_STATE');
    assert.equal((await fetch(`${base}/teams/alpha`, { headers: a1 })).status, 200, 'reads stay available');

    const approve = await fetch(`${base}/teams/alpha/plan/approve`, {
      method: 'POST', headers: admin, body: '{}',
    });
    assert.equal(approve.status, 200, 'the admin token is exempt');
    assert.equal(store.getTeam('alpha').phase, 'running');

    store.updateTeam('alpha', { control: 'halted' });
    assert.equal((await fetch(`${base}/teams/alpha/messages`, {
      method: 'POST', headers: a1, body: JSON.stringify({ to: 'a1', content: 'halted' }),
    })).status, 409);
    const resumed = await fetch(`${base}/teams/alpha/resume`, {
      method: 'POST', headers: admin, body: JSON.stringify({ reason: 'captain resumes' }),
    });
    assert.equal(resumed.status, 200, 'the admin token is exempt');

    store.updateTeam('alpha', { phase: 'running', control: 'halted' });
    assert.equal((await fetch(`${base}/teams/alpha/tasks`, {
      method: 'POST', headers: lead,
      body: JSON.stringify({ id: 'lead-task', subject: 'halted work', kind: 'work', assignee: 'a1' }),
    })).status, 409, 'a lead is still a member');

    store.updateTeam('alpha', { phase: 'halted', control: 'active' });
    assert.equal((await fetch(`${base}/teams/alpha/messages`, {
      method: 'POST', headers: a1, body: JSON.stringify({ to: 'a1', content: 'halted phase' }),
    })).status, 409);

    store.updateTeam('alpha', { phase: 'archived', control: 'halted' });
    assert.equal((await fetch(`${base}/teams/alpha/messages`, {
      method: 'POST', headers: a1, body: JSON.stringify({ to: 'a1', content: 'archived' }),
    })).status, 409);
  } finally {
    await app.close();
    store.close();
  }
});

test('revoked or expired member licenses invalidate the member token', async () => {
  const { store, service } = appFixture({ members: [{ name: 'a1' }, { name: 'a2' }] });
  const app = createApp({ store, service, token: 'secret' });
  const port = await listenForFetch(app);
  const base = `http://127.0.0.1:${port}/api/v1`;
  const a1 = memberHeaders(store, 'alpha', 'a1');
  const a2 = memberHeaders(store, 'alpha', 'a2');
  try {
    assert.equal((await fetch(`${base}/teams/alpha`, { headers: a1 })).status, 200);

    const first = store.findMember('alpha', 'a1');
    const firstLicense = store.listLicenses('alpha', first.id).find((license) => license.status === 'active');
    store.updateLicense(firstLicense.id, { status: 'revoked' });
    assert.equal((await fetch(`${base}/teams/alpha`, { headers: a1 })).status, 401);

    const second = store.findMember('alpha', 'a2');
    const secondLicense = store.listLicenses('alpha', second.id).find((license) => license.status === 'active');
    store.updateLicense(secondLicense.id, { expiresAt: Date.now() - 1000 });
    assert.equal((await fetch(`${base}/teams/alpha`, { headers: a2 })).status, 401);

    store.updateLicense(secondLicense.id, { expiresAt: Date.now() + 60_000 });
    assert.equal((await fetch(`${base}/teams/alpha`, { headers: a2 })).status, 200);

    store.updateLicense(secondLicense.id, { expiresAt: null });
    assert.equal((await fetch(`${base}/teams/alpha`, { headers: a2 })).status, 200, 'null never expires');

    const snapshot = store.getMember(second.id);
    store.updateMember(second.id, { license: { ...snapshot.license, status: 'revoked' } });
    assert.equal((await fetch(`${base}/teams/alpha`, { headers: a2 })).status, 401, 'the member snapshot is checked too');
    store.updateMember(second.id, { license: { ...snapshot.license, status: 'active' } });
    assert.equal((await fetch(`${base}/teams/alpha`, { headers: a2 })).status, 200);

    // A license row that disappears must not be kept alive by the member
    // snapshot alone.
    store.db.prepare('DELETE FROM licenses WHERE id = ?').run(secondLicense.id);
    assert.equal((await fetch(`${base}/teams/alpha`, { headers: a2 })).status, 401);
  } finally {
    await app.close();
    store.close();
  }
});

test('SSE streams are capped per team and per UI and drop slow readers', async () => {
  let destroyed = false;
  const stalled = {
    destroyed: false,
    writableEnded: false,
    write() { return false; },
    destroy() { destroyed = true; },
  };
  assert.equal(writeSse(stalled, 'event: x\n\n'), false);
  assert.equal(destroyed, true, 'a slow client must be destroyed instead of buffered');

  const { config } = loadConfig('config/example.two-teams.json');
  const store = new Store(':memory:');
  const service = new TeamService({ homeRoot: testHomeRoot(),
    store, adapter: new FakeSessionAdapter(), config, cwd: process.cwd(), now: () => 1000,
  });
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running', members: [{ name: 'a1' }] });
  service.createTeam({ id: 'beta', name: 'Beta', phase: 'running', members: [{ name: 'b1' }] });
  const app = createApp({
    store, service, token: 'secret', uiToken: 'viewtoken', uiAccessKey: '',
    maxTeamStreams: 1, maxUiStreams: 1,
  });
  const port = await listenForFetch(app);
  const root = `http://127.0.0.1:${port}`;
  const base = `${root}/api/v1`;
  const readers = [];
  const openStream = async (url, headers) => {
    const response = await fetch(url, { headers });
    if (response.status !== 200) {
      const body = await response.json().catch(() => ({}));
      return { response, body };
    }
    const reader = response.body.getReader();
    const first = await reader.read();
    readers.push(reader);
    return { response, reader, first: Buffer.from(first.value ?? []).toString('utf8') };
  };
  const waitForSlot = async (url, headers) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const opened = await openStream(url, headers);
      if (opened.response.status === 200) return opened;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
    throw new Error('stream slot was not released');
  };
  const admin = { authorization: 'Bearer secret' };
  try {
    const alpha = await openStream(`${base}/teams/alpha/stream`, admin);
    assert.equal(alpha.response.status, 200);
    assert.match(alpha.first, /connected/);

    const alphaCapped = await openStream(`${base}/teams/alpha/stream`, admin);
    assert.equal(alphaCapped.response.status, 429);
    assert.equal(alphaCapped.body.error.code, 'E_TOO_MANY_STREAMS');

    const beta = await openStream(`${base}/teams/beta/stream`, admin);
    assert.equal(beta.response.status, 200, 'the cap is per team');
    assert.equal((await openStream(`${base}/teams/beta/stream`, admin)).response.status, 429);

    await alpha.reader.cancel();
    const alphaReopened = await waitForSlot(`${base}/teams/alpha/stream`, admin);
    assert.equal(alphaReopened.response.status, 200);

    const ui = await openStream(`${base}/ui/stream?token=viewtoken`, {});
    assert.equal(ui.response.status, 200);
    assert.match(ui.first, /connected/);
    const uiCapped = await openStream(`${base}/ui/stream?token=viewtoken`, {});
    assert.equal(uiCapped.response.status, 429);
    await ui.reader.cancel();
    const uiReopened = await waitForSlot(`${base}/ui/stream?token=viewtoken`, {});
    assert.equal(uiReopened.response.status, 200);
  } finally {
    for (const reader of readers) {
      try { await reader.cancel(); } catch { /* already closed */ }
    }
    app.server.closeAllConnections?.();
    await app.close();
    store.close();
  }
});

test('UI access key gates the loopback panel and is stored in an HttpOnly cookie', async () => {
  const { config } = loadConfig('config/example.two-teams.json');
  const store = new Store(':memory:');
  const adapter = new FakeSessionAdapter();
  const service = new TeamService({ homeRoot: testHomeRoot(), store, adapter, config, cwd: process.cwd(), now: () => 1000 });
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running', members: [{ name: 'a1' }] });
  service.addTask('alpha', { id: 'dollar', subject: "$' literal", assignee: 'a1', kind: 'work' });
  const app = createApp({
    store,
    service,
    token: 'secret',
    uiToken: 'viewtoken',
    uiAccessKey: 'local-ui-key',
  });
  const port = await listenForFetch(app);
  const root = `http://127.0.0.1:${port}`;
  try {
    const denied = await fetch(`${root}/ui`);
    assert.equal(denied.status, 403);
    const wrong = await fetch(`${root}/ui?key=wrong-key`);
    assert.equal(wrong.status, 403);

    const opened = await fetch(`${root}/ui?key=local-ui-key`);
    assert.equal(opened.status, 200);
    const cookies = opened.headers.getSetCookie();
    const accessCookie = cookies.find((item) => item.startsWith(`at_ui_${port}=`)) ?? '';
    const sessionCookie = cookies.find((item) => item.startsWith(`agent_teams_ui_${port}=`)) ?? '';
    assert.equal(cookies.length, 3, 'the access key, UI session and team-scoped patrol cookies must coexist');
    const patrolCookie = cookies.find((item) => item.startsWith(`agent_teams_patrol_${port}_YWxwaGE=`)) ?? '';
    assert.match(patrolCookie, /HttpOnly/i);
    assert.match(patrolCookie, /SameSite=Strict/i);
    assert.match(patrolCookie, /Path=\/api\/v1\/teams\/alpha\/patrol(?:;|$)/i);
    assert.match(accessCookie, new RegExp(`at_ui_${port}=local-ui-key`));
    assert.match(accessCookie, /HttpOnly/i);
    assert.match(accessCookie, /Path=\/ui/i);
    assert.match(sessionCookie, new RegExp(`^agent_teams_ui_${port}=viewtoken;`));
    assert.match(sessionCookie, /HttpOnly/i);
    assert.match(sessionCookie, /Path=\/api\/v1\/ui/i);
    const html = await opened.text();
    assert.match(html, /window\.__AGENT_TEAMS_UI__/);
    assert.equal((html.match(/<script>window\.__AGENT_TEAMS_UI__=/g) ?? []).length, 1);
    assert.ok(!html.includes('AGENT_TEAMS_UI_BOOTSTRAP'));
    assert.ok(html.includes("$' literal"));
    assert.ok(!html.includes('local-ui-key'));
    assert.ok(!html.includes('viewtoken'), 'the UI token must not leak into the page');

    const cookiePair = accessCookie.split(';')[0];
    const withCookie = await fetch(`${root}/ui`, { headers: { cookie: cookiePair } });
    assert.equal(withCookie.status, 200);
    const wrongCookie = await fetch(`${root}/ui`, { headers: { cookie: `at_ui_${port}=wrong` } });
    assert.equal(wrongCookie.status, 403);
    const sessionOnly = await fetch(`${root}/ui`, { headers: { cookie: sessionCookie.split(';')[0] } });
    assert.equal(sessionOnly.status, 403, 'the UI session cookie must not replace the access key gate');
    const head = await fetch(`${root}/ui?key=local-ui-key`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal((await head.text()).length, 0);
  } finally {
    await app.close();
    store.close();
  }
});
