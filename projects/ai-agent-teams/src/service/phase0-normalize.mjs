const REPAIR_MIGRATED = 'task.repair_migrated';
const MODE_INFERRED = 'task.mode_inferred';
const MODE_FORCED_LEGACY = 'task.mode_forced_legacy';
const MERGED_BINDING = 'task.merged_binding_normalized';

function listAll(store) {
  const teams = store.listTeams(true);
  return teams.map((team) => ({ team, tasks: store.listTasks(team.id) }));
}

function nextSeqMap(teams) {
  const map = new Map();
  for (const { tasks } of teams) {
    for (const task of tasks) {
      if (task?.deliveryUnitId && Number.isInteger(task.deliverySeq) && task.deliverySeq >= 0) {
        map.set(task.deliveryUnitId, Math.max(map.get(task.deliveryUnitId) ?? 0, task.deliverySeq));
      }
      const binding = task?.binding;
      if (binding?.deliveryUnitId && Number.isInteger(binding.deliverySeq) && binding.deliverySeq >= 0) {
        map.set(binding.deliveryUnitId, Math.max(map.get(binding.deliveryUnitId) ?? 0, binding.deliverySeq));
      }
    }
  }
  return map;
}

function changedFields(task, next) {
  return Object.entries(next).some(([key, value]) => (task[key] ?? null) !== (value ?? null));
}

/**
 * Classify historical repair rows before mode normalization.
 *
 * A repair is promoted to bound only when its parent review, binding commit,
 * unit root and worktreeBase all prove the same parent commit. Everything else
 * is conservatively classified as legacyRepair and left for a human; this
 * migration never guesses a unit or rewrites merged rows.
 *
 * @param {import('../store.mjs').Store} store
 * @param {{ useWorktrees?: boolean, candidateIds?: Set<string> }} [options]
 */
export function migrateLegacyRepairs(store, { useWorktrees = true, candidateIds } = {}) {
  if (!store?.db || typeof store.transaction !== 'function') throw new TypeError('A SQLite Store instance is required');
  const teams = listAll(store);
  const candidates = new Set();
  for (const { tasks } of teams) {
    for (const task of tasks) {
      if (task.kind !== 'repair' || task.repairOrigin || task.parentIntegrationId
        || (task.mergeState === 'merged' && task.mergeReverted !== true)
        || (task.mode === 'bound' && task.deliveryUnitId
          && Number.isInteger(task.deliverySeq) && task.deliverySeq > 0)
        || task.legacyRepair === true) continue;
      if (candidateIds && !candidateIds.has(task.id)) continue;
      candidates.add(task.id);
    }
  }
  const seqByUnit = nextSeqMap(teams);
  let migrated = 0;
  let legacy = 0;
  for (const { team, tasks } of teams) {
    const byId = new Map(tasks.map((task) => [task.id, task]));
    for (const task of tasks) {
      if (!candidates.has(task.id)) continue;
      const parent = task.parentReviewTaskId ? byId.get(task.parentReviewTaskId) : undefined;
      const bindingCommit = parent?.binding?.sourceCommit;
      const root = parent?.reviewedTaskId ? byId.get(parent.reviewedTaskId) : undefined;
      const unitId = root?.deliveryUnitId ?? root?.id;
      const canBind = Boolean(useWorktrees && parent?.kind === 'review' && bindingCommit && root && unitId
        && task.worktreeBase === bindingCommit);
      let next;
      if (canBind) {
        const seq = Number.isInteger(task.deliverySeq) && task.deliverySeq > 0
          ? task.deliverySeq : (seqByUnit.get(unitId) ?? 0) + 1;
        seqByUnit.set(unitId, Math.max(seqByUnit.get(unitId) ?? 0, seq));
        next = {
          mode: 'bound', modeSource: 'inferred', deliveryUnitId: unitId, deliverySeq: seq,
          deliveryGeneration: root.taskEpoch ?? 0,
          sourceBase: bindingCommit, legacyRepair: false, bindingUnavailable: false,
          repairOrigin: task.repairOrigin ?? 'planner',
          bindingState: task.sourceCommit ? 'ready' : (task.status === 'completed' ? 'pending_adopt' : 'pending_commit'),
        };
        migrated += 1;
      } else {
        next = {
          mode: 'legacy', legacyRepair: true, bindingUnavailable: true,
          bindingState: 'not_applicable', deliveryUnitId: undefined, deliverySeq: undefined,
        };
        legacy += 1;
      }
      if (!changedFields(task, next)) continue;
      store.updateTask(task.id, next);
      if (canBind && parent.deliveryGeneration === undefined) {
        // The promoted repair is only dispatchable while its parent review is
        // current; old bound reviews also predate the generation stamp.
        store.updateTask(parent.id, { deliveryGeneration: root.taskEpoch ?? 0 });
      }
      store.addEvent(team.id, REPAIR_MIGRATED, { taskId: task.id, mode: next.mode, legacyRepair: next.legacyRepair });
    }
  }
  return { candidates: candidates.size, migrated, legacy, changed: migrated + legacy > 0 };
}

/**
 * Normalize task mode/binding fields for tasks that predate V15. Merged rows
 * are terminal: only bindingState is filled. Worktree-disabled deployments do
 * not persist a guessed mode.
 *
 * @param {import('../store.mjs').Store} store
 * @param {{ useWorktrees?: boolean }} [options]
 */
export function normalizeTaskModes(store, { useWorktrees = true } = {}) {
  if (!store?.db || typeof store.transaction !== 'function') throw new TypeError('A SQLite Store instance is required');
  let changed = 0;
  for (const { team, tasks } of listAll(store)) {
    for (const task of tasks) {
      const kind = task.kind ?? 'work';
      const deliverable = ['implementation', 'repair'].includes(kind);
      const mergeable = ['implementation', 'repair', 'integration'].includes(kind);
      const reviewish = ['review', 'verification'].includes(kind);
      if (task.mergeState === 'merged' && task.mergeReverted !== true) {
        if (task.bindingState !== 'merged') {
          store.updateTask(task.id, { bindingState: 'merged' });
          store.addEvent(team.id, MERGED_BINDING, { taskId: task.id });
          changed += 1;
        }
        continue;
      }
      if (kind === 'repair' && task.parentIntegrationId) {
        const next = { mode: 'legacy', bindingUnavailable: true, bindingState: 'not_applicable',
          deliveryUnitId: undefined, deliverySeq: undefined };
        if (!changedFields(task, next)) continue;
        store.updateTask(task.id, next);
        store.addEvent(team.id, MODE_FORCED_LEGACY, { taskId: task.id, mode: 'legacy' });
        changed += 1;
        continue;
      }
      if (kind === 'repair' && (!task.repairOrigin || task.repairOrigin === 'manual')
        && !task.parentReviewTaskId) {
        const historical = task.legacyRepair === true || task.historical === true || task.legacyUnbound === true;
        const next = {
          mode: 'legacy', legacyUnbound: historical, bindingUnavailable: true,
          bindingState: 'not_applicable', deliveryUnitId: undefined, deliverySeq: undefined,
          ...(historical ? { legacyRepair: true } : { legacyRepair: false,
            repairOrigin: task.repairOrigin ?? ((!task.sourceBase && !task.worktreeBase && !task.sourceCommit)
              ? 'manual' : 'planner') }),
        };
        if (!changedFields(task, next)) continue;
        store.updateTask(task.id, next);
        store.addEvent(team.id, MODE_FORCED_LEGACY, { taskId: task.id, mode: 'legacy' });
        changed += 1;
        continue;
      }
      if (!useWorktrees && !task.mode) {
        if (task.bindingUnavailable !== true) {
          store.updateTask(task.id, { bindingUnavailable: true });
          changed += 1;
        }
        continue;
      }
      let mode = task.mode;
      let inferred = false;
      let forcedLegacy = false;
      if (!mode) {
        mode = task.worktree && (mergeable || kind === 'work') ? 'bound' : 'legacy';
        inferred = true;
      }
      if (reviewish && mode !== 'legacy') {
        mode = 'legacy';
        inferred = true;
        forcedLegacy = true;
      }
      const validRepairUnit = kind !== 'repair'
        || (task.deliveryUnitId && Number.isInteger(task.deliverySeq) && task.deliverySeq > 0);
      const adoptBlocked = task.mergeState === 'blocked'
        && ['adopt_exhausted', 'untracked_artifacts', 'sensitive_artifacts', 'not_descendant',
          'no_worktree', 'no_base', 'gc_pin_expired', 'already_merged_manually'].includes(task.mergeBlockReason);
      const bindingState = deliverable
        ? (mode === 'bound' && validRepairUnit
          ? (task.sourceCommit ? 'ready'
            : (task.status === 'completed'
              ? (task.legacyAdoptAttemptedAt || adoptBlocked ? 'blocked' : 'pending_adopt')
              : 'pending_commit'))
          : (mode === 'bound' ? 'blocked' : 'not_applicable'))
        : 'not_applicable';
      const next = {
        mode,
        modeSource: task.modeSource ?? (inferred ? 'inferred' : undefined),
        bindingState,
        bindingUnavailable: mode === 'legacy',
        deliveryUnitId: kind === 'implementation' && mode === 'bound' ? task.id : task.deliveryUnitId,
        deliverySeq: kind === 'implementation' && mode === 'bound' ? 0 : task.deliverySeq,
        needsCaptain: kind === 'repair' && mode === 'bound' ? !validRepairUnit : task.needsCaptain,
      };
      if (kind === 'repair' && mode === 'bound' && !validRepairUnit) {
        // A half-bound repair must not become a dispatchable bound task.
        next.deliveryUnitId = undefined;
        next.deliverySeq = undefined;
        next.bindingState = 'blocked';
      }
      if (!changedFields(task, next)) continue;
      store.updateTask(task.id, next);
      store.addEvent(team.id, forcedLegacy ? MODE_FORCED_LEGACY : MODE_INFERRED, {
        taskId: task.id, mode, bindingState,
      });
      changed += 1;
    }
  }
  return { changed };
}

/**
 * Quarantine historical legacy repairs that cannot prove a trusted parent.
 * New planner repairs use legacyRepair=false and are not touched.
 *
 * @param {import('../store.mjs').Store} store
 */
export function quarantineLegacy(store, { now = Date.now() } = {}) {
  if (!store?.db || typeof store.transaction !== 'function') throw new TypeError('A SQLite Store instance is required');
  let quarantined = 0;
  for (const { team, tasks } of listAll(store)) {
    for (const task of tasks) {
      if (task.kind !== 'repair' || task.legacyRepair !== true
        || (task.mergeState === 'merged' && task.mergeReverted !== true)
        || task.hold?.class === 'legacy_repair_manual') continue;
      const quarantinedAt = Number.isFinite(task.quarantinedAt) && task.quarantinedAt > 0
        ? task.quarantinedAt : now;
      // Close any live attempt as well: a quarantined row must not keep a
      // member session writing into its worktree while waiting for a human.
      for (const attempt of store.listAttempts(team.id)) {
        if (attempt.taskId !== task.id || ['completed', 'failed', 'cancelled', 'orphaned', 'halted'].includes(attempt.status)) continue;
        store.updateAttempt(attempt.id, { status: 'orphaned', endedAt: quarantinedAt, error: 'legacy_repair_manual' });
      }
      const closeStatus = ['completed', 'pending', 'claimed', 'in_progress'].includes(task.status)
        ? 'cancelled' : task.status;
      store.updateTask(task.id, {
        mergeState: 'blocked', mergeBlockReason: 'legacy_repair_manual',
        hold: { class: 'legacy_repair_manual', reason: 'legacy_repair_manual' },
        needsCaptain: true,
        // Closing the row is part of quarantine: an active or completed row
        // with a worktree otherwise keeps settlementBlockers (and re-licensing)
        // blocked forever even though the row is excluded from delivery audit.
        status: closeStatus,
        ...(closeStatus === 'cancelled' ? { cancelledAt: quarantinedAt, cancelReason: 'legacy_repair_manual' } : {}),
        // deliveryAudit excludes rows that carry a quarantine receipt; without
        // this stamp the exclusion condition could never become true.
        quarantinedAt,
        historical: true,
      });
      store.addEvent(team.id, 'task.legacy_quarantined', { taskId: task.id, quarantinedAt });
      quarantined += 1;
    }
  }
  return { quarantined };
}
