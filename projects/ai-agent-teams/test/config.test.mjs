import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyDefaults, loadConfig, validateConfig } from '../src/config.mjs';
import { contractorPools, contractorSlotCap, resolveContractorSlot } from '../src/service/contractor-slots.mjs';

const example = JSON.parse(readFileSync('config/example.two-teams.json', 'utf8'));

test('canonical example is valid', () => {
  const result = validateConfig(example);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test('the removed cost gateway section is rejected as an unknown key', () => {
  const withCost = structuredClone(example);
  withCost.cost = { gateway: 'none' };
  const result = validateConfig(withCost);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /cost/);
});

test('one or two teams are accepted, three are rejected', () => {
  const one = structuredClone(example);
  one.teams.pop();
  assert.equal(validateConfig(one).ok, true);
  const three = structuredClone(example);
  three.teams.push({ id: 'gamma', name: 'Gamma', lead: 'gamma-lead', defaultMembers: 16, maxMembers: 32, baseBranch: 'main' });
  assert.match(validateConfig(three).errors.join('\n'), /1 or 2/);
});

test('defaultMembers cannot exceed maxMembers', () => {
  const config = structuredClone(example);
  config.teams[0].defaultMembers = 32;
  config.teams[0].maxMembers = 16;
  assert.match(validateConfig(config).errors.join('\n'), /cannot exceed maxMembers/);
});

test('maxMembers is capped at 32', () => {
  const config = structuredClone(example);
  config.teams[0].maxMembers = 33;
  assert.match(validateConfig(config).errors.join('\n'), /8\.\.32/);
});

test('employee roster minimum is 8 per team', () => {
  const config = structuredClone(example);
  config.teams[0].defaultMembers = 7;
  config.teams[0].maxMembers = 7;
  const errors = validateConfig(config).errors.join('\n');
  assert.match(errors, /defaultMembers must be 8\.\.32/);
  assert.match(errors, /maxMembers must be 8\.\.32/);
});

test('activeWorkerSlots must be positive and bounded', () => {
  const config = structuredClone(example);
  config.scheduler.activeWorkerSlots = 0;
  assert.match(validateConfig(config).errors.join('\n'), /activeWorkerSlots/);
});

test('duplicate lead names are rejected', () => {
  const config = structuredClone(example);
  config.teams[1].lead = config.teams[0].lead;
  assert.match(validateConfig(config).errors.join('\n'), /duplicate lead/);
});

test('active slots above 16 produce a warning', () => {
  const config = structuredClone(example);
  config.scheduler.activeWorkerSlots = 20;
  config.scheduler.maxActivePerTeam = 10;
  config.zcode.maxConcurrentSessions = 20;
  const result = validateConfig(config);
  assert.equal(result.ok, true);
  assert.match(result.warnings.join('\n'), /above the recommended 16/);
});

test('cli protocol warns that model selection is unsupported', () => {
  const config = structuredClone(example);
  config.zcode.protocol = 'cli';
  config.zcode.defaultModel = 'provider/model';
  config.zcode.defaultReasoning = 'max';
  const result = validateConfig(config);
  assert.equal(result.ok, true);
  assert.match(result.warnings.join('\n'), /protocol=cli does not support model selection/);
});


test('defaults are materialized for security-relevant fields', () => {
  const raw = structuredClone(example);
  delete raw.captain.model;
  delete raw.isolation.readOnlyRoot;
  delete raw.isolation.nonRoot;
  delete raw.isolation.network;
  delete raw.isolation.containerRuntime;
  delete raw.isolation.imagePullPolicy;
  delete raw.isolation.homeSeed;
  delete raw.isolation.workerModel;
  delete raw.isolation.workerMode;
  delete raw.isolation.hostAddress;
  delete raw.isolation.bindHost;
  delete raw.zcode.defaultModel;
  delete raw.zcode.defaultReasoning;
  for (const team of raw.teams) delete team.baseBranch;
  const config = applyDefaults(raw);
  assert.equal(config.captain.model, null);
  assert.equal(config.isolation.readOnlyRoot, true);
  assert.equal(config.isolation.nonRoot, true);
  assert.equal(config.isolation.network, 'gateway-only');
  assert.equal(config.isolation.containerRuntime, 'docker');
  assert.equal(config.isolation.imagePullPolicy, 'never');
  assert.equal(config.isolation.homeSeed, null);
  assert.equal(config.isolation.workerModel, null);
  assert.equal(config.isolation.workerMode, 'yolo');
  assert.equal(config.isolation.hostAddress, null);
  assert.equal(config.isolation.bindHost, null);
  assert.equal(config.zcode.defaultModel, null);
  assert.equal(config.zcode.defaultReasoning, null);
  assert.equal(config.teams[0].baseBranch, 'main');
});

test('worktree base cache and patrol timeout options are valid and bounded', () => {
  const config = structuredClone(example);
  config.scheduler.worktreeBaseCheckMs = 60000;
  config.patrol = {
    enabled: true,
    captainSelfWake: true,
    intervalMinutes: 10,
    whenCaptainBusy: 'one-shot-contractor',
    maxContractorPerCycle: 1,
    timeoutMinutes: 5,
  };
  assert.deepEqual(validateConfig(config).errors, []);
  const bad = structuredClone(config);
  bad.scheduler.worktreeBaseCheckMs = -1;
  bad.patrol.timeoutMinutes = 0;
  const errors = validateConfig(bad).errors.join('\n');
  assert.match(errors, /worktreeBaseCheckMs must be 0\.\.600000/);
  assert.match(errors, /timeoutMinutes must be 1\.\.1440/);
});

test('worktree base cache and patrol timeout defaults are applied', () => {
  const config = structuredClone(example);
  const withDefaults = applyDefaults(config);
  assert.equal(withDefaults.scheduler.worktreeBaseCheckMs, 30000);
  assert.equal(withDefaults.patrol.timeoutMinutes, 30);
});

test('unknown keys are rejected', () => {
  const config = structuredClone(example);
  config.extra = true;
  config.isolation.privileged = true;
  const errors = validateConfig(config).errors.join('\n');
  assert.match(errors, /unknown key "extra"/);
  assert.match(errors, /unknown key "privileged"/);
});

test('worker model requires provider and model ids', () => {
  const config = structuredClone(example);
  config.isolation.workerModel = { providerId: 'p' };
  assert.match(validateConfig(config).errors.join('\n'), /workerModel.modelId/);
  config.isolation.workerModel = { providerId: 'p', modelId: 'm', reasoningLevel: 'max' };
  assert.equal(validateConfig(config).ok, true);
});

test('container image pull policy accepts supported values and rejects unknown values', () => {
  const config = structuredClone(example);
  config.isolation.imagePullPolicy = 'always';
  assert.equal(validateConfig(config).ok, true);
  config.isolation.imagePullPolicy = 'on-start';
  assert.match(validateConfig(config).errors.join('\\n'), /imagePullPolicy must be never\\|if-missing\\|always/);
});

test('container mode rejects a loopback-only bind host', () => {
  const config = structuredClone(example);
  config.isolation.mode = 'container';
  config.isolation.bindHost = '127.0.0.1';
  assert.match(validateConfig(config).errors.join('\n'), /bindHost must be 0\.0\.0\.0/);
  config.isolation.bindHost = '0.0.0.0';
  assert.equal(validateConfig(config).ok, true);
});

test('maxConcurrentSessions must cover active workers', () => {
  const config = structuredClone(example);
  config.scheduler.activeWorkerSlots = 6;
  config.zcode.maxConcurrentSessions = 1;
  assert.match(validateConfig(config).errors.join('\n'), /maxConcurrentSessions must be >=/);
});

test('mergeBranch cannot equal a base branch', () => {
  const config = structuredClone(example);
  config.quality.mergeBranch = 'main';
  assert.match(validateConfig(config).errors.join(String.fromCharCode(10)), /mergeBranch must differ/);
});

test('shadow defaults to enabled with a 30-minute idle stop', () => {
  const normalized = applyDefaults(example);
  assert.equal(normalized.shadow.enabled, true);
  assert.equal(normalized.shadow.idleStopMinutes, 30);
  const bad = structuredClone(example);
  bad.shadow = { enabled: 'yes', idleStopMinutes: 0 };
  const errors = validateConfig(bad).errors.join('\n');
  assert.match(errors, /shadow\.enabled must be boolean/);
  assert.match(errors, /shadow\.idleStopMinutes must be 1\.\.1440/);
});

test('a non-object shadow setting is a validation error, not a crash', () => {
  const bad = structuredClone(example);
  bad.shadow = 'yes';
  const result = validateConfig(bad);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /shadow must be an object/);
});

test('patrol and main are aliases and cannot be configured together', () => {
  const bad = structuredClone(example);
  bad.contractors = {
    enabled: true,
    maxConcurrent: 2,
    slots: {
      merge: { cap: 1, kinds: ['*'] },
      patrol: { cap: 1, kinds: ['*'] },
      main: { cap: 1, kinds: ['*'] },
    },
  };
  assert.match(validateConfig(bad).errors.join('\n'), /patrol.*main.*aliases/);
});

test('a null patrol slot is dropped so the legacy main alias stays usable', () => {
  const raw = structuredClone(example);
  raw.contractors = {
    enabled: true,
    maxConcurrent: 2,
    slots: {
      merge: { cap: 1, kinds: ['*'] },
      patrol: null,
      main: { cap: 1, kinds: ['*'] },
    },
  };
  const normalized = applyDefaults(raw);
  assert.equal(Object.hasOwn(normalized.contractors.slots, 'patrol'), false);
  assert.equal(normalized.contractors.slots.main.cap, 1);
  assert.equal(validateConfig(raw).ok, true);
});

test('contractor slots default to one reserved merge plus one patrol slot', () => {
  const normalized = applyDefaults(example);
  assert.equal(normalized.contractors.maxConcurrent, 2);
  assert.equal(normalized.contractors.slots.merge.cap, 1);
  const patrol = normalized.contractors.slots.patrol ?? normalized.contractors.slots.main;
  assert.equal(patrol.cap, 1);
  assert.equal(normalized.contractors.allowBorrow, false);
});

test('contractor slot caps stay at one each and cannot exceed the total cap', () => {
  const config = structuredClone(example);
  config.contractors = {
    enabled: true,
    maxConcurrent: 2,
    slots: { merge: { cap: 1 }, main: { cap: 1 } },
  };
  assert.equal(validateConfig(config).ok, true);

  const wideMain = structuredClone(config);
  wideMain.contractors.slots.main.cap = 2;
  assert.match(validateConfig(wideMain).errors.join('\n'), /cap must be 0 or 1/);

  const tooMany = structuredClone(config);
  tooMany.contractors.maxConcurrent = 1;
  assert.match(validateConfig(tooMany).errors.join('\n'), /must not exceed contractors.maxConcurrent/);

  const borrow = structuredClone(config);
  borrow.contractors.allowBorrow = true;
  assert.match(validateConfig(borrow).errors.join('\n'), /allowBorrow is not implemented/);
});

test('reviewPool defaults off and legacy contractor slots retain their two-slot behavior', () => {
  const normalized = applyDefaults(example);
  assert.deepEqual(normalized.contractors.reviewPool, { enabled: false, capacity:  0 });
  assert.equal(normalized.contractors.maxConcurrent, 2);
  assert.equal(normalized.contractors.slots.merge.cap, 1);
  assert.equal(normalized.contractors.slots.patrol.cap, 1);
  assert.equal(validateConfig(example).ok, true);
});

test('reviewPool cannot be enabled until its scheduler is implemented', () => {
  const config = JSON.parse(readFileSync('config/example.v06.json', 'utf8'));
  config.contractors.maxConcurrent = 12;
  config.contractors.reviewPool = { enabled: true, capacity: 10 };
  assert.match(validateConfig(config).errors.join('\n'), /scheduling is not implemented/);
});

test('reviewPool rejects invalid capacity, missing contractor enablement, and overcommitted budgets', () => {
  const base = JSON.parse(readFileSync('config/example.v06.json', 'utf8'));
  base.contractors.maxConcurrent = 12;
  base.contractors.reviewPool = { enabled: true, capacity: 10 };
  const invalidCapacity = structuredClone(base);
  invalidCapacity.contractors.reviewPool.capacity = 11;
  assert.match(validateConfig(invalidCapacity).errors.join('\n'), /reviewPool.capacity must be 0\.\.10/);

  const disabledContractors = structuredClone(base);
  disabledContractors.contractors.enabled = false;
  assert.match(validateConfig(disabledContractors).errors.join('\n'), /requires contractors.enabled=true/);

  const overContractors = structuredClone(base);
  overContractors.contractors.maxConcurrent = 11;
  assert.match(validateConfig(overContractors).errors.join('\n'), /reviewPool capacities must not exceed contractors.maxConcurrent/);

  const overSessions = structuredClone(base);
  overSessions.scheduler.maxTotalSessions = 15;
  assert.match(validateConfig(overSessions).errors.join('\n'), /maxTotalSessions must cover active workers and reviewPool capacity/);
});

test('reviewPool disabled state cannot reserve capacity and enabled state requires positive capacity', () => {
  const base = JSON.parse(readFileSync('config/example.v06.json', 'utf8'));
  base.contractors.maxConcurrent = 12;
  base.contractors.reviewPool = { enabled: true, capacity: 10 };
  const disabledWithCapacity = structuredClone(base);
  disabledWithCapacity.contractors.reviewPool = { enabled: false, capacity: 1 };
  assert.match(validateConfig(disabledWithCapacity).errors.join('\n'), /capacity must be 0 when disabled/);

  const enabledWithoutCapacity = structuredClone(base);
  enabledWithoutCapacity.contractors.reviewPool.capacity = 0;
  assert.match(validateConfig(enabledWithoutCapacity).errors.join('\n'), /enabled requires capacity 1\.\.10/);
});

test('reviewPool routes only independent reviews and reports its isolated capacity', () => {
  const slots = { merge: { cap: 1 }, main: { cap: 2 } };
  const pool = { enabled: true, capacity: 3 };
  assert.equal(resolveContractorSlot('independent_review', 'review', slots, pool), 'review');
  assert.equal(contractorSlotCap(slots, 'review', pool), 3);
  assert.equal(resolveContractorSlot('task', undefined, slots, pool), 'main');
  assert.throws(() => resolveContractorSlot('task', 'review', slots, pool), /only accepts independent_review/);
  assert.throws(() => resolveContractorSlot('independent_review', 'main', slots, pool), /must use the review/);
  assert.throws(() => contractorSlotCap(slots, 'review', { enabled: true, capacity: 11 }), /capacity 1\.\.10/);

  const store = { listAllContractors: (_team, slot) => slot === 'review' ? [
    { id: 'r1', teamId: 'alpha', purpose: 'independent_review', status: 'running' },
    { id: 'r2', teamId: 'alpha', purpose: 'task', status: 'running' },
    { id: 'r3', teamId: 'alpha', purpose: 'independent_review', status: 'queued' },
  ] : [] };
  assert.deepEqual(contractorPools(store, slots, pool).at(-1), {
    slot: 'review', cap: 3, active: 1, queued: 1,
    running: [{ id: 'r1', teamId: 'alpha', purpose: 'independent_review', status: 'running' }],
  });
  assert.equal(contractorPools(store, slots).some((item) => item.slot === 'review'), false);
  assert.throws(() => resolveContractorSlot('task', undefined, slots, { enabled: false, capacity: 1 }), /disabled reviewPool capacity/);
});

function withConfigFile(config, run) {
  const dir = mkdtempSync(join(tmpdir(), 'ai-agent-teams-i18n-config-'));
  const path = join(dir, 'config.json');
  try {
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    return run(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('locale and timezone default to auto before resolution', () => {
  const config = applyDefaults({ version: 1 });
  assert.equal(config.zcode.locale, 'auto');
  assert.equal(config.zcode.timezone, 'auto');
});

test('every shipped example declares auto localization and validates', () => {
  for (const path of ['config/example.two-teams.json', 'config/example.minimal.json', 'config/example.v06.json']) {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(raw.zcode.locale, 'auto', path);
    assert.equal(raw.zcode.timezone, 'auto', path);
    const result = validateConfig(raw);
    assert.deepEqual(result.errors, [], path);
    assert.equal(result.ok, true, path);
  }
});

test('loadConfig resolves auto into concrete values from the environment', () => {
  const raw = structuredClone(example);
  raw.zcode.locale = 'auto';
  raw.zcode.timezone = 'auto';
  const previous = {
    AGENT_TEAMS_LOCALE: process.env.AGENT_TEAMS_LOCALE,
    AGENT_TEAMS_TIMEZONE: process.env.AGENT_TEAMS_TIMEZONE,
  };
  process.env.AGENT_TEAMS_LOCALE = 'ko-KR';
  process.env.AGENT_TEAMS_TIMEZONE = 'Asia/Seoul';
  try {
    withConfigFile(raw, (path) => {
      const { config, warnings } = loadConfig(path);
      assert.equal(config.zcode.locale, 'ko-KR');
      assert.equal(config.zcode.timezone, 'Asia/Seoul');
      assert.deepEqual(warnings, []);
      // The resolved config must round-trip through validation: no raw
      // preference field leaks into the object and trips the unknown-key check.
      assert.deepEqual(validateConfig(config).errors, []);
    });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('loadConfig keeps explicit valid locale and timezone values', () => {
  const raw = structuredClone(example);
  raw.zcode.locale = 'ja-JP';
  raw.zcode.timezone = 'Europe/Berlin';
  withConfigFile(raw, (path) => {
    const { config } = loadConfig(path);
    assert.equal(config.zcode.locale, 'ja-JP');
    assert.equal(config.zcode.timezone, 'Europe/Berlin');
  });
});

test('an explicit unsupported locale is rejected instead of silently detected', () => {
  for (const value of ['fr-FR', 'de', 'zh-TW', 'ko']) {
    const raw = structuredClone(example);
    raw.zcode.locale = value;
    const result = validateConfig(raw);
    assert.equal(result.ok, false, value);
    assert.match(result.errors.join('\n'), /zcode\.locale/, value);
  }
});

test('zcode.timezone accepts auto and IANA names but rejects invalid zones', () => {
  for (const value of ['auto', 'UTC', 'Asia/Shanghai', 'America/New_York', 'Etc/GMT+5']) {
    const raw = structuredClone(example);
    raw.zcode.timezone = value;
    assert.deepEqual(validateConfig(raw).errors, [], value);
  }
  for (const value of ['Not/AZone', 'GMT+8', '', 'asia shanghai', 8]) {
    const raw = structuredClone(example);
    raw.zcode.timezone = value;
    const result = validateConfig(raw);
    assert.equal(result.ok, false, String(value));
    assert.match(result.errors.join('\n'), /zcode\.timezone/, String(value));
  }
});

test('member home sweep requires explicit opt-in and validates the interval', () => {
  const config = structuredClone(example);
  delete config.scheduler.memberHomeReclaimMinutes;
  assert.equal(applyDefaults(config).scheduler.memberHomeReclaimMinutes, null);
  for (const value of [null, 0, 1, 1440]) {
    config.scheduler.memberHomeReclaimMinutes = value;
    assert.equal(validateConfig(config).ok, true);
  }
  for (const value of [-1, 1441, 0.5, '60', true]) {
    config.scheduler.memberHomeReclaimMinutes = value;
    assert.ok(validateConfig(config).errors.some((error) => error.includes('memberHomeReclaimMinutes')));
  }
});
