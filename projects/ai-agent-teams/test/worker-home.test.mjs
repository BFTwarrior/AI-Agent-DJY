import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { MEMBER_MCP_SERVER_NAME, MEMBER_MCP_SERVER_PATH, normalizeWorkerModel, seedWorkerHome, writeMemberMcpConfig } from '../src/session/worker-home.mjs';
import { ContainerCliSessionAdapter } from '../src/session/container-cli.mjs';
import { readWindowsAcl, windowsUserSid } from '../src/fs-permissions.mjs';

function temp() {
  return mkdtempSync(join(tmpdir(), 'ai-agent-teams-worker-home-'));
}

function seedDir(root) {
  const dir = join(root, 'seed');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'credentials.json'), '{"token":"redacted"}');
  writeFileSync(join(dir, 'provider_config.json'), JSON.stringify({ schemaVersion: 1, config: {} }));
  writeFileSync(join(dir, 'setting.json'), JSON.stringify({ locale: 'zh-CN' }));
  writeFileSync(join(dir, 'tasks-index.sqlite'), 'not copied');
  return dir;
}

test('worker home copies only the ZCode profile whitelist and injects the model', () => {
  const root = temp();
  try {
    const home = join(root, 'home');
    mkdirSync(home);
    const source = seedDir(root);
    const result = seedWorkerHome(home, {
      seedDir: source,
      model: { providerId: 'provider-a', modelId: 'model-x', reasoningLevel: 'max' },
    });
    assert.equal(result.seeded, true);
    assert.deepEqual(result.copied, ['credentials.json', 'provider_config.json', 'setting.json']);
    assert.equal(result.modelSelection.providerId, 'provider-a');
    const provider = JSON.parse(readFileSync(join(home, '.zcode', 'v2', 'provider_config.json'), 'utf8'));
    assert.deepEqual(provider.config.defaultModelSelection, {
      providerId: 'provider-a',
      modelId: 'model-x',
      options: { reasoningLevel: 'max' },
    });
    assert.equal(readFileSync(join(home, '.zcode', 'v2', 'credentials.json'), 'utf8'), '{"token":"redacted"}');
    assert.throws(() => readFileSync(join(home, '.zcode', 'v2', 'tasks-index.sqlite')), /ENOENT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('worker home reports a missing seed directory instead of throwing', () => {
  const root = temp();
  try {
    const home = join(root, 'home');
    mkdirSync(home);
    const result = seedWorkerHome(home, { seedDir: join(root, 'missing'), model: { providerId: 'p', modelId: 'm' } });
    assert.equal(result.seeded, false);
    assert.equal(result.credentialsCopied, false);
    assert.equal(result.modelInjected, false);
    assert.match(result.reason, /not found/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a setting-only seed is not reported as authenticated success', () => {
  const root = temp();
  try {
    const home = join(root, 'home');
    mkdirSync(home);
    const source = join(root, 'settings-only');
    mkdirSync(source);
    writeFileSync(join(source, 'setting.json'), '{}');
    const result = seedWorkerHome(home, { seedDir: source, model: { providerId: 'p', modelId: 'm' } });
    assert.equal(result.seeded, false);
    assert.equal(result.credentialsCopied, false);
    assert.equal(result.modelInjected, false);
    assert.match(result.reason, /credentials\.json/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('re-seeding updates the worker model on an existing home', () => {
  const root = temp();
  try {
    const home = join(root, 'home');
    mkdirSync(home);
    const source = seedDir(root);
    seedWorkerHome(home, { seedDir: source, model: { providerId: 'p', modelId: 'first' } });
    const second = seedWorkerHome(home, { seedDir: source, model: { providerId: 'p', modelId: 'second' } });
    assert.equal(second.modelInjected, true);
    const provider = JSON.parse(readFileSync(join(home, '.zcode', 'v2', 'provider_config.json'), 'utf8'));
    assert.equal(provider.config.defaultModelSelection.modelId, 'second');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('seed refuses a symlinked .zcode directory', (t) => {
  const root = temp();
  try {
    const home = join(root, 'home');
    const victim = join(root, 'victim');
    mkdirSync(home);
    mkdirSync(victim);
    writeFileSync(join(victim, 'keep.txt'), 'keep');
    try {
      symlinkSync(victim, join(home, '.zcode'), 'junction');
    } catch {
      t.skip('directory symlinks are not available');
      return;
    }
    const result = seedWorkerHome(home, { seedDir: seedDir(root), model: { providerId: 'p', modelId: 'm' } });
    assert.equal(result.seeded, false);
    assert.match(result.reason, /symlink/);
    assert.equal(readFileSync(join(victim, 'keep.txt'), 'utf8'), 'keep');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a non-object provider config is not reported as model-injected', () => {
  const root = temp();
  try {
    const home = join(root, 'home');
    const source = join(root, 'seed-array');
    mkdirSync(home);
    mkdirSync(source);
    writeFileSync(join(source, 'credentials.json'), '{}');
    writeFileSync(join(source, 'provider_config.json'), '[]');
    const result = seedWorkerHome(home, { seedDir: source, model: { providerId: 'p', modelId: 'm' } });
    assert.equal(result.seeded, true);
    assert.equal(result.modelInjected, false);
    assert.match(result.reason, /must be objects/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('worker model normalization requires provider and model ids', () => {
  assert.equal(normalizeWorkerModel(null), undefined);
  assert.equal(normalizeWorkerModel({ providerId: 'p' }), undefined);
  assert.deepEqual(normalizeWorkerModel({ providerId: 'p', modelId: 'm', options: { reasoningLevel: 'max', extra: true } }), {
    providerId: 'p',
    modelId: 'm',
    options: { reasoningLevel: 'max', extra: true },
  });
});

test('container adapter seeds a member home before the first turn', async () => {
  const root = temp();
  try {
    const home = join(root, 'member-home');
    const adapter = new ContainerCliSessionAdapter({
      runtime: 'docker',
      image: 'worker:test',
      containerBaseUrl: 'http://host.docker.internal:8779',
      homeSeed: seedDir(root),
      workerModel: { providerId: 'provider-a', modelId: 'model-x' },
      runner: async () => JSON.stringify({ sessionId: 'sess_seed_1', response: 'created', usage: {} }),
    });
    await adapter.create({
      teamId: 'alpha',
      memberName: 'Engineer 01',
      cwd: 'D:/worktree',
      prompt: 'test',
      token: 'mt_member-token',
      home,
    });
    const credentials = readFileSync(join(home, '.zcode', 'v2', 'credentials.json'), 'utf8');
    assert.equal(credentials, '{"token":"redacted"}');
    const provider = JSON.parse(readFileSync(join(home, '.zcode', 'v2', 'provider_config.json'), 'utf8'));
    assert.equal(provider.config.defaultModelSelection.modelId, 'model-x');
    const config = JSON.parse(readFileSync(join(home, '.zcode', 'cli', 'config.json'), 'utf8'));
    const server = config.mcp.servers[MEMBER_MCP_SERVER_NAME];
    assert.equal(server.env.AGENT_TEAMS_TOKEN, 'mt_member-token');
    assert.equal(server.env.AGENT_TEAMS_TEAM, 'alpha');
    assert.equal(server.env.AGENT_TEAMS_MEMBER, 'Engineer 01');
    assert.equal(server.env.AGENT_TEAMS_URL, 'http://host.docker.internal:8779');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('worker home rewrites only the selected loopback provider URL', () => {
  const root = temp();
  try {
    const home = join(root, 'home');
    const source = join(root, 'seed-provider');
    mkdirSync(home);
    mkdirSync(source);
    writeFileSync(join(source, 'credentials.json'), '{}');
    writeFileSync(join(source, 'provider_config.json'), JSON.stringify({
      config: {
        providerConfigRules: {
          providerRules: [
            {
              providerId: 'local',
              config: { api: { type: 'openai-chat-completions', baseUrl: 'http://127.0.0.1:8787/ap/v1' } },
            },
            {
              providerId: 'remote',
              config: { api: { type: 'openai-chat-completions', baseUrl: 'https://example.test/v1' } },
            },
          ],
        },
      },
    }));
    const result = seedWorkerHome(home, {
      seedDir: source,
      model: { providerId: 'local', modelId: 'model-a' },
      providerBaseUrl: 'http://192.0.2.10:49152/ap/v1',
    });
    assert.equal(result.seeded, true);
    assert.equal(result.modelInjected, true);
    assert.equal(result.providerUrlRewritten, true);
    const provider = JSON.parse(readFileSync(join(home, '.zcode', 'v2', 'provider_config.json'), 'utf8'));
    assert.equal(provider.config.providerConfigRules.providerRules[0].config.api.baseUrl, 'http://192.0.2.10:49152/ap/v1');
    assert.equal(provider.config.providerConfigRules.providerRules[1].config.api.baseUrl, 'https://example.test/v1');
    assert.equal(result.modelSelection.providerId, 'local');
    const unchanged = JSON.parse(readFileSync(join(source, 'provider_config.json'), 'utf8'));
    assert.equal(unchanged.config.providerConfigRules.providerRules[0].config.api.baseUrl, 'http://127.0.0.1:8787/ap/v1');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('worker home reports a provider rewrite failure without losing the model injection', () => {
  const root = temp();
  try {
    const home = join(root, 'home');
    const source = join(root, 'seed-provider-missing');
    mkdirSync(home);
    mkdirSync(source);
    writeFileSync(join(source, 'credentials.json'), '{}');
    writeFileSync(join(source, 'provider_config.json'), JSON.stringify({
      config: {
        providerConfigRules: {
          providerRules: [{ providerId: 'local', config: {} }],
        },
      },
    }));
    const result = seedWorkerHome(home, {
      seedDir: source,
      model: { providerId: 'local', modelId: 'model-a' },
      providerBaseUrl: 'http://192.0.2.10:49152/ap/v1',
    });
    assert.equal(result.seeded, true);
    assert.equal(result.modelInjected, true);
    assert.equal(result.providerUrlRewritten, false);
    assert.match(result.reason, /no api\.baseUrl/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('container adapter forwards the provider bridge URL into the worker home', async () => {
  const root = temp();
  try {
    const home = join(root, 'member-home');
    const source = join(root, 'provider-seed');
    mkdirSync(source);
    writeFileSync(join(source, 'credentials.json'), '{}');
    writeFileSync(join(source, 'provider_config.json'), JSON.stringify({
      config: {
        providerConfigRules: {
          providerRules: [{ providerId: 'local', config: { api: { baseUrl: 'http://127.0.0.1:8787/ap/v1' } } }],
        },
      },
    }));
    const adapter = new ContainerCliSessionAdapter({
      runtime: 'docker',
      image: 'worker:test',
      containerBaseUrl: 'http://192.0.2.10:8797',
      homeSeed: source,
      workerModel: { providerId: 'local', modelId: 'model-a' },
      providerBaseUrl: 'http://192.0.2.10:49152/ap/v1',
      runner: async () => JSON.stringify({ sessionId: 'sess_provider_1', response: 'created', usage: {} }),
    });
    await adapter.create({
      teamId: 'alpha',
      memberName: 'Analyst 01',
      cwd: 'D:/worktree',
      prompt: 'test',
      token: 'mt_member-token',
      home,
    });
    const provider = JSON.parse(readFileSync(join(home, '.zcode', 'v2', 'provider_config.json'), 'utf8'));
    assert.equal(provider.config.providerConfigRules.providerRules[0].config.api.baseUrl, 'http://192.0.2.10:49152/ap/v1');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('writeMemberMcpConfig writes only the member MCP server with the member token', () => {
  const root = temp();
  try {
    const home = join(root, 'member-home');
    mkdirSync(home);
    const adminToken = 'admin-token-must-not-leak';
    const result = writeMemberMcpConfig(home, {
      baseUrl: 'http://192.0.2.10:8799',
      token: 'mt_member-token-01',
      teamId: 'alpha',
      memberName: 'Analyst 01',
      adminToken,
    });
    assert.equal(result.written, true);
    assert.equal(result.serverName, MEMBER_MCP_SERVER_NAME);
    assert.equal(result.path, join(home, '.zcode', 'cli', 'config.json'));
    const raw = readFileSync(result.path, 'utf8');
    assert.ok(!raw.includes(adminToken));
    assert.ok(!raw.includes('AGENT_TEAMS_ADMIN'));
    const config = JSON.parse(raw);
    assert.deepEqual(Object.keys(config), ['mcp']);
    assert.deepEqual(Object.keys(config.mcp.servers), [MEMBER_MCP_SERVER_NAME]);
    const server = config.mcp.servers[MEMBER_MCP_SERVER_NAME];
    assert.equal(server.name, undefined);
    assert.equal(server.type, 'stdio');
    assert.equal(server.command, 'node');
    assert.deepEqual(server.args, [MEMBER_MCP_SERVER_PATH]);
    assert.equal(server.args[0], '/opt/agent-teams/src/mcp-server.mjs');
    assert.equal(server.timeoutMs, 30000);
    assert.deepEqual(server.env, {
      AGENT_TEAMS_AUTOSTART: '0',
      AGENT_TEAMS_URL: 'http://192.0.2.10:8799',
      AGENT_TEAMS_TOKEN: 'mt_member-token-01',
      AGENT_TEAMS_TEAM: 'alpha',
      AGENT_TEAMS_MEMBER: 'Analyst 01',
    });
    assert.equal(existsSync(join(home, '.zcode', 'cli', 'config.json')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('writeMemberMcpConfig keeps the directory 0700 and the file 0600', () => {
  const root = temp();
  try {
    const home = join(root, 'member-home');
    mkdirSync(home);
    const result = writeMemberMcpConfig(home, {
      baseUrl: 'http://192.0.2.10:8799',
      token: 'mt_member-token-01',
      teamId: 'alpha',
      memberName: 'Analyst 01',
    });
    assert.equal(result.written, true);
    const zcodeDir = join(home, '.zcode');
    const cliDir = join(zcodeDir, 'cli');

    if (process.platform === 'win32') {
      const userSid = windowsUserSid();
      for (const path of [zcodeDir, cliDir, result.path]) {
        const expectedSids = new Set([userSid, 'S-1-5-18']);
        const entries = readWindowsAcl(path);
        assert.equal(entries.length, 2, `${path} should have exactly two ACL entries`);
        for (const entry of entries) {
          assert.ok(expectedSids.has(entry.sid), `${path} has unexpected SID ${entry.sid}`);
          assert.equal(entry.type, 'Allow', `${path} should only grant access`);
          assert.equal(Number(entry.rights), 2032127, `${path} should grant FullControl`);
          assert.equal(entry.inherited, false, `${path} should not have inherited ACEs`);
          expectedSids.delete(entry.sid);
        }
        assert.equal(expectedSids.size, 0, `${path} should include the current user and LocalSystem`);
      }
    } else {
      assert.equal(statSync(zcodeDir).mode & 0o777, 0o700);
      assert.equal(statSync(cliDir).mode & 0o777, 0o700);
      assert.equal(statSync(result.path).mode & 0o777, 0o600);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('writeMemberMcpConfig refuses to write when a required value is missing', () => {
  const root = temp();
  try {
    const home = join(root, 'member-home');
    mkdirSync(home);
    const complete = { baseUrl: 'http://192.0.2.10:8799', token: 'mt_member-token', teamId: 'alpha', memberName: 'Analyst 01' };
    for (const key of Object.keys(complete)) {
      const input = { ...complete, [key]: '' };
      const result = writeMemberMcpConfig(home, input);
      assert.equal(result.written, false, `missing ${key} must not write`);
      assert.match(result.reason, new RegExp(key));
      assert.equal(existsSync(join(home, '.zcode', 'cli', 'config.json')), false, `missing ${key} left a partial config`);
    }
    const noBaseUrl = writeMemberMcpConfig(home, { ...complete, baseUrl: undefined });
    assert.equal(noBaseUrl.written, false);
    assert.match(noBaseUrl.reason, /baseUrl/);
    const adminToken = writeMemberMcpConfig(home, { ...complete, token: 'admin-token' });
    assert.equal(adminToken.written, false);
    assert.match(adminToken.reason, /member token/);
    const hostHome = writeMemberMcpConfig(homedir(), {
      baseUrl: 'http://192.0.2.10:8799',
      token: 'mt_member-token',
      teamId: 'alpha',
      memberName: 'Analyst 01',
    });
    assert.equal(hostHome.written, false);
    assert.match(hostHome.reason, /host ZCode home/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('writeMemberMcpConfig refuses a symlinked .zcode/cli directory', (t) => {
  const root = temp();
  try {
    const home = join(root, 'member-home');
    const victim = join(root, 'victim');
    mkdirSync(join(home, '.zcode'), { recursive: true });
    mkdirSync(victim);
    writeFileSync(join(victim, 'keep.txt'), 'keep');
    try {
      symlinkSync(victim, join(home, '.zcode', 'cli'), 'junction');
    } catch {
      t.skip('directory symlinks are not available');
      return;
    }
    const result = writeMemberMcpConfig(home, {
      baseUrl: 'http://192.0.2.10:8799',
      token: 'mt_member-token',
      teamId: 'alpha',
      memberName: 'Analyst 01',
    });
    assert.equal(result.written, false);
    assert.match(result.reason, /symlink/);
    assert.equal(readFileSync(join(victim, 'keep.txt'), 'utf8'), 'keep');
    assert.equal(existsSync(join(victim, 'config.json')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('container adapter writes no MCP config for an ephemeral contractor', async () => {
  const root = temp();
  try {
    const home = join(root, 'contractor-home');
    const adapter = new ContainerCliSessionAdapter({
      runtime: 'docker',
      image: 'worker:test',
      containerBaseUrl: 'http://host.docker.internal:8779',
      runner: async () => JSON.stringify({ sessionId: 'sess_contractor_1', response: 'created', usage: {} }),
    });
    await adapter.create({
      teamId: 'alpha',
      memberName: 'Contractor 01',
      cwd: 'D:/worktree',
      prompt: 'one shot',
      ephemeral: true,
      home,
    });
    assert.equal(existsSync(join(home, '.zcode', 'cli', 'config.json')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('container adapter refreshes the MCP token on a later send', async () => {
  const root = temp();
  try {
    const home = join(root, 'member-home');
    const runner = async ({ args }) => (args.includes('--resume')
      ? JSON.stringify({ response: 'done', usage: {} })
      : JSON.stringify({ sessionId: 'sess_refresh_1', response: 'created', usage: {} }));
    const adapter = new ContainerCliSessionAdapter({
      runtime: 'docker',
      image: 'worker:test',
      containerBaseUrl: 'http://192.0.2.10:8799',
      runner,
    });
    await adapter.create({
      teamId: 'alpha',
      memberName: 'Analyst 01',
      cwd: 'D:/worktree',
      prompt: 'start',
      token: 'mt_member-token-old',
      home,
    });
    const first = JSON.parse(readFileSync(join(home, '.zcode', 'cli', 'config.json'), 'utf8'));
    assert.equal(first.mcp.servers[MEMBER_MCP_SERVER_NAME].env.AGENT_TEAMS_TOKEN, 'mt_member-token-old');
    await adapter.send({
      sessionId: 'sess_refresh_1',
      message: 'next',
      token: 'mt_member-token-new',
      teamId: 'alpha',
      memberName: 'Analyst 01',
    });
    const second = JSON.parse(readFileSync(join(home, '.zcode', 'cli', 'config.json'), 'utf8'));
    assert.equal(second.mcp.servers[MEMBER_MCP_SERVER_NAME].env.AGENT_TEAMS_TOKEN, 'mt_member-token-new');
    assert.equal(second.mcp.servers[MEMBER_MCP_SERVER_NAME].env.AGENT_TEAMS_MEMBER, 'Analyst 01');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
