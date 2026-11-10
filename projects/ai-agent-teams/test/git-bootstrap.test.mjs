import test, { after, before, mock } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync, closeSync, existsSync, ftruncateSync, lstatSync, mkdirSync, mkdtempSync,
  openSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import {
  DEFAULT_MAX_FILE_BYTES, GITIGNORE_END, GITIGNORE_START, GIT_BOOTSTRAP_LOCK,
  HARD_MAX_FILE_BYTES, __testing, bootstrapGit, inspectProject, planBootstrap, runGit,
} from '../src/git-bootstrap.mjs';

// The production inspector deliberately ignores Git ceilings. Hide only the
// host checkout's ancestor markers from its filesystem view; fixture-owned
// parent/nested repositories and every real Git command stay visible.
const hostRoot = realpathSync.native(fileURLToPath(new URL('../', import.meta.url)));
const pathKey = (path) => {
  const absolute = resolve(path);
  let canonical = absolute;
  try {
    canonical = realpathSync.native(absolute);
  } catch {
    // A not-yet-created marker still has to compare by its normalized path.
  }
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
};
const hostGitMarkers = new Set();
for (let cursor = hostRoot; ; cursor = dirname(cursor)) {
  hostGitMarkers.add(pathKey(join(cursor, '.git')));
  if (dirname(cursor) === cursor) break;
}
const fixtureRoots = new Set();
let filesystemIsolation;
let gitGuard;

before(() => {
  const originalStat = fs.lstatSync;
  filesystemIsolation = mock.method(fs, 'lstatSync', (path, ...options) => {
    const file = path instanceof URL ? fileURLToPath(path) : String(path);
    if (hostGitMarkers.has(pathKey(file))) {
      if (options[0]?.throwIfNoEntry === false) return undefined;
      throw Object.assign(new Error('host repository marker is outside the fixture'), { code: 'ENOENT' });
    }
    return originalStat(path, ...options);
  });
  const originalSpawn = childProcess.spawn;
  gitGuard = mock.method(childProcess, 'spawn', (command, args, options) => {
    if (command === 'git') {
      const cwd = pathKey(options?.cwd ?? process.cwd());
      assert.ok(fixtureRoots.has(cwd), 'Git must run in a registered fixture, never the host checkout');
      assert.ok(args[0] === '--version' || args[0] === 'init' || existsSync(join(cwd, '.git')),
        'only version/init may run before the fixture owns its repository');
    }
    return originalSpawn(command, args, options);
  });
  syncBuiltinESMExports();
});
after(() => {
  filesystemIsolation.mock.restore();
  gitGuard.mock.restore();
  syncBuiltinESMExports();
});

function makeProject(t, prefix = 'ai-agent-teams-git-bootstrap-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  fixtureRoots.add(pathKey(realpathSync.native(root)));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return root;
}

function realRoot(root) {
  const resolver = typeof realpathSync.native === 'function' ? realpathSync.native : realpathSync;
  return resolver(root);
}

function writeFile(root, rel, content = '') {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
  return path;
}

function makeSparseFile(root, rel, size) {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'w');
  try {
    ftruncateSync(fd, size);
  } finally {
    closeSync(fd);
  }
  return path;
}

function git(root, args) {
  const insideFixture = [...fixtureRoots].some((fixture) => {
    const path = relative(fixture, pathKey(root));
    return !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`);
  });
  assert.ok(insideFixture, 'fixture Git commands must not target the host checkout');
  assert.ok(args[0] === 'init' || existsSync(join(root, '.git')),
    'fixture Git commands require a local repository before any mutation');
  return execFileSync('git', [
    '-c', 'user.name=Test', '-c', 'user.email=test@example.com',
    ...args,
  ], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function lsFiles(root, args = []) {
  return execFileSync('git', ['ls-files', '-z', ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).split('\0').filter(Boolean);
}

function listTree(root) {
  const entries = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      const rel = relative(root, absolute).split(sep).join('/');
      if (entry.isDirectory()) {
        entries.push(`${rel}/`);
        walk(absolute);
      } else {
        entries.push(rel);
      }
    }
  };
  walk(root);
  return entries.sort();
}

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

async function withEnv(values, callback) {
  const previous = new Map();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function statEntry(root, rel) {
  const stat = lstatSync(join(root, rel));
  return { path: rel, size: stat.size, dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs };
}

// ---------------------------------------------------------------------------
// inspectProject
// ---------------------------------------------------------------------------

test('a plain project is reported as bootstrap-required and inspectProject writes nothing', (t) => {
  const root = makeProject(t);
  writeFile(root, 'src/app.js', 'export const value = 1;\n');
  const before = listTree(root);

  const inspection = inspectProject({ cwd: root });

  assert.equal(inspection.cwd, realRoot(root));
  assert.equal(inspection.status, 'not-git');
  assert.equal(inspection.code, null);
  assert.equal(inspection.bootstrapRequired, true);
  assert.equal(inspection.repoRoot, null);
  assert.equal(inspection.parentRepo, null);
  assert.deepEqual(inspection.errors, []);
  assert.deepEqual(listTree(root), before);
  assert.equal(existsSync(join(root, '.git')), false);
  assert.equal(existsSync(join(root, '.gitignore')), false);
});

test('inspectProject resolves a symlinked or junctioned workspace before scanning parents', (t) => {
  const parent = makeProject(t);
  git(parent, ['init', '-b', 'main']);
  const child = join(parent, 'package');
  mkdirSync(child);
  const linkParent = makeProject(t);
  const link = join(linkParent, 'workspace-link');
  try {
    symlinkSync(child, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    t.skip('this platform does not allow creating directory links without elevation');
    return;
  }

  const inspection = inspectProject({ cwd: link });

  assert.equal(inspection.cwd, realRoot(child));
  assert.equal(inspection.status, 'parent-repo');
  assert.equal(inspection.code, 'GIT_PARENT_REPO');
  assert.equal(inspection.parentRepo, realRoot(parent));
  assert.equal(inspection.bootstrapRequired, false);
});

test('fixture parent repositories still block bootstrap despite an inherited Git ceiling', async (t) => {
  const parent = makeProject(t);
  git(parent, ['init', '-b', 'main']);
  const child = join(parent, 'child');
  mkdirSync(child);
  const ceilings = [process.env.GIT_CEILING_DIRECTORIES, parent].filter(Boolean).join(delimiter);
  await withEnv({ GIT_CEILING_DIRECTORIES: ceilings }, async () => {
    const inspection = inspectProject({ cwd: child });
    assert.equal(inspection.code, 'GIT_PARENT_REPO');
    assert.equal(inspection.parentRepo, realRoot(parent));
    const result = await bootstrapGit({ cwd: child });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'GIT_PARENT_REPO');
    assert.equal(existsSync(join(child, '.git')), false);
  });
});

test('inspectProject reports OneDrive and long-path risks', (t) => {
  const base = makeProject(t);
  const root = join(base, 'OneDrive - Test');
  mkdirSync(root);

  const inspection = inspectProject({ cwd: root });
  assert.ok(inspection.risks.some((risk) => risk.type === 'onedrive'), 'OneDrive risk should be reported');

  const longPathRisks = __testing.pathRisks(`C:\\${'nested-'.repeat(40)}`);
  assert.ok(longPathRisks.some((risk) => risk.type === 'long-path'));
});

// ---------------------------------------------------------------------------
// planBootstrap
// ---------------------------------------------------------------------------

test('planBootstrap skips build directories, secrets and oversized files', (t) => {
  const root = makeProject(t);
  writeFile(root, 'src/main.js', 'main\n');
  for (const directory of [
    'node_modules', 'dist', 'build', 'target', '.venv', '__pycache__', '历史', '归档',
    '.ai-agent-teams',
  ]) {
    writeFile(root, `${directory}/artifact.txt`, 'artifact\n');
  }
  const secretFiles = [
    '.env', '.envrc', '.env2', '.env_backup', '.env-staging', '.env.production',
    'server.pem', 'certs/client.key', 'id_rsa', 'id_rsa_old',
    'credentials.json', 'credentials-prod.json',
  ];
  for (const file of secretFiles) writeFile(root, file, 'private material\n');
  writeFile(root, 'big.bin', 'x'.repeat(64));

  const plan = planBootstrap({ cwd: root, maxFileBytes: 16 });

  assert.equal(plan.cwd, realRoot(root));
  assert.deepEqual(plan.files, ['src/main.js']);
  assert.deepEqual(plan.secrets, [...secretFiles].sort());
  assert.deepEqual(plan.largeFiles.map((file) => file.path), ['big.bin']);
  for (const directory of [
    'node_modules', 'dist', 'build', 'target', '.venv', '__pycache__', '历史', '归档',
    '.ai-agent-teams',
  ]) {
    assert.ok(
      plan.ignored.some((item) => item.path === `${directory}/` && item.reason === 'directory'),
      `${directory}/ should be ignored`,
    );
  }
  assert.equal(DEFAULT_MAX_FILE_BYTES, 50 * 1024 * 1024);
});

test('.ENV follows the platform case sensitivity of the filesystem', (t) => {
  const root = makeProject(t);
  writeFile(root, '.ENV', 'TOKEN=secret\n');

  const plan = planBootstrap({ cwd: root });

  if (process.platform === 'win32') {
    assert.deepEqual(plan.secrets, ['.ENV']);
  } else {
    assert.deepEqual(plan.secrets, []);
    assert.deepEqual(plan.files, ['.ENV']);
  }
});

test('win32 treats .GIT and NODE_MODULES variants like their lowercase names', (t) => {
  if (process.platform !== 'win32') {
    t.skip('case-insensitive directory matching only applies on win32');
    return;
  }
  const root = makeProject(t);
  writeFile(root, '.GIT/config', 'git dir\n');
  writeFile(root, 'NODE_MODULES/pkg/index.js', 'dependency\n');
  writeFile(root, 'app.js', 'app\n');

  const plan = planBootstrap({ cwd: root });

  assert.deepEqual(plan.files, ['app.js']);
  assert.ok(plan.ignored.some((item) => item.path === 'NODE_MODULES/' && item.reason === 'directory'));
});

test('planBootstrap refuses a file above the hard size limit', (t) => {
  const root = makeProject(t);
  writeFile(root, 'app.js', 'app\n');
  makeSparseFile(root, 'huge.bin', HARD_MAX_FILE_BYTES + 1);

  assert.throws(
    () => planBootstrap({ cwd: root, maxFileBytes: HARD_MAX_FILE_BYTES * 2 }),
    (error) => error.code === 'GIT_TOO_LARGE' && error.path === 'huge.bin' && error.size === HARD_MAX_FILE_BYTES + 1,
  );
});

test('include: [] selects no files instead of silently meaning "everything"', async (t) => {
  const root = makeProject(t);
  writeFile(root, 'app.js', 'app\n');

  const plan = planBootstrap({ cwd: root, include: [] });
  assert.deepEqual(plan.files, []);
  assert.ok(plan.ignored.some((item) => item.path === 'app.js' && item.reason === 'not-included'));

  const result = await bootstrapGit({ cwd: root, include: [] });
  assert.equal(result.ok, true);
  assert.deepEqual(git(root, ['ls-tree', '-r', '--name-only', 'HEAD']).split('\n').filter(Boolean), ['.gitignore']);
});

test('planBootstrap truncates the scan above maxEntries instead of failing', (t) => {
  const root = makeProject(t);
  for (const name of ['a.js', 'b.js', 'c.js', 'd.js', 'e.js']) writeFile(root, name, 'x\n');

  const plan = planBootstrap({ cwd: root, maxEntries: 2 });

  assert.equal(plan.truncated, true);
  assert.ok(plan.warnings.some((warning) => warning.includes('stopped after 2 entries')));
  assert.ok(plan.files.length < 5);
});

test('planBootstrap sorts paths by code point, not by locale', (t) => {
  const root = makeProject(t);
  for (const name of ['a.js', 'B.js', 'Z.js', '_x.js']) writeFile(root, name, 'x\n');

  const plan = planBootstrap({ cwd: root });

  assert.deepEqual(plan.files, ['B.js', 'Z.js', '_x.js', 'a.js']);
});

test('planBootstrap reports source content that looks like a secret', (t) => {
  const root = makeProject(t);
  writeFile(root, 'src/app.js', 'export const ok = 1;\n');
  writeFile(root, 'src/key.js', 'const key = `-----BEGIN RSA PRIVATE KEY-----`;\n');
  writeFile(root, 'src/token.js', `const token = "ghp_${'0'.repeat(20)}";\n`);

  const plan = planBootstrap({ cwd: root });

  assert.deepEqual(plan.contentSecrets.map((item) => item.path), ['src/key.js', 'src/token.js']);
  assert.equal(plan.contentSecrets[0].kind, 'private-key');
  assert.equal(plan.contentSecrets[1].kind, 'github-token');
});

test('the content secret scan is bounded by secretScanBytes', (t) => {
  const root = makeProject(t);
  writeFile(root, 'src/late.js', `${'x'.repeat(9000)}\n-----BEGIN PRIVATE KEY-----\n`);

  const bounded = planBootstrap({ cwd: root });
  const widened = planBootstrap({ cwd: root, secretScanBytes: 10000 });

  assert.deepEqual(bounded.contentSecrets, []);
  assert.deepEqual(widened.contentSecrets.map((item) => item.path), ['src/late.js']);
});

test('symbolic links are skipped instead of followed', (t) => {
  const root = makeProject(t);
  writeFile(root, 'real.txt', 'real\n');
  try {
    symlinkSync(join(root, 'real.txt'), join(root, 'link.txt'), 'file');
  } catch {
    t.skip('this platform does not allow creating symbolic links without elevation');
    return;
  }

  const plan = planBootstrap({ cwd: root });

  assert.deepEqual(plan.files, ['real.txt']);
  assert.ok(plan.ignored.some((item) => item.path === 'link.txt' && item.reason === 'symlink'));
  assert.ok(plan.warnings.some((warning) => warning.includes('symbolic link link.txt')));
});

// ---------------------------------------------------------------------------
// dryRun
// ---------------------------------------------------------------------------

test('dryRun returns a provisional plan without creating .git, .gitignore or a lock', async (t) => {
  const root = makeProject(t);
  writeFile(root, 'src/app.js', 'export const value = 1;\n');
  writeFile(root, '.env', 'TOKEN=secret\n');
  writeFile(root, '.envrc', 'export TOKEN=secret\n');
  writeFile(root, 'node_modules/pkg/index.js', 'dependency\n');
  const before = listTree(root);

  const result = await bootstrapGit({ cwd: root, dryRun: true });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'would-bootstrap');
  assert.equal(result.dryRun, true);
  assert.equal(result.provisional, true);
  assert.deepEqual(result.files, ['src/app.js']);
  assert.deepEqual(result.secrets, ['.env', '.envrc']);
  assert.equal(result.marker, '.git/agent-teams-bootstrap.json');
  assert.ok(result.warnings.some((warning) => warning.includes('provisional')));
  assert.deepEqual(listTree(root), before);
  assert.equal(existsSync(join(root, '.git')), false);
  assert.equal(existsSync(join(root, '.gitignore')), false);
  assert.equal(existsSync(join(root, '.ai-agent-teams')), false);
});

test('dryRun still validates the author identity', async (t) => {
  const root = makeProject(t);
  writeFile(root, 'app.js', 'app\n');

  const result = await bootstrapGit({ cwd: root, dryRun: true, authorName: '   ', authorEmail: 'x@example.com' });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'GIT_BOOTSTRAP_FAILED');
  assert.match(result.message, /authorName/u);
  assert.equal(existsSync(join(root, '.git')), false);
});

// ---------------------------------------------------------------------------
// bootstrapGit: happy path, idempotency, marker
// ---------------------------------------------------------------------------

test('bootstrapGit creates one baseline commit without secrets or build output', async (t) => {
  const root = makeProject(t);
  writeFile(root, 'src/app.js', 'export const value = 1;\n');
  writeFile(root, 'README.md', '# demo\n');
  writeFile(root, '.env', 'TOKEN=secret\n');
  writeFile(root, '.envrc', 'export TOKEN=secret\n');
  writeFile(root, '.env.local', 'TOKEN=secret\n');
  writeFile(root, 'server.pem', 'private key\n');
  writeFile(root, 'certs/client.key', 'private key\n');
  writeFile(root, 'id_rsa', 'private key\n');
  writeFile(root, 'id_rsa_old', 'private key\n');
  writeFile(root, 'credentials-prod.json', '{}\n');
  writeFile(root, 'node_modules/pkg/index.js', 'dependency\n');
  writeFile(root, 'dist/bundle.js', 'dist\n');
  writeFile(root, 'build/output.js', 'build\n');
  writeFile(root, 'target/debug/app', 'target\n');
  writeFile(root, '.venv/lib/site.py', 'venv\n');
  writeFile(root, '__pycache__/cache.pyc', 'cache\n');
  writeFile(root, '历史/old.md', 'old\n');
  writeFile(root, '归档/历史/old.md', 'archived old\n');

  const result = await bootstrapGit({ cwd: root });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'bootstrapped');
  assert.equal(result.branch, 'main');
  assert.equal(result.repoRoot, realRoot(root));
  assert.equal(result.marker, '.git/agent-teams-bootstrap.json');
  assert.equal(result.markerWritten, true);
  assert.equal(result.markerVersion, 2);
  assert.equal(existsSync(join(root, '.git', 'agent-teams-bootstrap.json')), true);
  assert.equal(git(root, ['rev-list', '--count', 'HEAD']), '1');
  assert.equal(
    git(root, ['log', '-1', '--format=%s']),
    'chore: baseline before Ai-Agent-Teams collaboration',
  );
  assert.equal(git(root, ['log', '-1', '--format=%an <%ae>']), 'Agent Teams <agent-teams@localhost>');
  assert.equal(result.tree, git(root, ['rev-parse', 'HEAD^{tree}']));

  const committed = git(root, ['ls-tree', '-r', '--name-only', 'HEAD']).split('\n').filter(Boolean).sort();
  assert.deepEqual(committed, ['.gitignore', 'README.md', 'src/app.js'].sort());
  for (const forbidden of [
    '.env', '.envrc', '.env.local', 'server.pem', 'certs/client.key', 'id_rsa', 'id_rsa_old',
    'credentials-prod.json', 'node_modules/pkg/index.js', 'dist/bundle.js', 'build/output.js',
    'target/debug/app', '.venv/lib/site.py', '__pycache__/cache.pyc', '历史/old.md', '归档/历史/old.md',
  ]) {
    assert.equal(committed.includes(forbidden), false, `${forbidden} must not be committed`);
    assert.equal(existsSync(join(root, forbidden)), true, `${forbidden} must stay on disk`);
  }

  const ignore = readFileSync(join(root, '.gitignore'), 'utf8');
  assert.equal(countOccurrences(ignore, GITIGNORE_START), 1);
  assert.equal(countOccurrences(ignore, GITIGNORE_END), 1);
  assert.match(ignore, /^node_modules\/$/m);
  assert.match(ignore, /^dist\/$/m);
  assert.match(ignore, /^历史\/$/m);
  assert.match(ignore, /^归档\/$/m);
  assert.match(ignore, /^\.env\*$/m);
  assert.match(ignore, /^\*\.pem$/m);
  assert.match(ignore, /^id_rsa\*$/m);
  assert.match(ignore, /^credentials\*$/m);
  assert.match(ignore, /^\.ai-agent-teams\/$/m);

  const marker = JSON.parse(readFileSync(join(root, '.git', 'agent-teams-bootstrap.json'), 'utf8'));
  assert.equal(marker.version, 2);
  assert.equal(marker.branch, 'main');
  assert.equal(marker.commit, result.commit);
  assert.equal(marker.tree, result.tree);
  assert.equal(marker.fileCount, result.fileCount);
  assert.equal(typeof marker.createdAt, 'string');
  assert.equal(marker.totalBytes, result.totalBytes);
  assert.ok(Array.isArray(marker.ignored));
  assert.ok(marker.ignored.some((item) => item.path === '.env' && item.reason === 'secret'));
  assert.match(marker.gitVersion, /^git version /u);
  assert.equal(marker.nodeVersion, process.version);
  assert.equal(typeof marker.codeLines, 'number');
  assert.equal(existsSync(join(root, '.ai-agent-teams', GIT_BOOTSTRAP_LOCK)), false);
  assert.deepEqual(readdirSync(join(root, '.ai-agent-teams')), []);
});

test('a second bootstrap is idempotent and keeps the first commit', async (t) => {
  const root = makeProject(t);
  writeFile(root, 'app.js', 'app\n');
  const first = await bootstrapGit({ cwd: root });
  assert.equal(first.ok, true);

  const second = await bootstrapGit({ cwd: root });

  assert.equal(second.ok, true);
  assert.equal(second.status, 'git');
  assert.equal(second.skipped, true);
  assert.equal(second.alreadyBootstrapped, true);
  assert.equal(second.commit, first.commit);
  assert.equal(second.tree, first.tree);
  assert.equal(git(root, ['rev-list', '--count', 'HEAD']), '1');
  const ignore = readFileSync(join(root, '.gitignore'), 'utf8');
  assert.equal(countOccurrences(ignore, GITIGNORE_START), 1);
});

test('an existing git repository is skipped without a new commit', async (t) => {
  const root = makeProject(t);
  git(root, ['init', '-b', 'main']);
  git(root, ['commit', '--allow-empty', '-m', 'existing']);
  const head = git(root, ['rev-parse', 'HEAD']);

  const inspection = inspectProject({ cwd: root });
  assert.equal(inspection.status, 'git');
  assert.equal(inspection.repoRoot, realRoot(root));
  assert.equal(inspection.bootstrapRequired, false);

  const result = await bootstrapGit({ cwd: root });
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.equal(result.alreadyBootstrapped, false);
  assert.equal(git(root, ['rev-parse', 'HEAD']), head);
  assert.equal(existsSync(join(root, '.git', 'agent-teams-bootstrap.json')), false);
});

test('a bare git repository is treated as existing git', async (t) => {
  const root = makeProject(t);
  const bare = join(root, 'bare.git');
  mkdirSync(bare);
  git(bare, ['init', '--bare']);

  const inspection = inspectProject({ cwd: bare });
  assert.equal(inspection.status, 'git');
  assert.equal(inspection.bootstrapRequired, false);
  assert.ok(inspection.warnings.some((warning) => warning.includes('bare git repository')));

  const result = await bootstrapGit({ cwd: bare });
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.equal(existsSync(join(bare, '.git')), false);
});

// ---------------------------------------------------------------------------
// bootstrapGit: refusal paths
// ---------------------------------------------------------------------------

test('a subdirectory of a parent repository is refused with GIT_PARENT_REPO', async (t) => {
  const parent = makeProject(t);
  git(parent, ['init', '-b', 'main']);
  const child = join(parent, 'package');
  writeFile(child, 'app.js', 'app\n');

  const inspection = inspectProject({ cwd: child });
  assert.equal(inspection.status, 'parent-repo');
  assert.equal(inspection.code, 'GIT_PARENT_REPO');
  assert.equal(inspection.repoRoot, realRoot(parent));
  assert.equal(inspection.parentRepo, realRoot(parent));
  assert.equal(inspection.bootstrapRequired, false);

  const result = await bootstrapGit({ cwd: child });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'GIT_PARENT_REPO');
  assert.equal(result.repoRoot, realRoot(parent));
  assert.equal(existsSync(join(child, '.git')), false);
  assert.equal(existsSync(join(child, '.gitignore')), false);
});

test('a workspace containing a nested repository is refused with GIT_NESTED_REPO', async (t) => {
  const root = makeProject(t);
  writeFile(root, 'app.js', 'app\n');
  const nested = join(root, 'vendor', 'library');
  mkdirSync(nested, { recursive: true });
  git(nested, ['init', '-b', 'main']);

  const inspection = inspectProject({ cwd: root });
  assert.equal(inspection.status, 'nested-repo');
  assert.equal(inspection.code, 'GIT_NESTED_REPO');
  assert.deepEqual(inspection.nestedRepos, ['vendor/library']);

  const result = await bootstrapGit({ cwd: root });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'GIT_NESTED_REPO');
  assert.equal(existsSync(join(root, '.git')), false);
});

test('an existing Mercurial or SVN checkout is refused with GIT_EXISTING_VCS', async (t) => {
  for (const marker of ['.hg', '.svn']) {
    const root = makeProject(t);
    writeFile(root, 'app.js', 'app\n');
    mkdirSync(join(root, marker));

    const inspection = inspectProject({ cwd: root });
    assert.equal(inspection.status, 'existing-vcs');
    assert.equal(inspection.code, 'GIT_EXISTING_VCS');

    const result = await bootstrapGit({ cwd: root });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'GIT_EXISTING_VCS');
    assert.equal(existsSync(join(root, '.git')), false);
  }
});

test('a read-only workspace is refused with GIT_READ_ONLY', async (t) => {
  const root = makeProject(t);
  writeFile(root, 'app.js', 'app\n');
  chmodSync(root, 0o555);
  try {
    const inspection = inspectProject({ cwd: root });
    assert.equal(inspection.status, 'read-only');
    assert.equal(inspection.code, 'GIT_READ_ONLY');

    const result = await bootstrapGit({ cwd: root });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'GIT_READ_ONLY');
    assert.equal(existsSync(join(root, '.git')), false);
  } finally {
    chmodSync(root, 0o755);
  }
});

test('an inaccessible workspace reports GIT_PERMISSION without throwing', async (t) => {
  const root = makeProject(t);
  const missing = join(root, 'does-not-exist');

  const inspection = inspectProject({ cwd: missing });
  assert.equal(inspection.status, 'permission');
  assert.equal(inspection.code, 'GIT_PERMISSION');
  assert.equal(inspection.errors.length, 1);

  const result = await bootstrapGit({ cwd: missing });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'GIT_PERMISSION');
  assert.equal(existsSync(join(missing, '.git')), false);
});

test('a missing git executable reports GIT_REQUIRED', async (t) => {
  const root = makeProject(t);
  writeFile(root, 'app.js', 'app\n');

  const result = await bootstrapGit({ cwd: root, gitCommand: 'ai-agent-teams-no-such-git-binary' });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'GIT_REQUIRED');
  assert.equal(existsSync(join(root, '.git')), false);
});

test('a baseline above maxTotalBytes is refused with GIT_TOO_LARGE', async (t) => {
  const root = makeProject(t);
  writeFile(root, 'app.js', 'hello\n');

  const result = await bootstrapGit({ cwd: root, maxTotalBytes: 1 });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'GIT_TOO_LARGE');
  assert.equal(existsSync(join(root, '.git')), false);
  assert.equal(existsSync(join(root, '.gitignore')), false);
  assert.equal(existsSync(join(root, '.ai-agent-teams')), false);
});

test('an explicitly included secret is refused with GIT_SECRETS_FOUND', async (t) => {
  const root = makeProject(t);
  writeFile(root, '.env', 'TOKEN=secret\n');
  writeFile(root, 'app.js', 'app\n');

  const result = await bootstrapGit({ cwd: root, include: ['.env', 'app.js'] });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'GIT_SECRETS_FOUND');
  assert.equal(existsSync(join(root, '.git')), false);
});

test('source content that looks like a secret blocks bootstrap and reports the path', async (t) => {
  const root = makeProject(t);
  writeFile(root, 'src/app.js', 'export const ok = 1;\n');
  writeFile(root, 'src/key.js', 'const key = `-----BEGIN PRIVATE KEY-----`;\n');

  const result = await bootstrapGit({ cwd: root });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'GIT_SECRETS_FOUND');
  assert.deepEqual(result.contentSecrets.map((item) => item.path), ['src/key.js']);
  assert.match(result.message, /src\/key\.js/u);
  assert.equal(existsSync(join(root, '.git')), false);
  assert.equal(existsSync(join(root, '.gitignore')), false);
});

// ---------------------------------------------------------------------------
// include/exclude and explicit staging
// ---------------------------------------------------------------------------

test('include and exclude patterns select only the intended files', (t) => {
  const root = makeProject(t);
  writeFile(root, 'src/keep.js', 'keep\n');
  writeFile(root, 'src/skip.js', 'skip\n');
  writeFile(root, 'docs/readme.md', 'docs\n');

  const plan = planBootstrap({ cwd: root, include: ['src'], exclude: ['src/skip.js'] });

  assert.deepEqual(plan.files, ['src/keep.js']);
  assert.ok(plan.ignored.some((item) => item.path === 'src/skip.js' && item.reason === 'exclude'));
  assert.ok(plan.ignored.some((item) => item.path === 'docs/readme.md' && item.reason === 'not-included'));
});

test('bootstrapGit only adds planned files, never git add -A', async (t) => {
  const root = makeProject(t);
  writeFile(root, 'src/keep.js', 'keep\n');
  writeFile(root, 'notes.txt', 'not part of the baseline\n');

  const result = await bootstrapGit({ cwd: root, include: ['src'] });

  assert.equal(result.ok, true);
  const committed = git(root, ['ls-tree', '-r', '--name-only', 'HEAD']).split('\n').filter(Boolean).sort();
  assert.deepEqual(committed, ['.gitignore', 'src/keep.js'].sort());
  assert.equal(existsSync(join(root, 'notes.txt')), true);
  const status = git(root, ['status', '--porcelain']);
  assert.match(status, /\?\? notes\.txt/u);
  assert.doesNotMatch(status, /\.ai-agent-teams/u);
});

// ---------------------------------------------------------------------------
// .gitignore handling
// ---------------------------------------------------------------------------

test('an existing .gitignore is preserved and the managed block is not duplicated', async (t) => {
  const root = makeProject(t);
  writeFile(root, 'app.js', 'app\n');
  writeFile(root, '.gitignore', 'custom-output/\n');

  const result = await bootstrapGit({ cwd: root });
  assert.equal(result.ok, true);
  const content = readFileSync(join(root, '.gitignore'), 'utf8');
  assert.ok(content.startsWith('custom-output/\n'));
  assert.equal(countOccurrences(content, GITIGNORE_START), 1);
  assert.equal(countOccurrences(content, GITIGNORE_END), 1);
  assert.match(git(root, ['show', 'HEAD:.gitignore']), /custom-output\//u);
  assert.equal(readdirSync(join(root, '.ai-agent-teams')).length, 0, 'the lock and temp files must be cleaned up');
  assert.equal(listTree(root).some((entry) => entry.includes('ai-agent-teams-write-')), false);
});

test('files ignored by the existing .gitignore are filtered before git add', async (t) => {
  const root = makeProject(t);
  writeFile(root, '.gitignore', 'notes.txt\n');
  writeFile(root, 'notes.txt', 'private notes\n');
  writeFile(root, 'app.js', 'app\n');

  const result = await bootstrapGit({ cwd: root });

  assert.equal(result.ok, true);
  assert.ok(result.ignored.some((item) => item.path === 'notes.txt' && item.reason === 'gitignore'));
  const committed = git(root, ['ls-tree', '-r', '--name-only', 'HEAD']).split('\n').filter(Boolean);
  assert.equal(committed.includes('notes.txt'), false);
  assert.equal(committed.includes('app.js'), true);
});

test('bootstrap refuses a .gitignore that is a symbolic link', async (t) => {
  const root = makeProject(t);
  writeFile(root, 'app.js', 'app\n');
  writeFile(root, 'real-gitignore', 'custom/\n');
  try {
    symlinkSync(join(root, 'real-gitignore'), join(root, '.gitignore'), 'file');
  } catch {
    t.skip('this platform does not allow creating symbolic links without elevation');
    return;
  }

  const result = await bootstrapGit({ cwd: root });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'GIT_BOOTSTRAP_FAILED');
  assert.match(result.message, /symbolic link/u);
  assert.equal(existsSync(join(root, '.git')), false);
});

// ---------------------------------------------------------------------------
// Author identity and git environment isolation
// ---------------------------------------------------------------------------

test('the requested author identity is used for the baseline commit', async (t) => {
  const root = makeProject(t);
  writeFile(root, 'app.js', 'app\n');

  const result = await bootstrapGit({
    cwd: root,
    authorName: 'Custom Author',
    authorEmail: 'custom@example.com',
  });

  assert.equal(result.ok, true);
  assert.equal(git(root, ['log', '-1', '--format=%an <%ae>']), 'Custom Author <custom@example.com>');
  assert.equal(git(root, ['config', '--local', '--get', 'user.name']), 'Custom Author');
  assert.equal(git(root, ['config', '--local', '--get', 'user.email']), 'custom@example.com');
});

test('the global git config is ignored even when it forces signing and another identity', async (t) => {
  const root = makeProject(t);
  writeFile(root, 'app.js', 'app\n');
  const configDir = makeProject(t, 'ai-agent-teams-global-config-');
  const configFile = join(configDir, 'gitconfig');
  writeFileSync(configFile, '[user]\n\tname = Global User\n\temail = global@example.com\n[commit]\n\tgpgsign = true\n', 'utf8');

  await withEnv({ GIT_CONFIG_GLOBAL: configFile, GIT_CONFIG_NOSYSTEM: '0' }, async () => {
    const result = await bootstrapGit({ cwd: root });
    assert.equal(result.ok, true);
    assert.equal(git(root, ['log', '-1', '--format=%an <%ae>']), 'Agent Teams <agent-teams@localhost>');
  });
});

test('an invalid author identity fails without writing anything', async (t) => {
  const root = makeProject(t);
  writeFile(root, 'app.js', 'app\n');

  const result = await bootstrapGit({ cwd: root, authorName: '   ', authorEmail: 'custom@example.com' });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'GIT_BOOTSTRAP_FAILED');
  assert.equal(existsSync(join(root, '.git')), false);
  assert.equal(existsSync(join(root, '.gitignore')), false);
});

test('an inherited GIT_DIR cannot redirect the bootstrap into another repository', async (t) => {
  const decoy = makeProject(t);
  git(decoy, ['init', '-b', 'main']);
  git(decoy, ['commit', '--allow-empty', '-m', 'decoy']);
  const decoyHead = git(decoy, ['rev-parse', 'HEAD']);

  const root = makeProject(t);
  writeFile(root, 'app.js', 'app\n');

  await withEnv({ GIT_DIR: join(decoy, '.git') }, async () => {
    const result = await bootstrapGit({ cwd: root });
    assert.equal(result.ok, true);
  });

  assert.equal(git(decoy, ['rev-parse', 'HEAD']), decoyHead);
  assert.equal(existsSync(join(root, '.git')), true);
  assert.equal(git(root, ['rev-list', '--count', 'HEAD']), '1');
});

test('buildGitEnv strips repository redirects and isolates config files', async () => {
  await withEnv({ GIT_DIR: '/tmp/decoy.git', GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_VALUE_0: 'c' }, () => {
    const env = __testing.buildGitEnv();
    assert.equal(env.GIT_DIR, undefined);
    assert.equal(env.GIT_CONFIG_KEY_0, undefined);
    assert.equal(env.GIT_CONFIG_VALUE_0, undefined);
    assert.equal(env.GIT_CONFIG_GLOBAL, process.platform === 'win32' ? 'NUL' : '/dev/null');
    assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
  });
});

// ---------------------------------------------------------------------------
// P0-1: rollback only removes a repository created by this call
// ---------------------------------------------------------------------------

test('rollback removes .git only when it was created by this call', (t) => {
  const untouched = makeProject(t);
  mkdirSync(join(untouched, '.git'));
  writeFile(untouched, '.git/HEAD', 'ref: refs/heads/main\n');

  const notCreated = __testing.rollbackBootstrap({ root: untouched, gitCreated: false, gitignoreWritten: false });
  assert.equal(notCreated.gitRemoved, false);
  assert.equal(existsSync(join(untouched, '.git', 'HEAD')), true);

  const created = makeProject(t);
  mkdirSync(join(created, '.git'));
  writeFile(created, '.git/HEAD', 'ref: refs/heads/main\n');
  const removed = __testing.rollbackBootstrap({ root: created, gitCreated: true, gitignoreWritten: false });
  assert.equal(removed.gitRemoved, true);
  assert.equal(existsSync(join(created, '.git')), false);
});

test('initRepository reports created and refuses to initialize over an existing .git', async (t) => {
  const root = makeProject(t);
  const first = await __testing.initRepository(root, 'git', { major: 2, minor: 40, patch: 0 });
  assert.deepEqual(first, { created: true });
  assert.equal(existsSync(join(root, '.git')), true);

  await assert.rejects(
    __testing.initRepository(root, 'git', { major: 2, minor: 40, patch: 0 }),
    (error) => error.code === 'GIT_BOOTSTRAP_FAILED' && /appeared before init/u.test(error.message),
  );
});

// ---------------------------------------------------------------------------
// P1-3: plan -> add re-validation
// ---------------------------------------------------------------------------

test('addFiles rejects a file replaced by a symbolic link after planning', async (t) => {
  const root = makeProject(t);
  git(root, ['init', '-b', 'main']);
  writeFile(root, 'target.txt', 'target\n');
  writeFile(root, 'subject.txt', 'subject\n');
  const entry = statEntry(root, 'subject.txt');
  rmSync(join(root, 'subject.txt'));
  try {
    symlinkSync(join(root, 'target.txt'), join(root, 'subject.txt'), 'file');
  } catch {
    t.skip('this platform does not allow creating symbolic links without elevation');
    return;
  }
  const warnings = [];

  await assert.rejects(
    __testing.addFiles(root, [entry], 'git', warnings),
    (error) => error.code === 'GIT_BOOTSTRAP_FAILED' && /symbolic link/u.test(error.message),
  );
  assert.deepEqual(lsFiles(root), []);
});

test('addFiles rejects a file replaced by a directory after planning', async (t) => {
  const root = makeProject(t);
  git(root, ['init', '-b', 'main']);
  writeFile(root, 'subject.txt', 'subject\n');
  const entry = statEntry(root, 'subject.txt');
  rmSync(join(root, 'subject.txt'));
  mkdirSync(join(root, 'subject.txt'));
  writeFile(root, 'subject.txt/extra.txt', 'extra\n');

  await assert.rejects(
    __testing.addFiles(root, [entry], 'git', []),
    (error) => error.code === 'GIT_BOOTSTRAP_FAILED' && /regular file/u.test(error.message),
  );
  assert.deepEqual(lsFiles(root), []);
});

test('addFiles rejects a file whose size changed after planning', async (t) => {
  const root = makeProject(t);
  git(root, ['init', '-b', 'main']);
  writeFile(root, 'subject.txt', 'short\n');
  const entry = statEntry(root, 'subject.txt');
  writeFile(root, 'subject.txt', 'a much longer content\n');

  await assert.rejects(
    __testing.addFiles(root, [entry], 'git', []),
    (error) => error.code === 'GIT_BOOTSTRAP_FAILED' && /size changed/u.test(error.message),
  );
  assert.deepEqual(lsFiles(root), []);
});

test('addFiles degrades a vanished file to a warning instead of failing the batch', async (t) => {
  const root = makeProject(t);
  git(root, ['init', '-b', 'main']);
  writeFile(root, 'keep.txt', 'keep\n');
  writeFile(root, 'gone.txt', 'gone\n');
  const entries = [statEntry(root, 'keep.txt'), statEntry(root, 'gone.txt')];
  rmSync(join(root, 'gone.txt'));
  const warnings = [];

  const added = await __testing.addFiles(root, entries, 'git', warnings);

  assert.deepEqual(added, ['keep.txt']);
  assert.ok(warnings.some((warning) => warning.includes('file disappeared before add: gone.txt')));
  assert.deepEqual(lsFiles(root), ['keep.txt']);
});

test('verifyStagedEntries rejects a staged symbolic link mode', async (t) => {
  const root = makeProject(t);
  git(root, ['init', '-b', 'main']);
  writeFile(root, 'target.txt', 'target\n');
  try {
    symlinkSync(join(root, 'target.txt'), join(root, 'link.txt'), 'file');
  } catch {
    t.skip('this platform does not allow creating symbolic links without elevation');
    return;
  }
  git(root, ['add', '--', 'link.txt']);

  await assert.rejects(
    __testing.verifyStagedEntries(root, ['link.txt'], 'git'),
    (error) => error.code === 'GIT_BOOTSTRAP_FAILED' && /mode 120000/u.test(error.message),
  );
});

// ---------------------------------------------------------------------------
// P1-4: stdin EPIPE handling
// ---------------------------------------------------------------------------

test('runGit survives a git process that exits before reading stdin', async (t) => {
  const root = makeProject(t);

  try {
    const result = await runGit(['-e', 'process.exit(0)'], root, {
      input: 'x'.repeat(8 * 1024 * 1024),
      gitCommand: process.execPath,
    });
    assert.equal(result.code, 0);
  } catch (error) {
    // The write lost the race against the child exit; the important part is
    // that the EPIPE became a rejected promise instead of an uncaught 'error'
    // event that would crash the daemon.
    assert.equal(error.code, 'GIT_BOOTSTRAP_FAILED');
    assert.match(error.message, /stdin/u);
  }
});

// ---------------------------------------------------------------------------
// P1-5: bootstrap lock
// ---------------------------------------------------------------------------

test('concurrent bootstrap calls serialize on the O_EXCL lock', async (t) => {
  const root = makeProject(t);
  writeFile(root, 'app.js', 'app\n');

  const results = await Promise.all([
    bootstrapGit({ cwd: root }),
    bootstrapGit({ cwd: root }),
  ]);

  assert.equal(results.every((result) => result.ok), true);
  assert.equal(results.filter((result) => result.status === 'bootstrapped').length, 1);
  assert.equal(results.filter((result) => result.skipped === true).length, 1);
  assert.equal(git(root, ['rev-list', '--count', 'HEAD']), '1');
  assert.equal(existsSync(join(root, '.ai-agent-teams', GIT_BOOTSTRAP_LOCK)), false);
  const committed = git(root, ['ls-tree', '-r', '--name-only', 'HEAD']).split('\n').filter(Boolean);
  assert.equal(committed.some((path) => path.startsWith('.ai-agent-teams/')), false);
});

test('a stale bootstrap lock is reclaimed', async (t) => {
  const root = makeProject(t);
  writeFile(root, 'app.js', 'app\n');
  const lockDir = join(root, '.ai-agent-teams');
  mkdirSync(lockDir, { recursive: true });
  const lockPath = join(lockDir, GIT_BOOTSTRAP_LOCK);
  writeFileSync(lockPath, '{"stale":true}\n', 'utf8');
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  utimesSync(lockPath, old, old);

  const result = await bootstrapGit({ cwd: root });

  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((warning) => warning.includes('stale bootstrap lock')));
  assert.equal(existsSync(lockPath), false);
  assert.equal(git(root, ['rev-list', '--count', 'HEAD']), '1');
});

test('a fresh lock held by another process makes bootstrap time out without deleting it', async (t) => {
  const root = makeProject(t);
  writeFile(root, 'app.js', 'app\n');
  const lockDir = join(root, '.ai-agent-teams');
  mkdirSync(lockDir, { recursive: true });
  const lockPath = join(lockDir, GIT_BOOTSTRAP_LOCK);
  writeFileSync(lockPath, '{"held":true}\n', 'utf8');

  const result = await bootstrapGit({ cwd: root, lockTimeoutMs: 100 });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'GIT_BOOTSTRAP_FAILED');
  assert.match(result.message, /timed out/u);
  assert.equal(existsSync(lockPath), true);
  assert.equal(existsSync(join(root, '.git')), false);
});

// ---------------------------------------------------------------------------
// P2-8: git version handling
// ---------------------------------------------------------------------------

test('git version parsing selects the -b fallback without reading stderr', () => {
  const old = __testing.parseGitVersion('git version 2.27.0.windows.1');
  const modern = __testing.parseGitVersion('git version 2.28.0');
  const localized = __testing.parseGitVersion('git version 2.55.0.windows.5');

  assert.deepEqual(old, { major: 2, minor: 27, patch: 0 });
  assert.deepEqual(modern, { major: 2, minor: 28, patch: 0 });
  assert.equal(__testing.supportsInitialBranch(old), false);
  assert.equal(__testing.supportsInitialBranch(modern), true);
  assert.equal(__testing.supportsInitialBranch(localized), true);
  assert.equal(__testing.supportsInitialBranch(null), false);
});
