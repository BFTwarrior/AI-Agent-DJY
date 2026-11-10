import { testHomeRoot } from './support/cleanup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/http/server.mjs';
import { loadConfig } from '../src/config.mjs';
import { FakeSessionAdapter } from '../src/session/adapter.mjs';
import { TeamService } from '../src/scheduler-service.mjs';
import { Store } from '../src/store.mjs';
import { listenForFetch } from './support/listen.mjs';

test('a team lead can publish and manage tasks in its own team; a plain member cannot', async () => {
  const { config } = loadConfig('config/example.v06.json');
  const store = new Store(':memory:');
  const adapter = new FakeSessionAdapter();
  const service = new TeamService({ homeRoot: testHomeRoot(), store, adapter, config, cwd: process.cwd(), now: () => 1000 });
  service.createTeam({
    id: 'alpha', name: 'Alpha', phase: 'running',
    members: [{ name: 'lead', role: 'lead' }, { name: 'eng', role: 'engineer' }],
  });
  service.createTeam({ id: 'beta', name: 'Beta', phase: 'running', members: [{ name: 'b1', role: 'engineer' }] });
  const app = createApp({ store, service, token: 'admin' });
  const port = await listenForFetch(app);
  const base = `http://127.0.0.1:${port}/api/v1`;
  const lead = store.findMember('alpha', 'lead');
  const eng = store.findMember('alpha', 'eng');
  const leadHeaders = {
    authorization: `Bearer ${store.getMemberToken(lead.id)}`,
    'content-type': 'application/json',
  };
  const engHeaders = {
    authorization: `Bearer ${store.getMemberToken(eng.id)}`,
    'content-type': 'application/json',
  };
  try {
    assert.equal(lead.license.roleKey, 'lead');
    assert.ok(lead.license.capabilities.includes('team:lead'));
    assert.equal(lead.license.toolPolicy, 'workspace-write');

    const created = await fetch(`${base}/teams/alpha/tasks`, {
      method: 'POST', headers: leadHeaders,
      body: JSON.stringify({ id: 'lead-task', subject: 'lead-created work', kind: 'work', assignee: 'eng' }),
    });
    assert.equal(created.status, 201);

    await service.tick('alpha');
    const dispatched = store.getTask('lead-task');
    assert.ok(dispatched.attemptId, 'the lead-created task should be dispatched to the engineer');

    const amended = await fetch(`${base}/teams/alpha/tasks/lead-task/amend`, {
      method: 'POST', headers: leadHeaders,
      body: JSON.stringify({ fields: { objective: 'updated by lead' }, reason: 'lead contract update' }),
    });
    assert.equal(amended.status, 403, 'task contracts are captain/shadow-only');
    assert.equal(store.getTask('lead-task').objective, undefined);
    assert.equal((store.getTask('lead-task').revisions ?? []).length, 0);

    const completed = await fetch(`${base}/teams/alpha/tasks/lead-task/complete`, {
      method: 'POST', headers: leadHeaders,
      body: JSON.stringify({ attemptId: dispatched.attemptId, status: 'completed', output: 'closed by lead' }),
    });
    assert.equal(completed.status, 200);
    assert.equal((await completed.json()).data.task.status, 'completed');

    const second = await fetch(`${base}/teams/alpha/tasks`, {
      method: 'POST', headers: leadHeaders,
      body: JSON.stringify({ id: 'lead-task-2', subject: 'second task', kind: 'work', assignee: 'eng' }),
    });
    assert.equal(second.status, 201);
    const reassigned = await fetch(`${base}/teams/alpha/tasks/lead-task-2/reassign`, {
      method: 'POST', headers: leadHeaders,
      body: JSON.stringify({ assignee: 'lead', reason: 'lead takes the task' }),
    });
    assert.equal(reassigned.status, 200);
    assert.equal((await reassigned.json()).data.assignee, 'lead');

    const patrol = await fetch(`${base}/teams/alpha/patrol`, {
      method: 'POST', headers: leadHeaders, body: '{}',
    });
    assert.equal(patrol.status, 200);

    const plainCreate = await fetch(`${base}/teams/alpha/tasks`, {
      method: 'POST', headers: engHeaders,
      body: JSON.stringify({ id: 'eng-task', subject: 'not allowed', kind: 'work', assignee: 'eng' }),
    });
    assert.equal(plainCreate.status, 403);

    const crossTeam = await fetch(`${base}/teams/beta/tasks`, {
      method: 'POST', headers: leadHeaders,
      body: JSON.stringify({ id: 'cross-task', subject: 'not allowed', kind: 'work' }),
    });
    assert.equal(crossTeam.status, 403);

    const addMember = await fetch(`${base}/teams/alpha/members`, {
      method: 'POST', headers: leadHeaders,
      body: JSON.stringify({ name: 'extra', role: 'engineer' }),
    });
    assert.equal(addMember.status, 403);

    const relicense = await fetch(`${base}/teams/alpha/members/${lead.id}/relicense`, {
      method: 'POST', headers: leadHeaders,
      body: JSON.stringify({ label: 'Lead' }),
    });
    assert.equal(relicense.status, 403);

    const createTeam = await fetch(`${base}/teams`, {
      method: 'POST', headers: leadHeaders,
      body: JSON.stringify({ id: 'alpha', name: 'Alpha 2' }),
    });
    assert.equal(createTeam.status, 403);
  } finally {
    await app.close();
    store.close();
  }
});
