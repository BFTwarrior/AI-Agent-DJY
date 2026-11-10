import { testHomeRoot } from './support/cleanup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/http/server.mjs';
import { loadConfig } from '../src/config.mjs';
import { FakeSessionAdapter } from '../src/session/adapter.mjs';
import { TeamService } from '../src/scheduler-service.mjs';
import { Store } from '../src/store.mjs';
import { listenForFetch } from './support/listen.mjs';

test('v0.6 HTTP exposes licenses, lifecycle, sleep/wake, contractors and patrol', async () => {
  const { config } = loadConfig('config/example.v06.json');
  const store = new Store(':memory:');
  const adapter = new FakeSessionAdapter();
  const service = new TeamService({ homeRoot: testHomeRoot(),
    store, adapter, config, cwd: process.cwd(), now: () => 1000,
    memoryUsage: () => ({ rssBytes: 1, budgetBytes: 100 }),
  });
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running', members: [{ name: 'a1' }] });
  service.createTeam({ id: 'beta', name: 'Beta', phase: 'running', members: [{ name: 'b1' }, { name: 'b2' }] });
  service.addTask('alpha', { id: 't1', subject: 'work', kind: 'work', assignee: 'a1' });
  await service.tick('alpha');
  const app = createApp({ store, service, token: 'secret' });
  const port = await listenForFetch(app);
  const base = `http://127.0.0.1:${port}/api/v1`;
  const headers = { authorization: 'Bearer secret', 'content-type': 'application/json' };
  try {
    const member = store.listMembers('alpha')[0];
    const task = store.getTask('t1');
    await service.completeTask({
      teamId: 'alpha', taskId: 't1', attemptId: task.attemptId,
      update: { status: 'completed', output: 'done' },
    });

    const licenses = await fetch(`${base}/teams/alpha/licenses`, { headers });
    assert.equal(licenses.status, 200);
    assert.equal((await licenses.json()).data.length, 1);

    const sleep = await fetch(`${base}/teams/alpha/members/${member.id}/sleep`, {
      method: 'POST', headers, body: JSON.stringify({ reason: 'test' }),
    });
    assert.equal(sleep.status, 200);
    assert.equal((await sleep.json()).data.ok, true);

    const wake = await fetch(`${base}/teams/alpha/members/${member.id}/wake`, {
      method: 'POST', headers, body: '{}',
    });
    assert.equal(wake.status, 200);

    const lifecycle = await fetch(`${base}/teams/alpha/lifecycle`, { headers });
    assert.equal(lifecycle.status, 200);
    assert.equal(typeof (await lifecycle.json()).data.hot, 'number');

    const submitted = await fetch(`${base}/teams/alpha/contractors`, {
      method: 'POST', headers,
      body: JSON.stringify({ purpose: 'test', prompt: 'return ok' }),
    });
    assert.equal(submitted.status, 202);
    const submittedBody = await submitted.json();
    assert.equal(submittedBody.data.slot, 'main');
    const contractorId = submittedBody.data.id;
    let contractor;
    for (let i = 0; i < 50; i += 1) {
      const current = await fetch(`${base}/teams/alpha/contractors/${contractorId}`, { headers });
      contractor = (await current.json()).data;
      if (['completed', 'failed', 'killed'].includes(contractor.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(contractor.status, 'completed');

    const list = await fetch(`${base}/teams/alpha/contractors`, { headers });
    assert.equal((await list.json()).data.length, 1);

    const badSlot = await fetch(`${base}/teams/alpha/contractors`, {
      method: 'POST', headers,
      body: JSON.stringify({ slot: 'merge', purpose: 'research', prompt: 'wrong slot' }),
    });
    assert.equal(badSlot.status, 400);
    assert.equal((await badSlot.json()).error.code, 'E_INVALID');

    const badMode = await fetch(`${base}/teams/alpha/contractors`, {
      method: 'POST', headers,
      body: JSON.stringify({ purpose: 'research', prompt: 'bad mode', mode: 'bogus' }),
    });
    assert.equal(badMode.status, 400);

    const unknown = await fetch(`${base}/teams/alpha/contractors/ctr_missing`, { headers });
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error.code, 'E_NOT_FOUND');

    const killUnknown = await fetch(`${base}/teams/alpha/contractors/ctr_missing/kill`, { method: 'POST', headers, body: '{}' });
    assert.equal(killUnknown.status, 404);

    const cross = await fetch(`${base}/teams/alpha/messages`, {
      method: 'POST', headers,
      body: JSON.stringify({ toTeam: 'beta', to: 'captain', content: 'alpha progress' }),
    });
    assert.equal(cross.status, 201);
    const crossBody = await cross.json();
    assert.equal(crossBody.data.approvalState, 'pending_captain');
    const pending = await fetch(`${base}/messages/pending`, { headers });
    assert.equal(pending.status, 200);
    assert.ok((await pending.json()).data.some((message) => message.id === crossBody.data.id));
    const betaMember = store.listMembers('beta')[0];
    const betaToken = store.getMemberToken(betaMember.id);
    const betaHeaders = { authorization: `Bearer ${betaToken}`, 'content-type': 'application/json' };
    const memberPending = await fetch(`${base}/messages/pending`, { headers: betaHeaders });
    assert.equal(memberPending.status, 403);
    const memberApprove = await fetch(`${base}/messages/${crossBody.data.id}/approve`, { method: 'POST', headers: betaHeaders, body: '{}' });
    assert.equal(memberApprove.status, 403);
    const betaInbox = await fetch(`${base}/teams/beta/messages`, { headers: betaHeaders });
    assert.equal(betaInbox.status, 200);
    assert.equal((await betaInbox.json()).data.some((message) => message.id === crossBody.data.id), false);
    const spoof = await fetch(`${base}/teams/beta/messages`, {
      method: 'POST', headers: betaHeaders,
      body: JSON.stringify({ to: 'a1', toTeam: 'alpha', content: 'spoof', approvalState: 'approved', teamId: 'alpha' }),
    });
    assert.equal(spoof.status, 201);
    const spoofBody = (await spoof.json()).data;
    assert.equal(spoofBody.approvalState, 'pending_captain');
    assert.equal(spoofBody.teamId, 'alpha');
    assert.equal(spoofBody.fromTeamId, 'beta');

    const approved = await fetch(`${base}/messages/${crossBody.data.id}/approve`, { method: 'POST', headers, body: '{}' });
    assert.equal(approved.status, 200);
    assert.equal((await approved.json()).data.approvalState, 'approved');

    service.addTask('beta', { id: 'bt1', subject: 'beta work', kind: 'work', assignee: 'b1' });
    await service.tick('beta');
    const betaTask = store.getTask('bt1');
    const b2 = store.findMember('beta', 'b2');
    const b2Token = store.getMemberToken(b2.id);
    const b2Headers = { authorization: `Bearer ${b2Token}`, 'content-type': 'application/json' };
    const badClaim = await fetch(`${base}/teams/beta/tasks/bt1/claim`, {
      method: 'POST', headers: b2Headers, body: JSON.stringify({ member: 'b2', attemptId: betaTask.attemptId }),
    });
    assert.equal(badClaim.status, 403);
    const badHeartbeat = await fetch(`${base}/teams/beta/tasks/bt1/heartbeat`, {
      method: 'POST', headers: b2Headers, body: JSON.stringify({ attemptId: betaTask.attemptId }),
    });
    assert.equal(badHeartbeat.status, 403);
    const badUpdate = await fetch(`${base}/teams/beta/tasks/bt1/update`, {
      method: 'POST', headers: b2Headers,
      body: JSON.stringify({ attemptId: betaTask.attemptId, status: 'completed', output: 'forged' }),
    });
    assert.equal(badUpdate.status, 403);

    const patrol = await fetch(`${base}/teams/alpha/patrol`, { method: 'POST', headers, body: '{}' });
    assert.equal(patrol.status, 200);
  } finally {
    await app.close();
    store.close();
  }
});

test('v0.6 member tokens are scoped and cannot call captain routes', async () => {
  const { config } = loadConfig('config/example.v06.json');
  const store = new Store(':memory:');
  const adapter = new FakeSessionAdapter();
  const service = new TeamService({ homeRoot: testHomeRoot(), store, adapter, config, cwd: process.cwd(), now: () => 1000 });
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running', members: [{ name: 'a1' }] });
  service.addTask('alpha', { id: 't1', subject: 'work', kind: 'work', assignee: 'a1' });
  await service.tick('alpha');
  const member = store.listMembers('alpha')[0];
  const memberToken = store.getMemberToken(member.id);
  assert.ok(memberToken);
  const app = createApp({ store, service, token: 'admin' });
  const port = await listenForFetch(app);
  const base = `http://127.0.0.1:${port}/api/v1`;
  const headers = { authorization: `Bearer ${memberToken}`, 'content-type': 'application/json' };
  try {
    const denied = await fetch(`${base}/teams/alpha/members/${member.id}/relicense`, {
      method: 'POST', headers, body: JSON.stringify({ label: 'Admin' }),
    });
    assert.equal(denied.status, 403);

    const task = store.getTask('t1');
    const allowed = await fetch(`${base}/teams/alpha/tasks/t1/update`, {
      method: 'POST', headers, body: JSON.stringify({ attemptId: task.attemptId, status: 'in_progress' }),
    });
    assert.equal(allowed.status, 200);

    const crossTeam = await fetch(`${base}/teams/beta`, { headers });
    assert.equal(crossTeam.status, 403);
  } finally {
    await app.close();
    store.close();
  }
});
