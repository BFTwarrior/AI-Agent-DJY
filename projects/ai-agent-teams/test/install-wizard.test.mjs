import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { recommendIsolation } from '../src/installer.mjs';
import {
  applyPreset,
  chooseIsolation,
  defaultStatePath,
  inspectInstall,
  presetOptions,
  readInstallState,
  verifyInstall,
  PACKAGE_VERSION,
  writeInstallState,
} from '../src/install-wizard.mjs';
import { loadConfig } from '../src/config.mjs';

function host(overrides = {}) {
  return {
    platform: 'win32', arch: 'x64',
    windows: { build: 26200, supported: true },
    memoryGb: 32, freeDiskGb: 500, admin: true,
    virtualization: { enabled: true },
    wsl: { installed: false, version2: false, distros: [] },
    container: { docker: false, podman: false },
    git: { ok: true, version: 'git version 2.50.0' },
    node: { version: '24.21.0', ok: true }, sqlite: true,
    zcode: { ok: true, path: '/opt/zcode/resources/glm/zcode.cjs' },
    ...overrides,
  };
}

function stateFor(dir, hostValue = host()) {
  return {
    version: 1,
    phase: 'awaiting-isolation-choice',
    workspace: dir,
    host: hostValue,
    recommendation: recommendIsolation(hostValue),
    teamMode: 'dual',
  };
}

test('install wizard requires an explicit isolation choice and cannot fake hard isolation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-agent-teams-wizard-'));
  try {
    const statePath = defaultStatePath(dir);
    writeInstallState(statePath, stateFor(dir));
    const hard = await chooseIsolation({ workspace: dir, statePath, isolation: 'hard' });
    assert.equal(hard.ok, false);
    assert.equal(hard.code, 'HARD_ISOLATION_UNAVAILABLE');
    assert.ok(Array.isArray(hard.requirements) && hard.requirements.some((item) => /WSL2/.test(item)));
    assert.ok(Array.isArray(hard.repairSteps) && hard.repairSteps.some((item) => /wsl --install/i.test(item)));
    assert.ok(hard.repairSteps.some((item) => /Podman|Docker/.test(item)));
    assert.equal(hard.next, 'install-hard-prerequisites-or-choose-soft');
    const soft = await chooseIsolation({ workspace: dir, statePath, isolation: 'soft' });
    assert.equal(soft.ok, true);
    assert.equal(soft.phase, 'awaiting-restart-verification');
    assert.equal(soft.restartRequired, true);
    assert.equal(readInstallState(statePath).isolation.effective, 'worktree');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('install wizard gates presets behind verification and applies both options', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-agent-teams-wizard-preset-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
    const statePath = defaultStatePath(dir);
    const state = stateFor(dir);
    state.phase = 'awaiting-preset-choice';
    state.isolation = { requested: 'soft', effective: 'worktree' };
    writeInstallState(statePath, state);
    const options = presetOptions({ workspace: dir, statePath });
    assert.deepEqual(options.options.map((item) => item.preset), ['conservative', 'balanced']);
    assert.ok(options.options.every((item) => item.activeWorkerSlots > 0));
    const output = join(dir, 'config', 'local.json');
    const applied = applyPreset({ workspace: dir, statePath, preset: 'conservative', outputPath: output });
    assert.equal(applied.phase, 'complete');
    assert.equal(readInstallState(statePath).phase, 'complete');
    const loaded = loadConfig(output);
    assert.equal(loaded.config.isolation.mode, 'worktree');
    assert.equal(loaded.config.scheduler.preset, 'conservative');
    assert.match(readFileSync(output, 'utf8'), /"activeWorkerSlots"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('install wizard writes concrete localization into the generated config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-agent-teams-wizard-i18n-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
    const statePath = defaultStatePath(dir);
    const state = stateFor(dir);
    state.phase = 'awaiting-preset-choice';
    state.isolation = { requested: 'soft', effective: 'worktree' };
    writeInstallState(statePath, state);
    const output = join(dir, 'config', 'local.json');
    applyPreset({ workspace: dir, statePath, preset: 'balanced', outputPath: output });
    const written = JSON.parse(readFileSync(output, 'utf8'));
    assert.notEqual(written.zcode.locale, 'auto');
    assert.notEqual(written.zcode.timezone, 'auto');
    assert.match(written.zcode.locale, /^(zh-CN|ja-JP|ko-KR|en-US)$/);
    const loaded = loadConfig(output);
    assert.equal(loaded.config.zcode.locale, written.zcode.locale);
    assert.equal(loaded.config.zcode.timezone, written.zcode.timezone);

    const second = join(dir, 'second');
    mkdirSync(second, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: second });
    const explicitState = defaultStatePath(second);
    const secondState = stateFor(second);
    secondState.phase = 'awaiting-preset-choice';
    secondState.isolation = { requested: 'soft', effective: 'worktree' };
    writeInstallState(explicitState, secondState);
    const explicitOutput = join(second, 'config', 'local.json');
    applyPreset({
      workspace: second, statePath: explicitState, preset: 'conservative',
      locale: 'ko-KR', timezone: 'Asia/Seoul', outputPath: explicitOutput,
    });
    const explicit = JSON.parse(readFileSync(explicitOutput, 'utf8'));
    assert.equal(explicit.zcode.locale, 'ko-KR');
    assert.equal(explicit.zcode.timezone, 'Asia/Seoul');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('install wizard refuses presets before restart verification', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-agent-teams-wizard-gate-'));
  try {
    const statePath = defaultStatePath(dir);
    writeInstallState(statePath, stateFor(dir));
    assert.throws(() => presetOptions({ workspace: dir, statePath }), /awaiting-preset-choice/);
    assert.throws(() => applyPreset({ workspace: dir, statePath, preset: 'balanced', outputPath: join(dir, 'local.json') }), /awaiting-preset-choice/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('install wizard refuses verify before an explicit isolation choice', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-agent-teams-wizard-verify-gate-'));
  try {
    const statePath = defaultStatePath(dir);
    writeInstallState(statePath, stateFor(dir));
    await assert.rejects(
      () => verifyInstall({ workspace: dir, statePath, restartConfirmed: true }),
      /awaiting-restart-verification/,
    );
    const state = stateFor(dir);
    state.phase = 'awaiting-restart-verification';
    writeInstallState(statePath, state);
    await assert.rejects(
      () => verifyInstall({ workspace: dir, statePath, restartConfirmed: true }),
      /explicit hard\|soft isolation choice/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('install wizard refuses soft presets when the workspace is not a git repo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-agent-teams-wizard-nogit-'));
  try {
    const statePath = defaultStatePath(dir);
    const state = stateFor(dir);
    state.phase = 'awaiting-preset-choice';
    state.isolation = { requested: 'soft', effective: 'worktree' };
    state.recommendation.options.soft = { available: false, effective: 'none', reason: 'not a git worktree' };
    writeInstallState(statePath, state);
    assert.throws(() => presetOptions({ workspace: dir, statePath }), /soft isolation is not available/);
    assert.throws(() => applyPreset({ workspace: dir, statePath, preset: 'balanced', outputPath: join(dir, 'local.json') }), /soft isolation is not available/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('install wizard completes the verified flow with matching plugin and daemon versions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-agent-teams-wizard-success-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
    const statePath = defaultStatePath(dir);
    const state = stateFor(dir);
    state.phase = 'awaiting-restart-verification';
    state.isolation = { requested: 'soft', effective: 'worktree' };
    writeInstallState(statePath, state);
    const result = await verifyInstall({
      workspace: dir,
      statePath,
      restartConfirmed: true,
      dependencies: {
        host: host(),
        gitRepo: true,
        plugin: { installed: true, version: PACKAGE_VERSION, contentOk: true, installPath: 'synthetic' },
        daemon: { running: true, version: PACKAGE_VERSION, port: 1 },
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.phase, 'awaiting-preset-choice');
    const options = presetOptions({ workspace: dir, statePath });
    assert.equal(options.options.length, 2);
    const applied = applyPreset({ workspace: dir, statePath, preset: 'balanced', outputPath: join(dir, 'config', 'local.json') });
    assert.equal(applied.phase, 'complete');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hard isolation requires an explicit Podman or Docker runtime choice', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-agent-teams-wizard-runtime-'));
  try {
    const statePath = defaultStatePath(dir);
    const readyHost = host({
      wsl: { installed: true, version2: true, distros: ['Ubuntu'] },
      container: { docker: true, podman: false },
    });
    writeInstallState(statePath, stateFor(dir, readyHost));
    const missing = await chooseIsolation({ workspace: dir, statePath, isolation: 'hard' });
    assert.equal(missing.ok, false);
    assert.equal(missing.code, 'RUNTIME_CHOICE_REQUIRED');
    assert.deepEqual(missing.options.map((item) => item.value), ['podman', 'docker']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('install-hard requires an explicit container runtime', () => {
  const output = execFileSync(process.execPath, ['src/install-wizard.mjs', '--install-hard'], {
    cwd: join(import.meta.dirname, '..'),
    encoding: 'utf8',
  });
  const result = JSON.parse(output);
  assert.equal(result.code, 'RUNTIME_CHOICE_REQUIRED');
  assert.deepEqual(result.options.map((item) => item.value), ['podman', 'docker']);
});


test('install inspection offers a fixed team-size choice', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-agent-teams-wizard-'));
  try {
    const result = await inspectInstall({ workspace: dir });
    const question = result.questions.find((item) => item.id === 'teamMode');
    assert.ok(question);
    assert.deepEqual(question.options.map((item) => item.value), ['dual', 'single']);
    const dual = question.options.find((item) => item.value === 'dual');
    assert.equal(dual.recommended, true);
    // The dual description has to name the teams the panel shows (A队 + B队);
    // the retired colour names must not come back.
    assert.match(dual.description, /A队 \+ B队/u);
    assert.equal(/蓝队|绿队/u.test(dual.description), false, `dual description names a colour: ${dual.description}`);
    assert.match(question.options.find((item) => item.value === 'single').description, /单队/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('install wizard --apply forwards --locale and --timezone to the generated config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-agent-teams-wizard-cli-i18n-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
    const statePath = defaultStatePath(dir);
    const state = stateFor(dir);
    state.phase = 'awaiting-preset-choice';
    state.isolation = { requested: 'soft', effective: 'worktree' };
    writeInstallState(statePath, state);
    const output = join(dir, 'config', 'local.json');
    const stdout = execFileSync(process.execPath, [
      join(import.meta.dirname, '..', 'src', 'install-wizard.mjs'),
      '--apply', '--preset', 'balanced',
      '--workspace', dir, '--state', statePath,
      '--write', output,
      '--locale', 'ja-JP', '--timezone', 'Asia/Tokyo',
    ], { encoding: 'utf8', windowsHide: true });
    const result = JSON.parse(stdout);
    assert.equal(result.ok, true);
    assert.equal(result.phase, 'complete');
    const written = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(written.zcode.locale, 'ja-JP');
    assert.equal(written.zcode.timezone, 'Asia/Tokyo');
    // The CLI arguments must not leak into the state file as an unknown key.
    const next = readInstallState(statePath);
    assert.equal(next.phase, 'complete');
    assert.equal(next.locale, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('install wizard --apply rejects an unsupported --locale instead of writing it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-agent-teams-wizard-cli-bad-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
    const statePath = defaultStatePath(dir);
    const state = stateFor(dir);
    state.phase = 'awaiting-preset-choice';
    state.isolation = { requested: 'soft', effective: 'worktree' };
    writeInstallState(statePath, state);
    const output = join(dir, 'config', 'local.json');
    assert.throws(
      () => execFileSync(process.execPath, [
        join(import.meta.dirname, '..', 'src', 'install-wizard.mjs'),
        '--apply', '--preset', 'balanced',
        '--workspace', dir, '--state', statePath,
        '--write', output,
        '--locale', 'de-DE',
      ], { encoding: 'utf8', stdio: 'pipe', windowsHide: true }),
      (error) => /unsupported locale/.test(String(error.stderr)),
    );
    assert.equal(existsSync(output), false, 'a rejected locale writes no config');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
