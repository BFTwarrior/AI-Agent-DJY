import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { removeTreeWithRetry } from './support/cleanup.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const preload = fileURLToPath(new URL('./support/tmp-root.mjs', import.meta.url));
const probe = `
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const run = os.tmpdir();
  const bare = fs.mkdtempSync(path.join(run, 'bare-'));
  const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  const outside = git(bare, ['rev-parse', '--show-toplevel']);
  const init = git(bare, ['init', '-q']);
  const inside = git(bare, ['rev-parse', '--show-toplevel']);
  const parent = git(process.cwd(), ['rev-parse', '--show-toplevel']);
  fs.writeFileSync(path.join(run, 'leftover.txt'), 'removed on exit');
  console.log(JSON.stringify({ run, bare, temp: process.env.TEMP, tmp: process.env.TMP,
    ceilings: process.env.GIT_CEILING_DIRECTORIES, outside: outside.status,
    initialized: init.status, inside: inside.status, top: inside.stdout.trim(),
    parent: parent.status }));
`;

function sandbox(t) {
  const path = mkdtempSync(join(tmpdir(), 'tmp-root-contract-'));
  t.after(() => removeTreeWithRetry(path));
  return path;
}

function childProbe({ root, helper = preload, ceilings } = {}) {
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: ceilings };
  if (root === undefined) delete env.AGENT_TEAMS_TEST_TMP;
  else env.AGENT_TEAMS_TEST_TMP = root;
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(helper).href, '-e', probe], {
    cwd: repo, env, encoding: 'utf8', timeout: 20000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const data = JSON.parse(result.stdout.trim());
  assert.equal(data.temp, data.run);
  assert.equal(data.tmp, data.run);
  assert.equal(data.outside, 128, 'a bare fixture must not discover the enclosing project');
  assert.equal(data.initialized, 0);
  assert.equal(data.inside, 0, 'the ceiling must not hide a fixture-owned repository');
  assert.equal(realpathSync.native(dirname(data.run)), realpathSync.native(resolve(root ?? dirname(data.run))));
  assert.equal(resolve(data.top), resolve(data.bare));
  assert.equal(data.parent, 0, 'Git in the real checkout must remain unaffected');
  assert.equal(existsSync(data.run), false, 'the child must remove its whole per-run directory on exit');
  assert.ok(data.ceilings.startsWith(`${ceilings}${delimiter}`), 'preserve every inherited ceiling entry');
  return data;
}

test('tmp root defaults to the project dated directory and fences Git without hiding nested repos', (t) => {
  const scratch = sandbox(t);
  const inherited = [scratch, '', join(scratch, 'another-ceiling')].join(delimiter);
  const data = childProbe({ ceilings: inherited });
  const parent = dirname(data.run);
  assert.equal(dirname(parent), join(resolve(repo), '.tmp'));
  assert.match(parent, /\d{4}-\d{2}-\d{2}-tests$/);
  assert.ok(data.ceilings.split(delimiter).some((entry) => entry && resolve(entry) === parent));
});

test('tmp root accepts relative in-project overrides and keeps runs isolated from siblings', (t) => {
  const scratch = sandbox(t);
  const root = join(scratch, 'override');
  mkdirSync(root);
  const sibling = join(root, 'keep.txt');
  writeFileSync(sibling, 'another run owns this');
  const relativeRoot = relative(repo, root);
  assert.equal(isAbsolute(relativeRoot), false);
  const first = childProbe({ root: relativeRoot, ceilings: scratch });
  const second = childProbe({ root: relativeRoot, ceilings: scratch });
  assert.equal(dirname(first.run), root);
  assert.equal(dirname(second.run), root);
  assert.notEqual(first.run, second.run);
  assert.equal(existsSync(sibling), true, 'cleanup must only remove its own run directory');
});

test('tmp root retains outside-override compatibility without writing outside the real project', (t) => {
  const scratch = sandbox(t);
  const simulatedRepo = join(scratch, 'simulated-repo');
  const helper = join(simulatedRepo, 'test', 'support', 'tmp-root.mjs');
  mkdirSync(dirname(helper), { recursive: true });
  copyFileSync(preload, helper);
  const root = join(scratch, 'outside-simulated-repo');
  const data = childProbe({ root, helper, ceilings: scratch });
  assert.equal(dirname(data.run), root);
  assert.ok(relative(simulatedRepo, root).startsWith('..'));
  assert.equal(relative(repo, root).startsWith('..'), false, 'all test artifacts stay in the real project');
});
