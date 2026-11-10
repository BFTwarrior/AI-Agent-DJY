import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { recommendPreset } from './domain/lifecycle.mjs';
import { CONTAINER_IMAGE_PULL_POLICIES } from './domain/container-image-policy.mjs';
import { isValidTimeZone, normalizeLocale, resolveLocale, resolveTimeZone, SUPPORTED_LOCALES } from './i18n.mjs';

const ALL_KINDS = ['requirements', 'implementation', 'verification', 'review', 'repair', 'integration'];
const FEATURE_KEYS = ['lazyMembers', 'licenses', 'compression', 'contractors', 'patrol', 'postMergeReview'];
const LOCALE_VALUES = ['auto', ...SUPPORTED_LOCALES];

/**
 * Apply every documented default. Returns a new object; the input is not mutated.
 * `zcode.maxConcurrentSessions` counts worker sessions only (captain/leads are
 * control sessions outside this budget).
 * @param {any} raw
 * @returns {any}
 */
export function applyDefaults(raw) {
  const config = structuredClone(raw);
  config.features ??= {};
  for (const key of FEATURE_KEYS) config.features[key] ??= false;

  config.captain ??= {};
  config.captain.name ??= 'captain';
  config.captain.model ??= null;
  config.captain.maxTeams ??= 2;

  if (Array.isArray(config.teams)) {
    for (const team of config.teams) {
      if (!team || typeof team !== 'object') continue;
      team.baseBranch ??= 'main';
      team.defaultMembers ??= 16;
      team.maxMembers ??= 32;
    }
  }

  config.scheduler ??= {};
  const preset = config.scheduler.preset ?? null;
  if (preset !== null) {
    const recommended = recommendPreset({
      memoryGb: config.scheduler.memoryGb ?? 16,
      mode: preset,
      teams: Array.isArray(config.teams) ? config.teams.length : 2,
    });
    config.scheduler.activeWorkerSlots ??= recommended.activeWorkerSlots;
    config.scheduler.maxActivePerTeam ??= recommended.maxActivePerTeam;
    config.scheduler.minActivePerTeam ??= recommended.minActivePerTeam;
    config.scheduler.maxControlSessions ??= recommended.maxControlSessions;
    config.scheduler.maxTotalSessions ??= recommended.maxTotalSessions;
  } else {
    config.scheduler.activeWorkerSlots ??= 6;
    config.scheduler.maxActivePerTeam ??= 3;
    config.scheduler.minActivePerTeam ??= 1;
    config.scheduler.maxControlSessions ??= 5;
    config.scheduler.maxTotalSessions ??= 32;
  }
  config.scheduler.preset ??= null;
  config.scheduler.memoryGb ??= null;
  config.scheduler.allowAboveDesignCap ??= false;
  config.scheduler.fairness ??= 'equal';
  config.scheduler.dynamicTeams ??= false;
  config.scheduler.maxTurnsPerTask ??= 30;
  config.scheduler.taskTimeoutMinutes ??= 120;
  config.scheduler.idleSessionMinutes ??= 30;

  config.automation ??= {};
  config.automation.mode ??= 'standard';

  if (config.shadow === undefined) config.shadow = {};
  if (config.shadow && typeof config.shadow === 'object' && !Array.isArray(config.shadow)) {
    config.shadow.enabled ??= true;
    config.shadow.idleStopMinutes ??= 30;
  }

  config.contractors ??= {};
  config.contractors.enabled ??= config.features.contractors;
  config.contractors.maxConcurrent ??= 2;
  config.contractors.maxLifetimeMinutes ??= 15;
  config.contractors.defaultPermission ??= 'read-only';
  config.contractors.allowBorrow ??= false;
  config.contractors.reviewPool ??= {};
  config.contractors.reviewPool.enabled ??= false;
  config.contractors.reviewPool.capacity ??= 0;
  config.contractors.slots ??= {};
  for (const slot of ['merge', 'patrol', 'main']) {
    if (config.contractors.slots[slot] === null) delete config.contractors.slots[slot];
  }
  config.contractors.slots.merge ??= {
    cap: config.contractors.maxConcurrent > 0 ? 1 : 0,
    kinds: ['post_merge_review', 'merge_verify', 'merge_review', 'merge'],
  };
  if (!config.contractors.slots.patrol && !config.contractors.slots.main) {
    config.contractors.slots.patrol = {
      cap: Math.min(1, Math.max(0, config.contractors.maxConcurrent - (config.contractors.slots.merge.cap ?? 0))),
      kinds: ['*'],
    };
  }
  // `main` is the legacy name for the patrol slot. Never add both: doing so
  // would make a second applyDefaults() pass exceed maxConcurrent.
  config.contractors.slots.merge.kinds ??= ['post_merge_review', 'merge_verify'];
  if (config.contractors.slots.patrol) config.contractors.slots.patrol.kinds ??= ['*'];
  if (config.contractors.slots.main) config.contractors.slots.main.kinds ??= ['*'];

  config.patrol ??= {};
  config.patrol.enabled ??= config.features.patrol;
  config.patrol.captainSelfWake ??= true;
  config.patrol.intervalMinutes ??= 15;
  config.patrol.whenCaptainBusy ??= 'queue';
  config.patrol.maxContractorPerCycle ??= 1;
  config.patrol.timeoutMinutes ??= 30;

  config.scheduler.worktreeBaseCheckMs ??= 30000;
  // Task checkouts are reclaimed after this TTL once the task is terminal
  // (merged/cancelled/failed). SPEC promises 24h; a dirty checkout is never
  // removed, so lowering this only accelerates clean ones.
  config.scheduler.worktreeTtlHours ??= 24;
  // Soft ceiling on how many task checkouts may stay on disk at once. The
  // reclaimer deletes the oldest reclaimable, clean checkouts first.
  config.scheduler.maxConcurrentWorktrees ??= 6;
  // How often the daemon re-runs the reclaimer. 0 disables the periodic sweep
  // (startup, cancel and merge paths still reclaim).
  config.scheduler.worktreeReclaimMinutes ??= 30;
  config.scheduler.memberHomeReclaimMinutes ??= null;

  config.memory ??= {};
  config.memory.enabled ??= config.features.compression;
  config.memory.highWatermarkPercent ??= 80;
  config.memory.lowWatermarkPercent ??= 65;
  config.memory.budgetMb ??= null;
  config.memory.availableIdleMinutes ??= 10;
  config.memory.waitingWarmMinutes ??= 3;
  config.memory.waitingColdMinutes ??= 10;

  config.isolation ??= {};
  config.isolation.mode ??= 'worktree';
  config.isolation.containerRuntime ??= 'docker';
  config.isolation.image ??= 'ai-agent-teams-worker:latest';
  config.isolation.imagePullPolicy ??= 'never';
  config.isolation.cliPath ??= 'zcode';
  config.isolation.containerUrl ??= null;
  config.isolation.hostAddress ??= null;
  config.isolation.bindHost ??= null;
  config.isolation.homeSeed ??= null;
  config.isolation.workerModel ??= null;
  config.isolation.workerMode ??= 'yolo';
  for (const key of ['containerUrl', 'hostAddress', 'bindHost', 'homeSeed']) {
    if (config.isolation[key] === '') config.isolation[key] = null;
  }
  config.isolation.network ??= 'gateway-only';
  config.isolation.readOnlyRoot ??= true;
  config.isolation.nonRoot ??= true;
  config.isolation.cpuLimit ??= 2;
  config.isolation.memoryMb ??= 2048;
  config.isolation.pidsLimit ??= 512;

  config.interruption ??= {};
  config.interruption.defaultDelivery ??= 'queue';
  config.interruption.urgentDelivery ??= 'guide';
  config.interruption.hardStop ??= 'stop';
  config.interruption.cancelBackgroundTasks ??= true;

  config.zcode ??= {};
  config.zcode.cliPath ??= 'auto';
  config.zcode.protocol ??= 'app-server';
  config.zcode.mode ??= 'build';
  config.zcode.locale ??= 'auto';
  config.zcode.timezone ??= 'auto';
  config.zcode.defaultModel ??= null;
  config.zcode.defaultReasoning ??= null;
  config.zcode.modelPolicy ??= 'follow-host';
  config.zcode.maxRequestsPerMinute ??= 0;
  config.zcode.maxConcurrentSessions ??= Math.max(6, config.scheduler.activeWorkerSlots);
  config.zcode.memberMcpServers ??= 'minimal';
  config.zcode.turnWatchIntervalMs ??= 2000;
  config.zcode.turnFailureRetry ??= {};
  config.zcode.turnFailureRetry.enabled ??= true;
  config.zcode.turnFailureRetry.maxAttempts ??= 3;
  config.zcode.turnFailureRetry.capacityMaxAttempts ??= 3;
  config.zcode.turnFailureRetry.baseDelayMs ??= 3000;
  config.zcode.turnFailureRetry.maxDelayMs ??= 60000;
  config.zcode.turnFailureRetry.capacityRecoveryMs ??= 60000;
  config.zcode.turnFailureRetry.capacityRecoverySuccesses ??= 3;
  config.zcode.redAutoReview ??= {};
  config.zcode.redAutoReview.enabled ??= true;
  config.zcode.redAutoReview.maxContinues ??= 3;
  config.zcode.redAutoReview.retryDelayMs ??= 5000;
  config.zcode.redAutoReview.maxAttempts ??= 5;

  config.storage ??= {};
  config.storage.database ??= '.ai-agent-teams/state.db';
  config.storage.archiveDays ??= 30;

  config.quality ??= {};
  config.quality.kinds ??= [...ALL_KINDS];
  config.quality.requireIndependentReview ??= true;
  config.quality.maxReviewRounds ??= 3;
  config.quality.verifyCommands ??= [];
  config.quality.reviewPolicy ??= {};
  config.quality.reviewPolicy.requirementsMinRounds ??= 1;
  config.quality.reviewPolicy.requirementsMaxRounds ??= 2;
  config.quality.reviewPolicy.codeMaxRounds ??= 3;
  config.quality.reviewPolicy.maxRepairAttempts ??= 2;
  config.quality.reviewPolicy.requiredReviewers ??= [];
  config.quality.postMergeReview ??= config.features.postMergeReview ? 'contractor' : 'off';
  config.quality.mergeBranch ??= 'integration';

  return config;
}

/**
 * Load, default, and validate a JSON config.
 * @param {string} path
 * @returns {{ config: any, warnings: string[] }}
 */
export function loadConfig(path) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read config ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const config = applyDefaults(raw);
  const result = validateConfig(config);
  if (!result.ok) {
    throw new Error(`invalid config ${path}:\n- ${result.errors.join('\n- ')}`);
  }
  // Resolve `auto` after validation so the returned config always carries the
  // concrete locale/time zone that sessions and the console will use. The raw
  // preference is deliberately not copied onto the result: a stray
  // `localePreference` key would fail the unknown-key check on reload.
  const locale = resolveLocale(config.zcode.locale);
  const timeZone = resolveTimeZone(config.zcode.timezone);
  config.zcode.locale = locale.locale;
  config.zcode.timezone = timeZone.timeZone;
  const warnings = [...result.warnings];
  for (const warning of [locale.warning, timeZone.warning]) {
    if (warning) warnings.push(warning);
  }
  return { config, warnings };
}

/**
 * Validate the semantic constraints of a config. Defaults are applied first.
 * @param {unknown} input
 * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
 */
export function validateConfig(input) {
  const errors = [];
  const warnings = [];
  const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const isInt = (value) => Number.isInteger(value);

  if (!isObject(input)) {
    return { ok: false, errors: ['config must be an object'], warnings };
  }
  const config = applyDefaults(input);

  const checkKeys = (value, allowed, label) => {
    if (!isObject(value)) return;
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) errors.push(`${label}: unknown key "${key}"`);
    }
  };

  checkKeys(config, ['$schema', 'version', 'captain', 'teams', 'features', 'scheduler', 'automation', 'shadow', 'contractors', 'patrol', 'memory', 'isolation', 'interruption', 'zcode', 'storage', 'quality'], 'config');
  if (config.version !== 1) errors.push('version must be 1');
  if (!isObject(config.features)) {
    errors.push('features must be an object');
  } else {
    checkKeys(config.features, FEATURE_KEYS, 'features');
    for (const key of FEATURE_KEYS) {
      if (typeof config.features[key] !== 'boolean') errors.push(`features.${key} must be boolean`);
    }
  }

  // captain
  if (!isObject(config.captain)) {
    errors.push('captain must be an object');
  } else {
    checkKeys(config.captain, ['name', 'model', 'maxTeams'], 'captain');
    if (typeof config.captain.name !== 'string' || !config.captain.name.trim()) {
      errors.push('captain.name must be a non-empty string');
    }
    if (![1, 2].includes(config.captain.maxTeams)) errors.push('captain.maxTeams must be 1 or 2');
    if (config.captain.model !== null && typeof config.captain.model !== 'string') {
      errors.push('captain.model must be a string or null');
    }
  }

  // teams
  if (!Array.isArray(config.teams) || config.teams.length < 1 || config.teams.length > 2) {
    errors.push('teams must contain 1 or 2 entries');
  } else {
    const ids = new Set();
    const leads = new Set();
    config.teams.forEach((team, index) => {
      if (!isObject(team)) {
        errors.push(`teams[${index}] must be an object`);
        return;
      }
      checkKeys(team, ['id', 'name', 'lead', 'defaultMembers', 'maxMembers', 'baseBranch', 'maxActiveWorkers'], `teams[${index}]`);
      if (team.maxActiveWorkers !== undefined
        && (!isInt(team.maxActiveWorkers) || team.maxActiveWorkers < 1 || team.maxActiveWorkers > 32)) {
        errors.push(`teams[${index}].maxActiveWorkers must be an integer 1..32`);
      }
      if (typeof team.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,31}$/.test(team.id)) {
        errors.push(`teams[${index}].id must match ^[a-z0-9][a-z0-9._-]{0,31}$`);
      } else if (ids.has(team.id)) {
        errors.push(`duplicate team id: ${team.id}`);
      } else {
        ids.add(team.id);
      }
      if (typeof team.name !== 'string' || !team.name.trim()) errors.push(`teams[${index}].name must be non-empty`);
      if (typeof team.lead !== 'string' || !team.lead.trim()) {
        errors.push(`teams[${index}].lead must be non-empty`);
      } else if (leads.has(team.lead)) {
        errors.push(`duplicate lead name: ${team.lead}`);
      } else {
        leads.add(team.lead);
      }
      if (!isInt(team.defaultMembers) || team.defaultMembers < 8 || team.defaultMembers > 32) {
        errors.push(`teams[${index}].defaultMembers must be 8..32`);
      }
      if (!isInt(team.maxMembers) || team.maxMembers < 8 || team.maxMembers > 32) {
        errors.push(`teams[${index}].maxMembers must be 8..32`);
      }
      if (isInt(team.defaultMembers) && isInt(team.maxMembers) && team.defaultMembers > team.maxMembers) {
        errors.push(`teams[${index}].defaultMembers cannot exceed maxMembers`);
      }
      if (typeof team.baseBranch !== 'string' || !team.baseBranch.trim()) {
        errors.push(`teams[${index}].baseBranch must be non-empty`);
      }
    });
  }

  // scheduler
  const scheduler = config.scheduler;
  if (!isObject(scheduler)) {
    errors.push('scheduler must be an object');
  } else {
    checkKeys(scheduler, [
      'preset', 'memoryGb', 'activeWorkerSlots', 'maxActivePerTeam', 'minActivePerTeam',
      'maxControlSessions', 'maxTotalSessions', 'allowAboveDesignCap', 'fairness', 'dynamicTeams',
      'maxTurnsPerTask', 'taskTimeoutMinutes', 'idleSessionMinutes', 'worktreeBaseCheckMs',
      'worktreeTtlHours', 'maxConcurrentWorktrees', 'worktreeReclaimMinutes', 'memberHomeReclaimMinutes',
    ], 'scheduler');
    if (scheduler.preset !== null && !['conservative', 'balanced'].includes(scheduler.preset)) {
      errors.push('scheduler.preset must be conservative|balanced|null');
    }
    if (scheduler.memoryGb !== null && (!isInt(scheduler.memoryGb) || scheduler.memoryGb < 8 || scheduler.memoryGb > 1024)) {
      errors.push('scheduler.memoryGb must be null or 8..1024');
    }
    if (!isInt(scheduler.activeWorkerSlots) || scheduler.activeWorkerSlots < 1 || scheduler.activeWorkerSlots > 64) {
      errors.push('scheduler.activeWorkerSlots must be 1..64');
    }
    if (!scheduler.allowAboveDesignCap && isInt(scheduler.activeWorkerSlots) && scheduler.activeWorkerSlots > 32) {
      errors.push('scheduler.activeWorkerSlots above 32 requires allowAboveDesignCap=true');
    }
    if (!isInt(scheduler.maxActivePerTeam) || scheduler.maxActivePerTeam < 1 || scheduler.maxActivePerTeam > 32) {
      errors.push('scheduler.maxActivePerTeam must be 1..32');
    }
    if (!isInt(scheduler.minActivePerTeam) || scheduler.minActivePerTeam < 1 || scheduler.minActivePerTeam > 32) {
      errors.push('scheduler.minActivePerTeam must be 1..32');
    }
    if (isInt(scheduler.minActivePerTeam) && isInt(scheduler.maxActivePerTeam)
      && scheduler.minActivePerTeam > scheduler.maxActivePerTeam) {
      errors.push('scheduler.minActivePerTeam cannot exceed maxActivePerTeam');
    }
    if (isInt(scheduler.activeWorkerSlots) && isInt(scheduler.maxActivePerTeam)
      && scheduler.maxActivePerTeam > scheduler.activeWorkerSlots) {
      errors.push('scheduler.maxActivePerTeam cannot exceed activeWorkerSlots');
    }
    for (const key of ['maxControlSessions', 'maxTotalSessions']) {
      if (!isInt(scheduler[key]) || scheduler[key] < 1 || scheduler[key] > 128) {
        errors.push(`scheduler.${key} must be 1..128`);
      }
    }
    if (isInt(scheduler.maxTotalSessions) && isInt(scheduler.activeWorkerSlots)
      && scheduler.maxTotalSessions < scheduler.activeWorkerSlots) {
      errors.push('scheduler.maxTotalSessions must be >= activeWorkerSlots');
    }
    if (typeof scheduler.allowAboveDesignCap !== 'boolean') errors.push('scheduler.allowAboveDesignCap must be boolean');
    if (!['equal', 'priority'].includes(scheduler.fairness)) {
      errors.push('scheduler.fairness must be equal or priority');
    }
    if (typeof scheduler.dynamicTeams !== 'boolean') errors.push('scheduler.dynamicTeams must be boolean');
    for (const key of ['maxTurnsPerTask', 'taskTimeoutMinutes', 'idleSessionMinutes']) {
      if (!isInt(scheduler[key]) || scheduler[key] < 1) errors.push(`scheduler.${key} must be a positive integer`);
    }
    if (scheduler.worktreeBaseCheckMs !== undefined
      && (!isInt(scheduler.worktreeBaseCheckMs) || scheduler.worktreeBaseCheckMs < 0 || scheduler.worktreeBaseCheckMs > 600000)) {
      errors.push('scheduler.worktreeBaseCheckMs must be 0..600000');
    }
    if (scheduler.worktreeTtlHours !== undefined
      && (!isInt(scheduler.worktreeTtlHours) || scheduler.worktreeTtlHours < 0 || scheduler.worktreeTtlHours > 720)) {
      errors.push('scheduler.worktreeTtlHours must be an integer 0..720');
    }
    if (scheduler.maxConcurrentWorktrees !== undefined
      && (!isInt(scheduler.maxConcurrentWorktrees) || scheduler.maxConcurrentWorktrees < 1 || scheduler.maxConcurrentWorktrees > 64)) {
      errors.push('scheduler.maxConcurrentWorktrees must be an integer 1..64');
    }
    if (scheduler.worktreeReclaimMinutes !== undefined
      && (!isInt(scheduler.worktreeReclaimMinutes) || scheduler.worktreeReclaimMinutes < 0 || scheduler.worktreeReclaimMinutes > 1440)) {
      errors.push('scheduler.worktreeReclaimMinutes must be an integer 0..1440 (0 disables the periodic sweep)');
    }
    if (scheduler.memberHomeReclaimMinutes != null
      && (!isInt(scheduler.memberHomeReclaimMinutes) || scheduler.memberHomeReclaimMinutes < 0 || scheduler.memberHomeReclaimMinutes > 1440)) {
      errors.push('scheduler.memberHomeReclaimMinutes must be null or an integer 0..1440');
    }
    if (isInt(scheduler.activeWorkerSlots) && scheduler.activeWorkerSlots > 16) {
      warnings.push(`activeWorkerSlots=${scheduler.activeWorkerSlots} is above the recommended 16; load-test first`);
    }
    if (scheduler.preset === null && config.features?.lazyMembers) {
      warnings.push('features.lazyMembers is enabled without a preset; explicit worker values are used');
    }
  }

  if (!isObject(config.automation)) {
    errors.push('automation must be an object');
  } else {
    checkKeys(config.automation, ['mode'], 'automation');
    if (!['standard', 'full-access'].includes(config.automation.mode)) {
      errors.push('automation.mode must be standard|full-access');
    }
  }

  // contractors / patrol / shadow / memory
  for (const [label, value, keys] of [
    ['contractors', config.contractors, ['enabled', 'maxConcurrent', 'maxLifetimeMinutes', 'defaultPermission', 'slots', 'allowBorrow', 'reviewPool']],
    ['patrol', config.patrol, ['enabled', 'captainSelfWake', 'intervalMinutes', 'whenCaptainBusy', 'maxContractorPerCycle', 'timeoutMinutes']],
    ['shadow', config.shadow, ['enabled', 'idleStopMinutes']],
    ['memory', config.memory, ['enabled', 'highWatermarkPercent', 'lowWatermarkPercent', 'budgetMb', 'availableIdleMinutes', 'waitingWarmMinutes', 'waitingColdMinutes']],
  ]) {
    if (!isObject(value)) {
      errors.push(`${label} must be an object`);
    } else {
      checkKeys(value, keys, label);
    }
  }
  if (isObject(config.shadow)) {
    if (typeof config.shadow.enabled !== 'boolean') errors.push('shadow.enabled must be boolean');
    if (!isInt(config.shadow.idleStopMinutes) || config.shadow.idleStopMinutes < 1 || config.shadow.idleStopMinutes > 1440) {
      errors.push('shadow.idleStopMinutes must be 1..1440');
    }
  }
  if (isObject(config.contractors)) {
    if (typeof config.contractors.enabled !== 'boolean') errors.push('contractors.enabled must be boolean');
    if (!isInt(config.contractors.maxConcurrent) || config.contractors.maxConcurrent < 0 || config.contractors.maxConcurrent > 16) {
      errors.push('contractors.maxConcurrent must be 0..16');
    }
    if (!isInt(config.contractors.maxLifetimeMinutes) || config.contractors.maxLifetimeMinutes < 1) {
      errors.push('contractors.maxLifetimeMinutes must be >= 1');
    }
    if (!['read-only', 'workspace-write'].includes(config.contractors.defaultPermission)) {
      errors.push('contractors.defaultPermission must be read-only|workspace-write');
    }
    if (typeof config.contractors.allowBorrow !== 'boolean') {
      errors.push('contractors.allowBorrow must be boolean');
    } else if (config.contractors.allowBorrow) {
      errors.push('contractors.allowBorrow is not implemented; keep false so merge and main slots stay reserved');
    }
    const reviewPool = config.contractors.reviewPool;
    if (!isObject(reviewPool)) {
      errors.push('contractors.reviewPool must be an object');
    } else {
      checkKeys(reviewPool, ['enabled', 'capacity'], 'contractors.reviewPool');
      if (typeof reviewPool.enabled !== 'boolean') errors.push('contractors.reviewPool.enabled must be boolean');
      if (!isInt(reviewPool.capacity) || reviewPool.capacity < 0 || reviewPool.capacity > 10) {
        errors.push('contractors.reviewPool.capacity must be 0..10');
      }
      if (reviewPool.enabled === true && (!isInt(reviewPool.capacity) || reviewPool.capacity < 1)) {
        errors.push('contractors.reviewPool.enabled requires capacity 1..10');
      }
      if (reviewPool.enabled === true) errors.push('contractors.reviewPool scheduling is not implemented; do not enable it');
      if (reviewPool.enabled === false && reviewPool.capacity !== 0) {
        errors.push('contractors.reviewPool.capacity must be 0 when disabled');
      }
      if (reviewPool.enabled === true && config.contractors.enabled !== true) {
        errors.push('contractors.reviewPool.enabled requires contractors.enabled=true');
      }
    }
    if (!isObject(config.contractors.slots)) {
      errors.push('contractors.slots must be an object');
    } else {
      const slotNames = ['merge', 'patrol', 'main'];
      checkKeys(config.contractors.slots, slotNames, 'contractors.slots');
      if (config.contractors.slots.patrol && config.contractors.slots.main) {
        errors.push('contractors.slots.patrol and contractors.slots.main are aliases; configure only one');
      }
      let totalCaps = 0;
      for (const name of slotNames) {
        const slot = config.contractors.slots[name];
        if (!slot && ['patrol', 'main'].includes(name)
          && (config.contractors.slots.patrol || config.contractors.slots.main)) {
          // `patrol` and its legacy alias `main` are alternatives; exactly one
          // of them is required.
          continue;
        }
        if (!isObject(slot)) {
          errors.push(`contractors.slots.${name} must be an object`);
          continue;
        }
        checkKeys(slot, ['cap', 'kinds'], `contractors.slots.${name}`);
        if (!isInt(slot.cap) || slot.cap < 0 || slot.cap > 16) {
          errors.push(`contractors.slots.${name}.cap must be 0..16`);
        } else {
          totalCaps += slot.cap;
        }
        if (isInt(slot.cap) && slot.cap > 1) {
          errors.push(`contractors.slots.${name}.cap must be 0 or 1`);
        }
        if (!Array.isArray(slot.kinds) || slot.kinds.some((kind) => typeof kind !== 'string')) {
          errors.push(`contractors.slots.${name}.kinds must be an array of strings`);
        }
      }
      if (totalCaps > config.contractors.maxConcurrent) {
        errors.push('contractor slot caps must not exceed contractors.maxConcurrent');
      }
      const reviewCapacity = isObject(reviewPool) && reviewPool.enabled === true && isInt(reviewPool.capacity)
        ? reviewPool.capacity : 0;
      if (totalCaps + reviewCapacity > config.contractors.maxConcurrent) {
        errors.push('contractor slot and reviewPool capacities must not exceed contractors.maxConcurrent');
      }
      if (reviewCapacity > 0 && isInt(config.scheduler?.maxTotalSessions)
        && isInt(config.scheduler?.activeWorkerSlots)
        && config.scheduler.maxTotalSessions < config.scheduler.activeWorkerSlots + reviewCapacity) {
        errors.push('scheduler.maxTotalSessions must cover active workers and reviewPool capacity');
      }
    }
  }
  if (isObject(config.patrol)) {
    if (typeof config.patrol.enabled !== 'boolean' || typeof config.patrol.captainSelfWake !== 'boolean') {
      errors.push('patrol.enabled and patrol.captainSelfWake must be boolean');
    }
    if (!isInt(config.patrol.intervalMinutes) || config.patrol.intervalMinutes < 1) {
      errors.push('patrol.intervalMinutes must be >= 1');
    }
    if (!['queue', 'one-shot-contractor', 'wait'].includes(config.patrol.whenCaptainBusy)) {
      errors.push('patrol.whenCaptainBusy must be queue|one-shot-contractor|wait');
    }
    if (!isInt(config.patrol.maxContractorPerCycle) || config.patrol.maxContractorPerCycle < 0 || config.patrol.maxContractorPerCycle > 2) {
      errors.push('patrol.maxContractorPerCycle must be 0..2');
    }
    if (config.patrol.timeoutMinutes !== undefined
      && (!isInt(config.patrol.timeoutMinutes) || config.patrol.timeoutMinutes < 1 || config.patrol.timeoutMinutes > 1440)) {
      errors.push('patrol.timeoutMinutes must be 1..1440');
    }
  }
  if (isObject(config.memory)) {
    if (typeof config.memory.enabled !== 'boolean') errors.push('memory.enabled must be boolean');
    for (const key of ['highWatermarkPercent', 'lowWatermarkPercent']) {
      if (!isInt(config.memory[key]) || config.memory[key] < 1 || config.memory[key] > 100) {
        errors.push(`memory.${key} must be 1..100`);
      }
    }
    if (config.memory.budgetMb !== null && (!isInt(config.memory.budgetMb) || config.memory.budgetMb < 128)) {
      errors.push('memory.budgetMb must be null or >= 128');
    }
    if (isInt(config.memory.highWatermarkPercent) && isInt(config.memory.lowWatermarkPercent)
      && config.memory.lowWatermarkPercent > config.memory.highWatermarkPercent) {
      errors.push('memory.lowWatermarkPercent cannot exceed highWatermarkPercent');
    }
    for (const key of ['availableIdleMinutes', 'waitingWarmMinutes', 'waitingColdMinutes']) {
      if (!isInt(config.memory[key]) || config.memory[key] < 1) errors.push(`memory.${key} must be >= 1`);
    }
  }

  // isolation
  const isolation = config.isolation;
  if (!isObject(isolation)) {
    errors.push('isolation must be an object');
  } else {
    checkKeys(isolation, ['mode', 'containerRuntime', 'image', 'imagePullPolicy', 'cliPath', 'containerUrl', 'hostAddress', 'bindHost', 'homeSeed', 'workerModel', 'workerMode', 'network', 'readOnlyRoot', 'nonRoot', 'cpuLimit', 'memoryMb', 'pidsLimit'], 'isolation');
    if (!['worktree', 'container', 'microvm', 'none'].includes(isolation.mode)) {
      errors.push('isolation.mode must be worktree|container|microvm|none');
    }
    if (!['docker', 'podman'].includes(isolation.containerRuntime)) {
      errors.push('isolation.containerRuntime must be docker|podman');
    }
    if (typeof isolation.image !== 'string' || !isolation.image.trim()) errors.push('isolation.image must be a non-empty string');
    if (!CONTAINER_IMAGE_PULL_POLICIES.includes(isolation.imagePullPolicy)) {
      errors.push(`isolation.imagePullPolicy must be ${CONTAINER_IMAGE_PULL_POLICIES.join('|')}`);
    }
    if (typeof isolation.cliPath !== 'string' || !isolation.cliPath.trim()) errors.push('isolation.cliPath must be a non-empty string');
    if (isolation.containerUrl !== null && typeof isolation.containerUrl !== 'string') errors.push('isolation.containerUrl must be a string or null');
    if (typeof isolation.containerUrl === 'string' && isolation.containerUrl.trim()) {
      try {
        const url = new URL(isolation.containerUrl);
        if (!['http:', 'https:'].includes(url.protocol)) errors.push('isolation.containerUrl must use http or https');
        if (['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
          warnings.push('isolation.containerUrl points to loopback; the daemon rewrites it to hostAddress:<actual-port> at startup');
        }
      } catch {
        errors.push('isolation.containerUrl must be a valid URL');
      }
    }
    if (isolation.hostAddress !== null && typeof isolation.hostAddress !== 'string') errors.push('isolation.hostAddress must be a string or null');
    if (typeof isolation.hostAddress === 'string') {
      const value = isolation.hostAddress.trim();
      if (!value) errors.push('isolation.hostAddress must not be empty');
      else if (!(isIP(value) || /^[A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9]$/.test(value))) {
        errors.push('isolation.hostAddress must be a host or IP without scheme, port or path');
      } else if (value === '0.0.0.0' || value === '::' || value === '::1' || value === 'localhost' || /^127\./.test(value)) {
        errors.push('isolation.hostAddress must be reachable from a container, not a wildcard/loopback address');
      }
    }
    if (isolation.bindHost !== null && typeof isolation.bindHost !== 'string') errors.push('isolation.bindHost must be a string or null');
    if (typeof isolation.bindHost === 'string') {
      const value = isolation.bindHost.trim();
      if (!value) errors.push('isolation.bindHost must not be empty');
      else if (!(isIP(value) || /^[A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9]$/.test(value))) {
        errors.push('isolation.bindHost must be an IP or host without scheme, port or path');
      } else if (isolation.mode === 'container' && value !== '0.0.0.0') {
        errors.push('isolation.bindHost must be 0.0.0.0 in container mode; containers need the wildcard listener and the panel stays on loopback');
      } else if (isolation.mode !== 'container') {
        warnings.push('isolation.bindHost is ignored outside container mode; the daemon binds 127.0.0.1');
      }
    }
    if (isolation.homeSeed !== null && typeof isolation.homeSeed !== 'string') errors.push('isolation.homeSeed must be a string or null');
    if (!['build', 'edit', 'plan', 'yolo', 'guarded'].includes(isolation.workerMode)) errors.push('isolation.workerMode must be build|edit|plan|yolo|guarded');
    if (isolation.workerModel !== null) {
      if (!isObject(isolation.workerModel)) {
        errors.push('isolation.workerModel must be an object or null');
      } else {
        checkKeys(isolation.workerModel, ['providerId', 'modelId', 'reasoningLevel', 'options'], 'isolation.workerModel');
        if (typeof isolation.workerModel.providerId !== 'string' || !isolation.workerModel.providerId.trim()) {
          errors.push('isolation.workerModel.providerId must be a non-empty string');
        }
        if (typeof isolation.workerModel.modelId !== 'string' || !isolation.workerModel.modelId.trim()) {
          errors.push('isolation.workerModel.modelId must be a non-empty string');
        }
      }
    }
    if (!['gateway-only', 'none'].includes(isolation.network)) {
      errors.push('isolation.network must be gateway-only|none');
    }
    if (typeof isolation.readOnlyRoot !== 'boolean') errors.push('isolation.readOnlyRoot must be boolean');
    if (typeof isolation.nonRoot !== 'boolean') errors.push('isolation.nonRoot must be boolean');
    if (typeof isolation.cpuLimit !== 'number' || isolation.cpuLimit <= 0) errors.push('isolation.cpuLimit must be > 0');
    if (!isInt(isolation.memoryMb) || isolation.memoryMb < 128) errors.push('isolation.memoryMb must be >= 128');
    if (!isInt(isolation.pidsLimit) || isolation.pidsLimit < 32) errors.push('isolation.pidsLimit must be >= 32');
    if (isolation.mode === 'none') warnings.push('isolation.mode=none provides no isolation');
    if (isolation.mode === 'container') {
      if (!isolation.homeSeed) warnings.push('isolation.mode=container without homeSeed: workers start without the host ZCode login');
      if (!isolation.workerModel) warnings.push('isolation.mode=container without workerModel: headless workers may fail with "Select a model"');
      if (!isolation.readOnlyRoot) warnings.push('isolation.mode=container with readOnlyRoot=false weakens the container boundary');
      if (!isolation.nonRoot) warnings.push('isolation.mode=container with nonRoot=false weakens the container boundary');
      if (isolation.workerMode === 'yolo') warnings.push('isolation.workerMode=yolo auto-approves tools inside the container');
      if (isolation.network === 'gateway-only') warnings.push('isolation.network=gateway-only allows outbound egress; it is not an egress firewall');
    }
    if (isolation.mode === 'microvm') warnings.push('microvm mode requires Kata/gVisor/Firecracker');
  }

  // interruption
  const interruption = config.interruption;
  if (!isObject(interruption)) {
    errors.push('interruption must be an object');
  } else {
    checkKeys(interruption, ['defaultDelivery', 'urgentDelivery', 'hardStop', 'cancelBackgroundTasks'], 'interruption');
    if (!['queue', 'guide'].includes(interruption.defaultDelivery)) errors.push('interruption.defaultDelivery must be queue|guide');
    if (!['guide', 'stop'].includes(interruption.urgentDelivery)) errors.push('interruption.urgentDelivery must be guide|stop');
    if (!['stop', 'kill'].includes(interruption.hardStop)) errors.push('interruption.hardStop must be stop|kill');
    if (typeof interruption.cancelBackgroundTasks !== 'boolean') errors.push('interruption.cancelBackgroundTasks must be boolean');
  }

  // zcode
  const zcode = config.zcode;
  if (!isObject(zcode)) {
    errors.push('zcode must be an object');
  } else {
    checkKeys(zcode, ['cliPath', 'protocol', 'mode', 'locale', 'timezone', 'defaultModel', 'defaultReasoning', 'modelPolicy', 'maxRequestsPerMinute', 'maxConcurrentSessions', 'memberMcpServers', 'turnWatchIntervalMs', 'turnFailureRetry', 'redAutoReview'], 'zcode');
    if (typeof zcode.cliPath !== 'string' || !zcode.cliPath.trim()) errors.push('zcode.cliPath must be non-empty');
    if (!['app-server', 'cli'].includes(zcode.protocol)) errors.push('zcode.protocol must be app-server|cli');
    if (!['build', 'edit', 'plan', 'yolo', 'guarded'].includes(zcode.mode)) errors.push('zcode.mode is invalid');
    if (!LOCALE_VALUES.includes(zcode.locale)) {
      errors.push(`zcode.locale must be one of ${LOCALE_VALUES.join('|')}`);
    } else if (zcode.locale !== 'auto' && !normalizeLocale(zcode.locale)) {
      errors.push('zcode.locale is not a supported locale');
    }
    if (typeof zcode.timezone !== 'string') {
      errors.push('zcode.timezone must be a string');
    } else if (zcode.timezone !== 'auto' && !isValidTimeZone(zcode.timezone)) {
      errors.push('zcode.timezone must be auto or a valid IANA time zone');
    }
    if (zcode.defaultModel !== null && typeof zcode.defaultModel !== 'string') errors.push('zcode.defaultModel must be string or null');
    if (zcode.defaultReasoning !== null && typeof zcode.defaultReasoning !== 'string') errors.push('zcode.defaultReasoning must be string or null');
    if (!['follow-host', 'fixed'].includes(zcode.modelPolicy)) {
      errors.push('zcode.modelPolicy must be follow-host|fixed');
    }
    if (zcode.defaultReasoning && !zcode.defaultModel) warnings.push('zcode.defaultReasoning has no defaultModel; it will be ignored unless a member supplies model');
    const modelDefaults = Boolean(zcode.defaultModel || zcode.defaultReasoning);
    if (zcode.modelPolicy === 'follow-host' && zcode.protocol === 'cli' && !modelDefaults) {
      warnings.push('zcode.protocol=cli cannot hot-switch models; follow-host members keep the ZCode default until app-server is used');
    }
    if (zcode.modelPolicy === 'follow-host' && isObject(isolation) && isolation.mode === 'container') {
      warnings.push('isolation.mode=container cannot hot-switch models; follow-host only affects the session/create model and container setModel is unsupported');
    }
    if (zcode.modelPolicy === 'fixed' && !zcode.defaultModel) {
      warnings.push('zcode.modelPolicy=fixed has no defaultModel; members without an explicit model spawn with the ZCode default until agent_teams_model set pins one');
    }
    if (!isInt(zcode.maxRequestsPerMinute) || zcode.maxRequestsPerMinute < 0 || zcode.maxRequestsPerMinute > 1000) {
      errors.push('zcode.maxRequestsPerMinute must be 0..1000');
    }
    if (!isInt(zcode.maxConcurrentSessions) || zcode.maxConcurrentSessions < 1 || zcode.maxConcurrentSessions > 64) {
      errors.push('zcode.maxConcurrentSessions must be 1..64');
    }
    if (!['minimal'].includes(zcode.memberMcpServers)) {
      errors.push('zcode.memberMcpServers must be minimal; the full host MCP catalog is not supported for member sessions because it would inherit the admin discovery token');
    }
    if (!isInt(zcode.turnWatchIntervalMs) || zcode.turnWatchIntervalMs < 500 || zcode.turnWatchIntervalMs > 60000) {
      errors.push('zcode.turnWatchIntervalMs must be 500..60000');
    }
    if (!isObject(zcode.turnFailureRetry)) {
      errors.push('zcode.turnFailureRetry must be an object');
    } else {
      const retry = zcode.turnFailureRetry;
      checkKeys(retry, ['enabled', 'maxAttempts', 'capacityMaxAttempts', 'baseDelayMs', 'maxDelayMs', 'capacityRecoveryMs', 'capacityRecoverySuccesses'], 'zcode.turnFailureRetry');
      if (typeof retry.enabled !== 'boolean') errors.push('zcode.turnFailureRetry.enabled must be boolean');
      if (!isInt(retry.maxAttempts) || retry.maxAttempts < 0 || retry.maxAttempts > 10) {
        errors.push('zcode.turnFailureRetry.maxAttempts must be 0..10');
      }
      if (!isInt(retry.capacityMaxAttempts) || retry.capacityMaxAttempts < 0 || retry.capacityMaxAttempts > 100) {
        errors.push('zcode.turnFailureRetry.capacityMaxAttempts must be 0..100');
      }
      if (!isInt(retry.baseDelayMs) || retry.baseDelayMs < 0 || retry.baseDelayMs > 600000) {
        errors.push('zcode.turnFailureRetry.baseDelayMs must be 0..600000');
      }
      if (!isInt(retry.maxDelayMs) || retry.maxDelayMs < retry.baseDelayMs || retry.maxDelayMs > 3600000) {
        errors.push('zcode.turnFailureRetry.maxDelayMs must be >= baseDelayMs and <= 3600000');
      }
      if (!isInt(retry.capacityRecoveryMs) || retry.capacityRecoveryMs < 0 || retry.capacityRecoveryMs > 3600000) {
        errors.push('zcode.turnFailureRetry.capacityRecoveryMs must be 0..3600000');
      }
      if (!isInt(retry.capacityRecoverySuccesses) || retry.capacityRecoverySuccesses < 1 || retry.capacityRecoverySuccesses > 100) {
        errors.push('zcode.turnFailureRetry.capacityRecoverySuccesses must be 1..100');
      }
    }
    if (!isObject(zcode.redAutoReview)) {
      errors.push('zcode.redAutoReview must be an object');
    } else {
      const red = zcode.redAutoReview;
      checkKeys(red, ['enabled', 'maxContinues', 'retryDelayMs', 'maxAttempts'], 'zcode.redAutoReview');
      if (typeof red.enabled !== 'boolean') errors.push('zcode.redAutoReview.enabled must be boolean');
      if (!isInt(red.maxContinues) || red.maxContinues < 0 || red.maxContinues > 10) {
        errors.push('zcode.redAutoReview.maxContinues must be 0..10');
      }
      if (!isInt(red.retryDelayMs) || red.retryDelayMs < 0 || red.retryDelayMs > 600000) {
        errors.push('zcode.redAutoReview.retryDelayMs must be 0..600000');
      }
      if (!isInt(red.maxAttempts) || red.maxAttempts < 1 || red.maxAttempts > 50) {
        errors.push('zcode.redAutoReview.maxAttempts must be 1..50');
      }
    }
    if (isInt(zcode.maxConcurrentSessions) && isInt(scheduler?.activeWorkerSlots)
      && zcode.maxConcurrentSessions < scheduler.activeWorkerSlots) {
      errors.push('zcode.maxConcurrentSessions must be >= scheduler.activeWorkerSlots (it counts worker sessions)');
    }
    if (zcode.mode === 'yolo') warnings.push('zcode.mode=yolo disables interactive safety; require an explicit opt-in');
    if (zcode.protocol === 'cli' && (zcode.defaultModel || zcode.defaultReasoning)) {
      warnings.push('zcode.protocol=cli does not support model selection; daemon will use app-server when model defaults are set');
    }
  }

  // storage
  const storage = config.storage;
  if (!isObject(storage)) {
    errors.push('storage must be an object');
  } else {
    checkKeys(storage, ['database', 'archiveDays'], 'storage');
    if (typeof storage.database !== 'string' || !storage.database.trim()) errors.push('storage.database must be non-empty');
    if (!isInt(storage.archiveDays) || storage.archiveDays < 0) errors.push('storage.archiveDays must be >= 0');
  }

  // quality
  const quality = config.quality;
  if (!isObject(quality)) {
    errors.push('quality must be an object');
  } else {
    checkKeys(quality, ['kinds', 'requireIndependentReview', 'maxReviewRounds', 'verifyCommands', 'reviewPolicy', 'postMergeReview', 'mergeBranch'], 'quality');
    if (!['off', 'contractor'].includes(quality.postMergeReview)) {
      errors.push('quality.postMergeReview must be off|contractor');
    }
    if (typeof quality.mergeBranch !== 'string' || !quality.mergeBranch.trim()) {
      errors.push('quality.mergeBranch must be non-empty');
    } else if (Array.isArray(config.teams) && config.teams.some((team) => team?.baseBranch === quality.mergeBranch)) {
      errors.push('quality.mergeBranch must differ from every team baseBranch');
    }
    if (!Array.isArray(quality.kinds) || quality.kinds.length === 0) {
      errors.push('quality.kinds must be a non-empty array');
    } else {
      for (const kind of quality.kinds) if (!ALL_KINDS.includes(kind)) errors.push(`unknown quality kind: ${kind}`);
      if (new Set(quality.kinds).size !== quality.kinds.length) errors.push('quality.kinds must be unique');
    }
    if (typeof quality.requireIndependentReview !== 'boolean') errors.push('quality.requireIndependentReview must be boolean');
    if (!isInt(quality.maxReviewRounds) || quality.maxReviewRounds < 1) errors.push('quality.maxReviewRounds must be >= 1');
    if (!Array.isArray(quality.verifyCommands) || quality.verifyCommands.some((item) => typeof item !== 'string' || !item.trim())) {
      errors.push('quality.verifyCommands must be an array of non-empty strings');
    }
    const policy = quality.reviewPolicy;
    if (!isObject(policy)) {
      errors.push('quality.reviewPolicy must be an object');
    } else {
      checkKeys(policy, ['requirementsMinRounds', 'requirementsMaxRounds', 'codeMaxRounds', 'maxRepairAttempts', 'requiredReviewers'], 'quality.reviewPolicy');
      for (const key of ['requirementsMinRounds', 'requirementsMaxRounds', 'codeMaxRounds', 'maxRepairAttempts']) {
        if (!isInt(policy[key]) || policy[key] < 1) errors.push(`quality.reviewPolicy.${key} must be >= 1`);
      }
      if (isInt(policy.requirementsMinRounds) && isInt(policy.requirementsMaxRounds)
        && policy.requirementsMinRounds > policy.requirementsMaxRounds) {
        errors.push('requirementsMinRounds cannot exceed requirementsMaxRounds');
      }
      if (!Array.isArray(policy.requiredReviewers) || policy.requiredReviewers.some((item) => typeof item !== 'string' || !item.trim())) {
        errors.push('requiredReviewers must be an array of non-empty strings');
      } else if (new Set(policy.requiredReviewers).size !== policy.requiredReviewers.length) {
        errors.push('requiredReviewers must be unique');
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Throw if the config is invalid.
 * @param {unknown} config
 * @returns {{ config: any, warnings: string[] }}
 */
export function assertConfig(config) {
  const result = validateConfig(config);
  if (!result.ok) throw new Error(`invalid config:\n- ${result.errors.join('\n- ')}`);
  const resolved = applyDefaults(config);
  const locale = resolveLocale(resolved.zcode.locale);
  const timeZone = resolveTimeZone(resolved.zcode.timezone);
  resolved.zcode.locale = locale.locale;
  resolved.zcode.timezone = timeZone.timeZone;
  const warnings = [...result.warnings];
  for (const warning of [locale.warning, timeZone.warning]) {
    if (warning) warnings.push(warning);
  }
  return { config: resolved, warnings };
}
