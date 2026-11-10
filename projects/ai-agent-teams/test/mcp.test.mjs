import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoveryPathForWorkspace } from '../src/discovery.mjs';
import { createMcpHandler, TOOL_DEFINITIONS } from '../src/mcp/handler.mjs';
import { readFileSync } from 'node:fs';

// The reported serverInfo version must track the shipped package, so
// read it instead of pinning a literal that every release bump breaks.
const PACKAGE_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

// The test runner inherits the developer/CI shell. A member token would switch
// the handler into member mode (hiding captain tools) and a live daemon would
// change the initialize instructions, so every test below opts in explicitly
// instead of depending on ambient AGENT_TEAMS_* variables.
for (const key of [
  'AGENT_TEAMS_URL',
  'AGENT_TEAMS_TOKEN',
  'AGENT_TEAMS_MEMBER',
  'AGENT_TEAMS_TEAM',
  'AGENT_TEAMS_WORKSPACE',
  'AGENT_TEAMS_AUTOSTART',
]) {
  delete process.env[key];
}

function fakeFetch(calls) {
  return async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, data: { id: 'alpha', members: [{ id: 'm1', name: 'a1' }], tasks: [] }, error: null }),
    };
  };
}

test('MCP exposes the tool catalog and handles initialize/tools call', async () => {
  const calls = [];
  // The PANEL_STARTUP_RULE is injected only for a team workspace. Use a
  // disposable team config so the assertion does not depend on the checkout or
  // on a live daemon having been discovered for it.
  const workspace = mkdtempSync(join(tmpdir(), 'zat-panel-workspace-'));
  mkdirSync(join(workspace, '.ai-agent-teams'), { recursive: true });
  const handle = createMcpHandler({
    workspace,
    fetchImpl: fakeFetch(calls),
    baseUrl: 'http://daemon',
    token: 't',
    defaultTeam: 'alpha',
  });
  assert.equal(TOOL_DEFINITIONS.length, 37);

  const init = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(init.result.serverInfo.name, 'ai-agent-teams');
  assert.equal(init.result.serverInfo.version, PACKAGE_VERSION);
  assert.equal(init.result.capabilities.resources !== undefined, true);
  assert.match(init.result.instructions, /Team panel/);
  assert.match(init.result.instructions, /panel --open/);
  assert.match(init.result.instructions, /Automatic team rule/);
  assert.match(init.result.instructions, /10 minutes/);
  // Only this fixture's exact workspace path is data, not English prose.
  const workspaceLine = `Current team workspace: ${workspace}\n`;
  assert.ok(init.result.instructions.includes(workspaceLine));
  const prose = init.result.instructions.replace(workspaceLine, 'Current team workspace: <fixture>\n');
  assert.doesNotMatch(prose, /[\u3400-\u9fff]/u);
  // A team workspace alone must not make a plain test session open the panel.
  assert.doesNotMatch(init.result.instructions, /Session startup rule/);
  const previousAutoPanel = process.env.AI_AGENT_TEAMS_AUTO_PANEL;
  process.env.AI_AGENT_TEAMS_AUTO_PANEL = '1';
  try {
    const optIn = await handle({ jsonrpc: '2.0', id: 11, method: 'initialize', params: {} });
    assert.match(optIn.result.instructions, /Session startup rule/);
    assert.match(optIn.result.instructions, /agent_teams_view/);
  } finally {
    if (previousAutoPanel === undefined) delete process.env.AI_AGENT_TEAMS_AUTO_PANEL;
    else process.env.AI_AGENT_TEAMS_AUTO_PANEL = previousAutoPanel;
  }

  const list = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(list.result.tools.length, 37);
  const view = TOOL_DEFINITIONS.find((item) => item.name === 'agent_teams_view');
  assert.equal(view?._meta?.ui?.resourceUri, 'ui://ai-agent-teams/panel.html');
  // fullscreen + surface is what makes ZCode open the registered side-pane tab.
  assert.equal(view?._meta?.ui?.preferredDisplayMode, 'fullscreen');
  assert.equal(view?._meta?.ui?.surface, 'ai-agent-teams');
  assert.equal(view?._meta?.ui?.showInline, undefined);
  const snapshot = TOOL_DEFINITIONS.find((item) => item.name === 'agent_teams_view_snapshot');
  assert.equal(snapshot?._meta?.ui?.preferredDisplayMode, 'inline');

  const status = await handle({
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'agent_teams_status', arguments: {} },
  });
  assert.equal(status.result.isError, false);
  assert.ok(calls.some((call) => call.url.endsWith('/api/v1/teams/alpha')));
  assert.ok(calls.some((call) => call.url.endsWith('/audit')));

  const route = await handle({
    jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: 'agent_teams_route', arguments: { independent_subtasks: 2, estimated_minutes: 20 } },
  });
  assert.equal(route.result.isError, false);
  const routeDecision = JSON.parse(route.result.content[0].text);
  assert.equal(routeDecision.mode, 'team');
  assert.match(routeDecision.reasons.join('\n'), /independent subtasks/);

  for (const [name, args, suffix] of [
    ['agent_teams_contractor_status', { contractor_id: 'ctr_1' }, '/contractors/ctr_1'],
    ['agent_teams_contractor_result', { contractor_id: 'ctr_1' }, '/contractors/ctr_1'],
    ['agent_teams_list_contractors', { slot: 'merge' }, '/contractors?slot=merge'],
    ['agent_teams_pending_messages', {}, '/messages/pending'],
    ['agent_teams_approve_message', { message_id: 'msg_1' }, '/messages/msg_1/approve'],
    ['agent_teams_reject_message', { message_id: 'msg_1', reason: 'no' }, '/messages/msg_1/reject'],
    ['agent_teams_shadow_status', {}, '/shadow'],
    ['agent_teams_shadow_start', {}, '/shadow/start'],
    ['agent_teams_shadow_stop', { reason: 'done' }, '/shadow/stop'],
  ]) {
    const result = await handle({
      jsonrpc: '2.0', id: 10, method: 'tools/call',
      params: { name, arguments: args },
    });
    assert.equal(result.result.isError, false);
    assert.ok(calls.some((call) => call.url.endsWith(suffix)));
  }
});

test('MCP switches team workspaces and falls back in a bare host folder', async () => {
  const projectA = mkdtempSync(join(tmpdir(), 'zat-project-a-'));
  const projectB = mkdtempSync(join(tmpdir(), 'zat-project-b-'));
  const bare = mkdtempSync(join(tmpdir(), 'zat-bare-'));
  mkdirSync(join(projectA, '.ai-agent-teams'), { recursive: true });
  mkdirSync(join(projectB, '.ai-agent-teams'), { recursive: true });
  const statePath = join(mkdtempSync(join(tmpdir(), 'zat-state-')), 'active.json');

  const call = async (handle, name, args = {}) => {
    const response = await handle({
      jsonrpc: '2.0', id: 90, method: 'tools/call', params: { name, arguments: args },
    });
    if (response.result.isError) return { error: response.result.content[0].text };
    return JSON.parse(response.result.content[0].text);
  };

  let handle = createMcpHandler({
    workspace: projectA, statePath, discoveries: [], fetchImpl: fakeFetch([]), baseUrl: 'http://daemon', token: 't',
  });
  assert.equal((await call(handle, 'agent_teams_workspace', { action: 'current' })).workspace, projectA);

  const used = await call(handle, 'agent_teams_workspace', { action: 'use', workspace: projectB });
  assert.equal(used.workspace, projectB);
  assert.equal(used.source, 'active');
  assert.equal((await call(handle, 'agent_teams_workspace', { action: 'current' })).workspace, projectB);

  // A new MCP process (ZCode's default workspace) sees no team state, so it
  // uses the saved target instead of failing on the host folder.
  handle = createMcpHandler({
    workspace: bare, statePath, discoveries: [], fetchImpl: fakeFetch([]), baseUrl: 'http://daemon', token: 't',
  });
  const fallback = await call(handle, 'agent_teams_workspace', { action: 'current' });
  assert.equal(fallback.workspace, projectB);
  assert.equal(fallback.source, 'saved');
  assert.equal(fallback.fallback, true);

  const auto = await call(handle, 'agent_teams_workspace', { action: 'auto' });
  assert.equal(auto.workspace, bare);
  assert.equal(auto.source, 'startup');

  const invalid = await call(handle, 'agent_teams_workspace', { action: 'use', workspace: join(bare, 'missing') });
  assert.match(invalid.error, /does not exist/);
});

test('every tool schema accepts an optional per-call workspace', () => {
  for (const tool of TOOL_DEFINITIONS) {
    if (tool.name === 'agent_teams_workspace') continue;
    assert.equal(tool.inputSchema.properties.workspace.type, 'string', tool.name);
    assert.ok(!(tool.inputSchema.required ?? []).includes('workspace'), tool.name);
  }
  const workspaceTool = TOOL_DEFINITIONS.find((tool) => tool.name === 'agent_teams_workspace');
  assert.deepEqual(workspaceTool.inputSchema.properties.action.enum, ['current', 'list', 'use', 'auto']);
});

test('member MCP hides the workspace tool and cannot write the saved target', async () => {
  const handle = createMcpHandler({
    fetchImpl: fakeFetch([]), baseUrl: 'http://daemon', token: 't', defaultMember: 'a1',
  });
  const list = await handle({ jsonrpc: '2.0', id: 91, method: 'tools/list' });
  assert.equal(list.result.tools.length, 29);
  assert.equal(list.result.tools.some((tool) => tool.name === 'agent_teams_workspace'), false);
  for (const tool of list.result.tools) {
    assert.equal(tool.inputSchema.properties.workspace, undefined, tool.name);
  }
  const response = await handle({
    jsonrpc: '2.0', id: 92, method: 'tools/call',
    params: { name: 'agent_teams_workspace', arguments: { action: 'current' } },
  });
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /captain/);
});

test('agent_teams_workspace use rejects a dead discovery and accepts a live one', async () => {
  const previous = process.env.AGENT_TEAMS_DISCOVERY_BASE;
  const base = mkdtempSync(join(tmpdir(), 'zat-handler-discovery-'));
  const dead = mkdtempSync(join(tmpdir(), 'zat-dead-ws-'));
  const live = mkdtempSync(join(tmpdir(), 'zat-live-ws-'));
  process.env.AGENT_TEAMS_DISCOVERY_BASE = base;
  try {
    const deadPath = discoveryPathForWorkspace(dead);
    const livePath = discoveryPathForWorkspace(live);
    mkdirSync(join(deadPath, '..'), { recursive: true });
    mkdirSync(join(livePath, '..'), { recursive: true });
    const record = (workspace, port, pid) => ({
      port, token: `token-${port}`, pid, version: '0.1.8', workspace,
      startedAt: Date.now(), apiVersion: 'v1',
    });
    writeFileSync(deadPath, JSON.stringify(record(dead, 8801, 999999)), 'utf8');
    writeFileSync(livePath, JSON.stringify(record(live, 8802, process.pid)), 'utf8');
    const statePath = join(mkdtempSync(join(tmpdir(), 'zat-state-')), 'active.json');
    const handle = createMcpHandler({
      workspace: mkdtempSync(join(tmpdir(), 'zat-bare-')), statePath, discoveries: [],
      fetchImpl: fakeFetch([]), baseUrl: 'http://daemon', token: 't',
    });
    const call = async (args) => {
      const response = await handle({
        jsonrpc: '2.0', id: 93, method: 'tools/call',
        params: { name: 'agent_teams_workspace', arguments: args },
      });
      return response.result;
    };
    const rejected = await call({ action: 'use', workspace: dead });
    assert.equal(rejected.isError, true);
    assert.match(rejected.content[0].text, /live daemon/);
    const accepted = await call({ action: 'use', workspace: live });
    assert.equal(accepted.isError, false);
    assert.equal(JSON.parse(accepted.content[0].text).workspace, live);
  } finally {
    if (previous === undefined) delete process.env.AGENT_TEAMS_DISCOVERY_BASE;
    else process.env.AGENT_TEAMS_DISCOVERY_BASE = previous;
  }
});

test('switching workspace routes subsequent calls to that daemon', async () => {
  const previous = process.env.AGENT_TEAMS_DISCOVERY_BASE;
  const base = mkdtempSync(join(tmpdir(), 'zat-route-discovery-'));
  const projectA = mkdtempSync(join(tmpdir(), 'zat-route-a-'));
  const projectB = mkdtempSync(join(tmpdir(), 'zat-route-b-'));
  mkdirSync(join(projectA, '.ai-agent-teams'), { recursive: true });
  mkdirSync(join(projectB, '.ai-agent-teams'), { recursive: true });
  process.env.AGENT_TEAMS_DISCOVERY_BASE = base;
  for (const [workspace, port] of [[projectA, 8801], [projectB, 8802]]) {
    const path = discoveryPathForWorkspace(workspace);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify({
      port, token: `token-${port}`, pid: process.pid, version: '0.1.8',
      workspace, startedAt: Date.now(), apiVersion: 'v1',
    }), 'utf8');
  }
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET' });
    return { ok: true, status: 200, json: async () => ({ ok: true, data: [] }) };
  };
  try {
    const statePath = join(mkdtempSync(join(tmpdir(), 'zat-state-')), 'active.json');
    const handle = createMcpHandler({
      workspace: mkdtempSync(join(tmpdir(), 'zat-route-bare-')), statePath, discoveries: [], fetchImpl,
    });
    const call = async (name, args = {}) => {
      const response = await handle({ jsonrpc: '2.0', id: 94, method: 'tools/call', params: { name, arguments: args } });
      assert.equal(response.result.isError, false, response.result.content[0].text);
      return JSON.parse(response.result.content[0].text);
    };
    await call('agent_teams_workspace', { action: 'use', workspace: projectA });
    const listed = await call('agent_teams_workspace', { action: 'list' });
    assert.equal(listed.workspaces.find((item) => item.workspace === projectA).current, true);
    await call('agent_teams_status', {});
    await call('agent_teams_workspace', { action: 'use', workspace: projectB });
    await call('agent_teams_status', {});
    const ports = calls.filter((item) => item.url.endsWith('/api/v1/teams')).map((item) => new URL(item.url).port);
    assert.deepEqual(ports, ['8801', '8802']);
  } finally {
    if (previous === undefined) delete process.env.AGENT_TEAMS_DISCOVERY_BASE;
    else process.env.AGENT_TEAMS_DISCOVERY_BASE = previous;
  }
});

test('a folder without team config never auto-starts a daemon', async () => {
  let ensureCalls = 0;
  const workspace = mkdtempSync(join(tmpdir(), 'zat-no-config-'));
  const handle = createMcpHandler({
    workspace,
    statePath: join(workspace, 'isolated-active-workspace.json'),
    discoveries: [],
    baseUrl: 'http://127.0.0.1:1',
    token: 'test-only-token',
    fetchImpl: async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); },
    ensureDaemon: async () => { ensureCalls += 1; return { started: true }; },
  });
  const response = await handle({
    jsonrpc: '2.0', id: 98, method: 'tools/call',
    params: { name: 'agent_teams_status', arguments: { workspace } },
  });
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /has no team config/);
  assert.equal(ensureCalls, 0);
});

test('a non-idempotent request is not replayed after a timeout', async () => {
  const calls = [];
  let ensureCalls = 0;
  const handle = createMcpHandler({
    workspace: process.cwd(),
    baseUrl: 'http://daemon', token: 't',
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method ?? 'GET' });
      throw new Error('daemon timed out');
    },
    ensureDaemon: async () => { ensureCalls += 1; return { started: false }; },
  });
  const response = await handle({
    jsonrpc: '2.0', id: 95, method: 'tools/call',
    params: { name: 'agent_teams_merge_and_review', arguments: { team_id: 'alpha', task_id: 't1' } },
  });
  assert.equal(response.result.isError, true);
  // A slow daemon is not probed/killed; only a connection failure justifies
  // ensureDaemon.
  assert.equal(ensureCalls, 0);
  assert.equal(calls.length, 1);
});

test('create_task strips the workspace routing field from the daemon body', async () => {
  const calls = [];
  const handle = createMcpHandler({
    fetchImpl: fakeFetch(calls), baseUrl: 'http://daemon', token: 't', defaultTeam: 'alpha',
  });
  const response = await handle({
    jsonrpc: '2.0', id: 96, method: 'tools/call',
    params: {
      name: 'agent_teams_create_task',
      arguments: { team_id: 'alpha', subject: 'x', workspace: 'D:\\tmp\\other' },
    },
  });
  assert.equal(response.result.isError, false);
  const call = calls.find((item) => item.url.endsWith('/teams/alpha/tasks'));
  assert.equal(Object.hasOwn(JSON.parse(call.body), 'workspace'), false);

  await handle({
    jsonrpc: '2.0', id: 99, method: 'tools/call',
    params: {
      name: 'agent_teams_update_task',
      arguments: {
        team_id: 'alpha', task_id: 't1', attempt_id: 'a1', status: 'completed',
        workspace: 'D:\\tmp\\other',
      },
    },
  });
  const update = calls.find((item) => item.url.endsWith('/tasks/t1/update'));
  const body = JSON.parse(update.body);
  for (const key of ['workspace', 'team_id', 'task_id', 'attempt_id']) {
    assert.equal(Object.hasOwn(body, key), false, key);
  }
  assert.equal(body.attemptId, 'a1');
});

test('the workspace routing field is stripped from the update body', async () => {
  const calls = [];
  const handle = createMcpHandler({
    fetchImpl: fakeFetch(calls), baseUrl: 'http://daemon', token: 't', defaultTeam: 'alpha',
  });
  const response = await handle({
    jsonrpc: '2.0', id: 98, method: 'tools/call',
    params: {
      name: 'agent_teams_update_task',
      arguments: {
        team_id: 'alpha', task_id: 't1', attempt_id: 'a1', status: 'completed',
        workspace: 'D:\\tmp\\other',
      },
    },
  });
  assert.equal(response.result.isError, false);
  const update = calls.find((item) => item.url.endsWith('/tasks/t1/update'));
  const body = JSON.parse(update.body);
  for (const key of ['workspace', 'team_id', 'task_id', 'attempt_id']) {
    assert.equal(Object.hasOwn(body, key), false, key);
  }
  assert.equal(body.attemptId, 'a1');
});

test('claim_task and update_task require the current attempt_id after a continue', async () => {
  for (const name of ['agent_teams_claim_task', 'agent_teams_update_task']) {
    const tool = TOOL_DEFINITIONS.find((item) => item.name === name);
    assert.equal(
      (tool.inputSchema.required ?? []).includes('attempt_id'),
      true,
      `${name} must require the current attempt_id`,
    );
    assert.equal(tool.inputSchema.properties.attempt_id.type, 'string');
  }
  const updateTool = TOOL_DEFINITIONS.find((item) => item.name === 'agent_teams_update_task');
  assert.match(updateTool.description, /explicit attempt_id/);

  const calls = [];
  const handle = createMcpHandler({
    fetchImpl: fakeFetch(calls), baseUrl: 'http://daemon', token: 't',
    defaultTeam: 'alpha', defaultMember: 'a1',
  });
  const response = await handle({
    jsonrpc: '2.0', id: 100, method: 'tools/call',
    params: {
      name: 'agent_teams_update_task',
      arguments: { team_id: 'alpha', task_id: 't1', status: 'completed', output: 'done after continue' },
    },
  });
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /attempt_id is required/);
  const accepted = await handle({
    jsonrpc: '2.0', id: 102, method: 'tools/call',
    params: {
      name: 'agent_teams_update_task',
      arguments: { team_id: 'alpha', task_id: 't1', attempt_id: 'new-attempt', status: 'completed', output: 'done after continue' },
    },
  });
  assert.equal(accepted.result.isError, false);
  const update = calls.find((item) => item.url.endsWith('/tasks/t1/update'));
  const body = JSON.parse(update.body);
  assert.equal(body.attemptId, 'new-attempt');
  assert.equal(body.status, 'completed');
  assert.equal(body.output, 'done after continue');

  const claim = await handle({
    jsonrpc: '2.0', id: 101, method: 'tools/call',
    params: { name: 'agent_teams_claim_task', arguments: { team_id: 'alpha', task_id: 't1', attempt_id: 'new-attempt' } },
  });
  assert.equal(claim.result.isError, false);
  const claimCall = calls.find((item) => item.url.endsWith('/tasks/t1/claim'));
  assert.equal(JSON.parse(claimCall.body).attemptId, 'new-attempt');
  assert.equal(JSON.parse(claimCall.body).member, 'a1');
});

test('agent_teams_view window mode calls the standalone opener', async () => {
  const opened = [];
  const handle = createMcpHandler({
    fetchImpl: fakeFetch([]), baseUrl: 'http://daemon', token: 't',
    openPanelImpl: async (url, options) => {
      opened.push({ url, options });
      return { opened: true, browser: 'edge', mode: 'window', appWindow: true };
    },
  });
  const response = await handle({
    jsonrpc: '2.0', id: 97, method: 'tools/call',
    params: { name: 'agent_teams_view', arguments: { window: true } },
  });
  assert.equal(response.result.isError, false);
  assert.equal(opened.length, 1);
  assert.equal(opened[0].options.mode, 'window');
  assert.equal(response.result.structuredContent.window.opened, true);
  assert.match(response.result.content[0].text, /Standalone window opened with edge/);
});

test('agent_teams_view reports a normal tab when no app window opened', async () => {
  const handle = createMcpHandler({
    fetchImpl: fakeFetch([]), baseUrl: 'http://daemon', token: 't',
    openPanelImpl: async () => ({ opened: true, browser: 'default', mode: 'tab', appWindow: false }),
  });
  const response = await handle({
    jsonrpc: '2.0', id: 100, method: 'tools/call',
    params: { name: 'agent_teams_view', arguments: { window: true } },
  });
  assert.equal(response.result.isError, false);
  assert.match(response.result.content[0].text, /tab\/normal window/);
  assert.doesNotMatch(response.result.content[0].text, /Standalone window opened/);
});

test('MCP claim maps attempt_id and default member', async () => {
  const calls = [];
  const handle = createMcpHandler({ fetchImpl: fakeFetch(calls), baseUrl: 'http://daemon', token: 't', defaultTeam: 'alpha', defaultMember: 'a1' });
  const response = await handle({
    jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: 'agent_teams_claim_task', arguments: { task_id: 't1', attempt_id: 'att1' } },
  });
  assert.equal(response.result.isError, false);
  const call = calls.find((item) => item.url.endsWith('/tasks/t1/claim'));
  assert.ok(call);
  assert.deepEqual(JSON.parse(call.body), { attemptId: 'att1', member: 'a1' });
});

test('MCP add_member forwards model and reasoning', async () => {
  const calls = [];
  const handle = createMcpHandler({ fetchImpl: fakeFetch(calls), baseUrl: 'http://daemon', token: 't', defaultTeam: 'alpha' });
  const tool = TOOL_DEFINITIONS.find((item) => item.name === 'agent_teams_add_member');
  assert.ok(tool.inputSchema.properties.reasoning);
  const response = await handle({
    jsonrpc: '2.0', id: 41, method: 'tools/call',
    params: {
      name: 'agent_teams_add_member',
      arguments: { name: 'Engineer 01', role: 'engineer', model: 'provider/model', reasoning: 'max' },
    },
  });
  assert.equal(response.result.isError, false);
  const call = calls.find((item) => item.url.endsWith('/teams/alpha/members'));
  assert.ok(call);
  assert.deepEqual(JSON.parse(call.body), { name: 'Engineer 01', role: 'engineer', model: 'provider/model', reasoning: 'max' });
});

test('MCP unknown tool returns an error result', async () => {
  const handle = createMcpHandler({ fetchImpl: fakeFetch([]), baseUrl: 'http://daemon', token: 't' });
  const response = await handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope' } });
  assert.equal(response.result.isError, true);
});

test('MCP v0.6 tools map relicense, contractor and lifecycle calls', async () => {
  const calls = [];
  const handle = createMcpHandler({ fetchImpl: fakeFetch(calls), baseUrl: 'http://daemon', token: 't', defaultTeam: 'alpha' });
  let response = await handle({
    jsonrpc: '2.0', id: 6, method: 'tools/call',
    params: { name: 'agent_teams_relicense_member', arguments: { member: 'a1', label: 'Analyst 01', role: 'analyst' } },
  });
  assert.equal(response.result.isError, false);
  assert.ok(calls.some((call) => call.url.endsWith('/members/m1/relicense')));
  response = await handle({
    jsonrpc: '2.0', id: 7, method: 'tools/call',
    params: { name: 'agent_teams_spawn_contractor', arguments: { prompt: 'review', purpose: 'post_merge_review:t1', model: 'provider/model', reasoning: 'max' } },
  });
  assert.equal(response.result.isError, false);
  const contractorCall = calls.find((call) => call.url.endsWith('/contractors'));
  assert.ok(contractorCall);
  assert.equal(JSON.parse(contractorCall.body).reasoning, 'max');
  response = await handle({
    jsonrpc: '2.0', id: 8, method: 'tools/call',
    params: { name: 'agent_teams_lifecycle', arguments: {} },
  });
  assert.equal(response.result.isError, false);
  assert.ok(calls.some((call) => call.url.endsWith('/lifecycle')));
});

test('member MCP hides panel tools and does not call the admin audit route', async () => {
  const calls = [];
  const handle = createMcpHandler({
    fetchImpl: fakeFetch(calls), baseUrl: 'http://daemon', token: 'member-token',
    defaultTeam: 'alpha', defaultMember: 'a1',
  });
  const list = await handle({ jsonrpc: '2.0', id: 30, method: 'tools/list' });
  assert.equal(list.result.tools.length, 29);
  assert.equal(list.result.tools.some((tool) => tool.name === 'agent_teams_view'), false);
  const init = await handle({ jsonrpc: '2.0', id: 33, method: 'initialize', params: {} });
  assert.equal(init.result.instructions, undefined);
  const resources = await handle({ jsonrpc: '2.0', id: 34, method: 'resources/list' });
  assert.deepEqual(resources.result.resources, []);

  const status = await handle({
    jsonrpc: '2.0', id: 31, method: 'tools/call',
    params: { name: 'agent_teams_status', arguments: {} },
  });
  assert.equal(status.result.isError, false);
  assert.equal(calls.some((call) => call.url.endsWith('/audit')), false);

  const view = await handle({
    jsonrpc: '2.0', id: 32, method: 'tools/call',
    params: { name: 'agent_teams_view', arguments: {} },
  });
  assert.equal(view.result.isError, true);
});

test('MCP serves the team-panel resource and view snapshot', async () => {
  const calls = [];
  const handle = createMcpHandler({ fetchImpl: fakeFetch(calls), baseUrl: 'http://daemon:43123', token: 't', defaultTeam: 'alpha' });
  const resources = await handle({ jsonrpc: '2.0', id: 20, method: 'resources/list' });
  assert.equal(resources.result.resources[0].uri, 'ui://ai-agent-teams/panel.html');
  assert.equal(resources.result.resources[0].mimeType, 'text/html;profile=mcp-app');
  const read = await handle({ jsonrpc: '2.0', id: 21, method: 'resources/read', params: { uri: 'ui://ai-agent-teams/panel.html' } });
  assert.match(read.result.contents[0].text, /Ai-Agent-Teams-Zcode/);
  const view = await handle({ jsonrpc: '2.0', id: 22, method: 'tools/call', params: { name: 'agent_teams_view', arguments: {} } });
  assert.equal(view.result.isError, false);
  assert.ok(view.result.structuredContent);
  assert.equal(view.result.structuredContent.viewUrl, 'http://daemon:43123/ui#tasks');
  assert.match(view.result.content[0].text, /Open full task view/);
  assert.ok(calls.some((call) => call.url.endsWith('/api/v1/ui/snapshot')));
});

test('MCP view URL includes the local panel access key when configured', async () => {
  const calls = [];
  const handle = createMcpHandler({
    fetchImpl: fakeFetch(calls),
    baseUrl: 'http://127.0.0.1:43123',
    token: 't',
    uiKey: 'local-key',
  });
  const init = await handle({ jsonrpc: '2.0', id: 24, method: 'initialize', params: {} });
  assert.match(init.result.instructions, /panel --open/);
  assert.doesNotMatch(init.result.instructions, /key=local-key/);
  const view = await handle({ jsonrpc: '2.0', id: 23, method: 'tools/call', params: { name: 'agent_teams_view', arguments: {} } });
  assert.equal(view.result.isError, false);
  assert.equal(view.result.structuredContent.viewUrl, 'http://127.0.0.1:43123/ui?key=local-key#tasks');
});

test('a real undici headers timeout does not trigger ensureDaemon', async () => {
  const calls = [];
  let ensureCalls = 0;
  const timeoutError = new TypeError('fetch failed');
  timeoutError.cause = { code: 'UND_ERR_HEADERS_TIMEOUT' };
  const handle = createMcpHandler({
    workspace: process.cwd(),
    baseUrl: 'http://daemon', token: 't',
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method ?? 'GET' });
      throw timeoutError;
    },
    ensureDaemon: async () => { ensureCalls += 1; return { started: true }; },
  });
  const response = await handle({
    jsonrpc: '2.0', id: 99, method: 'tools/call',
    params: { name: 'agent_teams_merge_and_review', arguments: { team_id: 'alpha', task_id: 't1' } },
  });
  assert.equal(response.result.isError, true);
  assert.equal(ensureCalls, 0);
  assert.equal(calls.length, 1);
});

test('a member MCP session without AGENT_TEAMS_TOKEN fails closed instead of borrowing the discovery admin token', async () => {
  const previous = process.env.AGENT_TEAMS_DISCOVERY_BASE;
  const base = mkdtempSync(join(tmpdir(), 'zat-member-fail-closed-'));
  const workspace = mkdtempSync(join(tmpdir(), 'zat-member-ws-'));
  process.env.AGENT_TEAMS_DISCOVERY_BASE = base;
  try {
    const path = discoveryPathForWorkspace(workspace);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify({
      port: 8811, token: 'admin-discovery-token', pid: process.pid, version: '0.1.8',
      workspace, startedAt: Date.now(), apiVersion: 'v1',
    }), 'utf8');

    const memberCalls = [];
    const member = createMcpHandler({
      workspace,
      defaultMember: 'a1',
      baseUrl: 'http://daemon',
      fetchImpl: fakeFetch(memberCalls),
    });
    const denied = await member({
      jsonrpc: '2.0', id: 200, method: 'tools/call',
      params: { name: 'agent_teams_status', arguments: {} },
    });
    assert.equal(denied.result.isError, true);
    assert.match(denied.result.content[0].text, /AGENT_TEAMS_TOKEN/);
    assert.equal(memberCalls.length, 0, 'a member must never call the daemon with the discovered admin token');

    const adminCalls = [];
    const adminAuth = [];
    const admin = createMcpHandler({
      workspace,
      fetchImpl: async (url, init = {}) => {
        adminCalls.push(String(url));
        adminAuth.push(String(init.headers?.authorization ?? ''));
        return { ok: true, status: 200, json: async () => ({ ok: true, data: [], error: null }) };
      },
    });
    const allowed = await admin({
      jsonrpc: '2.0', id: 201, method: 'tools/call',
      params: { name: 'agent_teams_status', arguments: {} },
    });
    assert.equal(allowed.result.isError, false);
    assert.ok(adminCalls.length > 0);
    assert.equal(adminAuth[0], 'Bearer admin-discovery-token', 'the admin mode keeps the discovery fallback');
  } finally {
    if (previous === undefined) delete process.env.AGENT_TEAMS_DISCOVERY_BASE;
    else process.env.AGENT_TEAMS_DISCOVERY_BASE = previous;
  }
});

test('the shadow catalog hides spawn_contractor while the ordinary member catalog keeps it', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, data: {}, error: null }) });
  const shadow = createMcpHandler({
    fetchImpl, baseUrl: 'http://daemon', token: 't', defaultMember: 'shadow', shadowMember: true,
  });
  const normal = createMcpHandler({
    fetchImpl, baseUrl: 'http://daemon', token: 't', defaultMember: 'a1',
  });
  const shadowList = await shadow({ jsonrpc: '2.0', id: 210, method: 'tools/list' });
  const normalList = await normal({ jsonrpc: '2.0', id: 211, method: 'tools/list' });
  assert.equal(shadowList.result.tools.some((item) => item.name === 'agent_teams_spawn_contractor'), false);
  assert.equal(normalList.result.tools.some((item) => item.name === 'agent_teams_spawn_contractor'), true);

  const denied = await shadow({
    jsonrpc: '2.0', id: 212, method: 'tools/call',
    params: { name: 'agent_teams_spawn_contractor', arguments: { prompt: 'write the patch' } },
  });
  assert.equal(denied.result.isError, true);
  assert.match(denied.result.content[0].text, /captain\/admin token/);

  const shadowResources = await shadow({ jsonrpc: '2.0', id: 213, method: 'resources/list' });
  assert.deepEqual(shadowResources.result.resources, []);
  const shadowRead = await shadow({
    jsonrpc: '2.0', id: 214, method: 'resources/read',
    params: { uri: 'ui://ai-agent-teams/panel.html' },
  });
  assert.match(shadowRead.error.message, /captain\/UI/);
});

test('a generic fetch failure is not treated as never reaching the daemon', async () => {
  let ensureCalls = 0;
  const handle = createMcpHandler({
    workspace: process.cwd(),
    baseUrl: 'http://daemon', token: 't',
    fetchImpl: async () => { throw new TypeError('fetch failed'); },
    ensureDaemon: async () => { ensureCalls += 1; return { started: true }; },
  });
  const response = await handle({
    jsonrpc: '2.0', id: 100, method: 'tools/call',
    params: { name: 'agent_teams_status', arguments: {} },
  });
  assert.equal(response.result.isError, true);
  assert.equal(ensureCalls, 0);
});
