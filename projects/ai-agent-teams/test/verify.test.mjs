import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OUTPUT_CAP, runCommand, runVerify } from '../src/gates/verify.mjs';

async function waitUntil(predicate, { timeoutMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
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

test('verify runner records pass and fail exit codes', async () => {
  const results = await runVerify({
    cwd: process.cwd(),
    commands: ['node -e "process.exit(0)"', 'node -e "process.exit(1)"'],
  });
  assert.equal(results.length, 2);
  assert.equal(results[0].status, 'passed');
  assert.equal(results[0].exitCode, 0);
  assert.equal(results[1].status, 'failed');
  assert.equal(results[1].exitCode, 1);
});

test('verify output stays capped at 64KB', async () => {
  const result = await runCommand({
    cwd: process.cwd(),
    command: `node -e "process.stdout.write('o'.repeat(${OUTPUT_CAP + 5000})); process.stderr.write('e'.repeat(${OUTPUT_CAP + 5000}))"`,
  });
  assert.equal(result.exitCode, 0);
  assert.ok(result.stdout.length <= OUTPUT_CAP + ' [truncated]'.length, `stdout grew to ${result.stdout.length}`);
  assert.ok(result.stderr.length <= OUTPUT_CAP + ' [truncated]'.length, `stderr grew to ${result.stderr.length}`);
  assert.match(result.stdout, /^o+ \[truncated\]$/);
  assert.match(result.stderr, /^e+ \[truncated\]$/);
  assert.equal(result.outputTruncated, true);
});

test('verify runner fails when either output stream exceeds the cap', async () => {
  const results = await runVerify({
    cwd: process.cwd(),
    commands: [
      `node -e "process.stdout.write('o'.repeat(${OUTPUT_CAP * 8}))"`,
      `node -e "process.stderr.write('e'.repeat(${OUTPUT_CAP * 8}))"`,
      `node -e "process.stdout.write('o'.repeat(${OUTPUT_CAP * 8})); process.stderr.write('e'.repeat(${OUTPUT_CAP * 8}))"`,
    ],
  });
  assert.equal(results.length, 3);
  for (const result of results) {
    assert.equal(result.exitCode, 0, 'preserve the child exit code');
    assert.equal(result.status, 'failed', 'truncated output is not complete verification evidence');
    assert.equal(result.outputTruncated, true);
    assert.ok(result.stdout.length <= OUTPUT_CAP + ' [truncated]'.length);
    assert.ok(result.stderr.length <= OUTPUT_CAP + ' [truncated]'.length);
  }
});

test('verify output exactly at the cap is not marked truncated', async () => {
  const result = await runCommand({
    cwd: process.cwd(),
    command: `node -e "process.stdout.write('x'.repeat(${OUTPUT_CAP}))"`,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.length, OUTPUT_CAP);
  assert.equal(result.stdout.endsWith('[truncated]'), false);
  assert.equal(result.outputTruncated, false);
});

test('verify output limit counts UTF-8 bytes instead of characters', async () => {
  const command = `node -e "process.stdout.write('界'.repeat(${Math.floor(OUTPUT_CAP / 3) + 1}))"`;
  const result = await runCommand({ command, cwd: process.cwd() });
  assert.equal(result.outputTruncated, true);
  assert.equal(result.stdout.includes('\ufffd'), false);
  const [verify] = await runVerify({ cwd: process.cwd(), commands: [command] });
  assert.equal(verify.status, 'failed');
});

test('verify runner preserves existing pass and nonzero-exit behavior', async () => {
  const results = await runVerify({
    cwd: process.cwd(),
    commands: ['node -e "process.stdout.write(\'complete\')"', 'node -e "process.exit(7)"'],
  });
  assert.deepEqual(results.map(({ status, exitCode, outputTruncated }) => ({ status, exitCode, outputTruncated })), [
    { status: 'passed', exitCode: 0, outputTruncated: false },
    { status: 'failed', exitCode: 7, outputTruncated: false },
  ]);
});

test('verify timeout kills the whole process tree', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-agent-teams-verify-tree-'));
  const marker = join(dir, 'grandchild.pid');
  const script = join(dir, 'tree.mjs');
  writeFileSync(script, [
    "import { spawn } from 'node:child_process';",
    "import { writeFileSync } from 'node:fs';",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    'writeFileSync(process.argv[2], String(child.pid));',
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  try {
    await assert.rejects(
      () => runCommand({ cwd: process.cwd(), command: `"${process.execPath}" "${script}" "${marker}"`, timeoutMs: 1500 }),
      /verify command timed out after 1500ms/,
    );
    assert.equal(await waitUntil(() => existsSync(marker)), true, 'grandchild pid was never written');
    const grandchild = Number(readFileSync(marker, 'utf8'));
    assert.ok(Number.isInteger(grandchild) && grandchild > 0);
    assert.equal(
      await waitUntil(() => !isAlive(grandchild)),
      true,
      `grandchild ${grandchild} survived the verify timeout`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
  }
});
