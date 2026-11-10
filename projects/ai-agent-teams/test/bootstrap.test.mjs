import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureDaemon } from '../src/bootstrap.mjs';
import { isGitWorkspace } from '../src/domain/workspace.mjs';
import { makeTestTmpDir, removeTreeWithRetry } from './support/cleanup.mjs';
import { terminate } from './support/child-daemon.mjs';

// Portable liveness probe, matching `src/bootstrap.mjs`.
function isAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

test('ensureDaemon fails fast for worktree config outside a git workspace', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'ai-agent-teams-bootstrap-'));
  try {
    // The fail-fast branch only runs for a NON-git workspace. If the temp root is
    // redirected inside the checkout (AGENT_TEAMS_TEST_TMP), `isGitWorkspace`
    // reports true, the guard is skipped, and `ensureDaemon` goes on to spawn a
    // real detached daemon that outlives this test and keeps a port open. Assert
    // the precondition instead of allowing that: a loud failure here is far
    // better than a silent process leak.
    assert.equal(isGitWorkspace(workspace), false,
      `temp root ${workspace} is inside a git checkout; set AGENT_TEAMS_TEST_TMP to a path outside the repository`);
    await assert.rejects(
      () => ensureDaemon({
        workspace,
        configPath: join(process.cwd(), 'config', 'example.v06.json'),
        timeoutMs: 10,
      }),
      /not a git repository but config requests worktree isolation/,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

// Discovery root for this file's cases. It is created lazily and removed in the
// `after` hook below: `AGENT_TEAMS_DISCOVERY_BASE` makes each run write a
// `<hash>/runtime.json` under it, and only removing the workspace left one
// `ai-agent-teams-skew-disc-*` directory behind on every single run.
let skewDiscoveryBase;

test('a version mismatch never becomes a shortcut past the identity gate', async () => {
  // This used to be a source-position assertion (`indexOf('const versionSkew')`
  // before `indexOf('if (identityMatches')`). Position proves nothing: a mutant
  // that kills the recorded pid *before* the identity check leaves both strings
  // in the same order and still passes. What actually matters is the behaviour,
  // so it is asserted here instead.
  //
  // Setup: the discovery record names this workspace and an OLD version (so the
  // skew branch is live), but the daemon answering the port reports a different
  // pid and instanceId -- somebody else's process. `ensureDaemon` must refuse,
  // and that process must still be running afterwards.
  const workspace = realpathSync.native(makeTestTmpDir('ai-agent-teams-skew-'));
  mkdirSync(join(workspace, 'config'), { recursive: true });
  writeFileSync(join(workspace, 'config', 'local.json'),
    JSON.stringify({ isolation: { mode: 'none' } }), 'utf8');

  const foreignInstance = 'not-the-recorded-instance';
  // A separate, live process to name in the record. It is a plain sleeper: the
  // point is only that the pid exists and must survive.
  const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  const otherPid = other.pid;
  const server = createServer((req, res) => {
    if (req.url === '/api/v1/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        data: {
          status: 'ok',
          // Old version: this daemon is a legitimate upgrade candidate...
          version: '0.0.1-ancient',
          workspace,
          // ...but the identity does not match the record below.
          pid: process.pid,
          instanceId: foreignInstance,
        },
      }));
      return;
    }
    if (req.url === '/api/v1/teams') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;

  try {
    skewDiscoveryBase = realpathSync.native(makeTestTmpDir('ai-agent-teams-skew-disc-'));
    process.env.AGENT_TEAMS_DISCOVERY_BASE = skewDiscoveryBase;
    const { discoveryPathForWorkspace } = await import('../src/discovery.mjs');
    const discoveryPath = discoveryPathForWorkspace(workspace);
    mkdirSync(join(discoveryPath, '..'), { recursive: true });
    writeFileSync(discoveryPath, JSON.stringify({
      port,
      token: 'shared-token',
      // A live pid that this test did NOT start -- the stub answers on `port` and
      // reports `process.pid`, so recording a different live process models "the
      // record points at a process that is not the one answering". Using a
      // non-existent pid here would make a pre-gate kill attempt silently fail
      // and the test would pass for the wrong reason.
      pid: otherPid,
      workspace,
      version: '0.0.1-ancient',
      instanceId: 'the-recorded-instance',
    }), 'utf8');

    await assert.rejects(
      () => ensureDaemon({ workspace, configPath: join(workspace, 'config', 'local.json'), timeoutMs: 900 }),
      /did not prove its PID|did not accept its discovery token|did not become healthy/,
    );

    // The decisive assertion: the daemon is still serving...
    const probe = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
    assert.equal(probe.status, 200, 'a version mismatch must never justify killing a process we cannot identify');
    // ...and the process named by the record is untouched. This is what a
    // pre-identity kill mutant violates.
    assert.equal(isAlive(otherPid), true,
      'version skew must not be used as a licence to signal the pid from the record');
  } finally {
    server.close();
    terminate(otherPid);
    removeTreeWithRetry(workspace);
    if (skewDiscoveryBase) {
      removeTreeWithRetry(skewDiscoveryBase);
      skewDiscoveryBase = undefined;
    }
  }
});

// Backstop for the case where an assertion throws before the `finally` above can
// clear it (for example if creating the directory itself succeeds but a later
// import fails). Cheap, and the module-level variable makes it idempotent.
after(() => {
  if (skewDiscoveryBase) removeTreeWithRetry(skewDiscoveryBase);
});
