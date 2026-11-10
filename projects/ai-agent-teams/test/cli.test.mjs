import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  CliSessionAdapter,
  buildCreateArgs,
  buildSendArgs,
  commandFor,
  parseCliOutput,
  providerErrorDetails,
  providerErrorFromText,
} from '../src/session/cli.mjs';
import { killProcessTree } from '../src/session/process-tree.mjs';

test('create arguments include prompt, json, mode and cwd', () => {
  assert.deepEqual(buildCreateArgs({ prompt: 'hello', cwd: 'D:/work', mode: 'plan' }), [
    '-p', 'hello', '--json', '--mode', 'plan', '--cwd', 'D:/work',
  ]);
});

test('send arguments use --resume and per-run tool restrictions', () => {
  assert.deepEqual(buildSendArgs({
    sessionId: 'sess_1', message: 'next', cwd: 'D:/work', mode: 'build', disallowedTools: ['Bash', 'Edit'],
  }), [
    '--resume', 'sess_1', '-p', 'next', '--json', '--mode', 'build', '--cwd', 'D:/work',
    '--disallowed-tools', 'Bash', 'Edit',
  ]);
});

test('CLI JSON is parsed through leading log lines', () => {
  const output = 'some log\n{"sessionId":"sess_1","response":"OK","usage":{"totalTokens":3}}\n';
  assert.equal(parseCliOutput(output).response, 'OK');
});

test('CLI member env fails closed without a member token', () => {
  const adapter = new CliSessionAdapter({ baseUrl: 'http://daemon', token: 'admin-token' });
  assert.throws(
    () => adapter.envFor('a1', undefined, 'alpha'),
    /member token required/,
  );
});

test('CLI JSON provider errors become retryable send failures with structured fields', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-agent-teams-cli-'));
  try {
    const cli = join(dir, 'fake.cjs');
    writeFileSync(cli, 'console.log(JSON.stringify({ error: { message: "group requests-per-minute limit exceeded", code: "rate_limit_exceeded", type: "provider_error", retryAfterMs: 45000 } }));\n', 'utf8');
    const adapter = new CliSessionAdapter({ cliPath: cli, baseUrl: 'http://daemon', token: 'admin-token' });
    adapter.sessions.set('s1', { sessionId: 's1', teamId: 'alpha', memberName: 'a1', token: 'member-token', ephemeral: false });
    const result = await adapter.send({ sessionId: 's1', message: 'task' });
    assert.equal(result.ok, false);
    assert.match(result.warning, /group requests-per-minute limit exceeded/);
    assert.equal(result.error.code, 'rate_limit_exceeded');
    assert.equal(result.error.type, 'provider_error');
    assert.equal(result.error.retryAfterMs, 45000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI nonzero exits preserve provider fields from JSON stdout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-agent-teams-cli-'));
  try {
    const cli = join(dir, 'fake.cjs');
    writeFileSync(cli, 'console.log(JSON.stringify({ error: { message: "429 too many requests", code: "429", retryAfterSeconds: 30 } })); process.exit(1);\n', 'utf8');
    const adapter = new CliSessionAdapter({ cliPath: cli, baseUrl: 'http://daemon', token: 'admin-token' });
    adapter.sessions.set('s1', { sessionId: 's1', teamId: 'alpha', memberName: 'a1', token: 'member-token', ephemeral: false });
    await assert.rejects(
      () => adapter.send({ sessionId: 's1', message: 'task' }),
      (error) => {
        assert.equal(error.code, '429');
        assert.equal(error.retryAfterMs, 30000);
        assert.equal(error.exitCode, 1);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI plain-text stderr preserves hard-quota errors as non-retryable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-agent-teams-cli-'));
  try {
    const cli = join(dir, 'fake.cjs');
    writeFileSync(cli, 'console.error("Error: insufficient_quota: hard quota exhausted (traceId: abc)"); process.exit(1);\n', 'utf8');
    const adapter = new CliSessionAdapter({ cliPath: cli, baseUrl: 'http://daemon', token: 'admin-token' });
    adapter.sessions.set('s1', { sessionId: 's1', teamId: 'alpha', memberName: 'a1', token: 'member-token', ephemeral: false });
    await assert.rejects(
      () => adapter.send({ sessionId: 's1', message: 'task' }),
      (error) => {
        assert.equal(error.code, 'insufficient_quota');
        assert.equal(error.retryable, false);
        assert.match(error.message, /hard quota/);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('providerErrorDetails handles string and nested error shapes', () => {
  assert.deepEqual(providerErrorDetails({ error: 'rate limited' }), { message: 'rate limited' });
  assert.deepEqual(providerErrorDetails({ ok: false, message: 'quota exceeded', code: 'quota' }), {
    message: 'quota exceeded',
    code: 'quota',
  });
  assert.deepEqual(providerErrorDetails({ error: { message: 'too many', status: 429 } }), {
    message: 'too many',
    code: 429,
  });
  assert.equal(providerErrorDetails({ response: 'OK' }), undefined);
  assert.equal(providerErrorDetails({ error: { message: '429 too many requests: 1316 pending', code: '429' } }).retryable, undefined);
  assert.equal(providerErrorFromText('Error: requests per minute exceeded, 1316 queued').code, undefined);
  assert.equal(providerErrorFromText('Error: requests per minute exceeded, 1316 queued').retryable, undefined);
  assert.equal(providerErrorFromText('Error: code=2056 hard quota exhausted').retryable, false);
  assert.equal(providerErrorFromText('Error: insufficient_quota (traceId: x)').retryable, false);
  const multiline = providerErrorFromText('warning: rate limit probe failed\nError: insufficient_quota: hard quota exhausted (traceId: abc)');
  assert.match(multiline.message, /hard quota/);
  assert.equal(multiline.code, 'insufficient_quota');
  assert.equal(multiline.retryable, false);
  const current = providerErrorFromText('Error: exceeded_current_quota_error (traceId: x)');
  assert.equal(current.retryable, false);
});

test('a .cjs CLI is launched through the current Node binary', () => {
  const launched = commandFor('D:/app/zcode.cjs');
  assert.equal(launched.command, process.execPath);
  assert.deepEqual(launched.prefix, ['D:/app/zcode.cjs']);
});

test('CLI stop between turns is unknown because no termination or revocation proof exists', async () => {
  const adapter = new CliSessionAdapter({ baseUrl: 'http://daemon', token: 'admin-token' });
  adapter.sessions.set('sess_not_running', { sessionId: 'sess_not_running' });
  const result = await adapter.stop({ sessionId: 'sess_not_running' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'unknown');
  assert.equal(adapter.sessions.has('sess_not_running'), true);
});

test('process-tree termination without a verifiable process identity is unknown', () => {
  const result = killProcessTree({});
  assert.equal(result.ok, false);
  assert.equal(result.status, 'unknown');
});

test('CLI stop and close retain session state when tree exit or revocation is unproven', async () => {
  const adapter = new CliSessionAdapter();
  const child = { pid: undefined, exitCode: null };
  adapter.sessions.set('sess_keep', { sessionId: 'sess_keep' });
  adapter.processes.set('sess_keep', child);

  const stopped = await adapter.stop({ sessionId: 'sess_keep' });
  assert.equal(stopped.status, 'unknown');
  assert.equal(adapter.sessions.has('sess_keep'), true);
  assert.equal(adapter.processes.get('sess_keep'), child);

  adapter.processes.delete('sess_keep');
  const closed = await adapter.close({ sessionId: 'sess_keep' });
  assert.equal(closed.status, 'unknown');
  assert.equal(adapter.sessions.has('sess_keep'), true);
});
