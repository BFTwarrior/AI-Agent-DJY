/**
 * Task-worktree reclaimer.
 *
 * A task checkout is reclaimed only after its task is terminal, its delivery
 * artifact is safe outside the checkout (or its kind never creates a commit),
 * its retention TTL has elapsed, and git reports it clean. Merge failures and
 * unknown merge states are retained for human diagnosis. The worktree-count
 * ceiling is advisory: pressure is reported, never used to bypass those safety
 * conditions or the configured TTL.
 *
 * Orphan worktrees are swept only when explicitly requested and backed by a
 * durable store. Every candidate is isolated so a store or filesystem error
 * cannot abort the daemon tick or hide later cleanup results.
 */

import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { listWorktrees, removeWorktree } from './worktree.mjs';

const execFileAsync = promisify(execFile);
const HOUR = 60 * 60 * 1000;
const DEFAULT_TTL_HOURS = 24;
const DEFAULT_MAX_ACTIVE = 6;
const NO_COMMIT_KINDS = new Set(['review', 'verification', 'requirements', 'red-auto-review']);

/**
 * Classify whether the task's checkout is safe to reclaim.
 *
 * @param {any} task
 * @param {number} now epoch milliseconds from the service clock
 * @param {number} ttlMs
 * @returns {{ reclaimable: boolean, reason: string }}
 */
export function classifyTaskWorktree(task, now, ttlMs = DEFAULT_TTL_HOURS * HOUR) {
  if (!(task?.worktree ?? task?.reviewWorktree)) return { reclaimable: false, reason: 'no_worktree' };
  if (task.attemptId) return { reclaimable: false, reason: 'attempt_open' };
  if (task.cleanupPending === true) return { reclaimable: false, reason: 'cleanup_pending' };
  if (!['completed', 'cancelled', 'failed'].includes(task.status)) {
    return { reclaimable: false, reason: 'still_needed' };
  }

  // Diagnostic and non-terminal merge states stay available even when a task
  // is cancelled or failed. Only the explicitly known pending state is safe to
  // age out for terminal tasks; unknown states fail closed.
  if (task.mergeState === 'blocked') return { reclaimable: false, reason: 'merge_blocked' };
  if (task.mergeState === 'merged') {
    const mergedAt = task.mergedAt ?? task.reviewedAt ?? task.completedAt ?? task.updatedAt ?? 0;
    if (now - mergedAt < ttlMs) return { reclaimable: false, reason: 'within_ttl' };
    return { reclaimable: true, reason: 'merged' };
  }
  if (task.mergeState !== undefined && task.mergeState !== null
      && task.mergeState !== 'not_applicable' && task.mergeState !== 'pending') {
    return { reclaimable: false, reason: 'still_needed' };
  }
  if (task.status === 'cancelled' || task.status === 'failed') {
    const endedAt = task.cancelledAt ?? task.failedAt ?? task.completedAt ?? task.updatedAt ?? 0;
    if (now - endedAt < ttlMs) return { reclaimable: false, reason: 'within_ttl' };
    return { reclaimable: true, reason: task.status };
  }
  if (task.mergeState === 'pending') return { reclaimable: false, reason: 'still_needed' };
  if (task.status === 'completed') {
    const hasArtifact = Boolean(task.sourceCommit) || NO_COMMIT_KINDS.has(task.kind);
    if (!hasArtifact) return { reclaimable: false, reason: 'still_needed' };
    const doneAt = task.completedAt ?? task.updatedAt ?? 0;
    if (now - doneAt < ttlMs) return { reclaimable: false, reason: 'within_ttl' };
    return { reclaimable: true, reason: task.kind ? `${task.kind}_completed` : 'completed' };
  }
  return { reclaimable: false, reason: 'still_needed' };
}

/**
 * @param {string} path
 * @returns {Promise<boolean>} true when the checkout has local changes
 */
export async function worktreeIsDirty(path) {
  if (!existsSync(path)) return false;
  try {
    const result = await execFileAsync('git', ['-c', 'core.quotePath=false', 'status', '--porcelain=v1', '-uall'], {
      cwd: path,
      maxBuffer: 32 * 1024 * 1024,
    });
    return String(result.stdout ?? '').trim().length > 0;
  } catch {
    // Broken git metadata is not evidence of a clean worktree.
    return true;
  }
}

function directoryAgeMs(path) {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/** Normalize absolute/relative paths the same way on both Git and the OS side. */
function normalizePath(path, base) {
  const absolute = resolve(base, String(path));
  let normalized = absolute;
  try {
    normalized = realpathSync.native(absolute);
  } catch {
    // A missing path cannot be safely matched as a registered worktree.
  }
  normalized = normalized.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

const RECLAIM_GENERATION_FIELDS = [
  'attemptId', 'lastAttemptId', 'attempt', 'taskEpoch', 'controlEpoch', 'deliveryGeneration', 'epoch',
];
const WORKTREE_FIELDS = ['worktree', 'reviewWorktree'];

/**
 * Canonical key for a task worktree reference. Both the snapshot and the
 * current row go through this function, so a realpath failure (a path that no
 * longer exists) degrades identically on both sides instead of comparing a
 * realpath against a raw path and mistaking a match for a stale decision.
 */
function taskReferenceKey(task, field, cwd) {
  const path = task?.[field];
  return path ? normalizePath(resolve(cwd, String(path)), cwd) : undefined;
}

function collectReferences(store, cwd) {
  const referenced = new Map();
  for (const team of store.listTeams(true)) {
    for (const task of store.listTasks(team.id)) {
      for (const field of WORKTREE_FIELDS) {
        const key = taskReferenceKey(task, field, cwd);
        if (!key) continue;
        const path = resolve(cwd, String(task[field]));
        if (!referenced.has(key)) referenced.set(key, { key, path, refs: [], tasks: [] });
        const entry = referenced.get(key);
        entry.refs.push({ task, field, teamControlEpoch: team.controlEpoch });
        if (!entry.tasks.some((item) => item.id === task.id)) entry.tasks.push(task);
      }
    }
  }
  return referenced;
}

function taskReferenceIsReclaimable(task, field, now, ttlMs) {
  return classifyTaskWorktree({ ...task, worktree: task[field], reviewWorktree: undefined }, now, ttlMs).reclaimable;
}

function sameTaskGeneration(snapshot, current) {
  return RECLAIM_GENERATION_FIELDS.every((field) => snapshot[field] === current[field]);
}

function retainCurrentTaskPaths(store, taskId, cwd, retained) {
  const current = store.getTask(taskId);
  if (!current) return;
  for (const field of WORKTREE_FIELDS) {
    const key = taskReferenceKey(current, field, cwd);
    const path = current[field] ? resolve(cwd, String(current[field])) : undefined;
    if (key && path && existsSync(path)) retained.add(key);
  }
}

function clearTaskReferencesIfCurrent({ store, task, fields, teamId, teamControlEpoch, cwd, now, ttlMs }) {
  const update = () => {
    const current = store.getTask(task.id);
    if (!current) return { stale: true };
    // Compare canonical keys, the same identity `collectReferences` grouped by,
    // so a symlinked alias of one directory cannot be mistaken for a new path.
    // `taskReferenceKey` is re-evaluated on both sides here, so a path that no
    // longer exists falls back to the same raw normalization on both.
    const snapshotKeys = new Set(fields.map((field) => taskReferenceKey(task, field, cwd)));
    snapshotKeys.delete(undefined);
    const matchingFields = WORKTREE_FIELDS.filter((field) => {
      const key = taskReferenceKey(current, field, cwd);
      return key !== undefined && snapshotKeys.has(key);
    });
    if (matchingFields.length === 0) return { stale: true };

    const currentIsReclaimable = matchingFields.every((field) => (
      taskReferenceIsReclaimable(current, field, now, ttlMs)
    ));
    const generationMatches = sameTaskGeneration(task, current);
    const currentTeam = store.getTeam?.(teamId);
    const teamEpochMatches = !currentTeam || currentTeam.controlEpoch === teamControlEpoch;
    const stateMatches = task.status === current.status
      && task.mergeState === current.mergeState
      && current.mergeState !== 'blocked'
      && task.cleanupPending === current.cleanupPending
      && current.cleanupPending !== true
      && teamEpochMatches;
    if (!currentIsReclaimable || !generationMatches || !stateMatches) {
      // The directory is gone. Remove only still-matching references to that
      // deleted path; any path installed by the newer task generation is untouched.
      try {
        store.updateTask(task.id, Object.fromEntries(matchingFields.map((field) => [field, undefined])));
        return { stale: true, clearedOldReference: true };
      } catch (error) {
        return { stale: true, updateError: error };
      }
    }

    store.updateTask(task.id, Object.fromEntries(matchingFields.map((field) => [field, undefined])));
    return { cleared: true };
  };

  // Store.transaction() is the repository's atomic compare-and-update boundary.
  // Test doubles may omit it, so retain their synchronous behavior as a fallback.
  return typeof store.transaction === 'function' ? store.transaction(update) : update();
}

/**
 * Reclaim terminal task worktrees and unreferenced leftovers.
 *
 * `pinnedOverCapacity` (global) and `pinnedOverGlobalCeiling` (per team) both
 * measure the same thing: how many pinned directories exceed the *global*
 * `maxActive` ceiling. Per-team entries do not describe a team quota; the
 * project has no per-team worktree ceiling, so the name says "global".
 *
 * @param {{ repo: string, cwd: string, store: any, now?: number, ttlHours?: number,
 *   maxActive?: number, allowOrphanSweep?: boolean, logger?: (line: string) => void }} input
 * @returns {Promise<{ removed: string[], skipped: Array<{path: string, reason: string}>,
 *   errors: Array<{path: string, stage?: string, error: string}>, active: number,
 *   remaining: number, freedDirs: number, overCapacity: boolean,
 *   pinned: number, protected: number, pinnedOverCapacity: number,
 *   byTeam: Record<string, {removedDirs: number, removedTasks: number,
 *     skippedDirs: number, skippedTasks: number, errors: number,
 *     pinned: number, protected: number, active: number, remaining: number,
 *     pinnedOverGlobalCeiling: number}> }>} `now` is the
 *   task/service epoch clock; filesystem TTLs use wall-clock mtimes independently.
 */
export async function reclaimWorktrees({
  repo,
  cwd,
  store,
  now = Date.now(),
  ttlHours = DEFAULT_TTL_HOURS,
  maxActive = DEFAULT_MAX_ACTIVE,
  allowOrphanSweep = false,
  logger,
} = {}) {
  const report = {
    removed: [], skipped: [], errors: [], active: 0, pinned: 0, protected: 0, remaining: 0, freedDirs: 0,
    overCapacity: false, pinnedOverCapacity: 0, byTeam: {},
  };
  if (!repo || !cwd || !store) return report;

  const storeIsDurable = store.persistent === true;
  const orphanSweep = allowOrphanSweep === true && storeIsDurable;
  if (allowOrphanSweep === true && !storeIsDurable) report.orphanSweepBlocked = 'in_memory_store';
  const numericTtl = Number(ttlHours);
  const ttlMs = (Number.isFinite(numericTtl) && numericTtl >= 0 ? numericTtl : DEFAULT_TTL_HOURS) * HOUR;
  const taskNow = Number.isFinite(now) ? now : Date.now();
  const numericMax = Number(maxActive);
  const ceiling = Number.isFinite(numericMax) && numericMax > 0
    ? Math.floor(numericMax) : DEFAULT_MAX_ACTIVE;

  const bucket = (teamId) => {
    if (!teamId) return null;
    report.byTeam[teamId] ??= {
      removedDirs: 0, removedTasks: 0, skippedDirs: 0, skippedTasks: 0, errors: 0,
      pinned: 0, protected: 0, active: 0, remaining: 0, pinnedOverGlobalCeiling: 0,
    };
    return report.byTeam[teamId];
  };
  const noteDirectory = (tasks, field) => {
    for (const teamId of new Set(tasks.map((task) => task.teamId).filter(Boolean))) {
      bucket(teamId)[field] += 1;
    }
  };

  let referenced;
  try {
    referenced = collectReferences(store, cwd);
  } catch (error) {
    report.errors.push({ path: '', stage: 'store_read', error: errorMessage(error) });
    return report;
  }

  const existingEntries = [...referenced.values()].filter(({ path }) => existsSync(path));
  const retainedByCleanup = new Set();
  const candidates = [];
  for (const entry of existingEntries) {
    const verdicts = entry.refs.map(({ task, field }) => (
      taskReferenceIsReclaimable(task, field, taskNow, ttlMs)
    ));
    if (verdicts.every((verdict) => verdict)) candidates.push(entry);
  }

  // TTL and task safety always outrank capacity. Only after expired, clean
  // candidates are removed may this pass reduce the remaining count to ceiling;
  // if too many checkouts are pinned, report the unmet limit rather than delete.
  // Oldest first. An unreadable mtime (`null`) sorts as infinitely old; the
  // comparator is total, so it never returns NaN (which made removal order
  // engine-dependent) even when two entries are both unreadable.
  const ageOf = (entry) => directoryAgeMs(entry.path) ?? Number.POSITIVE_INFINITY;
  candidates.sort((left, right) => {
    const leftAge = ageOf(left);
    const rightAge = ageOf(right);
    if (leftAge === rightAge) return 0;
    return rightAge > leftAge ? 1 : -1;
  });
  // TTL expiry is an explicit retention decision; reclaim every safe expired
  // candidate. The capacity ceiling never suppresses TTL cleanup and never
  // authorizes deleting an unexpired/pinned checkout.
  for (const entry of candidates) {
    const { path, tasks } = entry;
    if (!existsSync(path)) {
      for (const task of tasks) {
        try {
          const reference = entry.refs.find((ref) => ref.task.id === task.id);
          const result = clearTaskReferencesIfCurrent({
            store, task, fields: entry.refs.filter((ref) => ref.task.id === task.id).map((ref) => ref.field),
            teamId: task.teamId, teamControlEpoch: reference?.teamControlEpoch,
            cwd, now: taskNow, ttlMs,
          });
          if (result.updateError) {
            report.errors.push({ path, stage: 'store_update_missing', error: errorMessage(result.updateError) });
            const team = bucket(task.teamId);
            if (team) team.errors += 1;
          }
          if (result.stale) {
            report.errors.push({ path, stage: 'stale_decision', error: 'task changed after reclaim scan' });
            const team = bucket(task.teamId);
            if (team) team.errors += 1;
          }
        } catch (error) {
          report.errors.push({ path, stage: 'store_update_missing', error: errorMessage(error) });
          const team = bucket(task.teamId);
          if (team) team.errors += 1;
        }
      }
      continue;
    }
    let dirty;
    try {
      dirty = await worktreeIsDirty(path);
    } catch {
      dirty = true;
    }
    if (dirty) {
      retainedByCleanup.add(entry.key);
      report.skipped.push({ path, reason: 'dirty' });
      noteDirectory(tasks, 'skippedDirs');
      for (const task of tasks) {
        const team = bucket(task.teamId);
        if (team) team.skippedTasks += 1;
        try {
          store.addEvent(task.teamId, 'task.worktree_reclaim_skipped', {
            taskId: task.id, path, reason: 'uncommitted changes',
          });
        } catch (error) {
          report.errors.push({ path, stage: 'skip_event', error: errorMessage(error) });
          if (team) team.errors += 1;
        }
      }
      continue;
    }
    try {
      await removeWorktree({ repo, path, force: false });
    } catch (error) {
      retainedByCleanup.add(entry.key);
      report.errors.push({ path, stage: 'remove', error: errorMessage(error) });
      noteDirectory(tasks, 'errors');
      continue;
    }

    // Record deletion before database writes: a store failure cannot turn a
    // successful filesystem removal into a false failure report.
    report.removed.push(path);
    report.freedDirs += 1;
    noteDirectory(tasks, 'removedDirs');
    for (const task of tasks) {
      const team = bucket(task.teamId);
      try {
        const reference = entry.refs.find((ref) => ref.task.id === task.id);
        const result = clearTaskReferencesIfCurrent({
          store, task, fields: entry.refs.filter((ref) => ref.task.id === task.id).map((ref) => ref.field),
          teamId: task.teamId, teamControlEpoch: reference?.teamControlEpoch,
          cwd, now: taskNow,
        });
        if (result.cleared || result.clearedOldReference) {
          if (team) team.removedTasks += 1;
          store.addEvent(task.teamId, 'task.worktree_reclaimed', { taskId: task.id, path });
        }
        if (result.updateError) {
          report.errors.push({ path, stage: 'store_update', error: errorMessage(result.updateError) });
          if (team) team.errors += 1;
        }
        if (result.stale) {
          report.errors.push({ path, stage: 'stale_decision', error: 'task changed after reclaim scan' });
          if (team) team.errors += 1;
          retainCurrentTaskPaths(store, task.id, cwd, retainedByCleanup);
        }
      } catch (error) {
        report.errors.push({ path, stage: 'store_update', error: errorMessage(error) });
        if (team) team.errors += 1;
      }
    }
  }

  // Refresh the reference snapshot so concurrent redispatches are reflected in
  // the report and cannot make a newly referenced checkout look orphaned.
  try {
    referenced = collectReferences(store, cwd);
  } catch (error) {
    report.errors.push({ path: '', stage: 'store_read', error: errorMessage(error) });
  }

  // The ceiling is advisory. Recompute against surviving real directories after
  // removals, rather than reporting the pre-cleanup snapshot. `remaining` counts
  // task-referenced directories still on disk; `active` is the protected or
  // unsuccessfully reclaimed subset, not unreferenced orphan directories.
  const survivingEntries = [...referenced.values()].filter(({ path }) => existsSync(path));
  report.remaining = survivingEntries.length;
  const protectedRemaining = survivingEntries.filter((entry) => (
    entry.refs.some(({ task, field }) => !taskReferenceIsReclaimable(task, field, taskNow, ttlMs))
  )).length;
  report.active = survivingEntries.filter((entry) => (
    retainedByCleanup.has(entry.key) || entry.refs.some(({ task, field }) => (
      !taskReferenceIsReclaimable(task, field, taskNow, ttlMs)
    ))
  )).length;
  report.pinned = protectedRemaining;
  report.protected = survivingEntries.reduce((count, entry) => count + entry.refs.filter(({ task, field }) => (
    !taskReferenceIsReclaimable(task, field, taskNow, ttlMs)
  )).length, 0);
  for (const entry of survivingEntries) {
    const refsByTeam = new Map();
    for (const ref of entry.refs) {
      if (!ref.task.teamId) continue;
      if (!refsByTeam.has(ref.task.teamId)) refsByTeam.set(ref.task.teamId, []);
      refsByTeam.get(ref.task.teamId).push(ref);
    }
    for (const [teamId, refs] of refsByTeam) {
      const team = bucket(teamId);
      const protectedRefs = refs.filter(({ task, field }) => (
        !taskReferenceIsReclaimable(task, field, taskNow, ttlMs)
      )).length;
      team.remaining += 1;
      team.protected += protectedRefs;
      if (protectedRefs > 0) team.pinned += 1;
      if (retainedByCleanup.has(entry.key) || protectedRefs > 0) team.active += 1;
    }
  }
  report.overCapacity = report.remaining > ceiling;
  // Only protected directories are counted here; a reclaimable directory that
  // failed removal belongs in `active`/`errors`, not in the pinned diagnosis.
  report.pinnedOverCapacity = Math.max(0, protectedRemaining - ceiling);
  const teamPinnedTotal = new Map();
  for (const entry of survivingEntries) {
    if (!entry.refs.some(({ task, field }) => !taskReferenceIsReclaimable(task, field, taskNow, ttlMs))) continue;
    for (const teamId of new Set(entry.refs.map(({ task }) => task.teamId).filter(Boolean))) {
      teamPinnedTotal.set(teamId, (teamPinnedTotal.get(teamId) ?? 0) + 1);
    }
  }
  // Per-team attempt at the same *global* limit: how many of this team's pinned
  // directories are above `maxActive`. This is not a team quota (there is none);
  // the name states the denominator so an operator cannot read it as one.
  for (const [teamId, pinned] of teamPinnedTotal) {
    bucket(teamId).pinnedOverGlobalCeiling = Math.max(0, pinned - ceiling);
  }

  const root = join(cwd, '.agent-teams-worktrees');
  if (orphanSweep && existsSync(root)) {
    let registered = new Set();
    try {
      registered = new Set((await listWorktrees(repo)).map((entry) => normalizePath(entry.path, cwd)));
    } catch (error) {
      report.errors.push({ path: root, stage: 'list_worktrees', error: errorMessage(error) });
    }
    let teamsOnDisk = [];
    try {
      teamsOnDisk = readdirSync(root, { withFileTypes: true });
    } catch (error) {
      report.errors.push({ path: root, stage: 'read_orphan_root', error: errorMessage(error) });
    }
    for (const teamEntry of teamsOnDisk) {
      if (!teamEntry.isDirectory()) continue;
      const teamDir = join(root, teamEntry.name);
      let entries = [];
      try {
        entries = readdirSync(teamDir, { withFileTypes: true });
      } catch (error) {
        report.errors.push({ path: teamDir, stage: 'read_orphan_team', error: errorMessage(error) });
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const path = join(teamDir, entry.name);
        const key = normalizePath(path, cwd);
        if (referenced.has(key)) continue;
        const ageMs = directoryAgeMs(path);
        if (ageMs === null || ageMs < ttlMs) continue;
        // Unregistered folders are never assumed to be clean Git worktrees.
        if (!registered.has(key)) {
          report.skipped.push({ path, reason: 'unregistered' });
          continue;
        }
        if (await worktreeIsDirty(path)) {
          report.skipped.push({ path, reason: 'dirty_orphan' });
          continue;
        }
        try {
          await removeWorktree({ repo, path, force: false });
          report.removed.push(path);
          report.freedDirs += 1;
          const teamId = teamEntry.name;
          const team = bucket(teamId);
          if (team) team.removedDirs += 1;
        } catch (error) {
          report.errors.push({ path, stage: 'remove_orphan', error: errorMessage(error) });
          const team = bucket(teamEntry.name);
          if (team) team.errors += 1;
        }
      }
    }
    await execFileAsync('git', ['worktree', 'prune'], { cwd: repo }).catch((error) => {
      report.errors.push({ path: repo, stage: 'worktree_prune', error: errorMessage(error) });
    });
  }

  try {
    logger?.(`worktree reclaim: removed=${report.removed.length} skipped=${report.skipped.length} active=${report.active} remaining=${report.remaining} pinnedOverCapacity=${report.pinnedOverCapacity} errors=${report.errors.length}`);
  } catch { /* logging must not abort the sweep */ }
  return report;
}

export { DEFAULT_MAX_ACTIVE, DEFAULT_TTL_HOURS };
 