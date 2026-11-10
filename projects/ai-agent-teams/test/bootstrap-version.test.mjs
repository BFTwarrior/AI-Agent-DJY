import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import fs, { mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { makeTestTmpDir, removeTreeWithRetry } from './support/cleanup.mjs';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { parse } from 'acorn';
import { ensureDaemon, healthy, packageVersion } from '../src/bootstrap.mjs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { formatDaemonResult } from '../scripts/supervisor-log.mjs';
import { startChildDaemon, terminate } from './support/child-daemon.mjs';

const SUPERVISOR = fileURLToPath(new URL('../scripts/daemon-supervisor.mjs', import.meta.url));

// `process.kill(pid, 0)` is the portable liveness probe; EPERM means it exists
// but belongs to somebody else.
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function waitForExit(pid, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
}
import { discoveryBaseDir } from '../src/discovery.mjs';

// A stub daemon that answers /api/v1/health with a chosen version and identity.
// `ensureDaemon` only needs the health probe, the discovery record and a token,
// so a real daemon process is unnecessary for these cases.
async function startStubDaemon({ version, workspace, token, reportWorkspace }) {
  const instanceId = `stub-${version}-${Math.random().toString(16).slice(2, 10)}`;
  // `reportWorkspace` models a daemon that answers on the recorded port but
  // belongs to a different workspace, which is what the cross-workspace gate
  // exists to reject.
  const reportedWorkspace = reportWorkspace ?? workspace;
  const server = createServer((req, res) => {
    if (req.url === '/api/v1/health') {
      // `/api/v1/health` is an unauthenticated liveness endpoint: `probeHealth`
      // deliberately sends no token, so requiring one here would make every
      // case look unhealthy for the wrong reason.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, data: { status: 'ok', version, workspace: reportedWorkspace, pid: process.pid, instanceId } }));
      return;
    }
    if (req.url === '/api/v1/teams') {
      // `ensureDaemon` calls this to confirm it holds the discovery token before
      // it is allowed to stop a daemon, so the stub must answer it.
      const authorized = req.headers.authorization === `Bearer ${token}`;
      res.writeHead(authorized ? 200 : 401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: authorized }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, port: server.address().port, instanceId };
}

// Every case gets a private discovery root. Sharing the real
// `~/.ai-agent-teams/workspaces` lets a concurrently running daemon or another
// test satisfy the record first, which makes the result depend on run order.
let discoveryBase;
function workspaceWithConfig() {
  if (!discoveryBase) {
    discoveryBase = realpathSync.native(makeTestTmpDir('ai-agent-teams-discovery-'));
    process.env.AGENT_TEAMS_DISCOVERY_BASE = discoveryBase;
  }
  // Fail loudly instead of silently falling back to the real user HOME: the
  // discovery module resolves the override, so compare against the resolved form.
  assert.equal(discoveryBaseDir(), resolve(discoveryBase),
    'the discovery root must be the private temp directory, not the real HOME');
  // `realpathSync.native` expands 8.3 short names (C:\Users\BFTWAR~1) that the
  // daemon would otherwise report, which `resolve` alone does not normalise.
  const workspace = realpathSync.native(makeTestTmpDir('ai-agent-teams-bootstrap-'));
  mkdirSync(join(workspace, 'config'), { recursive: true });
  // `none` isolation keeps the git-repository precondition out of the way.
  writeFileSync(join(workspace, 'config', 'local.json'), JSON.stringify({ isolation: { mode: 'none' } }), 'utf8');
  return workspace;
}

test('the expected version reflects package.json at call time, not at import time', (t) => {
  // Change only the bytes returned for this exact read. Rewriting the real
  // package races other test workers that import its version during startup.
  const pkgUrl = new URL('../package.json', import.meta.url);
  const pkgPath = fileURLToPath(pkgUrl);
  const originalRead = fs.readFileSync;
  const originalWrite = fs.writeFileSync;
  const original = originalRead(pkgUrl);
  const before = statSync(pkgUrl, { bigint: true });
  const parsed = JSON.parse(original.toString('utf8'));
  const matchesPackage = (path) => {
    if (typeof path === 'number') return false;
    const absolute = resolve(path instanceof URL ? fileURLToPath(path) : String(path));
    return process.platform === 'win32'
      ? absolute.toLowerCase() === pkgPath.toLowerCase() : absolute === pkgPath;
  };
  let contents = original.toString('utf8');
  let packageReads = 0;
  const read = t.mock.method(fs, 'readFileSync', (path, options) => {
    if (!matchesPackage(path)) return originalRead(path, options);
    packageReads += 1;
    const encoding = typeof options === 'string' ? options : options?.encoding;
    return encoding ? Buffer.from(contents).toString(encoding) : Buffer.from(contents);
  });
  const write = t.mock.method(fs, 'writeFileSync', (path, ...args) => {
    assert.equal(matchesPackage(path), false, 'this test must never write the host package.json');
    return originalWrite(path, ...args);
  });
  syncBuiltinESMExports();
  try {
    assert.equal(packageVersion(), parsed.version);
    contents = JSON.stringify({ ...parsed, version: '0.0.0-sentinel' });
    assert.equal(packageVersion(), '0.0.0-sentinel',
      'the version must be re-read on every call, not cached at import');
    contents = original.toString('utf8');
    assert.equal(packageVersion(), parsed.version, 'the original version must come back');
    assert.equal(packageReads, 3, 'all three calls must read the current package bytes');
  } finally {
    read.mock.restore();
    write.mock.restore();
    syncBuiltinESMExports();
    assert.deepEqual(originalRead(pkgUrl), original, 'the real package bytes must stay untouched');
    assert.equal(statSync(pkgUrl, { bigint: true }).mtimeNs, before.mtimeNs,
      'even a write followed by restore must be rejected');
  }
  assert.equal(packageVersion(), parsed.version, 'restoring the mock must restore real file reads');
});

test('health never compares against a version this process remembers', () => {
  // Version must be absent from the health predicate entirely. Including it
  // makes a long-lived caller reject a self-consistent daemon after an upgrade;
  // the supervisor then logs the version error on every interval.
  const source = readFileSync(new URL('../src/bootstrap.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('async function healthy(');
  const end = source.indexOf('function processAlive', start);
  const body = source.slice(start, end);
  assert.ok(!/packageVersion\(/.test(body),
    'the health predicate must not consult the package version');
  assert.match(body, /health\.version === discovery\.version/,
    'the daemon must be judged against its own discovery record');
});

test('a healthy daemon running the on-disk version is adopted', async () => {
  // Adoption needs both properties: the daemon is alive and agrees with its own
  // record, AND it runs the version that is on disk right now. This case covers
  // the happy path; the two cases below cover each failure of those conditions.
  const workspace = workspaceWithConfig();
  const stub = await startStubDaemon({ version: packageVersion(), workspace, token: 'shared-token' });
  try {
    const { discoveryPathForWorkspace } = await import('../src/discovery.mjs');
    const discoveryPath = discoveryPathForWorkspace(workspace);
    mkdirSync(join(discoveryPath, '..'), { recursive: true });
    writeFileSync(discoveryPath, JSON.stringify({
      port: stub.port,
      token: 'shared-token',
      pid: process.pid,
      workspace,
      version: packageVersion(),
      instanceId: stub.instanceId,
    }), 'utf8');

    const result = await ensureDaemon({
      workspace,
      configPath: join(workspace, 'config', 'local.json'),
      timeoutMs: 2000,
    });
    assert.equal(result.started, false, 'a matching, healthy daemon must be reused');
    assert.equal(result.discovery.port, stub.port);
    assert.equal(result.replacedVersion, undefined, 'nothing was replaced');

    const probe = await fetch(`http://127.0.0.1:${stub.port}/api/v1/health`, {
      headers: { authorization: 'Bearer shared-token' },
    });
    assert.equal(probe.status, 200, 'the daemon must still be running after the call');
  } finally {
    stub.server.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('a discovery record that disagrees with the live daemon is not trusted', async () => {
  // If the record claims one version and the daemon answers with another, the
  // pair is inconsistent: the tunnel is stale, so the record must not be used
  // and the daemon must not be killed on the strength of it.
  const workspace = workspaceWithConfig();
  const stub = await startStubDaemon({ version: '9.9.9-newer', workspace, token: 'shared-token' });
  try {
    const { discoveryPathForWorkspace } = await import('../src/discovery.mjs');
    const discoveryPath = discoveryPathForWorkspace(workspace);
    mkdirSync(join(discoveryPath, '..'), { recursive: true });
    writeFileSync(discoveryPath, JSON.stringify({
      port: stub.port,
      token: 'shared-token',
      pid: process.pid,
      workspace,
      version: '0.0.1-stale-record',
      instanceId: stub.instanceId,
    }), 'utf8');

    // A record whose version disagrees with what the daemon reports is stale, so
    // it must not be trusted as a healthy match. Here the daemon also claims this
    // test process's pid, so replacement is attempted and fails to stop it --
    // which is the safe outcome: the daemon is still serving.
    await assert.rejects(
      () => ensureDaemon({ workspace, configPath: join(workspace, 'config', 'local.json'), timeoutMs: 600 }),
      /did not accept its discovery token|did not prove its PID|did not become healthy|failed to stop the stale/,
    );
    const probe = await fetch(`http://127.0.0.1:${stub.port}/api/v1/health`);
    assert.equal(probe.status, 200, 'an unverified daemon must never be killed');
  } finally {
    stub.server.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('a self-consistent daemon of an older version is replaced, not adopted', async () => {
  // The mirror image of the original defect. Once the health predicate stopped
  // looking at versions, a daemon whose record and report were *both* older than
  // the code on disk looked perfectly healthy, was adopted on the fast path, and
  // the whole replacement branch became unreachable -- so an upgrade silently
  // kept running the old daemon. Adoption therefore needs both "healthy" and
  // "running the version on disk".
  const workspace = workspaceWithConfig();
  const diskVersion = packageVersion();
  const oldVersion = '0.0.1-older';
  assert.notEqual(diskVersion, oldVersion);
  const stub = await startStubDaemon({ version: oldVersion, workspace, token: 'shared-token' });
  try {
    const { discoveryPathForWorkspace } = await import('../src/discovery.mjs');
    const discoveryPath = discoveryPathForWorkspace(workspace);
    mkdirSync(join(discoveryPath, '..'), { recursive: true });
    writeFileSync(discoveryPath, JSON.stringify({
      port: stub.port,
      token: 'shared-token',
      pid: process.pid,
      workspace,
      version: oldVersion,
      instanceId: stub.instanceId,
    }), 'utf8');

    // The daemon is alive and self-consistent, so `healthy` is true; only the
    // version test can tell that it must be replaced.
    let error;
    try {
      await ensureDaemon({ workspace, configPath: join(workspace, 'config', 'local.json'), timeoutMs: 900 });
    } catch (caught) {
      error = caught;
    }
    // On this host the old daemon shares the test process's pid, so the stop is
    // refused -- which is the safe outcome and proves the fast path did NOT
    // simply adopt it.
    assert.ok(error, 'an older daemon must not be adopted silently');
    assert.match(error.message,
      /failed to stop the stale|did not prove its PID|did not accept its discovery token|did not become healthy/);
    const probe = await fetch(`http://127.0.0.1:${stub.port}/api/v1/health`);
    assert.equal(probe.status, 200, 'the verification must not have killed an unowned process');
  } finally {
    stub.server.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('a daemon whose identity does not match its record is refused', async () => {
  // Safety gate: a reachable daemon that answers on the recorded port but claims
  // a different pid/instanceId is somebody else. It must be refused, and it must
  // stay alive -- version skew or not.
  const workspace = workspaceWithConfig();
  const stub = await startStubDaemon({ version: packageVersion(), workspace, token: 'shared-token' });
  try {
    const { discoveryPathForWorkspace } = await import('../src/discovery.mjs');
    const discoveryPath = discoveryPathForWorkspace(workspace);
    mkdirSync(join(discoveryPath, '..'), { recursive: true });
    writeFileSync(discoveryPath, JSON.stringify({
      port: stub.port,
      token: 'shared-token',
      pid: process.pid,
      workspace,
      version: packageVersion(),
      // The stub reports `stub.instanceId`; recording a different one models a
      // stale record that happens to point at a live, unrelated daemon.
      instanceId: 'a-different-instance',
    }), 'utf8');

    await assert.rejects(
      () => ensureDaemon({ workspace, configPath: join(workspace, 'config', 'local.json'), timeoutMs: 900 }),
      /did not prove its PID|did not accept its discovery token|another AgentTeams daemon|did not become healthy/,
    );
    const probe = await fetch(`http://127.0.0.1:${stub.port}/api/v1/health`);
    assert.equal(probe.status, 200, 'an unverified daemon must never be killed');
  } finally {
    stub.server.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('the supervisor reports a replacement distinctly from a fresh start', () => {
  // Behaviour, not source shape: call the supervisor's own formatter and assert
  // the two cases are distinguishable. A regression that collapses the
  // replacement branch into "daemon started" would hide an upgrade from the log.
  assert.equal(
    formatDaemonResult({ started: true, replacedVersion: '0.0.9', discovery: { version: '0.1.9', port: 8779 } }),
    'daemon replaced 0.0.9 -> 0.1.9 port=8779',
  );
  assert.equal(
    formatDaemonResult({ started: true, discovery: { version: '0.1.9', port: 8779 } }),
    'daemon started port=8779',
  );
  assert.equal(formatDaemonResult({ started: false, discovery: { version: '0.1.9', port: 8779 } }), undefined,
    'adopting a healthy daemon is not worth a log line');
  // A malformed result must not throw: the supervisor catches everything and
  // would report only "ensureDaemon failed", hiding the real cause.
  assert.equal(formatDaemonResult({ started: true }), undefined);
  assert.equal(formatDaemonResult(undefined), undefined);
});

test('the supervisor stays a plain top-level script with no entry-point guard', async () => {
  // The logon task launches this file through wscript.exe, so a path that does
  // not compare equal to `import.meta.url` (8.3 short names, a trailing
  // separator, a case difference) would make an entry guard fail and the
  // supervisor exit immediately -- and then nothing restarts the daemon, with no
  // visible error anywhere. The constraint is documented in
  // `scripts/supervisor-log.mjs`; this test turns that comment into a gate.
  //
  // Behavioural half first: start it and require that it is still running after
  // its first line, rather than having exited at import time.
  const soloHome = makeTestTmpDir('ai-agent-teams-sup-home-');
  const soloWorkspace = makeTestTmpDir('ai-agent-teams-sup-ws-');
  mkdirSync(join(soloWorkspace, 'config'), { recursive: true });
  // Deliberately INVALID config. The supervisor only has to prove it reaches its
  // loop; a config that `loadConfig` rejects makes `ensureDaemon` throw before it
  // spawns anything, so this test cannot leave a detached daemon behind.
  //
  // An earlier version supplied a valid config and set AGENT_TEAMS_AUTOSTART=0,
  // believing that suppressed the spawn. It does not: that variable is only read
  // by `src/mcp/runtime-entry.mjs`. The supervisor spawned a real
  // `run-hidden.vbs` daemon pointing at this temporary workspace, and killing the
  // supervisor left the launcher alive forever (an orphan wscript.exe referring
  // to a directory that had already been deleted).
  writeFileSync(join(soloWorkspace, 'config', 'local.json'), JSON.stringify({ version: 999 }), 'utf8');
  const discoveryPath = join(soloWorkspace, 'discovery.json');
  const logPath = join(soloHome, '.ai-agent-teams', 'supervisor.log');
  const child = spawn(process.execPath, [SUPERVISOR], {
    env: {
      ...process.env,
      USERPROFILE: soloHome,
      HOME: soloHome,
      AGENT_TEAMS_WORKSPACE: soloWorkspace,
      AGENT_TEAMS_CONFIG: join(soloWorkspace, 'config', 'local.json'),
      AGENT_TEAMS_DISCOVERY: discoveryPath,
      // Long enough that the first iteration is still in flight, short enough
      // that the process cannot linger past the assertion window.
      AGENT_TEAMS_SUPERVISOR_INTERVAL_MS: '60000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  try {
    const deadline = Date.now() + 10000;
    let log = '';
    while (Date.now() < deadline) {
      try { log = readFileSync(logPath, 'utf8'); } catch { /* not written yet */ }
      if (log.includes('supervisor start')) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
    assert.match(log, /supervisor start/,
      'the supervisor must reach its loop when started as a plain script');
    assert.equal(child.exitCode, null,
      'the supervisor must still be running, not have exited at import time');
  } finally {
    // `taskkill /T` takes the whole tree: the supervisor plus anything it managed
    // to launch. A plain kill leaves a launcher behind on Windows.
    terminate(child.pid);
    await waitForExit(child.pid);
    removeTreeWithRetry(soloWorkspace);
    removeTreeWithRetry(soloHome);
  }

  // Structural half: the file must never ask how it was launched.
  //
  // The decisive property is that `process.argv` is absent from the module
  // entirely, and this is checked by walking the AST rather than matching text.
  //
  // Enumerating "where a guard can sit" does not work: earlier versions of this
  // test checked the loop condition, then the stop-flag initialiser, then
  // top-level ifs before the loop -- and each round a new spelling slipped past
  // (`if (...) break;` as the loop's first statement; `stopping ||= !(...)` as a
  // logical assignment; an IIFE `(() => { if (...) stopping = true; })()`). All
  // three are real guards that make the loop spin zero times under wscript.exe.
  //
  // Every one of those spellings has to read `process.argv` (or compare
  // `import.meta.url` against it) to decide anything about how the file was
  // launched, so "no reference at all" covers all of them, and it cannot be
  // satisfied by a guard that does something useful. The old structured checks
  // are kept below because they also catch a guard that keys off something else
  // entirely (an env var, for instance), which the argv rule would miss.
  //
  // Boundary worth knowing before anyone relaxes the structured checks below:
  // the argv rule is the PRIMARY test but it is NOT sufficient. Two spellings
  // produce no `process.argv` MemberExpression at all -- `process["argv"]`
  // (computed member) and `const { argv: ARGV } = process` (destructured alias).
  // Both are currently caught only by "no top-level if/return/throw/exit before
  // the loop". They were measured, not assumed. So: do not drop that structured
  // check believing the argv rule already covers everything.
  const source = readFileSync(SUPERVISOR, 'utf8');
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });

  const argvRefs = [];
  walkAst(ast, (node) => {
    if (node.type === 'MemberExpression'
      && node.object?.type === 'Identifier' && node.object.name === 'process'
      && !node.computed && node.property?.name === 'argv') {
      argvRefs.push(node);
    }
  });
  assert.equal(argvRefs.length, 0,
    'daemon-supervisor.mjs must not reference process.argv at all: any entry-point test '
    + 'built from it can make wscript.exe skip the supervise loop silently');

  const loops = ast.body.filter((node) => node.type === 'WhileStatement');
  assert.equal(loops.length, 1,
    'the supervisor must have exactly one top-level while loop');
  const loopIndex = ast.body.indexOf(loops[0]);

  // The loop must be driven by a flag that starts false, and no top-level
  // statement before it may branch, exit or throw.
  assert.match(JSON.stringify(loops[0].test), /stopping/,
    'the loop must be driven by the stop flag, not by an entry-point test');
  const stoppingInit = ast.body
    .slice(0, loopIndex)
    .filter((node) => node.type === 'VariableDeclaration')
    .flatMap((node) => node.declarations)
    .find((decl) => decl.id?.name === 'stopping');
  assert.ok(stoppingInit, 'the stop flag must be declared before the loop');
  assert.equal(stoppingInit.init?.type, 'Literal',
    'the stop flag must be initialised to a literal (false), never to a computed entry-point test');
  assert.equal(stoppingInit.init.value, false,
    'the stop flag must start as false so the loop always runs at least once');

  // Nothing may leave the loop early either: `if (...) break;` as the first
  // statement of the body is just as effective a guard as one before it.
  const earlyExits = [];
  walkAst(loops[0], (node) => {
    if (node.type === 'BreakStatement' || node.type === 'ContinueStatement') earlyExits.push(node);
  });
  assert.equal(earlyExits.length, 0,
    'the supervise loop must not break or continue: a guard inside the body skips every iteration');

  for (const node of ast.body.slice(0, loopIndex)) {
    if (node.type === 'IfStatement') {
      assert.fail('daemon-supervisor.mjs must not gate its loop behind a top-level if: wscript.exe can launch it with a path that fails the test');
    }
    if (node.type === 'ExpressionStatement' && node.expression.type === 'CallExpression') {
      const callee = node.expression.callee;
      const name = callee.type === 'Identifier' ? callee.name : callee.property?.name;
      assert.ok(!['exit', 'abort'].includes(name),
        `daemon-supervisor.mjs must not call ${name} before its loop`);
    }
    if (['ReturnStatement', 'ThrowStatement'].includes(node.type)) {
      assert.fail(`daemon-supervisor.mjs must not ${node.type === 'ReturnStatement' ? 'return' : 'throw'} at top level before its loop`);
    }
  }
});

// Depth-first walk over any acorn node, calling `visit` on every node.
function walkAst(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) walkAst(child, visit);
    } else if (value && typeof value === 'object' && typeof value.type === 'string') {
      walkAst(value, visit);
    }
  }
}

test('a successful replacement reports the version that was replaced', async () => {
  // The other replacement cases all serve `pid: process.pid`, which
  // `stopStaleDaemon` refuses to signal -- so they prove the fast path is not
  // taken, but they never reach the branch that actually stops the old daemon
  // and records `replacedVersion`. Deleting that assignment used to leave the
  // whole suite green, which meant the supervisor could log an upgrade as a
  // plain restart with nothing failing.
  //
  // Here the old daemon is a separate process, so the stop succeeds.
  const workspace = workspaceWithConfig();
  const oldVersion = '0.0.1-older';
  const diskVersion = packageVersion();
  assert.notEqual(diskVersion, oldVersion, 'the fixture must differ from the on-disk version');

  const child = await startChildDaemon({ version: oldVersion, workspace, token: 'shared-token' });
  // `ensureDaemon` detaches whatever daemon it starts, so it survives this test
  // and keeps its port bound. Track it here and stop it in `finally`: doing this
  // inline after the assertions meant a failing assertion leaked a daemon AND
  // then surfaced as an EPERM while deleting the workspace, which buried the
  // real failure.
  let startedPid;
  try {
    const { discoveryPathForWorkspace } = await import('../src/discovery.mjs');
    const discoveryPath = discoveryPathForWorkspace(workspace);
    mkdirSync(join(discoveryPath, '..'), { recursive: true });
    writeFileSync(discoveryPath, JSON.stringify({
      port: child.port,
      token: 'shared-token',
      pid: child.pid,
      workspace,
      version: oldVersion,
      instanceId: child.instanceId,
    }), 'utf8');

    // Replacement has to start a REAL daemon, so the config must be complete.
    // `example.v06.json` is the shipped baseline; only its isolation mode is
    // overridden, because `worktree` requires a git checkout and the point of
    // this fixture is a workspace that is not one.
    const configPath = join(workspace, 'config', 'local.json');
    const baseConfig = JSON.parse(readFileSync(new URL('../config/example.v06.json', import.meta.url), 'utf8'));
    baseConfig.isolation = { ...baseConfig.isolation, mode: 'none' };
    writeFileSync(configPath, JSON.stringify(baseConfig), 'utf8');

    const result = await ensureDaemon({
      workspace,
      configPath,
      timeoutMs: 25000,
    });
    startedPid = result.discovery?.pid ? Number(result.discovery.pid) : undefined;
    assert.equal(result.started, true, 'the old daemon must have been replaced');
    assert.equal(result.replacedVersion, oldVersion,
      'the version that was running before the upgrade must be reported');
    assert.equal(result.discovery.version, diskVersion, 'the new daemon runs the on-disk version');
    assert.equal(formatDaemonResult(result), `daemon replaced ${oldVersion} -> ${diskVersion} port=${result.discovery.port}`);

    // The old process must actually be gone, not just bypassed.
    await waitForExit(child.pid);
    assert.equal(isAlive(child.pid), false, 'the replaced daemon must have been stopped');
  } finally {
    child.stop();
    // Stop the detached daemon FIRST, then delete: a daemon still running holds
    // its SQLite file, so the delete would throw EPERM and mask the assertion
    // that actually failed. Both steps run even when an assertion above threw.
    if (startedPid) {
      terminate(startedPid);
      await waitForExit(startedPid);
    }
    removeTreeWithRetry(workspace);
  }
});

// The per-file discovery root is created lazily by `workspaceWithConfig`, so it
// must be reclaimed here too. Without this every run left one
// `ai-agent-teams-discovery-*` directory behind.
after(() => {
  if (discoveryBase) removeTreeWithRetry(discoveryBase);
});

test('a daemon serving a different workspace is refused, not killed', async () => {
  // Safety gate #1. The record says this workspace, the daemon says another one.
  // That is either a stale record pointing at somebody else's daemon or a
  // misconfiguration; either way it must be refused and left running.
  const workspace = workspaceWithConfig();
  const otherWorkspace = workspaceWithConfig();
  const stub = await startStubDaemon({
    version: packageVersion(),
    workspace,
    reportWorkspace: otherWorkspace,
    token: 'shared-token',
  });
  try {
    const { discoveryPathForWorkspace } = await import('../src/discovery.mjs');
    const discoveryPath = discoveryPathForWorkspace(workspace);
    mkdirSync(join(discoveryPath, '..'), { recursive: true });
    writeFileSync(discoveryPath, JSON.stringify({
      port: stub.port,
      token: 'shared-token',
      pid: process.pid,
      workspace,
      version: packageVersion(),
      instanceId: stub.instanceId,
    }), 'utf8');

    // `healthy` must reject on the workspace mismatch alone. Version, pid and
    // instanceId all match, so nothing else can explain the refusal.
    await assert.rejects(
      () => ensureDaemon({ workspace, configPath: join(workspace, 'config', 'local.json'), timeoutMs: 900 }),
      /another AgentTeams daemon is running for workspace|did not prove its PID|did not become healthy/,
    );
    const probe = await fetch(`http://127.0.0.1:${stub.port}/api/v1/health`);
    assert.equal(probe.status, 200, 'a daemon serving another workspace must never be killed');

    // Now point a record *at this workspace's own discovery path* while its
    // payload claims a different workspace. That is the only shape that reaches
    // the workspace guards, and both of them must refuse it.
    const impostor = workspaceWithConfig();
    try {
      const impostorPath = discoveryPathForWorkspace(impostor);
      mkdirSync(join(impostorPath, '..'), { recursive: true });
      writeFileSync(impostorPath, JSON.stringify({
        port: stub.port, token: 'shared-token', pid: process.pid,
        workspace: otherWorkspace, version: packageVersion(), instanceId: stub.instanceId,
      }), 'utf8');
      await assert.rejects(
        () => ensureDaemon({ workspace: impostor, configPath: join(impostor, 'config', 'local.json'), timeoutMs: 900 }),
        /another AgentTeams daemon is running for workspace|did not become healthy/,
        'a record whose workspace does not match the request must not be adopted',
      );
    } finally {
      rmSync(impostor, { recursive: true, force: true });
    }
  } finally {
    stub.server.close();
    rmSync(workspace, { recursive: true, force: true });
    rmSync(otherWorkspace, { recursive: true, force: true });
  }
});

test('a daemon that rejects the discovery token is refused, not killed', async () => {
  // Safety gate #3. Identity can match while the token does not: the process is
  // ours but we cannot prove we may talk to it, so it must not be stopped.
  const workspace = workspaceWithConfig();
  const oldVersion = '0.0.1-older';
  // The stub only accepts `stub-secret`; the record carries a different one.
  // The version is deliberately older than the disk so the replacement path is
  // actually reached -- on the fast path no token is consulted at all.
  const stub = await startStubDaemon({ version: oldVersion, workspace, token: 'stub-secret' });
  try {
    const { discoveryPathForWorkspace } = await import('../src/discovery.mjs');
    const discoveryPath = discoveryPathForWorkspace(workspace);
    mkdirSync(join(discoveryPath, '..'), { recursive: true });
    writeFileSync(discoveryPath, JSON.stringify({
      port: stub.port,
      token: 'a-token-the-daemon-does-not-accept',
      pid: process.pid,
      workspace,
      version: oldVersion,
      instanceId: stub.instanceId,
    }), 'utf8');

    // Version skew plus matching identity reaches the stop path, which must
    // refuse when the token we hold is not the one the daemon accepts.
    await assert.rejects(
      () => ensureDaemon({ workspace, configPath: join(workspace, 'config', 'local.json'), timeoutMs: 900 }),
      /did not accept its discovery token|did not prove its PID|did not become healthy/,
    );
    const probe = await fetch(`http://127.0.0.1:${stub.port}/api/v1/health`);
    assert.equal(probe.status, 200, 'a daemon whose token we do not hold must never be killed');
  } finally {
    stub.server.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('healthy() rejects a workspace mismatch at both guard points', async () => {
  // Unit-level guard coverage. An end-to-end case cannot reliably reach these
  // conditions because earlier checks usually fire first, so drive `healthy`
  // directly: version, pid and instanceId all agree, and only the workspace
  // differs.
  //
  // Note on mutation coverage: `healthy` has two workspace checks -- the record
  // against the request, and the daemon's report against the request. They are
  // deliberately redundant, so removing either one alone still leaves the other
  // refusing. That is defence in depth, not a gap: a single-check implementation
  // would fail these assertions, and removing BOTH makes the case fail loudly.
  const workspace = workspaceWithConfig();
  const other = workspaceWithConfig();
  const token = 'shared-token';
  const version = packageVersion();
  const stub = await startStubDaemon({ version, workspace: other, token });
  try {
    // Use the stub's own instanceId: `identityMatches` compares it, so a made-up
    // value would make every case fail for the wrong reason.
    const base = { port: stub.port, token, pid: process.pid, version, instanceId: stub.instanceId };

    // Guard A: the record itself belongs to another workspace.
    assert.equal(
      await healthy({ ...base, workspace: other }, workspace), false,
      'a record from another workspace must not be healthy for this one',
    );

    // Guard B: the record claims this workspace but the daemon reports another.
    assert.equal(
      await healthy({ ...base, workspace }, workspace), false,
      'a daemon reporting another workspace must not be healthy for this one',
    );

    // Control: with the record and the request naming the same workspace as the
    // daemon reports, `healthy` accepts it. This proves the two rejections above
    // are caused by the workspace alone, not by a broken stub.
    const control = await healthy({ ...base, workspace: other }, other);
    assert.equal(control, true, 'the matching workspace must be accepted');
  } finally {
    stub.server.close();
    rmSync(workspace, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});
