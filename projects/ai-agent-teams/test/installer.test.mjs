import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CONTAINER_RUNTIME_OPTIONS, buildInstallPlan, hardIsolationInstallPlan, installHardIsolationPrerequisites, recommendIsolation, writeInstallConfig } from '../src/installer.mjs';
import { loadConfig, validateConfig } from '../src/config.mjs';
import { isValidTimeZone } from '../src/i18n.mjs';

function host(overrides = {}) {
  return {
    platform: 'win32', arch: 'x64',
    windows: { build: 26200, supported: true },
    memoryGb: 32, freeDiskGb: 500, admin: true,
    virtualization: { hypervisorPresent: true, vmpState: 1, cpuVirtualization: false, slat: false, enabled: true },
    wsl: { installed: false, version2: false, distros: [] },
    container: { docker: false, podman: false },
    node: { version: '24.21.0', ok: true }, sqlite: true, zcode: { ok: true },
    ...overrides,
  };
}

test('virtualization on recommends WSL, but effective isolation stays worktree until dispatch is wired', () => {
  const recommendation = recommendIsolation(host());
  assert.equal(recommendation.recommended, 'wsl');
  assert.equal(recommendation.state, 'install-wsl');
  assert.equal(recommendation.requiresWsl, true);
  assert.equal(recommendation.effective, 'worktree');
  assert.equal(recommendation.canChooseSoft, true);
  assert.equal(recommendation.recommendedRuntime, 'podman');
  const podman = CONTAINER_RUNTIME_OPTIONS.find((option) => option.id === 'podman');
  const docker = CONTAINER_RUNTIME_OPTIONS.find((option) => option.id === 'docker');
  assert.equal(podman.priceLabel, '免费');
  assert.match(docker.priceLabel, /商用可能付费/);
});

test('virtualization off recommends soft isolation', () => {
  const recommendation = recommendIsolation(host({ virtualization: { enabled: false } }));
  assert.equal(recommendation.recommended, 'worktree');
  assert.equal(recommendation.state, 'soft-only');
  assert.equal(recommendation.requiresWsl, false);
});

test('no admin falls back to soft isolation with a reason', () => {
  const recommendation = recommendIsolation(host({ admin: false }));
  assert.equal(recommendation.recommended, 'worktree');
  assert.equal(recommendation.state, 'needs-admin');
});

test('WSL and runtime ready reports container-ready after dispatch wiring', () => {
  const recommendation = recommendIsolation(host({
    wsl: { installed: true, version2: true, distros: ['Ubuntu'] },
    container: { docker: true, podman: false },
  }));
  assert.equal(recommendation.recommended, 'wsl');
  assert.equal(recommendation.state, 'ready');
  assert.equal(recommendation.effective, 'container');
});

test('single-team plan creates one team and validates', () => {
  const plan = buildInstallPlan({ host: host({ memoryGb: 16 }), teamMode: 'single', preset: 'balanced' });
  assert.equal(plan.teams, 1);
  assert.equal(plan.config.teams.length, 1);
  assert.equal(plan.config.captain.maxTeams, 1);
  assert.equal(plan.config.scheduler.activeWorkerSlots, 16);
  const result = validateConfig(plan.config);
  assert.equal(result.ok, true, result.errors?.join('; '));
});

test('dual-team plan creates two teams and writes a loadable config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-agent-teams-installer-'));
  try {
    const plan = buildInstallPlan({ host: host({ memoryGb: 32 }), teamMode: 'dual', preset: 'balanced' });
    assert.equal(plan.config.teams.length, 2);
    assert.equal(plan.config.scheduler.activeWorkerSlots, 20);
    assert.equal(plan.config.scheduler.maxActivePerTeam, 10);
    const path = writeInstallConfig(plan, join(dir, 'local.json'));
    const loaded = loadConfig(path);
    assert.equal(loaded.config.teams.length, 2);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).scheduler.activeWorkerSlots, 20);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('installer CLI resolves --workspace before host detection', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-agent-teams-installer-cli-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
    const output = execFileSync(process.execPath, [
      join(process.cwd(), 'src', 'installer.mjs'),
      '--workspace', dir, '--plan', '--team-mode', 'single', '--preset', 'conservative',
    ], { encoding: 'utf8', windowsHide: true });
    const plan = JSON.parse(output);
    assert.equal(plan.teams, 1);
    assert.ok(['worktree', 'container', 'none'].includes(plan.config.isolation.mode));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('installer CLI forwards --image-pull-policy into the planned config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-agent-teams-installer-image-policy-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
    const output = execFileSync(process.execPath, [
      join(process.cwd(), 'src', 'installer.mjs'),
      '--workspace', dir, '--plan', '--team-mode', 'single', '--preset', 'conservative',
      '--image-pull-policy', 'always',
    ], { encoding: 'utf8', windowsHide: true });
    const plan = JSON.parse(output);
    assert.equal(plan.config.isolation.imagePullPolicy, 'always');
    assert.deepEqual(validateConfig(plan.config).errors, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('installer CLI rejects unsupported --image-pull-policy values', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-agent-teams-installer-image-policy-invalid-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
    assert.throws(() => execFileSync(process.execPath, [
      join(process.cwd(), 'src', 'installer.mjs'),
      '--workspace', dir, '--plan', '--team-mode', 'single', '--preset', 'conservative',
      '--image-pull-policy', 'sometimes',
    ], { encoding: 'utf8', windowsHide: true }), /unsupported image pull policy/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('installer CLI rejects --image-pull-policy when its value is missing or another flag', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-agent-teams-installer-image-policy-missing-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
    const script = join(process.cwd(), 'src', 'installer.mjs');
    for (const args of [
      ['--image-pull-policy'],
      ['--image-pull-policy', '--write', join(dir, 'config', 'local.json')],
    ]) {
      assert.throws(() => execFileSync(process.execPath, [
        script, '--workspace', dir, '--plan', '--team-mode', 'single', '--preset', 'conservative', ...args,
      ], { encoding: 'utf8', windowsHide: true }), /--image-pull-policy requires a value/);
    }
    assert.equal(existsSync(join(dir, 'config', 'local.json')), false, 'missing value must not write generated config');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('installer CLI forwards --locale and --timezone into the planned config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-agent-teams-installer-cli-i18n-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
    const output = execFileSync(process.execPath, [
      join(process.cwd(), 'src', 'installer.mjs'),
      '--workspace', dir, '--plan', '--team-mode', 'single', '--preset', 'conservative',
      '--locale', 'zh_CN.UTF-8', '--timezone', 'asia/shanghai',
    ], { encoding: 'utf8', windowsHide: true });
    const plan = JSON.parse(output);
    assert.equal(plan.config.zcode.locale, 'zh-CN', 'a POSIX spelling is canonicalized');
    assert.equal(plan.config.zcode.timezone, 'Asia/Shanghai', 'the zone is canonicalized');
    const validation = validateConfig(plan.config);
    assert.deepEqual(validation.errors, []);
    // Isolation warnings depend on the host; the localization keys must be clean.
    assert.deepEqual(validation.warnings.filter((warning) => /locale|time ?zone/i.test(warning)), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('install plan refuses soft worktree isolation for a non-git workspace', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-agent-teams-installer-nogit-'));
  try {
    const recommendation = recommendIsolation(host(), { workspace: dir });
    assert.equal(recommendation.options.soft.available, false);
    assert.throws(
      () => buildInstallPlan({
        host: host(), teamMode: 'dual', preset: 'balanced', isolation: 'soft',
        recommended: recommendation, workspace: dir,
      }),
      /soft worktree isolation requires a git workspace/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hard isolation setup is planned and only executes on explicit request', () => {
  const plan = hardIsolationInstallPlan({ runtime: 'podman', platform: 'win32' });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.steps.map((step) => step.id), ['wsl', 'podman', 'podman-cli']);
  assert.ok(plan.steps[0].args.includes('--install'));
  assert.ok(plan.steps[1].args.includes('RedHat.Podman-Desktop'));
  assert.ok(plan.steps[2].args.includes('RedHat.Podman'));
  assert.equal(plan.fallbacks.wsl.id, 'wsl-store');
  assert.equal(plan.requiresReboot, true);

  const calls = [];
  const runner = (command, args) => {
    calls.push([command, ...args]);
    return { status: 0, stdout: 'ok', stderr: '' };
  };
  const dry = installHardIsolationPrerequisites({ execute: false, runner, platform: 'win32' });
  assert.equal(dry.executed, false);
  assert.equal(calls.length, 0);
  const executed = installHardIsolationPrerequisites({ execute: true, runner, platform: 'win32' });
  assert.equal(executed.ok, true);
  assert.equal(executed.executed, true);
  assert.equal(executed.rebootRequired, true);
  assert.equal(executed.verified, true);
  assert.equal(executed.results.length, 3);
  assert.equal(executed.verifyResults.length, 3);
  assert.equal(calls.length, 6);
  assert.equal(calls[0][0], 'wsl.exe');
  assert.equal(calls[1][0], 'winget');
  assert.equal(calls[2][0], 'winget');
  assert.equal(calls[3][0], 'wsl.exe');
});

test('WSL install failure falls back to the Microsoft Store package', () => {
  const calls = [];
  const runner = (command, args) => {
    calls.push([command, ...args]);
    if (command === 'wsl.exe' && args.includes('--install')) return { status: 1, stdout: '', stderr: 'not installed' };
    return { status: 0, stdout: 'ok', stderr: '' };
  };
  const result = installHardIsolationPrerequisites({ execute: true, runner, platform: 'win32' });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 7);
  assert.ok(calls[1].includes('Microsoft.WSL'));
  assert.equal(result.results[1].id, 'wsl-store');
});

test('hard isolation verify failure is reported as pending reboot, not success', () => {
  const runner = (command, args) => {
    if (command === 'podman' && args[0] === 'info') return { status: 1, stdout: '', stderr: 'machine not running' };
    return { status: 0, stdout: 'ok', stderr: '' };
  };
  const result = installHardIsolationPrerequisites({ execute: true, runner, platform: 'win32' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PREREQUISITE_PENDING_REBOOT');
  assert.equal(result.installed, true);
  assert.equal(result.needsReboot, true);
  assert.equal(result.pending, true);
  assert.match(result.failedVerify, /podman/);
});

test('an install plan retains the configured worker image pull policy', () => {
  const defaults = buildInstallPlan({ host: host({ memoryGb: 16 }), teamMode: 'single', preset: 'balanced' });
  assert.equal(defaults.config.isolation.imagePullPolicy, 'never');
  const configured = buildInstallPlan({
    host: host({ memoryGb: 16 }), teamMode: 'single', preset: 'balanced',
    imagePullPolicy: 'always',
  });
  assert.equal(configured.config.isolation.imagePullPolicy, 'always');
  assert.deepEqual(validateConfig(configured.config).errors, []);
});

test('an install plan always carries concrete localization values', () => {
  const plan = buildInstallPlan({ host: host({ memoryGb: 16 }), teamMode: 'single', preset: 'balanced' });
  assert.match(plan.config.zcode.locale, /^(zh-CN|ja-JP|ko-KR|en-US)$/);
  assert.notEqual(plan.config.zcode.timezone, 'auto');
  assert.equal(isValidTimeZone(plan.config.zcode.timezone), true);
  assert.deepEqual(validateConfig(plan.config).errors, []);
});

test('an explicit locale and time zone override installation detection', () => {
  const plan = buildInstallPlan({
    host: host({ memoryGb: 16 }), teamMode: 'single', preset: 'balanced',
    locale: 'ja-JP', timezone: 'Asia/Tokyo',
  });
  assert.equal(plan.config.zcode.locale, 'ja-JP');
  assert.equal(plan.config.zcode.timezone, 'Asia/Tokyo');
  assert.throws(
    () => buildInstallPlan({ host: host({ memoryGb: 16 }), teamMode: 'single', preset: 'balanced', locale: 'de-DE' }),
    /unsupported locale/,
  );
  assert.throws(
    () => buildInstallPlan({ host: host({ memoryGb: 16 }), teamMode: 'single', preset: 'balanced', timezone: 'Not/AZone' }),
    /unsupported time zone/,
  );
});

test('a generated local.json reloads with the same concrete localization', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-agent-teams-installer-i18n-'));
  try {
    const plan = buildInstallPlan({ host: host({ memoryGb: 16 }), teamMode: 'single', preset: 'conservative' });
    const path = writeInstallConfig(plan, join(dir, 'local.json'));
    const written = JSON.parse(readFileSync(path, 'utf8'));
    assert.notEqual(written.zcode.locale, 'auto');
    assert.notEqual(written.zcode.timezone, 'auto');
    const loaded = loadConfig(path);
    assert.equal(loaded.config.zcode.locale, written.zcode.locale);
    assert.equal(loaded.config.zcode.timezone, written.zcode.timezone);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
