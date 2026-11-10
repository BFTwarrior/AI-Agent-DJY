import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  promises as fsp,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import {
  HotUpdateError,
  acquireRuntimeLock,
  assertPublishTargetInside,
  buildPackage,
  getStatus,
  installPackage,
  recoverRuntimeState,
  rollbackPackage,
  runHealthCheck,
  verifyPackage,
} from '../src/hot-update.mjs';
import { createMcpShell } from '../src/mcp/shell.mjs';
import { validatePointerTarget } from '../src/hot-update/pointer.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const isolatedEnv = {
  AGENT_TEAMS_AUTOSTART: '0',
  AGENT_TEAMS_URL: '',
  AGENT_TEAMS_TOKEN: '',
  AGENT_TEAMS_MEMBER: '',
  AGENT_TEAMS_TEAM: '',
  AGENT_TEAMS_WORKSPACE: '',
};

const COMMIT_V1 = 'a'.repeat(40);
const COMMIT_V2 = 'b'.repeat(40);
const COMMIT_V3 = 'c'.repeat(40);
const FIXED_NOW = 1793469672414;

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function toPosix(path) {
  return path.split('\\').join('/');
}

// Change one byte without changing the length: the manifest size check must
// not be what catches the tampering.
function flipBytesKeepLength(path) {
  const data = Buffer.from(readFileSync(path));
  assert.ok(data.length > 0, `cannot flip an empty file: ${path}`);
  data[0] = data[0] ^ 0x01;
  writeFileSync(path, data);
  assert.equal(statSync(path).size, data.length);
  return data.length;
}

function writeSymlinkOrSkip(t, target, linkPath) {
  try {
    symlinkSync(target, linkPath);
    return true;
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES' || error?.code === 'ENOSYS') {
      t.skip(`symlinks are not permitted in this environment: ${error.code}`);
      return false;
    }
    throw error;
  }
}

function makeTempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function listFiles(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else files.push(relative(root, absolute).split('\\').join('/'));
    }
  };
  walk(root);
  return files.sort();
}

function writeFakeRuntime(sourceRoot, options = {}) {
  const {
    version = '9.9.9',
    failInit = false,
    failTools = false,
    exitEarly = false,
    requireAutostartOff = false,
    rejectTeamEnv = false,
    expectEnvUrl = null,
    expectEnvMissing = [],
    tools = [{ name: 'alpha_ping', description: 'ping', inputSchema: { type: 'object' } }],
  } = options;
  const dir = join(sourceRoot, 'src', 'mcp');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'handler.mjs'), 'export const FAKE_HANDLER = true;\n');
  writeFileSync(join(dir, 'runtime-entry.mjs'), `import { createInterface } from 'node:readline';
import { FAKE_HANDLER } from './handler.mjs';
import { FAKE_CONTAINER } from '../runtime/container.mjs';
void FAKE_HANDLER; void FAKE_CONTAINER;

const FAIL_INIT = ${failInit};
const FAIL_TOOLS = ${failTools};
const EXIT_EARLY = ${exitEarly};
const REQUIRE_AUTOSTART_OFF = ${requireAutostartOff};
const REJECT_TEAM_ENV = ${rejectTeamEnv};
const EXPECT_ENV_URL = ${JSON.stringify(expectEnvUrl)};
const EXPECT_ENV_MISSING = ${JSON.stringify(expectEnvMissing)};
if (EXIT_EARLY) process.exit(3);
if (REQUIRE_AUTOSTART_OFF && process.env.AGENT_TEAMS_AUTOSTART !== '0') process.exit(4);
if (REJECT_TEAM_ENV && Object.keys(process.env).some((name) => {
  const upper = name.toUpperCase();
  return upper === 'AGENT_TEAMS_URL' || upper === 'AGENT_TEAMS_TOKEN'
    || upper === 'AGENT_TEAMS_TEAM' || upper === 'AGENT_TEAMS_MEMBER';
})) process.exit(6);
if (EXPECT_ENV_URL !== null && process.env.AGENT_TEAMS_URL !== EXPECT_ENV_URL) process.exit(7);
if (EXPECT_ENV_MISSING.some((key) => process.env[key] !== undefined)) process.exit(8);
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(message) { process.stdout.write(JSON.stringify(message) + '\\n'); }
rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  let message;
  try { message = JSON.parse(text); } catch { return; }
  if (message.method === 'initialize') {
    if (FAIL_INIT) {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'init exploded' } });
      return;
    }
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-runtime', version: ${JSON.stringify(version)} },
      },
    });
    return;
  }
  if (message.method === 'tools/list') {
    if (FAIL_TOOLS) {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'tools exploded' } });
      return;
    }
    send({ jsonrpc: '2.0', id: message.id, result: { tools: ${JSON.stringify(tools)} } });
  }
});
`);
  mkdirSync(join(sourceRoot, 'src', 'runtime'), { recursive: true });
  writeFileSync(join(sourceRoot, 'src', 'runtime', 'container.mjs'), 'export const FAKE_CONTAINER = true;\n');
}

function makeSourceFixture(t, options = {}) {
  const root = makeTempDir(t, 'zat-hot-src-');
  const version = options.version ?? '9.9.9';
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({ name: 'ai-agent-teams', version, type: 'module', private: true }, null, 2)}\n`);
  writeFileSync(join(root, 'VERSION'), `${version}\n`);
  writeFakeRuntime(root, { ...options, version });
  mkdirSync(join(root, 'assets'), { recursive: true });
  writeFileSync(join(root, 'assets', 'team-panel.html'), '<!doctype html><title>panel</title>\n');
  writeFileSync(join(root, 'assets', 'team-view.html'), '<!doctype html><title>view</title>\n');
  mkdirSync(join(root, 'assets', 'build'), { recursive: true });
  writeFileSync(join(root, 'assets', 'build', 'stale.css'), '/* excluded build output */\n');
  mkdirSync(join(root, 'config'), { recursive: true });
  writeFileSync(join(root, 'config', 'schema.json'), '{"type":"object"}\n');
  writeFileSync(join(root, 'config', 'example.two-teams.json'), '{"teams":[]}\n');
  writeFileSync(join(root, 'config', 'local.json'), '{"secret":"must-not-ship"}\n');
  mkdirSync(join(root, 'test'), { recursive: true });
  writeFileSync(join(root, 'test', 'fake.test.mjs'), '// excluded from packages\n');
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs', 'notes.md'), '# excluded\n');
  mkdirSync(join(root, '文档'), { recursive: true });
  writeFileSync(join(root, '文档', '设计.md'), '# excluded\n');
  mkdirSync(join(root, '历史'), { recursive: true });
  writeFileSync(join(root, '历史', 'old.md'), '# excluded legacy history\n');
  mkdirSync(join(root, '归档', '历史'), { recursive: true });
  writeFileSync(join(root, '归档', '历史', 'old.md'), '# excluded archive\n');
  mkdirSync(join(root, 'node_modules', 'left-pad'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');
  mkdirSync(join(root, 'src', 'node_modules'), { recursive: true });
  writeFileSync(join(root, 'src', 'node_modules', 'nested.js'), '// excluded\n');
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'dist', 'bundle.js'), '// excluded\n');
  mkdirSync(join(root, 'build'), { recursive: true });
  writeFileSync(join(root, 'build', 'out.bin'), 'excluded\n');
  mkdirSync(join(root, 'target'), { recursive: true });
  writeFileSync(join(root, 'target', 'classes.jar'), 'excluded\n');
  mkdirSync(join(root, '.venv'), { recursive: true });
  writeFileSync(join(root, '.venv', 'pyvenv.cfg'), 'home=/\n');
  mkdirSync(join(root, '.git'), { recursive: true });
  writeFileSync(join(root, '.git', 'config'), '[core]\n');
  return root;
}

function makePluginRoot(t) {
  return makeTempDir(t, 'zat-hot-plugin-');
}

async function buildInto(t, pluginRoot, options = {}) {
  const sourceRoot = makeSourceFixture(t, options);
  return buildPackage({
    sourceRoot,
    pluginRoot,
    versionsRoot: options.versionsRoot,
    version: options.version,
    gitCommit: options.gitCommit ?? COMMIT_V1,
    now: FIXED_NOW,
    force: options.force,
  });
}

function readPointer(pluginRoot) {
  return JSON.parse(readFileSync(join(pluginRoot, 'runtime', 'current.json'), 'utf8'));
}

function assertHotUpdateError(error, code) {
  assert.ok(error instanceof HotUpdateError, `expected HotUpdateError, got ${error?.constructor?.name}: ${error?.message}`);
  assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
}

function makePointerFixture(t) {
  const root = makeTempDir(t, 'zat-hot-pointer-');
  const pluginRoot = join(root, 'plugin');
  const entry = 'runtime/entry.mjs';
  const entryPath = join(pluginRoot, entry);
  mkdirSync(join(pluginRoot, 'runtime'), { recursive: true });
  writeFileSync(entryPath, 'export const runtime = true;\n');
  return { root, pluginRoot, entryPath, pointer: { entry, apiVersion: 1, sha256: sha256File(entryPath) } };
}

test('pointer target accepts a regular in-root entry with a matching digest', async (t) => {
  const { pluginRoot, entryPath, pointer } = makePointerFixture(t);
  assert.deepEqual(await validatePointerTarget(pluginRoot, pointer), {
    valid: true, entryPath, sha256: pointer.sha256, error: null,
  });
});

test('pointer target rejects non-object documents and arrays', async (t) => {
  const { pluginRoot } = makePointerFixture(t);
  for (const pointer of [undefined, null, false, true, 0, 1, 'pointer', []]) {
    assert.deepEqual(await validatePointerTarget(pluginRoot, pointer), {
      valid: false,
      error: { code: 'HOT_UPDATE_POINTER_INVALID', message: 'runtime pointer must be a JSON object' },
    }, `invalid document: ${JSON.stringify(pointer)}`);
  }
});

test('pointer target rejects missing, blank and non-string entries', async (t) => {
  const { pluginRoot, pointer } = makePointerFixture(t);
  for (const entry of [undefined, null, '', ' \t ', 42, []]) {
    assert.deepEqual(await validatePointerTarget(pluginRoot, { ...pointer, entry }), {
      valid: false,
      error: { code: 'HOT_UPDATE_POINTER_INVALID', message: 'runtime pointer must contain a non-empty "entry"' },
    }, `invalid entry: ${JSON.stringify(entry)}`);
  }
});

test('pointer target rejects relative and absolute entry escapes even with matching bytes', async (t) => {
  const { root, pluginRoot, entryPath, pointer } = makePointerFixture(t);
  const outside = join(root, 'plugin-sibling', 'entry.mjs');
  mkdirSync(join(root, 'plugin-sibling'));
  writeFileSync(outside, readFileSync(entryPath));
  assert.equal(sha256File(outside), pointer.sha256);
  for (const entry of [toPosix(relative(pluginRoot, outside)), outside]) {
    assert.deepEqual(await validatePointerTarget(pluginRoot, { ...pointer, entry }), {
      valid: false,
      error: { code: 'HOT_UPDATE_POINTER_INVALID', message: `runtime entry escapes the plugin directory: ${entry}` },
    });
  }
});

test('pointer target rejects a linked parent that resolves outside the plugin root', async (t) => {
  const { root, pluginRoot, entryPath, pointer } = makePointerFixture(t);
  const outsideDir = join(root, 'outside');
  mkdirSync(outsideDir);
  const outsideEntry = join(outsideDir, 'entry.mjs');
  writeFileSync(outsideEntry, readFileSync(entryPath));
  const linkedDir = join(pluginRoot, 'linked');
  // A directory junction needs no Windows symlink privilege; POSIX uses a directory symlink.
  symlinkSync(outsideDir, linkedDir, process.platform === 'win32' ? 'junction' : 'dir');
  const entry = 'linked/entry.mjs';
  const linkedEntry = join(pluginRoot, entry);
  assert.equal(lstatSync(linkedEntry).isFile(), true, 'the final segment must pass the regular-file check');
  assert.equal(realpathSync(linkedEntry), realpathSync(outsideEntry));
  assert.equal(sha256File(linkedEntry), pointer.sha256, 'the digest must not be the rejecting guard');
  assert.deepEqual(await validatePointerTarget(pluginRoot, { ...pointer, entry }), {
    valid: false,
    error: { code: 'HOT_UPDATE_POINTER_INVALID', message: `runtime entry resolves outside the plugin directory: ${entry}` },
  });
});

test('pointer target rejects missing and unsupported API versions without coercion', async (t) => {
  const { pluginRoot, pointer } = makePointerFixture(t);
  for (const apiVersion of [undefined, null, 0, 2, '1']) {
    assert.deepEqual(await validatePointerTarget(pluginRoot, { ...pointer, apiVersion }), {
      valid: false,
      error: { code: 'HOT_UPDATE_UNSUPPORTED_API', message: `runtime pointer apiVersion ${String(apiVersion)} is not 1` },
    });
  }
});

test('pointer target rejects missing files and directories', async (t) => {
  const { pluginRoot, pointer } = makePointerFixture(t);
  for (const entry of ['runtime/missing.mjs', 'runtime']) {
    assert.deepEqual(await validatePointerTarget(pluginRoot, { ...pointer, entry }), {
      valid: false,
      error: { code: 'HOT_UPDATE_FILE_MISSING', message: `runtime entry does not exist: ${resolve(pluginRoot, entry)}` },
    });
  }
});

test('pointer target rejects missing and malformed sha256 values', async (t) => {
  const { pluginRoot, pointer } = makePointerFixture(t);
  for (const sha256 of [undefined, null, '', ' ', 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64)]) {
    assert.deepEqual(await validatePointerTarget(pluginRoot, { ...pointer, sha256 }), {
      valid: false,
      error: { code: 'HOT_UPDATE_POINTER_INVALID', message: 'runtime pointer must contain a 64-character hex "sha256"' },
    });
  }
});

test('pointer target rejects a same-length entry tamper with a previously valid digest', async (t) => {
  const { pluginRoot, entryPath, pointer } = makePointerFixture(t);
  assert.equal((await validatePointerTarget(pluginRoot, pointer)).valid, true);
  flipBytesKeepLength(entryPath);
  const actual = sha256File(entryPath);
  assert.notEqual(actual, pointer.sha256);
  assert.deepEqual(await validatePointerTarget(pluginRoot, pointer), {
    valid: false,
    error: {
      code: 'HOT_UPDATE_DIGEST_MISMATCH',
      message: `runtime entry sha256 mismatch for ${entryPath} (expected ${pointer.sha256}, got ${actual})`,
    },
  });
});

test('build packages only the runtime surface with a sha256 manifest', async (t) => {
  const pluginRoot = makePluginRoot(t);
  const sourceRoot = makeSourceFixture(t);
  const result = await buildPackage({ sourceRoot, pluginRoot, gitCommit: COMMIT_V1, now: FIXED_NOW });

  assert.equal(result.id, `9.9.9-${'a'.repeat(7)}`);
  assert.equal(result.dir, join(pluginRoot, 'runtime', 'versions', result.id));
  assert.ok(
    result.warnings.some((warning) => warning.includes('skipped non-empty directory: src/node_modules')),
    'nested caches are skipped but reported',
  );
  assert.ok(
    result.warnings.some((warning) => warning.includes('skipped non-empty directory: assets/build')),
    'a skipped non-empty directory must produce a warning (INV-048)',
  );

  const manifest = JSON.parse(readFileSync(join(result.dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.version, '9.9.9');
  assert.equal(manifest.gitCommit, COMMIT_V1);
  assert.equal(manifest.shortCommit, 'a'.repeat(7));
  assert.equal(manifest.apiVersion, 1);
  assert.equal(manifest.entry, 'src/mcp/runtime-entry.mjs');
  assert.equal(manifest.createdAt, FIXED_NOW);
  assert.equal(manifest.fileCount, manifest.files.length);
  assert.equal(manifest.totalBytes, manifest.files.reduce((total, file) => total + file.size, 0));

  const paths = manifest.files.map((file) => file.path);
  assert.deepEqual(paths, [...paths].sort(), 'manifest file list must be sorted');
  for (const path of paths) {
    assert.ok(!path.includes('\\'), `manifest paths must be POSIX: ${path}`);
    assert.equal(manifest.files.find((file) => file.path === path).sha256, sha256File(join(result.dir, path)));
  }
  for (const expected of [
    'package.json',
    'VERSION',
    'src/mcp/runtime-entry.mjs',
    'src/mcp/handler.mjs',
    'src/runtime/container.mjs',
    'assets/team-panel.html',
    'assets/team-view.html',
    'config/schema.json',
    'config/example.two-teams.json',
  ]) {
    assert.ok(paths.includes(expected), `package must contain ${expected}`);
  }

  const packaged = listFiles(result.dir);
  for (const forbidden of [
    'node_modules',
    '.git',
    'test/',
    'docs/',
    '文档/',
    '历史/',
    '归档/',
    'dist/',
    'build/',
    'target/',
    '.venv/',
    'assets/build/',
    'config/local.json',
  ]) {
    assert.ok(!packaged.some((path) => path === forbidden || path.startsWith(forbidden)), `package must exclude ${forbidden}`);
  }
  assert.ok(!packaged.some((path) => path.split('/').includes('node_modules')), 'nested node_modules must be excluded');
});

test('build refuses to overwrite a version unless forced', async (t) => {
  const pluginRoot = makePluginRoot(t);
  const sourceRoot = makeSourceFixture(t);
  const options = { sourceRoot, pluginRoot, gitCommit: COMMIT_V1, now: FIXED_NOW };
  const first = await buildPackage(options);

  await assert.rejects(buildPackage(options), (error) => {
    assertHotUpdateError(error, 'HOT_UPDATE_VERSION_EXISTS');
    return true;
  });
  assert.ok(existsSync(join(first.dir, 'manifest.json')));

  writeFileSync(join(first.dir, 'stale-marker.txt'), 'old build\n');
  const rebuilt = await buildPackage({ ...options, force: true });
  assert.equal(rebuilt.id, first.id);
  assert.ok(!existsSync(join(rebuilt.dir, 'stale-marker.txt')), 'forced rebuild must replace the old directory');
});

test('build requires a resolvable git commit unless one is supplied', async (t) => {
  const pluginRoot = makePluginRoot(t);
  const sourceRoot = makeSourceFixture(t);
  await assert.rejects(
    buildPackage({ sourceRoot, pluginRoot }),
    (error) => {
      assertHotUpdateError(error, 'HOT_UPDATE_GIT_FAILED');
      return true;
    },
  );
  assert.ok(!existsSync(join(pluginRoot, 'runtime', 'versions')), 'a failed build must not create a version');
});

test('build resolves the commit from a real repository', async (t) => {
  const pluginRoot = makePluginRoot(t);
  const sourceRoot = makeSourceFixture(t);
  rmSync(join(sourceRoot, '.git'), { recursive: true, force: true });
  try {
    execFileSync('git', ['init', '-q'], { cwd: sourceRoot, stdio: 'ignore' });
    execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=test', 'add', '-A'], { cwd: sourceRoot, stdio: 'ignore' });
    execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '-qm', 'fixture'], { cwd: sourceRoot, stdio: 'ignore' });
  } catch {
    t.skip('git is not available in this environment');
    return;
  }
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim();
  const result = await buildPackage({ sourceRoot, pluginRoot, now: FIXED_NOW });
  assert.equal(result.manifest.gitCommit, head);
  assert.equal(result.id, `9.9.9-${head.slice(0, 7)}`);
});

test('verifyPackage rejects tampered, missing and incompatible packages', async (t) => {
  const pluginRoot = makePluginRoot(t);
  const built = await buildInto(t, pluginRoot);

  const tampered = join(pluginRoot, 'runtime', 'versions', 'tampered');
  mkdirSync(tampered, { recursive: true });
  copyTree(built.dir, tampered);
  writeFileSync(join(tampered, 'assets', 'team-panel.html'), 'tampered\n');
  await assert.rejects(verifyPackage(tampered), (error) => {
    assertHotUpdateError(error, 'HOT_UPDATE_DIGEST_MISMATCH');
    return true;
  });

  const missing = join(pluginRoot, 'runtime', 'versions', 'missing');
  mkdirSync(missing, { recursive: true });
  copyTree(built.dir, missing);
  rmSync(join(missing, 'src', 'mcp', 'handler.mjs'));
  await assert.rejects(verifyPackage(missing), (error) => {
    assertHotUpdateError(error, 'HOT_UPDATE_FILE_MISSING');
    return true;
  });

  const noManifest = join(pluginRoot, 'runtime', 'versions', 'no-manifest');
  mkdirSync(noManifest, { recursive: true });
  copyTree(built.dir, noManifest);
  rmSync(join(noManifest, 'manifest.json'));
  await assert.rejects(verifyPackage(noManifest), (error) => {
    assertHotUpdateError(error, 'HOT_UPDATE_MANIFEST_MISSING');
    return true;
  });

  const corruptManifest = join(pluginRoot, 'runtime', 'versions', 'corrupt-manifest');
  mkdirSync(corruptManifest, { recursive: true });
  copyTree(built.dir, corruptManifest);
  writeFileSync(join(corruptManifest, 'manifest.json'), '{ not json');
  await assert.rejects(verifyPackage(corruptManifest), (error) => {
    assertHotUpdateError(error, 'HOT_UPDATE_MANIFEST_INVALID');
    return true;
  });

  const wrongApi = join(pluginRoot, 'runtime', 'versions', 'wrong-api');
  mkdirSync(wrongApi, { recursive: true });
  copyTree(built.dir, wrongApi);
  const manifest = JSON.parse(readFileSync(join(wrongApi, 'manifest.json'), 'utf8'));
  manifest.apiVersion = 2;
  writeFileSync(join(wrongApi, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(verifyPackage(wrongApi), (error) => {
    assertHotUpdateError(error, 'HOT_UPDATE_UNSUPPORTED_API');
    return true;
  });

  const escaping = join(pluginRoot, 'runtime', 'versions', 'escaping');
  mkdirSync(escaping, { recursive: true });
  copyTree(built.dir, escaping);
  const escapingManifest = JSON.parse(readFileSync(join(escaping, 'manifest.json'), 'utf8'));
  escapingManifest.entry = '../outside.mjs';
  writeFileSync(join(escaping, 'manifest.json'), JSON.stringify(escapingManifest));
  await assert.rejects(verifyPackage(escaping), (error) => {
    assertHotUpdateError(error, 'HOT_UPDATE_MANIFEST_INVALID');
    return true;
  });
});

function copyTree(source, target) {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(to, { recursive: true });
      copyTree(from, to);
      continue;
    }
    writeFileSync(to, readFileSync(from));
  }
}

test('install verifies the package, health-checks it and writes the pointer atomically', async (t) => {
  const pluginRoot = makePluginRoot(t);
  const built = await buildInto(t, pluginRoot);
  const result = await installPackage({ pluginRoot, packagePath: built.dir, now: FIXED_NOW });

  assert.equal(result.health.ok, true);
  assert.equal(result.health.tools, 1);
  const pointer = readPointer(pluginRoot);
  assert.equal(pointer.version, '9.9.9');
  assert.equal(pointer.apiVersion, 1);
  assert.equal(pointer.gitCommit, COMMIT_V1);
  assert.equal(pointer.installedAt, FIXED_NOW);
  assert.equal(pointer.entry, `runtime/versions/${built.id}/src/mcp/runtime-entry.mjs`);
  assert.ok(!pointer.entry.includes('\\'), 'pointer entry must be POSIX');
  assert.equal(pointer.sha256, sha256File(join(built.dir, 'src', 'mcp', 'runtime-entry.mjs')));
  assert.equal(pointer.previous, undefined);

  const runtimeEntries = readdirSync(join(pluginRoot, 'runtime'));
  assert.deepEqual(runtimeEntries.sort(), ['current.json', 'versions'], 'no temp pointer files may be left behind');

  const again = await installPackage({ pluginRoot, packagePath: built.dir, now: FIXED_NOW + 1 });
  assert.equal(again.created, false, 'installing the same package is idempotent');
  assert.equal(readPointer(pluginRoot).sha256, pointer.sha256);
});

test('install rejects a tampered package and keeps the previous pointer', async (t) => {
  const pluginRoot = makePluginRoot(t);
  const v1 = await buildInto(t, pluginRoot, { version: '9.9.9', gitCommit: COMMIT_V1 });
  await installPackage({ pluginRoot, packagePath: v1.dir });
  const before = readFileSync(join(pluginRoot, 'runtime', 'current.json'), 'utf8');

  const v2 = await buildInto(t, pluginRoot, { version: '9.9.10', gitCommit: COMMIT_V2 });
  writeFileSync(join(v2.dir, 'assets', 'team-view.html'), 'tampered\n');
  await assert.rejects(installPackage({ pluginRoot, packagePath: v2.dir }), (error) => {
    assertHotUpdateError(error, 'HOT_UPDATE_DIGEST_MISMATCH');
    return true;
  });
  assert.equal(readFileSync(join(pluginRoot, 'runtime', 'current.json'), 'utf8'), before, 'the pointer must not move');

  const v3 = await buildInto(t, pluginRoot, { version: '9.9.11', gitCommit: COMMIT_V3 });
  rmSync(join(v3.dir, 'src', 'mcp', 'handler.mjs'));
  await assert.rejects(installPackage({ pluginRoot, packagePath: v3.dir }), (error) => {
    assertHotUpdateError(error, 'HOT_UPDATE_FILE_MISSING');
    return true;
  });
  assert.equal(readFileSync(join(pluginRoot, 'runtime', 'current.json'), 'utf8'), before);
  assert.ok(!readdirSync(join(pluginRoot, 'runtime', 'versions')).some((name) => name.startsWith('.')), 'staging directories must be cleaned up');
});

test('install rolls back a package that fails its health check', async (t) => {
  const pluginRoot = makePluginRoot(t);
  const v1 = await buildInto(t, pluginRoot, { version: '9.9.9', gitCommit: COMMIT_V1 });
  await installPackage({ pluginRoot, packagePath: v1.dir });
  const before = readFileSync(join(pluginRoot, 'runtime', 'current.json'), 'utf8');

  // Broken packages arrive as shipped package directories here: the install
  // publishes them, the health check fails, and the publish is rolled back.
  const external = makeTempDir(t, 'zat-hot-failing-');
  const failingInit = await buildInto(t, pluginRoot, {
    versionsRoot: external,
    version: '9.9.10',
    gitCommit: COMMIT_V2,
    failInit: true,
  });
  await assert.rejects(installPackage({ pluginRoot, packagePath: failingInit.dir }), (error) => {
    assertHotUpdateError(error, 'HOT_UPDATE_HEALTH_FAILED');
    assert.match(error.message, /initialize failed/);
    return true;
  });
  assert.equal(readFileSync(join(pluginRoot, 'runtime', 'current.json'), 'utf8'), before);
  assert.ok(!existsSync(join(pluginRoot, 'runtime', 'versions', failingInit.id)), 'a package that failed its health check must not stay installed');
  assert.ok(existsSync(failingInit.dir), 'the shipped package directory itself is never modified or deleted');

  const failingTools = await buildInto(t, pluginRoot, {
    versionsRoot: external,
    version: '9.9.11',
    gitCommit: COMMIT_V3,
    failTools: true,
  });
  await assert.rejects(installPackage({ pluginRoot, packagePath: failingTools.dir }), (error) => {
    assertHotUpdateError(error, 'HOT_UPDATE_HEALTH_FAILED');
    assert.match(error.message, /tools\/list failed/);
    return true;
  });
  assert.equal(readFileSync(join(pluginRoot, 'runtime', 'current.json'), 'utf8'), before);

  const exiting = await buildInto(t, pluginRoot, {
    versionsRoot: external,
    version: '9.9.12',
    gitCommit: COMMIT_V3,
    exitEarly: true,
  });
  await assert.rejects(installPackage({ pluginRoot, packagePath: exiting.dir }), (error) => {
    assertHotUpdateError(error, 'HOT_UPDATE_HEALTH_FAILED');
    assert.match(error.message, /exited before completing/);
    return true;
  });
  assert.equal(readFileSync(join(pluginRoot, 'runtime', 'current.json'), 'utf8'), before);
});

test('install never copies build caches or VCS directories from a package draft', async (t) => {
  const pluginRoot = makePluginRoot(t);
  const externalVersions = makeTempDir(t, 'zat-hot-external-');
  const sourceRoot = makeSourceFixture(t);
  const built = await buildPackage({ sourceRoot, pluginRoot, versionsRoot: externalVersions, gitCommit: COMMIT_V1 });
  mkdirSync(join(built.dir, 'node_modules', 'left-pad'), { recursive: true });
  writeFileSync(join(built.dir, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');
  mkdirSync(join(built.dir, 'dist'), { recursive: true });
  writeFileSync(join(built.dir, 'dist', 'bundle.js'), 'bundled\n');

  const result = await installPackage({ pluginRoot, packagePath: built.dir });
  const installedFiles = listFiles(result.versionDir);
  assert.ok(!installedFiles.some((path) => path.split('/').includes('node_modules')), 'node_modules must not be copied');
  assert.ok(!installedFiles.some((path) => path.startsWith('dist/')), 'dist must not be copied');
  assert.ok(installedFiles.includes('src/mcp/runtime-entry.mjs'));
});

test('install reports a broken installed copy and replaces it only with --force', async (t) => {
  const pluginRoot = makePluginRoot(t);
  const external = makeTempDir(t, 'zat-hot-broken-');
  const built = await buildInto(t, pluginRoot, { versionsRoot: external });
  await installPackage({ pluginRoot, packagePath: built.dir });
  const target = join(pluginRoot, 'runtime', 'versions', built.id);
  rmSync(join(target, 'manifest.json'));
  const before = readFileSync(join(pluginRoot, 'runtime', 'current.json'), 'utf8');

  await assert.rejects(installPackage({ pluginRoot, packagePath: built.dir }), (error) => {
    assertHotUpdateError(error, 'HOT_UPDATE_VERSION_EXISTS');
    assert.match(error.message, /installed copy is invalid: HOT_UPDATE_MANIFEST_MISSING/);
    return true;
  });
  assert.equal(readFileSync(join(pluginRoot, 'runtime', 'current.json'), 'utf8'), before);

  const repaired = await installPackage({ pluginRoot, packagePath: built.dir, force: true });
  assert.equal(repaired.health.ok, true);
  assert.ok(existsSync(join(target, 'manifest.json')), '--force must republish the intact package');

  await assert.rejects(installPackage({ pluginRoot, packagePath: join(external, 'missing-package') }), (error) => {
    assertHotUpdateError(error, 'HOT_UPDATE_PACKAGE_MISSING');
    return true;
  });
});

test('status reports the pointer, its health and every installed version', async (t) => {
  const pluginRoot = makePluginRoot(t);
  const empty = await getStatus({ pluginRoot, checkHealth: false });
  assert.equal(empty.current, null);
  assert.equal(empty.pointerError, null);
  assert.deepEqual(empty.versions, []);

  const built = await buildInto(t, pluginRoot);
  await installPackage({ pluginRoot, packagePath: built.dir });
  const status = await getStatus({ pluginRoot });
  assert.equal(status.current.id, built.id);
  assert.equal(status.current.version, '9.9.9');
  assert.equal(status.current.valid, true);
  assert.equal(status.health.checked, true);
  assert.equal(status.health.ok, true);
  assert.equal(status.health.tools, 1);
  assert.equal(status.versions.length, 1);
  assert.equal(status.versions[0].current, true);
  assert.equal(status.versions[0].entryPresent, true);
  assert.equal(status.versions[0].verified, true);
  assert.equal(status.current.verification.checked, true);
  assert.equal(status.current.verification.ok, true);

  const skipped = await getStatus({ pluginRoot, checkHealth: false });
  assert.equal(skipped.health.checked, false);

  writeFileSync(join(built.dir, 'src', 'mcp', 'runtime-entry.mjs'), '// replaced after install\n');
  const tampered = await getStatus({ pluginRoot });
  assert.equal(tampered.current.valid, false);
  assert.equal(tampered.current.error.code, 'HOT_UPDATE_DIGEST_MISMATCH');
  assert.equal(tampered.health.checked, false, 'an invalid entry must not be spawned');

  // A tamper that only changes a non-entry file must still fail the full
  // package verification: entry presence alone is not integrity.
  const fresh = await buildInto(t, pluginRoot, { version: '9.9.13', gitCommit: COMMIT_V3 });
  await installPackage({ pluginRoot, packagePath: fresh.dir });
  flipBytesKeepLength(join(fresh.dir, 'src', 'mcp', 'handler.mjs'));
  const deepTamper = await getStatus({ pluginRoot, checkHealth: false });
  assert.equal(deepTamper.current.entryValid, true, 'the entry itself is untouched');
  assert.equal(deepTamper.current.verification.checked, true);
  assert.equal(deepTamper.current.verification.ok, false);
  assert.equal(deepTamper.current.verification.error.code, 'HOT_UPDATE_DIGEST_MISMATCH');
  assert.equal(deepTamper.current.valid, false);
  assert.equal(deepTamper.health.checked, false, 'a package that failed verification must not be spawned');

  writeFileSync(join(pluginRoot, 'runtime', 'current.json'), '{ broken');
  const corrupt = await getStatus({ pluginRoot, checkHealth: false });
  assert.equal(corrupt.current, null);
  assert.equal(corrupt.pointerError.code, 'HOT_UPDATE_POINTER_INVALID');
});

test('rollback switches to the previous version only after a health check', async (t) => {
  const pluginRoot = makePluginRoot(t);
  const v1 = await buildInto(t, pluginRoot, { version: '9.9.9', gitCommit: COMMIT_V1 });
  const v2 = await buildInto(t, pluginRoot, { version: '9.9.10', gitCommit: COMMIT_V2 });
  await installPackage({ pluginRoot, packagePath: v1.dir, now: FIXED_NOW });
  await installPackage({ pluginRoot, packagePath: v2.dir, now: FIXED_NOW + 1 });
  assert.equal(readPointer(pluginRoot).version, '9.9.10');

  const rolled = await rollbackPackage({ pluginRoot, now: FIXED_NOW + 2 });
  assert.equal(rolled.pointer.version, '9.9.9');
  assert.equal(rolled.pointer.entry, `runtime/versions/${v1.id}/src/mcp/runtime-entry.mjs`);
  assert.equal(rolled.pointer.previous.version, '9.9.10');
  assert.equal(rolled.health.ok, true);
  assert.equal(readPointer(pluginRoot).version, '9.9.9');

  // A new session must still be able to initialize and list tools from the
  // rolled-back runtime: status spawns exactly the entry the shell would.
  const status = await getStatus({ pluginRoot });
  assert.equal(status.current.valid, true);
  assert.equal(status.health.ok, true);
  assert.equal(status.health.tools, 1);

  const forward = await rollbackPackage({ pluginRoot, version: v2.id, now: FIXED_NOW + 3 });
  assert.equal(forward.pointer.version, '9.9.10');
  assert.equal(forward.pointer.previous.version, '9.9.9');

  const before = readFileSync(join(pluginRoot, 'runtime', 'current.json'), 'utf8');
  await assert.rejects(rollbackPackage({ pluginRoot, version: '999.0.0' }), (error) => {
    assertHotUpdateError(error, 'HOT_UPDATE_VERSION_UNKNOWN');
    return true;
  });
  assert.equal(readFileSync(join(pluginRoot, 'runtime', 'current.json'), 'utf8'), before);
});

test('rollback refuses an unhealthy or tampered target and keeps the pointer', async (t) => {
  const pluginRoot = makePluginRoot(t);
  const healthyStub = async () => ({ ok: true, tools: 1, error: null, durationMs: 0 });
  const good = await buildInto(t, pluginRoot, { version: '9.9.10', gitCommit: COMMIT_V2 });
  const bad = await buildInto(t, pluginRoot, { version: '9.9.9', gitCommit: COMMIT_V1, failTools: true });
  await installPackage({ pluginRoot, packagePath: bad.dir, healthCheck: healthyStub });
  await installPackage({ pluginRoot, packagePath: good.dir, healthCheck: healthyStub });
  const before = readFileSync(join(pluginRoot, 'runtime', 'current.json'), 'utf8');

  await assert.rejects(rollbackPackage({ pluginRoot }), (error) => {
    assertHotUpdateError(error, 'HOT_UPDATE_HEALTH_FAILED');
    assert.match(error.message, /tools\/list failed/);
    return true;
  });
  assert.equal(readFileSync(join(pluginRoot, 'runtime', 'current.json'), 'utf8'), before);

  writeFileSync(join(bad.dir, 'src', 'mcp', 'handler.mjs'), '// tampered\n');
  await assert.rejects(rollbackPackage({ pluginRoot }), (error) => {
    assertHotUpdateError(error, 'HOT_UPDATE_DIGEST_MISMATCH');
    return true;
  });
  assert.equal(readFileSync(join(pluginRoot, 'runtime', 'current.json'), 'utf8'), before);

  await assert.rejects(rollbackPackage({ pluginRoot, version: good.id }), (error) => {
    assertHotUpdateError(error, 'HOT_UPDATE_ALREADY_CURRENT');
    return true;
  });
});

test('rollback without a pointer reports a stable error', async (t) => {
  const pluginRoot = makePluginRoot(t);
  await assert.rejects(rollbackPackage({ pluginRoot }), (error) => {
    assertHotUpdateError(error, 'HOT_UPDATE_POINTER_INVALID');
    return true;
  });
});

test('runHealthCheck disables autostart and reports failures with context', async (t) => {
  const sourceRoot = makeTempDir(t, 'zat-hot-probe-');
  writeFakeRuntime(sourceRoot, { requireAutostartOff: true });
  const entry = join(sourceRoot, 'src', 'mcp', 'runtime-entry.mjs');
  const healthy = await runHealthCheck({ entry, timeoutMs: 5000 });
  assert.equal(healthy.ok, true, healthy.error ?? 'health check should pass');
  assert.equal(healthy.tools, 1);

  const silent = join(sourceRoot, 'silent.mjs');
  writeFileSync(silent, "import { createInterface } from 'node:readline';\ncreateInterface({ input: process.stdin });\nsetInterval(() => {}, 1000);\n");
  const timedOut = await runHealthCheck({ entry: silent, timeoutMs: 250 });
  assert.equal(timedOut.ok, false);
  assert.match(timedOut.error, /within 250ms/);

  const missing = await runHealthCheck({ entry: join(sourceRoot, 'missing.mjs') });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /does not exist/);

  const broken = join(sourceRoot, 'broken.mjs');
  writeFileSync(broken, "process.stderr.write('boom from runtime\\n');\nprocess.exit(7);\n");
  const exited = await runHealthCheck({ entry: broken, timeoutMs: 5000 });
  assert.equal(exited.ok, false);
  assert.match(exited.error, /exited before completing/);
  assert.match(exited.stderrTail, /boom from runtime/);
});

test('a real package boots behind the stable shell and survives a rollback', async (t) => {
  const pluginRoot = makePluginRoot(t);
  const current = await buildPackage({ sourceRoot: REPO_ROOT, pluginRoot });
  const installed = await installPackage({ pluginRoot, packagePath: current.dir });
  assert.equal(installed.health.ok, true, installed.health.error ?? 'real runtime must pass the health check');
  assert.ok(installed.health.tools > 0, 'the packaged runtime must expose tools');

  const openShell = async () => {
    const shell = createMcpShell({
      pluginRoot,
      pointerPath: join(pluginRoot, 'runtime', 'current.json'),
      watch: false,
      env: isolatedEnv,
      stableAfterMs: 0,
      onLog: () => {},
      onNotification: () => {},
    });
    t.after(() => shell.close());
    const init = await shell.handleMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'hot-update-test', version: '1' } },
    });
    assert.equal(init.result.serverInfo.name, 'ai-agent-teams');
    const list = await shell.handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.ok(Array.isArray(list.result.tools) && list.result.tools.length > 0, 'tools/list must return the real tool catalog');
    return { shell, toolCount: list.result.tools.length };
  };

  const first = await openShell();
  assert.equal(first.shell.status().current.source, 'pointer');
  assert.equal(first.shell.status().current.version, current.manifest.version);
  await first.shell.close();

  // A second, older version lets the test prove rollback + a fresh session.
  const older = await buildPackage({ sourceRoot: REPO_ROOT, pluginRoot, version: '0.0.1' });
  await installPackage({ pluginRoot, packagePath: older.dir });
  const second = await openShell();
  assert.equal(second.shell.status().current.version, '0.0.1');
  await second.shell.close();

  const rolled = await rollbackPackage({ pluginRoot });
  assert.equal(rolled.pointer.version, current.manifest.version);
  assert.equal(rolled.pointer.previous.version, '0.0.1');
  assert.equal(rolled.health.ok, true);

  const third = await openShell();
  assert.equal(third.shell.status().current.version, current.manifest.version);
  assert.equal(third.toolCount, first.toolCount, 'rollback must not change the advertised tool catalog');
  await third.shell.close();
});

test('install rejects a package whose manifest apiVersion is not supported', async (t) => {
  const pluginRoot = makePluginRoot(t);
  const externalVersions = makeTempDir(t, 'zat-hot-api-');
  const sourceRoot = makeSourceFixture(t);
  const built = await buildPackage({ sourceRoot, pluginRoot, versionsRoot: externalVersions, gitCommit: COMMIT_V1 });
  const manifestPath = join(built.dir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.apiVersion = 9;
  writeFileSync(manifestPath, JSON.stringify(manifest));
  await assert.rejects(installPackage({ pluginRoot, packagePath: built.dir }), (error) => {
    assertHotUpdateError(error, 'HOT_UPDATE_UNSUPPORTED_API');
    return true;
  });
  assert.ok(!existsSync(join(pluginRoot, 'runtime', 'current.json')), 'a rejected package must not activate');
});

test('verifyPackage rejects a same-length digest tamper', async (t) => {
  const pluginRoot = makePluginRoot(t);
  const built = await buildInto(t, pluginRoot);
  const target = join(built.dir, 'assets', 'team-panel.html');
  const original = readFileSync(target);
  flipBytesKeepLength(target);
  assert.equal(readFileSync(target).length, original.length, 'tampering must not change the file size');
  await assert.rejects(verifyPackage(built.dir), (error) => {
    assertHotUpdateError(error, 'HOT_UPDATE_DIGEST_MISMATCH');
    assert.match(error.message, /sha256 mismatch/);
    return true;
  });
});

test('install rejects a same-length tamper and an equal-length pointer-entry tamper', async (t) => {
  const pluginRoot = makePluginRoot(t);
  const external = makeTempDir(t, 'zat-hot-eqlen-');
  const tampered = await buildInto(t, pluginRoot, { versionsRoot: external });
  flipBytesKeepLength(join(tampered.dir, 'assets', 'team-view.html'));
  await assert.rejects(installPackage({ pluginRoot, packagePath: tampered.dir }), (error) => {
    assertHotUpdateError(error, 'HOT_UPDATE_DIGEST_MISMATCH');
    return true;
  });
  assert.ok(!existsSync(join(pluginRoot, 'runtime', 'current.json')));

  const good = await buildInto(t, pluginRoot, { version: '9.9.15', gitCommit: COMMIT_V2 });
  await installPackage({ pluginRoot, packagePath: good.dir });
  flipBytesKeepLength(join(good.dir, 'src', 'mcp', 'runtime-entry.mjs'));
  const status = await getStatus({ pluginRoot, checkHealth: false });
  assert.equal(status.current.entryValid, false);
  assert.equal(status.current.error.code, 'HOT_UPDATE_DIGEST_MISMATCH');
});

test('build fails when a packaged relative import is missing (import closure)', async (t) => {
  const pluginRoot = makePluginRoot(t);
  const source = makeSourceFixture(t);
  writeFileSync(
    join(source, 'src', 'mcp', 'runtime-entry.mjs'),
    "import { createInterface } from 'node:readline';\nimport './missing-helper.mjs';\ncreateInterface({ input: process.stdin });\n",
  );
  await assert.rejects(buildPackage({ sourceRoot: source, pluginRoot, gitCommit: COMMIT_V1 }), (error) => {
    assertHotUpdateError(error, 'HOT_UPDATE_IMPORT_MISSING');
    assert.ok(error.details.imports.some((entry) => (
      entry.from === 'src/mcp/runtime-entry.mjs' && entry.specifier === './missing-helper.mjs'
    )), JSON.stringify(error.details));
    return true;
  });
  const versionsRoot = join(pluginRoot, 'runtime', 'versions');
  assert.ok(!existsSync(versionsRoot) || readdirSync(versionsRoot).length === 0);
});

test('build rejects a symlink inside the package source', async (t) => {
  const pluginRoot = makePluginRoot(t);
  const source = makeSourceFixture(t);
  if (!writeSymlinkOrSkip(t, join(source, 'src', 'mcp', 'handler.mjs'), join(source, 'src', 'linked-handler.mjs'))) return;
  await assert.rejects(buildPackage({ sourceRoot: source, pluginRoot, gitCommit: COMMIT_V1 }), (error) => {
    assertHotUpdateError(error, 'HOT_UPDATE_BUILD_FAILED');
    assert.match(error.message, /refusing to package a symlink/);
    return true;
  });
});

test('install rejects a draft whose manifest file was replaced by a symlink', async (t) => {
  const pluginRoot = makePluginRoot(t);
  const external = makeTempDir(t, 'zat-hot-draft-');
  const built = await buildInto(t, pluginRoot, { versionsRoot: external });
  const listed = join(built.dir, 'assets', 'team-view.html');
  const outside = join(external, 'outside.html');
  writeFileSync(outside, readFileSync(listed));
  rmSync(listed);
  if (!writeSymlinkOrSkip(t, outside, listed)) return;
  await assert.rejects(installPackage({ pluginRoot, packagePath: built.dir }), (error) => {
    assertHotUpdateError(error, 'HOT_UPDATE_FILE_MISSING');
    return true;
  });
  assert.ok(!existsSync(join(pluginRoot, 'runtime', 'current.json')));
});

test('verifyPackage rejects manifest files[].path traversal', async (t) => {
  const pluginRoot = makePluginRoot(t);
  const built = await buildInto(t, pluginRoot);
  const variants = [
    ['dotdot', (manifest) => { manifest.files[0].path = '../escape.mjs'; }],
    ['absolute', (manifest) => { manifest.files[0].path = '/etc/escape.mjs'; }],
    ['drive', (manifest) => { manifest.files[0].path = 'C:/escape.mjs'; }],
    ['backslash', (manifest) => { manifest.files[0].path = 'src\\mcp\\escape.mjs'; }],
  ];
  for (const [label, mutate] of variants) {
    const dir = join(pluginRoot, 'runtime', 'versions', `traversal-${label}`);
    mkdirSync(dir, { recursive: true });
    copyTree(built.dir, dir);
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    mutate(manifest);
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
    await assert.rejects(verifyPackage(dir), (error) => {
      assertHotUpdateError(error, 'HOT_UPDATE_MANIFEST_INVALID');
      return true;
    }, `${label} path must be rejected`);
  }
});

test('install copies only manifest files and warns about every skipped draft file', async (t) => {
  const pluginRoot = makePluginRoot(t);
  const external = makeTempDir(t, 'zat-hot-extras-');
  const built = await buildInto(t, pluginRoot, { versionsRoot: external });
  const entryPath = join(built.dir, 'src', 'mcp', 'runtime-entry.mjs');
  const entrySha = sha256File(entryPath);
  const shellCopyName = `.runtime-${entrySha}.mjs`;
  writeFileSync(join(built.dir, 'src', 'mcp', shellCopyName), readFileSync(entryPath));
  const wrongDigestName = `.runtime-${'0'.repeat(64)}.mjs`;
  writeFileSync(join(built.dir, 'src', 'mcp', wrongDigestName), '// not the entry bytes\n');
  writeFileSync(join(built.dir, 'config', 'local.json'), '{"secret":"must-not-ship"}\n');
  writeFileSync(join(built.dir, 'assets', 'team-view.html.bak'), 'backup\n');
  mkdirSync(join(built.dir, 'node_modules', 'left-pad'), { recursive: true });
  writeFileSync(join(built.dir, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');

  const result = await installPackage({ pluginRoot, packagePath: built.dir });
  const installed = result.versionDir;
  assert.ok(!existsSync(join(installed, 'config', 'local.json')), 'local config must never be installed');
  assert.ok(!existsSync(join(installed, 'assets', 'team-view.html.bak')));
  assert.ok(!existsSync(join(installed, 'node_modules')), 'node_modules must never be installed');
  assert.ok(existsSync(join(installed, 'src', 'mcp', shellCopyName)), 'the shell entry copy is preserved');
  assert.ok(!existsSync(join(installed, 'src', 'mcp', wrongDigestName)), 'a shell copy with a wrong digest is dropped');
  const warnings = result.warnings.join('\n');
  assert.match(warnings, /config\/local\.json/, 'the skipped local config is reported');
  assert.match(warnings, /team-view\.html\.bak/, 'other skipped draft files are reported');
  assert.match(warnings, /not listed in manifest\.json/);
  assert.match(warnings, /unexpected digest/);
});

test('recoverRuntimeState restores a version left behind by a crashed replace', async (t) => {
  const pluginRoot = makePluginRoot(t);
  const built = await buildInto(t, pluginRoot);
  const target = join(pluginRoot, 'runtime', 'versions', built.id);
  const backup = `${target}.replaced-deadbeef`;
  renameSync(target, backup);
  const journal = join(pluginRoot, 'runtime', 'recovery-test.json');
  writeFileSync(journal, JSON.stringify({
    schemaVersion: 1,
    target,
    backup,
    staging: `${target}.staging`,
    createdAt: 0,
  }));

  const recovery = await recoverRuntimeState(pluginRoot, { minAgeMs: 0 });
  assert.deepEqual(recovery.errors, []);
  assert.equal(recovery.actions[0].action, 'restored');
  assert.ok(existsSync(target), 'the target version is restored');
  assert.ok(!existsSync(backup), 'the backup is gone after recovery');
  assert.ok(!existsSync(journal), 'the recovery journal is consumed');
  await verifyPackage(target);

  // A surviving journal means the replace never committed, so the old bytes
  // must win even when the newly published target is itself a valid package.
  const victim = await buildInto(t, pluginRoot, { version: '9.9.14', gitCommit: COMMIT_V2 });
  const victimTarget = join(pluginRoot, 'runtime', 'versions', victim.id);
  const victimBackup = `${victimTarget}.replaced-abad1dea`;
  renameSync(victimTarget, victimBackup);
  mkdirSync(victimTarget, { recursive: true });
  copyTree(built.dir, victimTarget);
  const secondJournal = join(pluginRoot, 'runtime', 'recovery-test2.json');
  writeFileSync(secondJournal, JSON.stringify({
    schemaVersion: 1,
    target: victimTarget,
    backup: victimBackup,
    staging: null,
    createdAt: 0,
  }));
  const second = await recoverRuntimeState(pluginRoot, { minAgeMs: 0 });
  assert.ok(second.actions.some((action) => action.action === 'restored-previous'));
  assert.equal(
    JSON.parse(readFileSync(join(victimTarget, 'manifest.json'), 'utf8')).version,
    '9.9.14',
    'the uncommitted journal rolls the old version back even if the new target verifies',
  );
});

test('getStatus and install reclaim orphan backups and stale staging directories', async (t) => {
  const pluginRoot = makePluginRoot(t);
  const built = await buildInto(t, pluginRoot);
  const target = join(pluginRoot, 'runtime', 'versions', built.id);
  const backup = `${target}.replaced-cafebabe`;
  renameSync(target, backup);
  const journal = join(pluginRoot, 'runtime', 'recovery-status.json');
  writeFileSync(journal, JSON.stringify({ schemaVersion: 1, target, backup, staging: null, createdAt: 0 }));
  const staging = join(pluginRoot, 'runtime', 'versions', '.staging-leftover');
  mkdirSync(staging, { recursive: true });
  writeFileSync(join(staging, 'junk.txt'), 'leftover\n');

  const status = await getStatus({ pluginRoot, checkHealth: false });
  assert.ok(status.recovery.actions.length >= 1, 'status recovers crash leftovers');
  assert.ok(existsSync(target));
  assert.ok(!existsSync(backup));
  assert.ok(!existsSync(staging), 'stale staging directories are removed');

  // The same cleanup runs at the start of an install and is reported as warnings.
  const secondTarget = join(pluginRoot, 'runtime', 'versions', `9.9.99-${'d'.repeat(7)}`);
  const secondBackup = `${secondTarget}.replaced-0badf00d`;
  mkdirSync(secondTarget, { recursive: true });
  writeFileSync(join(secondTarget, 'marker.txt'), 'new\n');
  mkdirSync(secondBackup, { recursive: true });
  writeFileSync(join(secondBackup, 'marker.txt'), 'old\n');
  writeFileSync(join(pluginRoot, 'runtime', 'recovery-install.json'), JSON.stringify({
    schemaVersion: 1,
    target: secondTarget,
    backup: secondBackup,
    staging: null,
    createdAt: 0,
  }));
  const fresh = await buildInto(t, pluginRoot, { version: '9.9.16', gitCommit: COMMIT_V3 });
  const installed = await installPackage({ pluginRoot, packagePath: fresh.dir });
  assert.ok(installed.warnings.some((warning) => warning.includes('recovery:')), installed.warnings.join('\n'));
  assert.ok(!existsSync(secondBackup));
});

test('the runtime lock serializes pointer changes and reclaims stale locks', async (t) => {
  const pluginRoot = makePluginRoot(t);
  const lock = await acquireRuntimeLock(pluginRoot, { timeoutMs: 300 });
  await assert.rejects(acquireRuntimeLock(pluginRoot, { timeoutMs: 150 }), (error) => {
    assertHotUpdateError(error, 'HOT_UPDATE_LOCK_TIMEOUT');
    return true;
  });
  await lock.release();
  const again = await acquireRuntimeLock(pluginRoot, { timeoutMs: 300 });
  await again.release();

  const lockPath = join(pluginRoot, 'runtime', '.hot-update.lock');
  writeFileSync(lockPath, JSON.stringify({
    token: 'stale-owner',
    pid: 999999,
    hostname: 'some-other-host',
    createdAt: Date.now() - 60000,
  }));
  const reclaimed = await acquireRuntimeLock(pluginRoot, { timeoutMs: 500, staleMs: 100 });
  await reclaimed.release();
  assert.ok(!existsSync(lockPath), 'the stale lock is reclaimed and released');
});

test('install refuses to move the pointer while another holder owns the lock', async (t) => {
  const pluginRoot = makePluginRoot(t);
  const built = await buildInto(t, pluginRoot);
  const lock = await acquireRuntimeLock(pluginRoot, { timeoutMs: 300 });
  try {
    await assert.rejects(installPackage({ pluginRoot, packagePath: built.dir, lockTimeoutMs: 150 }), (error) => {
      assertHotUpdateError(error, 'HOT_UPDATE_LOCK_TIMEOUT');
      return true;
    });
  } finally {
    await lock.release();
  }
  assert.ok(!existsSync(join(pluginRoot, 'runtime', 'current.json')));
});

test('health checks drop inherited AGENT_TEAMS_* variables and only keep explicit overrides', async (t) => {
  const cleanRoot = makeTempDir(t, 'zat-hot-env-clean-');
  writeFakeRuntime(cleanRoot, { rejectTeamEnv: true, requireAutostartOff: true });
  const explicitRoot = makeTempDir(t, 'zat-hot-env-explicit-');
  writeFakeRuntime(explicitRoot, { expectEnvUrl: 'explicit-value' });
  const saved = {};
  for (const key of ['AGENT_TEAMS_URL', 'AGENT_TEAMS_TOKEN', 'AGENT_TEAMS_TEAM', 'AGENT_TEAMS_MEMBER', 'AGENT_TEAMS_WORKSPACE']) {
    saved[key] = process.env[key];
  }
  process.env.AGENT_TEAMS_URL = 'http://127.0.0.1:1';
  process.env.AGENT_TEAMS_TOKEN = 'host-secret';
  process.env.AGENT_TEAMS_TEAM = 'alpha';
  process.env.AGENT_TEAMS_MEMBER = 'alpha-eng';
  try {
    const inherited = await runHealthCheck({
      entry: join(cleanRoot, 'src', 'mcp', 'runtime-entry.mjs'),
      timeoutMs: 5000,
    });
    assert.equal(inherited.ok, true, inherited.error ?? 'inherited credentials must not reach the probe');
    assert.deepEqual(inherited.envOverrides, []);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  const explicit = await runHealthCheck({
    entry: join(explicitRoot, 'src', 'mcp', 'runtime-entry.mjs'),
    timeoutMs: 5000,
    env: { AGENT_TEAMS_URL: 'explicit-value' },
  });
  assert.equal(explicit.ok, true, explicit.error ?? 'an explicit override is passed through');
  assert.deepEqual(explicit.envOverrides, ['AGENT_TEAMS_URL']);
});

test('the CLI treats a path argument as a package directory and reports clear errors', async (t) => {
  const pluginRoot = makePluginRoot(t);
  const script = join(REPO_ROOT, 'scripts', 'hot-update.mjs');
  const missing = join(pluginRoot, 'missing-package');
  const missingResult = spawnSync(process.execPath, [script, 'install', missing, '--root', pluginRoot], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  assert.equal(missingResult.status, 1);
  assert.match(missingResult.stderr, /HOT_UPDATE_PACKAGE_MISSING/);
  assert.match(missingResult.stderr, /package directory does not exist/);

  const unknownResult = spawnSync(process.execPath, [script, 'install', '999.0.0', '--root', pluginRoot], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  assert.equal(unknownResult.status, 1);
  assert.match(unknownResult.stderr, /HOT_UPDATE_VERSION_UNKNOWN/);
});

test('a package built from this repository starts its daemon', async (t) => {
  const pluginRoot = makePluginRoot(t);
  const built = await buildPackage({ sourceRoot: REPO_ROOT, pluginRoot });
  const workspace = makeTempDir(t, 'zat-hot-daemon-ws-');
  const home = makeTempDir(t, 'zat-hot-daemon-home-');
  try {
    execFileSync('git', ['init', '-q'], { cwd: workspace, stdio: 'ignore' });
  } catch {
    t.skip('git is not available in this environment');
    return;
  }
  const env = { ...process.env, USERPROFILE: home, HOME: home };
  for (const key of Object.keys(env)) {
    if (key.startsWith('AGENT_TEAMS_')) delete env[key];
  }
  const child = spawn(process.execPath, [
    join(built.dir, 'src', 'daemon.mjs'),
    '--fake',
    '--no-loop',
    '--port', '0',
    '--cwd', workspace,
    '--config', join(built.dir, 'config', 'example.v06.json'),
    '--db', ':memory:',
  ], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  t.after(() => {
    try { child.kill(); } catch { /* already exited */ }
  });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && !stdout.includes('listening on') && child.exitCode === null) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  try { child.kill(); } catch { /* already exited */ }
  await new Promise((resolvePromise) => {
    if (child.exitCode !== null) resolvePromise();
    else child.once('close', resolvePromise);
  });
  assert.ok(
    stdout.includes('listening on'),
    `the packaged daemon did not start.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
  );
  assert.ok(!stderr.includes('ERR_MODULE_NOT_FOUND'), `the package is missing a daemon dependency:\n${stderr}`);
});

// ---------------------------------------------------------------------------
// Repair round 3: package identity, publish containment, crash recovery and
// the installation side effects the review flagged as untested.
// ---------------------------------------------------------------------------

test('verifyPackage requires shortCommit to be hex and to prefix gitCommit', async (t) => {
  const pluginRoot = makePluginRoot(t);
  const built = await buildInto(t, pluginRoot);

  const accepted = await verifyPackage(built.dir);
  assert.equal(accepted.shortCommit, COMMIT_V1.slice(0, 7), 'the normalized shortCommit is returned to callers');

  const variants = [
    ['missing', (manifest) => { delete manifest.shortCommit; }],
    ['undefined', (manifest) => { manifest.shortCommit = 'undefined'; }],
    ['posix-traversal', (manifest) => { manifest.shortCommit = '/../../../src'; }],
    ['windows-traversal', (manifest) => { manifest.shortCommit = '..\\..\\..\\src'; }],
    ['too-short', (manifest) => { manifest.shortCommit = 'a'.repeat(6); }],
    ['not-hex', (manifest) => { manifest.shortCommit = 'zzzzzzz'; }],
    ['not-a-prefix', (manifest) => { manifest.shortCommit = 'b'.repeat(7); }],
  ];
  for (const [label, mutate] of variants) {
    const dir = join(pluginRoot, 'runtime', 'versions', `short-${label}`);
    mkdirSync(dir, { recursive: true });
    copyTree(built.dir, dir);
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    mutate(manifest);
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
    await assert.rejects(verifyPackage(dir), (error) => {
      assertHotUpdateError(error, 'HOT_UPDATE_MANIFEST_INVALID');
      assert.match(error.message, /shortCommit/);
      return true;
    }, `${label} shortCommit must be rejected`);
  }
});

test('install refuses a draft whose shortCommit is missing or escapes the versions directory', async (t) => {
  const pluginRoot = makePluginRoot(t);
  // A `versions/../../src` slug would replace the plugin's own source tree, so
  // the marker below is what the traversal would destroy.
  mkdirSync(join(pluginRoot, 'src', 'mcp'), { recursive: true });
  writeFileSync(join(pluginRoot, 'src', 'mcp', 'marker.mjs'), 'export const MARKER = 1;\n');
  const external = makeTempDir(t, 'zat-hot-escape-');
  const draft = await buildInto(t, pluginRoot, { versionsRoot: external });
  const manifestPath = join(draft.dir, 'manifest.json');
  // The version directory in the fixture is named after a valid slug, so a
  // rejected install must leave that name alone as well.
  assert.equal(draft.id, `9.9.9-${COMMIT_V1.slice(0, 7)}`);

  const variants = [
    ['missing', (manifest) => { delete manifest.shortCommit; }],
    ['traversal', (manifest) => { manifest.shortCommit = '/../../../src'; }],
  ];
  for (const [label, mutate] of variants) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    mutate(manifest);
    writeFileSync(manifestPath, JSON.stringify(manifest));
    await assert.rejects(installPackage({ pluginRoot, packagePath: draft.dir }), (error) => {
      assertHotUpdateError(error, 'HOT_UPDATE_MANIFEST_INVALID');
      return true;
    }, `${label}: install must reject the draft`);
    assert.ok(existsSync(join(pluginRoot, 'src', 'mcp', 'marker.mjs')), 'the plugin source tree is untouched');
    assert.deepEqual(readdirSync(join(pluginRoot, 'runtime', 'versions')), [], 'no version directory is created');
    assert.ok(!existsSync(join(pluginRoot, 'runtime', 'current.json')), 'the pointer never moves');
  }
});

test('a publish target must be a direct child of the versions directory', async (t) => {
  const versionsRoot = makeTempDir(t, 'zat-hot-versions-');
  const allowed = join(versionsRoot, '9.9.9-aaaaaaa');
  assert.equal(assertPublishTargetInside(versionsRoot, allowed), allowed, 'a normal version directory is allowed');

  const rejected = [
    versionsRoot,
    resolve(versionsRoot, '..', 'src'),
    resolve(versionsRoot, '..', '..', 'src'),
    join(versionsRoot, 'nested', 'inner'),
    `${versionsRoot}-sibling`,
  ];
  for (const target of rejected) {
    assert.throws(() => assertPublishTargetInside(versionsRoot, target), (error) => {
      assertHotUpdateError(error, 'HOT_UPDATE_PACKAGE_INVALID');
      assert.match(error.message, /outside the versions directory/);
      return true;
    }, `${target} must not be a publish target`);
  }
});

test('recovery keeps a version whose pointer was already committed', async (t) => {
  const pluginRoot = makePluginRoot(t);
  const installed = await buildInto(t, pluginRoot, { version: '9.9.10', gitCommit: COMMIT_V2 });
  const target = installed.dir;
  const backup = `${target}.replaced-0ddba11`;
  const replacementRoot = makeTempDir(t, 'zat-hot-replacement-');
  const replacement = await buildInto(t, pluginRoot, {
    version: '9.9.10',
    gitCommit: COMMIT_V2,
    versionsRoot: replacementRoot,
    tools: [{ name: 'beta_ping', description: 'ping', inputSchema: { type: 'object' } }],
  });
  assert.equal(replacement.id, installed.id, 'the fixture must publish the same version id');

  const entryPath = join(target, 'src', 'mcp', 'runtime-entry.mjs');
  const swapId = 'c0ffee01';
  const pointer = {
    version: '9.9.10',
    entry: toPosix(relative(pluginRoot, entryPath)),
    apiVersion: 1,
    sha256: sha256File(join(replacement.dir, 'src', 'mcp', 'runtime-entry.mjs')),
    gitCommit: COMMIT_V2,
    installedAt: FIXED_NOW,
    swapId,
  };

  // Replay the exact crash window: journal written, old bytes moved aside, new
  // bytes renamed into place, pointer rewritten — then the process died before
  // commit() could delete the journal.
  const journalPath = join(pluginRoot, 'runtime', 'recovery-crash.json');
  writeFileSync(journalPath, JSON.stringify({
    schemaVersion: 1, target, backup, swapId, staging: null, createdAt: 0,
  }));
  renameSync(target, backup);
  copyTree(replacement.dir, target);
  writeFileSync(join(pluginRoot, 'runtime', 'current.json'), JSON.stringify(pointer));

  const recovery = await recoverRuntimeState(pluginRoot, { minAgeMs: 0 });
  assert.deepEqual(recovery.errors, []);
  const kept = recovery.actions.find((action) => action.action === 'discarded-backup');
  assert.ok(kept, `the committed version must win: ${JSON.stringify(recovery.actions)}`);
  assert.equal(kept.reason, 'pointer-committed');
  assert.equal(sha256File(entryPath), pointer.sha256, 'the pointer still matches the installed entry');
  assert.match(readFileSync(entryPath, 'utf8'), /beta_ping/, 'the new bytes are still in place');
  assert.ok(!existsSync(backup), 'the stale backup is removed');
  assert.ok(!existsSync(journalPath), 'the recovery journal is consumed');
  await verifyPackage(target);

  // A pointer that carries a different swap id did not commit this journal, so
  // the old bytes win even when the published target is a valid package.
  const second = await buildInto(t, pluginRoot, { version: '9.9.12', gitCommit: COMMIT_V3 });
  const secondTarget = second.dir;
  const secondBackup = `${secondTarget}.replaced-0badc0de`;
  renameSync(secondTarget, secondBackup);
  mkdirSync(secondTarget, { recursive: true });
  copyTree(replacement.dir, secondTarget);
  writeFileSync(join(pluginRoot, 'runtime', 'current.json'), JSON.stringify({
    ...pointer,
    entry: toPosix(relative(pluginRoot, join(secondTarget, 'src', 'mcp', 'runtime-entry.mjs'))),
    sha256: sha256File(join(secondBackup, 'src', 'mcp', 'runtime-entry.mjs')),
    swapId: 'fade0002',
  }));
  writeFileSync(join(pluginRoot, 'runtime', 'recovery-crash2.json'), JSON.stringify({
    schemaVersion: 1, target: secondTarget, backup: secondBackup, swapId: 'f00dbabe', staging: null, createdAt: 0,
  }));
  const secondRecovery = await recoverRuntimeState(pluginRoot, { minAgeMs: 0 });
  assert.ok(
    secondRecovery.actions.some((action) => action.action === 'restored-previous'),
    `a pointer for another swap must not bless the new bytes: ${JSON.stringify(secondRecovery.actions)}`,
  );
  assert.equal(
    JSON.parse(readFileSync(join(secondTarget, 'manifest.json'), 'utf8')).version,
    '9.9.12',
    'the previous version is restored',
  );

  // A journal written before swapId existed names no swap: recovery stays
  // conservative and restores the old bytes.
  const third = await buildInto(t, pluginRoot, { version: '9.9.13', gitCommit: COMMIT_V1 });
  const thirdTarget = third.dir;
  const thirdBackup = `${thirdTarget}.replaced-01d0c0de`;
  renameSync(thirdTarget, thirdBackup);
  mkdirSync(thirdTarget, { recursive: true });
  copyTree(replacement.dir, thirdTarget);
  writeFileSync(join(pluginRoot, 'runtime', 'current.json'), JSON.stringify({
    ...pointer,
    entry: toPosix(relative(pluginRoot, join(thirdTarget, 'src', 'mcp', 'runtime-entry.mjs'))),
    sha256: sha256File(join(thirdTarget, 'src', 'mcp', 'runtime-entry.mjs')),
  }));
  writeFileSync(join(pluginRoot, 'runtime', 'recovery-legacy.json'), JSON.stringify({
    schemaVersion: 1, target: thirdTarget, backup: thirdBackup, staging: null, createdAt: 0,
  }));
  const thirdRecovery = await recoverRuntimeState(pluginRoot, { minAgeMs: 0 });
  assert.ok(
    thirdRecovery.actions.some((action) => action.action === 'restored-previous'),
    `a legacy journal must be treated as uncommitted: ${JSON.stringify(thirdRecovery.actions)}`,
  );
  assert.equal(
    JSON.parse(readFileSync(join(thirdTarget, 'manifest.json'), 'utf8')).version,
    '9.9.13',
    'the old bytes are back',
  );
});

test('recovery does not bless a forced re-install whose entry bytes are unchanged', async (t) => {
  const pluginRoot = makePluginRoot(t);
  const installed = await buildInto(t, pluginRoot, { version: '9.9.15', gitCommit: COMMIT_V2 });
  const entryBytes = readFileSync(join(installed.dir, 'src', 'mcp', 'runtime-entry.mjs'));

  // Same version id, same entry bytes, changed dependency: the pointer digest
  // cannot tell the two trees apart, so only the swap id can.
  const sourceRoot = makeSourceFixture(t, { version: '9.9.15' });
  const external = makeTempDir(t, 'zat-hot-same-id-');
  await buildPackage({
    sourceRoot, pluginRoot, versionsRoot: external, version: '9.9.15', gitCommit: COMMIT_V2, now: FIXED_NOW,
  });
  writeFileSync(join(sourceRoot, 'src', 'mcp', 'handler.mjs'), 'export const FAKE_HANDLER = false;\n');
  const changed = await buildPackage({
    sourceRoot, pluginRoot, versionsRoot: external, version: '9.9.15', gitCommit: COMMIT_V2, now: FIXED_NOW + 1, force: true,
  });
  assert.equal(changed.id, installed.id, 'both builds must share the version id');
  assert.deepEqual(
    readFileSync(join(changed.dir, 'src', 'mcp', 'runtime-entry.mjs')),
    entryBytes,
    'the entry file must be byte-identical for the pointer digest to match both trees',
  );

  const target = installed.dir;
  const backup = `${target}.replaced-5eed0001`;
  const entryPath = join(target, 'src', 'mcp', 'runtime-entry.mjs');
  renameSync(target, backup);
  mkdirSync(target, { recursive: true });
  copyTree(changed.dir, target);
  // The pointer was never rewritten for this swap, so it carries the swap id of
  // the previously committed install — or none at all.
  writeFileSync(join(pluginRoot, 'runtime', 'current.json'), JSON.stringify({
    version: '9.9.15',
    entry: toPosix(relative(pluginRoot, entryPath)),
    apiVersion: 1,
    sha256: sha256File(entryPath),
    gitCommit: COMMIT_V2,
    installedAt: FIXED_NOW,
    swapId: '0ld0a11a',
  }));
  writeFileSync(join(pluginRoot, 'runtime', 'recovery-same-id.json'), JSON.stringify({
    schemaVersion: 1, target, backup, swapId: '5eed0001', staging: null, createdAt: 0,
  }));

  const recovery = await recoverRuntimeState(pluginRoot, { minAgeMs: 0 });
  assert.ok(
    recovery.actions.some((action) => action.action === 'restored-previous'),
    `a tree that never passed its health check must not stay: ${JSON.stringify(recovery.actions)}`,
  );
  assert.equal(
    readFileSync(join(target, 'src', 'mcp', 'handler.mjs'), 'utf8'),
    'export const FAKE_HANDLER = true;\n',
    'the previous dependency tree is back',
  );
  assert.deepEqual(readFileSync(entryPath), entryBytes, 'the previous entry bytes are back');
  await verifyPackage(target);
});

test('build and install flush every published file before the pointer can move', async (t) => {
  const pluginRoot = makePluginRoot(t);
  const external = makeTempDir(t, 'zat-hot-flush-');
  const builtFlushed = [];
  const built = await buildPackage({
    sourceRoot: makeSourceFixture(t),
    pluginRoot,
    versionsRoot: external,
    gitCommit: COMMIT_V1,
    now: FIXED_NOW,
    syncFile: async (path) => { builtFlushed.push(toPosix(path)); },
  });
  assert.ok(
    builtFlushed.length >= built.manifest.fileCount + 1,
    `every file and the manifest must be flushed (got ${builtFlushed.length} for ${built.manifest.fileCount} files)`,
  );
  for (const file of built.manifest.files) {
    assert.ok(
      builtFlushed.some((path) => path.endsWith(`/${file.path}`)),
      `${file.path} must be flushed before the package is published`,
    );
  }
  assert.ok(builtFlushed.some((path) => path.endsWith('/manifest.json')), 'the manifest is flushed too');

  const installedFlushed = [];
  const installed = await installPackage({
    pluginRoot,
    packagePath: built.dir,
    syncFile: async (path) => { installedFlushed.push(toPosix(path)); },
  });
  assert.ok(
    installedFlushed.length >= built.manifest.fileCount + 1,
    `install must flush every copied file (got ${installedFlushed.length})`,
  );
  for (const file of built.manifest.files) {
    assert.ok(
      installedFlushed.some((path) => path.endsWith(`/${file.path}`)),
      `${file.path} must be flushed during install`,
    );
  }
  assert.ok(existsSync(installed.versionDir), 'the flushed package is published');
});

test('install refuses a shell copy whose bytes do not match its digest', async (t) => {
  const pluginRoot = makePluginRoot(t);
  const external = makeTempDir(t, 'zat-hot-poisoned-');
  const built = await buildInto(t, pluginRoot, { versionsRoot: external });
  const entryPath = join(built.dir, 'src', 'mcp', 'runtime-entry.mjs');
  const entrySha = sha256File(entryPath);
  // Right name, wrong bytes: the name claims the entry digest.
  const poisonedName = `.runtime-${entrySha}.mjs`;
  writeFileSync(join(built.dir, 'src', 'mcp', poisonedName), '// not the entry bytes\n');

  const result = await installPackage({ pluginRoot, packagePath: built.dir });
  assert.ok(
    !existsSync(join(result.versionDir, 'src', 'mcp', poisonedName)),
    'a shell copy whose bytes do not match its name is never installed',
  );
  assert.ok(
    result.warnings.some((warning) => /do not match its digest/.test(warning)),
    result.warnings.join('\n'),
  );
  assert.equal(result.health.ok, true);
});

test('an explicit AGENT_TEAMS_AUTOSTART=1 never re-enables daemon start in a probe', async (t) => {
  const root = makeTempDir(t, 'zat-hot-autostart-');
  writeFakeRuntime(root, { requireAutostartOff: true });
  const entry = join(root, 'src', 'mcp', 'runtime-entry.mjs');

  const forced = await runHealthCheck({ entry, timeoutMs: 5000, env: { AGENT_TEAMS_AUTOSTART: '1' } });
  assert.equal(forced.ok, true, forced.error ?? 'autostart must stay disabled for a probe');
  assert.deepEqual(forced.ignoredEnvOverrides, ['AGENT_TEAMS_AUTOSTART']);

  const explicitOff = await runHealthCheck({ entry, timeoutMs: 5000, env: { AGENT_TEAMS_AUTOSTART: '0' } });
  assert.equal(explicitOff.ok, true, explicitOff.error ?? 'an explicit 0 is honoured');
  assert.deepEqual(explicitOff.envOverrides, ['AGENT_TEAMS_AUTOSTART']);
  assert.deepEqual(explicitOff.ignoredEnvOverrides, []);
});

test('health checks do not inherit build cache variables', async (t) => {
  const cacheKeys = ['npm_config_cache', 'CARGO_TARGET_DIR', 'PIP_CACHE_DIR'];
  const root = makeTempDir(t, 'zat-hot-cache-');
  writeFakeRuntime(root, { expectEnvMissing: cacheKeys });
  const saved = new Map();
  for (const key of cacheKeys) {
    saved.set(key, process.env[key]);
    process.env[key] = join(root, `cache-${key}`);
  }
  try {
    const health = await runHealthCheck({ entry: join(root, 'src', 'mcp', 'runtime-entry.mjs'), timeoutMs: 5000 });
    assert.equal(health.ok, true, health.error ?? 'cache variables must not reach the probe');
    assert.deepEqual(health.envOverrides, []);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('rollback refuses to guess when the recorded previous version is gone', async (t) => {
  const pluginRoot = makePluginRoot(t);
  const v1 = await buildInto(t, pluginRoot, { version: '9.9.9', gitCommit: COMMIT_V1 });
  const v2 = await buildInto(t, pluginRoot, { version: '9.9.10', gitCommit: COMMIT_V2 });
  const v3 = await buildInto(t, pluginRoot, { version: '9.9.11', gitCommit: COMMIT_V3 });
  await installPackage({ pluginRoot, packagePath: v1.dir, now: FIXED_NOW });
  await installPackage({ pluginRoot, packagePath: v2.dir, now: FIXED_NOW + 1 });
  await installPackage({ pluginRoot, packagePath: v3.dir, now: FIXED_NOW + 2 });
  assert.equal(readPointer(pluginRoot).previous.version, '9.9.10');

  rmSync(v2.dir, { recursive: true, force: true });
  const pointerPath = join(pluginRoot, 'runtime', 'current.json');
  const before = readFileSync(pointerPath, 'utf8');
  await assert.rejects(rollbackPackage({ pluginRoot }), (error) => {
    assertHotUpdateError(error, 'HOT_UPDATE_PREVIOUS_MISSING');
    assert.match(error.message, /no longer installed/);
    return true;
  });
  assert.equal(readFileSync(pointerPath, 'utf8'), before, 'the pointer must not move when the previous version is gone');

  // Selecting a still-installed version explicitly stays allowed.
  const explicit = await rollbackPackage({ pluginRoot, version: v1.id, now: FIXED_NOW + 3 });
  assert.equal(explicit.pointer.version, '9.9.9');
});

test('rollback without a recorded previous version does not pick another one', async (t) => {
  const pluginRoot = makePluginRoot(t);
  const v1 = await buildInto(t, pluginRoot, { version: '9.9.9', gitCommit: COMMIT_V1 });
  const v2 = await buildInto(t, pluginRoot, { version: '9.9.10', gitCommit: COMMIT_V2 });
  await installPackage({ pluginRoot, packagePath: v1.dir, now: FIXED_NOW });
  assert.equal(readPointer(pluginRoot).previous, undefined);

  const pointerPath = join(pluginRoot, 'runtime', 'current.json');
  const before = readFileSync(pointerPath, 'utf8');
  await assert.rejects(rollbackPackage({ pluginRoot }), (error) => {
    assertHotUpdateError(error, 'HOT_UPDATE_NO_ROLLBACK_TARGET');
    assert.match(error.message, /pass an explicit version/);
    return true;
  });
  assert.equal(readFileSync(pointerPath, 'utf8'), before, 'the pointer must not move');
  assert.ok(existsSync(v2.dir), 'the unrelated installed version is left alone');
});

test('install reports an undo that could not restore the previous version', async (t) => {
  const pluginRoot = makePluginRoot(t);
  const v1 = await buildInto(t, pluginRoot, { version: '9.9.9', gitCommit: COMMIT_V1 });
  await installPackage({ pluginRoot, packagePath: v1.dir, now: FIXED_NOW });
  const pointerPath = join(pluginRoot, 'runtime', 'current.json');
  const before = readFileSync(pointerPath, 'utf8');

  const external = makeTempDir(t, 'zat-hot-undo-');
  const replacement = await buildInto(t, pluginRoot, {
    version: '9.9.9',
    gitCommit: COMMIT_V1,
    versionsRoot: external,
    tools: [{ name: 'beta_ping', description: 'ping', inputSchema: { type: 'object' } }],
  });
  assert.equal(replacement.id, v1.id, 'the fixture must target the installed version id');

  const versionsDir = join(pluginRoot, 'runtime', 'versions');
  const healthCheck = async () => {
    // An outside cleanup removes the backup that the undo needs after the
    // health check reports failure.
    for (const name of readdirSync(versionsDir)) {
      if (name.includes('.replaced-')) rmSync(join(versionsDir, name), { recursive: true, force: true });
    }
    return { ok: false, tools: null, error: 'stub health failure', durationMs: 0 };
  };
  await assert.rejects(
    installPackage({ pluginRoot, packagePath: replacement.dir, force: true, healthCheck }),
    (error) => {
      assertHotUpdateError(error, 'HOT_UPDATE_HEALTH_FAILED');
      assert.equal(error.details?.undoError?.code, 'HOT_UPDATE_UNDO_FAILED');
      assert.match(error.message, /undoing the published version failed/);
      return true;
    },
  );
  assert.equal(readFileSync(pointerPath, 'utf8'), before, 'the pointer never moved');
  assert.ok(
    readdirSync(join(pluginRoot, 'runtime')).some((name) => name.startsWith('recovery-') && name.endsWith('.json')),
    'the recovery journal is kept so the next pass can finish the swap',
  );
});

test('install stamps the pointer with the swap id its journal names', async (t) => {
  const pluginRoot = makePluginRoot(t);
  const firstRoot = makeTempDir(t, 'zat-hot-swap-first-');
  const first = await buildInto(t, pluginRoot, {
    version: '9.9.17', gitCommit: COMMIT_V1, versionsRoot: firstRoot,
  });
  await installPackage({ pluginRoot, packagePath: first.dir, now: FIXED_NOW });
  const firstPointer = readPointer(pluginRoot);
  assert.match(String(firstPointer.swapId ?? ''), /^[0-9a-f]{16}$/, 'install records the swap id of the publish it committed');

  // A forced re-install publishes a different swap, so the pointer must adopt
  // the new id — otherwise recovery would never recognise that swap as committed.
  const external = makeTempDir(t, 'zat-hot-swap-');
  const replacement = await buildInto(t, pluginRoot, {
    version: '9.9.17',
    gitCommit: COMMIT_V1,
    versionsRoot: external,
    tools: [{ name: 'beta_ping', description: 'ping', inputSchema: { type: 'object' } }],
  });
  assert.equal(replacement.id, first.id, 'the fixture must target the installed version id');
  await installPackage({ pluginRoot, packagePath: replacement.dir, force: true, now: FIXED_NOW + 1 });
  const pointer = readPointer(pluginRoot);
  assert.match(String(pointer.swapId ?? ''), /^[0-9a-f]{16}$/);
  assert.notEqual(pointer.swapId, firstPointer.swapId, 'a new publish gets a new swap id');

  // Replay that publish's crash window with the id the pointer carries: the
  // recovery pass has to recognise the swap as committed and keep the new bytes.
  const target = join(pluginRoot, 'runtime', 'versions', first.id);
  const backup = `${target}.replaced-5a0a0000`;
  renameSync(target, backup);
  mkdirSync(target, { recursive: true });
  copyTree(replacement.dir, target);
  writeFileSync(join(pluginRoot, 'runtime', 'recovery-swap.json'), JSON.stringify({
    schemaVersion: 1, target, backup, swapId: pointer.swapId, staging: null, createdAt: 0,
  }));

  const recovery = await recoverRuntimeState(pluginRoot, { minAgeMs: 0 });
  const kept = recovery.actions.find((action) => action.action === 'discarded-backup');
  assert.ok(kept, `the pointer's swap id must claim the journal: ${JSON.stringify(recovery.actions)}`);
  assert.equal(kept.reason, 'pointer-committed');
  assert.equal(readPointer(pluginRoot).sha256, sha256File(join(target, 'src', 'mcp', 'runtime-entry.mjs')));
  assert.ok(!existsSync(backup));
  await verifyPackage(target);
});

test('build still warns about a dirty tree when --commit names the commit', async (t) => {
  const pluginRoot = makePluginRoot(t);
  const sourceRoot = makeSourceFixture(t);
  rmSync(join(sourceRoot, '.git'), { recursive: true, force: true });
  try {
    execFileSync('git', ['init', '-q'], { cwd: sourceRoot, stdio: 'ignore' });
    execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=test', 'add', '-A'], { cwd: sourceRoot, stdio: 'ignore' });
    execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '-qm', 'fixture'], { cwd: sourceRoot, stdio: 'ignore' });
  } catch {
    t.skip('git is not available in this environment');
    return;
  }
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim();

  const clean = await buildPackage({ sourceRoot, pluginRoot, gitCommit: head, now: FIXED_NOW });
  assert.equal(
    clean.warnings.some((warning) => /uncommitted tracked changes/.test(warning)),
    false,
    'a clean tree must not warn',
  );

  // `gitDirty: true` is the forced-warning bit for callers that already know the
  // tree is dirty; it has to work independently of what git reports.
  const forcedDirty = await buildPackage({
    sourceRoot,
    pluginRoot,
    gitCommit: head,
    gitDirty: true,
    force: true,
    now: FIXED_NOW + 1,
  });
  assert.ok(
    forcedDirty.warnings.some((warning) => /uncommitted tracked changes/.test(warning)),
    forcedDirty.warnings.join('\n'),
  );

  writeFileSync(join(sourceRoot, 'src', 'mcp', 'handler.mjs'), 'export const FAKE_HANDLER = false;\n');
  const dirty = await buildPackage({
    sourceRoot,
    pluginRoot,
    gitCommit: head,
    force: true,
    now: FIXED_NOW + 2,
  });
  assert.ok(
    dirty.warnings.some((warning) => /uncommitted tracked changes/.test(warning)),
    dirty.warnings.join('\n'),
  );
  assert.equal(dirty.manifest.gitCommit, head);
});

test('build reports when it cannot tell whether the tree is dirty', async (t) => {
  const pluginRoot = makePluginRoot(t);
  const sourceRoot = makeSourceFixture(t);
  // A `.git` file with garbage makes every git command fail deterministically,
  // whether or not a parent directory happens to be a repository.
  rmSync(join(sourceRoot, '.git'), { recursive: true, force: true });
  writeFileSync(join(sourceRoot, '.git'), 'not a gitfile\n');
  const built = await buildPackage({ sourceRoot, pluginRoot, gitCommit: COMMIT_V1, now: FIXED_NOW });
  assert.ok(
    built.warnings.some((warning) => /cannot tell whether the source tree is dirty/.test(warning)),
    built.warnings.join('\n'),
  );
});

// Fault injection stays on exact fixture publish paths; all other filesystem
// calls, including durability, lock, pointer and recovery operations, are real.
function mockPublishRename(t, pluginRoot, inject, platform = 'win32') {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
  t.after(() => Object.defineProperty(process, 'platform', descriptor));
  const rename = fsp.rename.bind(fsp);
  const attempts = [];
  let lockToken;
  t.mock.method(fsp, 'rename', async (from, to) => {
    if (resolve(to).startsWith(resolve(pluginRoot) + '/') || resolve(to).startsWith(resolve(pluginRoot) + '\\')) {
      if (/^\.(staging|install)-/.test(basename(from))) {
        const lock = JSON.parse(readFileSync(join(pluginRoot, 'runtime', '.hot-update.lock'), 'utf8'));
        if (lockToken === undefined) lockToken = lock.token;
        assert.equal(lock.token, lockToken, 'one runtime lock must cover every publish attempt');
        attempts.push({ from, to });
        await inject({ from, to, attempt: attempts.length });
      }
    }
    return rename(from, to);
  });
  return attempts;
}

function renameError(code) {
  return Object.assign(new Error(`injected staging rename ${code}`), { code });
}

function assertPublishClean(pluginRoot, expectedIds = []) {
  assert.deepEqual(readdirSync(join(pluginRoot, 'runtime', 'versions')).sort(), [...expectedIds].sort());
  assert.ok(!existsSync(join(pluginRoot, 'runtime', '.hot-update.lock')), 'the runtime lock is released');
  assert.ok(!readdirSync(join(pluginRoot, 'runtime')).some((name) => name.startsWith('recovery-')));
}

for (const code of ['EPERM', 'EBUSY']) {
  test(`publish retry: build recovers Windows ${code} with the same staging tree and lock`, async (t) => {
    const pluginRoot = makePluginRoot(t);
    const sourceRoot = makeSourceFixture(t);
    const open = fsp.open.bind(fsp);
    const handles = new Set();
    let closed = 0;
    t.mock.method(fsp, 'open', async (...args) => {
      const handle = await open(...args);
      handles.add(handle);
      const close = handle.close.bind(handle);
      t.mock.method(handle, 'close', async () => {
        await close();
        handles.delete(handle);
        closed += 1;
      });
      return handle;
    });
    const attempts = mockPublishRename(t, pluginRoot, async ({ attempt, from }) => {
      assert.equal(handles.size, 0, 'every explicit file handle is closed before publish');
      assert.ok(closed > 1, 'real lock and fsync handles must have been observed');
      await verifyPackage(from);
      if (attempt < 3) throw renameError(code);
    });
    const built = await buildPackage({ sourceRoot, pluginRoot, gitCommit: COMMIT_V1, now: FIXED_NOW });
    assert.equal(attempts.length, 3);
    assert.equal(new Set(attempts.map(({ from }) => from)).size, 1);
    assert.equal(new Set(attempts.map(({ to }) => to)).size, 1);
    await verifyPackage(built.dir);
    assertPublishClean(pluginRoot, [built.id]);
  });
}

for (const [platform, code, expectedAttempts] of [
  ['win32', 'EPERM', 5], ['win32', 'EBUSY', 5],
  ['win32', 'EACCES', 1], ['win32', 'EINVAL', 1], ['win32', 'ENOENT', 1],
  ['win32', 'EEXIST', 1], ['win32', 'ENOTEMPTY', 1], ['win32', 'EXDEV', 1], ['win32', 'EAGAIN', 1],
  ['linux', 'EPERM', 1], ['linux', 'EBUSY', 1], ['darwin', 'EPERM', 1],
]) {
  test(`publish retry: ${platform} ${code} fails closed after ${expectedAttempts} attempts`, async (t) => {
    const pluginRoot = makePluginRoot(t);
    const sourceRoot = makeSourceFixture(t);
    const denied = renameError(code);
    const attempts = mockPublishRename(t, pluginRoot, () => { throw denied; }, platform);
    await assert.rejects(buildPackage({ sourceRoot, pluginRoot, gitCommit: COMMIT_V1 }), (error) => error === denied);
    assert.equal(attempts.length, expectedAttempts);
    assertPublishClean(pluginRoot);
    assert.ok(!existsSync(join(pluginRoot, 'runtime', 'current.json')));
  });
}

test('publish retry: a target appearing before the first rename is rejected', async (t) => {
  const pluginRoot = makePluginRoot(t);
  const target = join(pluginRoot, 'runtime', 'versions', `9.9.9-${COMMIT_V1.slice(0, 7)}`);
  const lstat = fsp.lstat.bind(fsp);
  let targetChecks = 0;
  t.mock.method(fsp, 'lstat', async (path, ...args) => {
    if (resolve(path) === resolve(target) && ++targetChecks === 2) mkdirSync(target);
    return lstat(path, ...args);
  });
  const attempts = mockPublishRename(t, pluginRoot, () => { assert.fail('a foreign target must not reach rename'); });
  await assert.rejects(buildInto(t, pluginRoot), (error) => {
    assertHotUpdateError(error, 'HOT_UPDATE_VERSION_EXISTS');
    return true;
  });
  assert.equal(attempts.length, 0);
  assert.deepEqual(readdirSync(target), []);
  assertPublishClean(pluginRoot, [basename(target)]);
});

test('publish retry: a delayed Windows operation cannot start another attempt after the budget', async (t) => {
  const pluginRoot = makePluginRoot(t);
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const denied = renameError('EPERM');
  const attempts = mockPublishRename(t, pluginRoot, () => { now += 1000; throw denied; });
  await assert.rejects(buildInto(t, pluginRoot), (error) => error === denied);
  assert.equal(attempts.length, 1);
  assertPublishClean(pluginRoot);
});

test('publish retry: a target appearing before retry is never overwritten, even with force', async (t) => {
  for (const force of [false, true]) {
    const pluginRoot = makePluginRoot(t);
    const attempts = mockPublishRename(t, pluginRoot, ({ to }) => {
      mkdirSync(to);
      throw renameError('EPERM');
    });
    await assert.rejects(buildInto(t, pluginRoot, { force }), (error) => {
      assertHotUpdateError(error, 'HOT_UPDATE_VERSION_EXISTS');
      return true;
    });
    assert.equal(attempts.length, 1);
    assert.deepEqual(readdirSync(attempts[0].to), [], 'even an empty foreign target is preserved');
    assertPublishClean(pluginRoot, [basename(attempts[0].to)]);
  }
});

test('publish retry: forced install exhaustion restores old bytes and never probes or changes the pointer', async (t) => {
  const pluginRoot = makePluginRoot(t);
  const first = await buildInto(t, pluginRoot);
  await installPackage({ pluginRoot, packagePath: first.dir });
  const pointer = readFileSync(join(pluginRoot, 'runtime', 'current.json'));
  const external = makeTempDir(t, 'zat-hot-retry-draft-');
  const replacement = await buildInto(t, pluginRoot, { versionsRoot: external, tools: [] });
  const attempts = mockPublishRename(t, pluginRoot, () => { throw renameError('EPERM'); });
  await assert.rejects(installPackage({
    pluginRoot, packagePath: replacement.dir, force: true,
    healthCheck: async () => { assert.fail('an unpublished runtime must not be probed'); },
  }), (error) => {
    assertHotUpdateError(error, 'HOT_UPDATE_BUILD_FAILED');
    assert.equal(error.details.undoError, undefined);
    return true;
  });
  assert.equal(attempts.length, 5);
  assert.deepEqual(readFileSync(join(pluginRoot, 'runtime', 'current.json')), pointer);
  assert.match(readFileSync(join(first.dir, 'src', 'mcp', 'runtime-entry.mjs'), 'utf8'), /alpha_ping/);
  await verifyPackage(first.dir);
  assertPublishClean(pluginRoot, [first.id]);
});

test('publish retry: a successful forced install still rolls back when health fails', async (t) => {
  const pluginRoot = makePluginRoot(t);
  const first = await buildInto(t, pluginRoot);
  await installPackage({ pluginRoot, packagePath: first.dir });
  const pointer = readFileSync(join(pluginRoot, 'runtime', 'current.json'));
  const external = makeTempDir(t, 'zat-hot-retry-health-');
  const replacement = await buildInto(t, pluginRoot, { versionsRoot: external, tools: [] });
  const attempts = mockPublishRename(t, pluginRoot, ({ attempt }) => {
    if (attempt === 1) throw renameError('EPERM');
  });
  let probes = 0;
  await assert.rejects(installPackage({
    pluginRoot, packagePath: replacement.dir, force: true,
    healthCheck: async () => { probes += 1; return { ok: false, error: 'injected health failure' }; },
  }), (error) => {
    assertHotUpdateError(error, 'HOT_UPDATE_HEALTH_FAILED');
    assert.equal(error.details.undoError, undefined);
    return true;
  });
  assert.equal(attempts.length, 2);
  assert.equal(probes, 1);
  assert.deepEqual(readFileSync(join(pluginRoot, 'runtime', 'current.json')), pointer);
  assert.match(readFileSync(join(first.dir, 'src', 'mcp', 'runtime-entry.mjs'), 'utf8'), /alpha_ping/);
  await verifyPackage(first.dir);
  assertPublishClean(pluginRoot, [first.id]);
});

test('publish retry: forced target competition preserves backup and journal through recovery', async (t) => {
  const pluginRoot = makePluginRoot(t);
  const first = await buildInto(t, pluginRoot);
  await installPackage({ pluginRoot, packagePath: first.dir });
  const pointer = readFileSync(join(pluginRoot, 'runtime', 'current.json'));
  const external = makeTempDir(t, 'zat-hot-retry-race-');
  const replacement = await buildInto(t, pluginRoot, { versionsRoot: external, tools: [] });
  const attempts = mockPublishRename(t, pluginRoot, ({ to }) => {
    mkdirSync(to);
    writeFileSync(join(to, 'foreign.txt'), 'outside writer\n');
    throw renameError('EPERM');
  });
  await assert.rejects(installPackage({ pluginRoot, packagePath: replacement.dir, force: true }), (error) => {
    assertHotUpdateError(error, 'HOT_UPDATE_BUILD_FAILED');
    assert.equal(error.details.undoError.code, 'HOT_UPDATE_UNDO_FAILED');
    return true;
  });
  assert.equal(attempts.length, 1);
  const runtime = join(pluginRoot, 'runtime');
  const journal = join(runtime, readdirSync(runtime).find((name) => name.startsWith('recovery-')));
  const journalBytes = readFileSync(journal);
  const { backup, stagedIdentity } = JSON.parse(journalBytes);
  assert.match(stagedIdentity, /^\d+:\d+$/);
  assert.match(readFileSync(join(backup, 'src', 'mcp', 'runtime-entry.mjs'), 'utf8'), /alpha_ping/);
  const status = await getStatus({ pluginRoot, checkHealth: false });
  assert.ok(status.recovery.errors.some((message) => message.includes('recovery target changed')));
  assert.equal(readFileSync(join(first.dir, 'foreign.txt'), 'utf8'), 'outside writer\n');
  assert.deepEqual(readFileSync(journal), journalBytes);
  assert.deepEqual(readFileSync(join(runtime, 'current.json')), pointer);
  assert.ok(!existsSync(join(runtime, '.hot-update.lock')));
  // Once the outside writer's directory is moved away, the original journal
  // must still be usable; recovery must not have silently discarded it.
  renameSync(first.dir, join(external, 'foreign-preserved'));
  const recovered = await getStatus({ pluginRoot, checkHealth: false });
  assert.deepEqual(recovered.recovery.errors, []);
  await verifyPackage(first.dir);
  assertPublishClean(pluginRoot, [first.id]);
});

for (const expireOnCall of [3, 4]) {
  test(`publish retry: budget expiry at clock check ${expireOnCall} stops after the wait`, async (t) => {
    const pluginRoot = makePluginRoot(t);
    let calls = 0;
    t.mock.method(performance, 'now', () => (++calls >= expireOnCall ? 1000 : 0));
    const denied = renameError('EPERM');
    const attempts = mockPublishRename(t, pluginRoot, () => { throw denied; });
    await assert.rejects(buildInto(t, pluginRoot), (error) => error === denied);
    assert.equal(attempts.length, 1);
    assertPublishClean(pluginRoot);
  });
}

test('publish retry: retries do not extend to moving the previous version aside', async (t) => {
  const pluginRoot = makePluginRoot(t);
  const first = await buildInto(t, pluginRoot);
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' });
  t.after(() => Object.defineProperty(process, 'platform', descriptor));
  const rename = fsp.rename.bind(fsp);
  const denied = renameError('EPERM');
  let moves = 0;
  t.mock.method(fsp, 'rename', async (from, to) => {
    if (resolve(from) === resolve(first.dir)) { moves += 1; throw denied; }
    return rename(from, to);
  });
  await assert.rejects(buildInto(t, pluginRoot, { force: true }), (error) => error === denied);
  assert.equal(moves, 1);
  await verifyPackage(first.dir);
  assert.ok(!existsSync(join(pluginRoot, 'runtime', '.hot-update.lock')));
});

test('publish retry: a failed backup restore retains its journal and later recovers', async (t) => {
  const pluginRoot = makePluginRoot(t);
  const first = await buildInto(t, pluginRoot);
  await installPackage({ pluginRoot, packagePath: first.dir });
  const pointer = readFileSync(join(pluginRoot, 'runtime', 'current.json'));
  const attempts = mockPublishRename(t, pluginRoot, () => { throw renameError('EPERM'); });
  const rename = fsp.rename.bind(fsp);
  let restores = 0;
  const restoreMock = t.mock.method(fsp, 'rename', async (from, to) => {
    if (basename(from).includes('.replaced-')) { restores += 1; throw renameError('EACCES'); }
    return rename(from, to);
  });
  await assert.rejects(buildInto(t, pluginRoot, { force: true, tools: [] }), (error) => {
    assertHotUpdateError(error, 'HOT_UPDATE_BUILD_FAILED');
    assert.equal(error.details.undoError.code, 'HOT_UPDATE_UNDO_FAILED');
    return true;
  });
  assert.equal(attempts.length, 5);
  assert.equal(restores, 1, 'rollback rename is not retried');
  assert.ok(!existsSync(first.dir));
  const runtime = join(pluginRoot, 'runtime');
  const journal = JSON.parse(readFileSync(join(runtime, readdirSync(runtime).find((name) => name.startsWith('recovery-')))));
  await verifyPackage(journal.backup);
  assert.deepEqual(readFileSync(join(runtime, 'current.json')), pointer);
  restoreMock.mock.restore();
  const status = await getStatus({ pluginRoot, checkHealth: false });
  assert.deepEqual(status.recovery.errors, []);
  await verifyPackage(first.dir);
  assertPublishClean(pluginRoot, [first.id]);
});

test('publish retry: a retried forced install commits the new pointer before dropping its journal', async (t) => {
  const pluginRoot = makePluginRoot(t);
  const first = await buildInto(t, pluginRoot);
  await installPackage({ pluginRoot, packagePath: first.dir });
  const previousSwap = readPointer(pluginRoot).swapId;
  const external = makeTempDir(t, 'zat-hot-retry-commit-');
  const replacement = await buildInto(t, pluginRoot, { versionsRoot: external, tools: [] });
  const attempts = mockPublishRename(t, pluginRoot, ({ attempt }) => {
    if (attempt < 3) throw renameError('EPERM');
  });
  let swapId;
  const installed = await installPackage({
    pluginRoot, packagePath: replacement.dir, force: true,
    healthCheck: async () => {
      const runtime = join(pluginRoot, 'runtime');
      const journal = JSON.parse(readFileSync(join(runtime, readdirSync(runtime).find((name) => name.startsWith('recovery-')))));
      const stat = lstatSync(first.dir, { bigint: true });
      assert.equal(journal.stagedIdentity, `${stat.dev}:${stat.ino}`, 'rename preserves the journal-bound directory identity');
      assert.equal(readPointer(pluginRoot).swapId, previousSwap);
      await verifyPackage(journal.backup);
      swapId = journal.swapId;
      return { ok: true, tools: 0 };
    },
  });
  assert.equal(attempts.length, 3);
  assert.equal(installed.pointer.swapId, swapId);
  assert.notEqual(swapId, previousSwap);
  await verifyPackage(installed.versionDir);
  assertPublishClean(pluginRoot, [first.id]);
});

test('publish retry: recovery can still restore an uncommitted journal-bound published tree', async (t) => {
  const pluginRoot = makePluginRoot(t);
  const first = await buildInto(t, pluginRoot);
  const external = makeTempDir(t, 'zat-hot-retry-crash-');
  const replacement = await buildInto(t, pluginRoot, { versionsRoot: external, tools: [] });
  const backup = `${first.dir}.replaced-abad1dea`;
  renameSync(first.dir, backup);
  renameSync(replacement.dir, first.dir);
  const stat = lstatSync(first.dir, { bigint: true });
  const journal = join(pluginRoot, 'runtime', 'recovery-bound.json');
  writeFileSync(journal, JSON.stringify({
    schemaVersion: 1, target: first.dir, backup, staging: replacement.dir,
    stagedIdentity: `${stat.dev}:${stat.ino}`, swapId: 'uncommitted-test-swap', createdAt: 0,
  }));
  const status = await getStatus({ pluginRoot, checkHealth: false });
  assert.deepEqual(status.recovery.errors, []);
  assert.ok(status.recovery.actions.some((action) => action.action === 'restored-previous'));
  assert.match(readFileSync(join(first.dir, 'src', 'mcp', 'runtime-entry.mjs'), 'utf8'), /alpha_ping/);
  await verifyPackage(first.dir);
  assertPublishClean(pluginRoot, [first.id]);
});

test('recovery preserves an uncommitted tree when its journal identity is unavailable', async (t) => {
  const pluginRoot = makePluginRoot(t);
  const first = await buildInto(t, pluginRoot);
  await installPackage({ pluginRoot, packagePath: first.dir });
  const pointerPath = join(pluginRoot, 'runtime', 'current.json');
  const pointerBytes = readFileSync(pointerPath);
  const backup = `${first.dir}.replaced-0bad1dea`;
  renameSync(first.dir, backup);
  copyTree(backup, first.dir);
  const manifestBytes = readFileSync(join(first.dir, 'manifest.json'));
  const journalPath = join(pluginRoot, 'runtime', 'recovery-identity-unavailable.json');
  const journalBytes = JSON.stringify({
    schemaVersion: 1, target: first.dir, backup, staging: null,
    stagedIdentity: null, swapId: 'uncommitted-identity-unavailable', createdAt: 0,
  });
  writeFileSync(journalPath, journalBytes);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const status = await getStatus({ pluginRoot, checkHealth: false });
    assert.ok(status.recovery.errors.some((message) => message.includes('recovery target changed')));
    assert.equal(status.recovery.actions.some((action) => action.target === first.dir), false);
    assert.deepEqual(readFileSync(join(first.dir, 'manifest.json')), manifestBytes);
    assert.deepEqual(readFileSync(join(backup, 'manifest.json')), manifestBytes);
    assert.equal(readFileSync(journalPath, 'utf8'), journalBytes);
    assert.deepEqual(readFileSync(pointerPath), pointerBytes);
  }
});

test('recovery honors a committed pointer before a mismatching journal identity', async (t) => {
  const pluginRoot = makePluginRoot(t);
  const first = await buildInto(t, pluginRoot);
  await installPackage({ pluginRoot, packagePath: first.dir });
  const pointerPath = join(pluginRoot, 'runtime', 'current.json');
  const pointer = { ...JSON.parse(readFileSync(pointerPath)), swapId: 'committed-identity-test-swap' };
  // Replay the crash after a forced install committed its pointer, before cleanup.
  writeFileSync(pointerPath, JSON.stringify(pointer));
  const pointerBytes = readFileSync(pointerPath);
  const backup = `${first.dir}.replaced-0c0ffee0`;
  copyTree(first.dir, backup);
  const journalPath = join(pluginRoot, 'runtime', 'recovery-committed-identity.json');
  const stat = lstatSync(first.dir, { bigint: true });
  const stagedIdentity = `${stat.dev}:${stat.ino + 1n}`;
  assert.notEqual(stagedIdentity, `${stat.dev}:${stat.ino}`);
  writeFileSync(journalPath, JSON.stringify({
    schemaVersion: 1, target: first.dir, backup, staging: null,
    stagedIdentity, swapId: pointer.swapId, createdAt: 0,
  }));

  const status = await getStatus({ pluginRoot, checkHealth: false });
  assert.deepEqual(status.recovery.errors, []);
  assert.ok(status.recovery.actions.some((action) => action.target === first.dir
    && action.action === 'discarded-backup' && action.reason === 'pointer-committed'));
  assert.equal(existsSync(backup), false);
  assert.equal(existsSync(journalPath), false);
  assert.deepEqual(readFileSync(pointerPath), pointerBytes);
  await verifyPackage(first.dir);
});

test('probe environment treats AGENT_TEAMS_* names case-insensitively', async (t) => {
  const inheritedRoot = makeTempDir(t, 'zat-hot-env-inherited-case-');
  writeFakeRuntime(inheritedRoot, { requireAutostartOff: true, rejectTeamEnv: true });
  const explicitRoot = makeTempDir(t, 'zat-hot-env-explicit-case-');
  writeFakeRuntime(explicitRoot, { requireAutostartOff: true, expectEnvUrl: 'explicit-lower' });

  const saved = new Map();
  for (const key of ['agent_teams_url', 'agent_teams_autostart', 'agent_teams_token']) {
    saved.set(key, process.env[key]);
    process.env[key] = key === 'agent_teams_autostart' ? '1' : 'inherited-lower';
  }
  try {
    const inherited = await runHealthCheck({
      entry: join(inheritedRoot, 'src', 'mcp', 'runtime-entry.mjs'),
      timeoutMs: 5000,
    });
    assert.equal(inherited.ok, true, inherited.error ?? 'lowercase team variables must not reach the probe');
    assert.deepEqual(inherited.envOverrides, []);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  const explicit = await runHealthCheck({
    entry: join(explicitRoot, 'src', 'mcp', 'runtime-entry.mjs'),
    timeoutMs: 5000,
    env: { agent_teams_url: 'explicit-lower', agent_teams_autostart: '1' },
  });
  assert.equal(explicit.ok, true, explicit.error ?? 'a lowercase override is applied and autostart stays off');
  assert.deepEqual(explicit.envOverrides, ['AGENT_TEAMS_URL'], 'the override is normalized before it is applied');
  assert.deepEqual(explicit.ignoredEnvOverrides, ['AGENT_TEAMS_AUTOSTART']);
});
