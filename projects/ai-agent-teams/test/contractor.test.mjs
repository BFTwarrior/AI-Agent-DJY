import { testHomeRoot } from './support/cleanup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { FakeSessionAdapter } from '../src/session/adapter.mjs';
import { CliSessionAdapter, runCli } from '../src/session/cli.mjs';
import { TeamService } from '../src/scheduler-service.mjs';

function setup({ handler, adapter } = {}) {
  const { config } = loadConfig('config/example.v06.json');
  const store = new Store(':memory:');
  const sessionAdapter = adapter ?? new FakeSessionAdapter({ handler });
  const service = new TeamService({ homeRoot: testHomeRoot(),
    store,
    adapter: sessionAdapter,
    config,
    cwd: process.cwd(),
    now: () => 1000,
    memoryUsage: () => ({ rssBytes: 1, budgetBytes: 100 }),
  });
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  return { config, store, service, adapter: sessionAdapter };
}

function contractorCreate(adapter, contractor) {
  return adapter.calls.find((call) => call.kind === 'create' && call.input.memberName === `contractor:${contractor.id}`);
}

async function waitUntil(predicate, { timeoutMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('post-merge review contractors run commands but cannot write or merge', async () => {
  const { config, store, service, adapter } = setup();
  const headlessMode = config.isolation?.workerMode ?? config.zcode.mode;
  const contractor = await service.spawnContractor({
    teamId: 'alpha', purpose: 'post_merge_review:t1', prompt: 'run the required tests and review',
  });
  assert.equal(contractor.status, 'completed');
  assert.equal(contractor.mode, 'review');

  const create = contractorCreate(adapter, contractor);
  assert.ok(create);
  // Headless contractors cannot answer a permission prompt: they use the
  // worker mode (default yolo) instead of the interactive plan/build choice.
  // Plan mode plus a Bash denylist is what stalled every post-merge review
  // until its 15-minute lifetime expired.
  assert.equal(create.input.mode, headlessMode);
  assert.equal(create.input.mode, 'yolo');
  assert.equal(create.input.disallowedTools.includes('Bash'), false);
  for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'ApplyPatch', 'apply_patch']) {
    assert.equal(create.input.disallowedTools.includes(tool), true, `${tool} must stay denied in review mode`);
  }
  for (const tool of ['agent_teams_merge_and_review', 'agent_teams_approve', 'agent_teams_delete', 'agent_teams_create']) {
    assert.equal(create.input.disallowedTools.includes(tool), true, `${tool} must stay denied to contractors`);
  }
  assert.equal(create.input.disallowedTools.includes('agent_teams_model'), true);

  const send = adapter.calls.find((call) => call.kind === 'send');
  assert.ok(send);
  assert.equal(send.input.sessionId, create.sessionId);
  assert.equal(send.input.mode, headlessMode);
  assert.equal(send.input.disallowedTools.includes('Bash'), false);
  assert.equal(send.input.disallowedTools.includes('Edit'), true);
  store.close();
});

test('review purposes resolve to review mode even when the configured default is read-only', async () => {
  const { config, store, service } = setup();
  assert.equal(config.contractors.defaultPermission, 'read-only');
  for (const purpose of ['merge_verify:t1', 'merge_review:t1']) {
    const contractor = await service.spawnContractor({ teamId: 'alpha', purpose, prompt: 'verify' });
    assert.equal(contractor.mode, 'review');
  }
  store.close();
});

test('plain read-only contractors run read-only commands but cannot write', async () => {
  const { config, store, service, adapter } = setup();
  const headlessMode = config.isolation?.workerMode ?? config.zcode.mode;
  const contractor = await service.spawnContractor({
    teamId: 'alpha', purpose: 'audit', prompt: 'audit only', mode: 'read-only',
  });
  const create = contractorCreate(adapter, contractor);
  // Plan mode plus a Bash denylist was the stall: read-only means "no file
  // writes", not "no shell", so tests and git inspection can run.
  assert.equal(create.input.mode, headlessMode);
  assert.equal(create.input.disallowedTools.includes('Bash'), false);
  assert.equal(create.input.disallowedTools.includes('Write'), true);
  assert.equal(create.input.disallowedTools.includes('Edit'), true);
  assert.equal(create.input.disallowedTools.includes('agent_teams_merge_and_review'), true);

  // A non-review purpose with no explicit mode uses the configured default.
  const defaulted = await service.spawnContractor({ teamId: 'alpha', purpose: 'research', prompt: 'research' });
  assert.equal(defaulted.mode, 'read-only');
  store.close();
});

test('explicit workspace-write contractors keep file writes and still cannot merge', async () => {
  const { config, store, service, adapter } = setup();
  const headlessMode = config.isolation?.workerMode ?? config.zcode.mode;
  const contractor = await service.spawnContractor({
    teamId: 'alpha', purpose: 'research', prompt: 'write a patch', mode: 'workspace-write',
  });
  const create = contractorCreate(adapter, contractor);
  assert.equal(create.input.mode, headlessMode);
  assert.equal(create.input.disallowedTools.includes('Bash'), false);
  assert.equal(create.input.disallowedTools.includes('Edit'), false);
  assert.equal(create.input.disallowedTools.includes('Write'), false);
  assert.equal(create.input.disallowedTools.includes('agent_teams_merge_and_review'), true);
  assert.equal(create.input.disallowedTools.includes('agent_teams_approve'), true);
  store.close();
});

test('a review purpose can never be promoted to workspace-write', async () => {
  const { store, service } = setup();
  await assert.rejects(
    () => service.submitContractor({
      teamId: 'alpha', purpose: 'post_merge_review:t1', prompt: 'review', mode: 'workspace-write',
    }),
    /cannot use workspace-write mode/,
  );
  assert.equal(store.listContractors('alpha').length, 0);
  store.close();
});

test('an unknown contractor mode is rejected before anything is queued', async () => {
  const { store, service } = setup();
  await assert.rejects(
    () => service.submitContractor({ teamId: 'alpha', purpose: 'research', prompt: 'x', mode: 'yolo' }),
    /contractor mode must be read-only\|review\|workspace-write/,
  );
  assert.equal(store.listContractors('alpha').length, 0);
  store.close();
});

test('a timed-out contractor keeps its slot until the underlying send settles and termination is proven', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { store, service, adapter } = setup({ handler: async () => { await gate; return { response: 'late' }; } });
  const submitted = await service.submitContractor({
    teamId: 'alpha', purpose: 'research', prompt: 'slow work', timeoutMs: 30,
  });
  assert.equal(await waitUntil(() => store.getContractor(submitted.id).status === 'cleanup_error'), true);

  const failed = store.getContractor(submitted.id);
  assert.equal(failed.errorCode, 'E_CONTRACTOR_TIMEOUT');
  assert.match(failed.error, /\(research\) timed out after 30ms/);
  assert.ok(failed.sessionId);
  assert.ok(failed.cleanupError);
  assert.equal(failed.slot, 'main');

  const sessionId = adapter.calls.find((call) => call.kind === 'create').sessionId;
  assert.ok(adapter.calls.some((call) => call.kind === 'stop' && call.input.sessionId === sessionId));
  // FakeSessionAdapter.close removes the session from its map; the absence
  // proves the cleanup ran even though the adapter does not record close calls.
  assert.equal(adapter.sessions.has(sessionId), false);

  release();
  assert.equal(await waitUntil(() => service.contractorSends.size === 0), true);
  assert.equal(store.getContractor(submitted.id).status, 'cleanup_error');
  store.close();
});

test('a failed cleanup reports both the timeout and the cleanup error', async () => {
  class FailingCleanupAdapter extends FakeSessionAdapter {
    async stop(input) {
      await super.stop(input);
      throw new Error('stop failed');
    }

    async close() {
      throw new Error('close failed');
    }
  }
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const adapter = new FailingCleanupAdapter({ handler: async () => { await gate; return { response: 'late' }; } });
  const { store, service } = setup({ adapter });
  const submitted = await service.submitContractor({
    teamId: 'alpha', purpose: 'research', prompt: 'slow work', timeoutMs: 30,
  });
  assert.equal(await waitUntil(() => store.getContractor(submitted.id).status === 'cleanup_error'), true);
  const blocked = store.getContractor(submitted.id);
  assert.equal(blocked.errorCode, 'E_CONTRACTOR_TIMEOUT');
  assert.match(blocked.error, /timed out after 30ms/);
  assert.equal(blocked.cleanupError, 'stop failed');
  release();
  store.close();
});

test('an explicit kill releases a creation failure that has no session identity', async () => {
  class CreateFailureAdapter extends FakeSessionAdapter {
    constructor() {
      super();
      this.failNextCreate = true;
    }

    async create(input) {
      if (this.failNextCreate) {
        this.failNextCreate = false;
        throw Object.assign(new Error('creation timed out'), { code: 'E_CONTRACTOR_TIMEOUT' });
      }
      return super.create(input);
    }
  }
  const { store, service } = setup({ adapter: new CreateFailureAdapter() });
  const submitted = await service.submitContractor({
    teamId: 'alpha', purpose: 'post_merge_review:t1', prompt: 'review', timeoutMs: 1000,
  });
  assert.equal(await waitUntil(() => store.getContractor(submitted.id).status === 'cleanup_error'), true);
  const blocked = store.getContractor(submitted.id);
  assert.equal(blocked.sessionId, undefined);
  assert.match(blocked.cleanupError, /creation outcome unknown/);
  assert.equal(service.contractorPools().find((pool) => pool.slot === 'merge').active, 1,
    'until proof or an explicit release, the slot stays occupied');

  const released = await service.killContractor('alpha', submitted.id);
  assert.equal(released.status, 'orphaned');
  assert.equal(released.releaseReason, 'kill after unproven creation');
  assert.equal(service.contractorPools().find((pool) => pool.slot === 'merge').active, 0,
    'an explicit kill must release the merge slot');

  const next = await service.spawnContractor({ teamId: 'alpha', purpose: 'post_merge_review:t2', prompt: 'review again' });
  assert.equal(next.status, 'completed', 'the merge slot must be usable again');
  store.close();
});

test('reviewMerge reports a killed reviewer instead of an undefined error', async () => {
  const { config, store, service } = setup();
  config.quality.postMergeReview = 'contractor';
  store.addTask({
    id: 't1', teamId: 'alpha', subject: 'impl', kind: 'work', status: 'completed',
    mergeCommit: 'deadbeef', mergeState: 'review_pending',
  });
  service.spawnContractor = async () => ({ id: 'ctr_review', status: 'killed' });
  const result = await service.reviewMerge('alpha', 't1');
  assert.equal(result.ok, false);
  assert.equal(result.verdict, 'error');
  assert.equal(result.error, 'post-merge review contractor ended as killed');
  assert.equal(store.getTask('t1').mergeReviewError, result.error);
  assert.equal(store.getTask('t1').mergeState, 'review_pending_internal');
  store.close();
});

test('CLI timeout kills the whole process tree instead of orphaning the app-server', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-agent-teams-tree-'));
  const marker = join(dir, 'grandchild.pid');
  const script = [
    'const { spawn } = require("node:child_process");',
    'const fs = require("node:fs");',
    'const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });',
    'fs.writeFileSync(process.argv[1], String(child.pid));',
    'setInterval(()=>{},1000);',
  ].join('\n');
  try {
    await assert.rejects(
      () => runCli({ command: process.execPath, args: ['-e', script, marker], timeoutMs: 800 }),
      /timed out after 800ms/,
    );
    assert.equal(await waitUntil(() => existsSync(marker), { timeoutMs: 2000 }), true, 'grandchild pid was never written');
    const grandchild = Number(readFileSync(marker, 'utf8'));
    assert.ok(Number.isInteger(grandchild) && grandchild > 0);
    assert.equal(
      await waitUntil(() => !isAlive(grandchild), { timeoutMs: 3000 }),
      true,
      `grandchild ${grandchild} survived the CLI timeout`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
  }
});

// A fake `zcode` executable: `commandFor()` runs a .cjs path through node, so
// the recorded argv is exactly what the real CLI would receive.
function cliSetup(script) {
  const { config } = loadConfig('config/example.v06.json');
  const dir = mkdtempSync(join(tmpdir(), 'ai-agent-teams-contractor-cli-'));
  const cli = join(dir, 'fake-zcode.cjs');
  writeFileSync(cli, script, 'utf8');
  const store = new Store(':memory:');
  const service = new TeamService({ homeRoot: testHomeRoot(),
    store,
    adapter: new FakeSessionAdapter(),
    contractorAdapter: new CliSessionAdapter({ cliPath: cli }),
    config,
    // Keep the disposable fixture directory out of the spawned CLI's cwd;
    // Windows keeps a process's cwd locked for a moment after the process tree
    // is killed, which made the cleanup race the timeout assertion.
    cwd: process.cwd(),
    now: () => Date.now(),
    memoryUsage: () => ({ rssBytes: 1, budgetBytes: 100 }),
  });
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  return { config, store, service, dir, cli };
}

test('a timed-out CLI send cannot reuse the create process exit as proof', async () => {
  const script = [
    'const args = process.argv.slice(2);',
    'if (args.includes("--resume")) { setInterval(()=>{},1000); }',
    'else console.log(JSON.stringify({ sessionId: "sess_stale_1", response: "created" }));',
  ].join('\n');
  const { store, service, dir } = cliSetup(script);
  try {
    const submitted = await service.submitContractor({
      teamId: 'alpha', purpose: 'post_merge_review:t1', prompt: 'hang on the task turn', timeoutMs: 2000,
    });
    assert.equal(await waitUntil(() => store.getContractor(submitted.id).status === 'cleanup_error', { timeoutMs: 15000 }), true);
    const blocked = store.getContractor(submitted.id);
    // The create process exited cleanly, but the resumed turn was killed. Its
    // exit was never verified, so the stale create record must not count.
    assert.equal(blocked.sessionId, 'sess_stale_1');
    assert.equal(blocked.errorCode, 'E_CONTRACTOR_TIMEOUT');
    assert.ok(blocked.cleanupError);
    assert.equal(service.contractorPools().find((pool) => pool.slot === 'merge').active, 1);

    const released = await service.killContractor('alpha', submitted.id);
    assert.equal(released.status, 'orphaned');
    assert.equal(released.releaseReason, 'kill after unproven cleanup');
    assert.equal(service.contractorPools().find((pool) => pool.slot === 'merge').active, 0,
      'an explicit kill must release a cleanup_error that keeps a session id');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    store.close();
  }
});

test('a review contractor CLI turn is headless with Bash allowed and write/merge tools denied', async () => {
  const script = [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'fs.appendFileSync(path.join(__dirname, "argv.jsonl"), JSON.stringify(process.argv.slice(2)) + "\\n");',
    'console.log(JSON.stringify({ sessionId: "sess_cli_1", response: "verdict: pass", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }));',
  ].join('\n');
  const { store, service, dir } = cliSetup(script);
  try {
    const contractor = await service.spawnContractor({
      teamId: 'alpha', purpose: 'post_merge_review:t1', prompt: 'run node --test and report the verdict',
    });
    // A synchronous CLI turn ends when its wrapper process closes; that exit
    // is recorded as termination evidence, so a successful review completes
    // and releases the slot instead of sticking in cleanup_error.
    assert.equal(contractor.status, 'completed');
    assert.equal(contractor.sessionId, undefined);
    const turns = readFileSync(join(dir, 'argv.jsonl'), 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line));
    // One create plus one task turn: both must carry the same policy, otherwise
    // a reviewer regains (or loses) permissions mid-review.
    assert.equal(turns.length, 2);
    for (const args of turns) {
      assert.equal(args[args.indexOf('--mode') + 1], 'yolo', 'a headless contractor must not run in plan mode');
      const start = args.indexOf('--disallowed-tools');
      assert.notEqual(start, -1);
      const tools = args.slice(start + 1);
      assert.equal(tools.includes('Bash'), false, 'Bash must stay available for npm test and git diff');
      for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'ApplyPatch', 'apply_patch']) {
        assert.equal(tools.includes(tool), true, `${tool} must stay denied`);
      }
      for (const tool of ['agent_teams_merge_and_review', 'agent_teams_approve', 'agent_teams_delete']) {
        assert.equal(tools.includes(tool), true, `${tool} must stay denied`);
      }
      assert.equal(tools.includes('agent_teams_model'), true);
    }
    assert.equal(turns[1][turns[1].indexOf('--resume') + 1], 'sess_cli_1');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    store.close();
  }
});

test('a contractor whose CLI turn hangs is killed with its process tree and fails on timeout', async () => {
  const script = [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'const { spawn } = require("node:child_process");',
    'const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });',
    'fs.writeFileSync(path.join(__dirname, "grandchild.pid"), String(child.pid));',
    'setInterval(()=>{},1000);',
  ].join('\n');
  const { store, service, dir } = cliSetup(script);
  try {
    const submitted = await service.submitContractor({
      teamId: 'alpha', purpose: 'research', prompt: 'hang forever', timeoutMs: 2000,
    });
    const becameFailed = await waitUntil(() => store.getContractor(submitted.id).status === 'cleanup_error', { timeoutMs: 15000 });
    const failed = store.getContractor(submitted.id);
    assert.equal(becameFailed, true);
    assert.equal(failed.errorCode, 'E_CONTRACTOR_TIMEOUT');
    assert.match(failed.error, /contractor \(research\) timed out after 2000ms/);
    assert.equal(failed.sessionId, undefined);
    assert.equal(await waitUntil(() => existsSync(join(dir, 'grandchild.pid')), { timeoutMs: 5000 }), true, 'the fake CLI never started');
    const grandchild = Number(readFileSync(join(dir, 'grandchild.pid'), 'utf8'));
    assert.ok(Number.isInteger(grandchild) && grandchild > 0);
    assert.equal(
      await waitUntil(() => !isAlive(grandchild), { timeoutMs: 5000 }),
      true,
      `grandchild ${grandchild} survived the contractor timeout`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    store.close();
  }
});
