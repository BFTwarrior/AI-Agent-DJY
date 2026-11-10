const EVENT_TYPE = 'migration.phase0_epochs.completed';

function withDefaults(record, keys) {
  const next = { ...record };
  let changed = false;
  for (const key of keys) {
    if (next[key] === undefined || next[key] === null) {
      next[key] = 0;
      changed = true;
    }
  }
  if ((next.leaseExpiresAt === undefined || next.leaseExpiresAt === null)
      && next.legacyLease !== true) {
    next.legacyLease = true;
    changed = true;
  }
  return { next, changed };
}

/**
 * Synchronously migrate epoch and legacy-lease markers in the existing Store.
 * Writes and the per-team completion event share one SQLite transaction.
 * @param {import('../store.mjs').Store} store
 * @returns {{teams: number, tasks: number, attempts: number, changed: boolean}}
 */
export function migratePhase0Epochs(store) {
  if (!store?.db || typeof store.transaction !== 'function'
      || typeof store.listTeams !== 'function' || typeof store.listTasks !== 'function'
      || typeof store.listAttempts !== 'function' || typeof store.listEvents !== 'function'
      || typeof store.addEvent !== 'function') {
    throw new TypeError('A SQLite Store instance is required');
  }

  return store.transaction(() => {
    let teams = 0;
    let tasks = 0;
    let attempts = 0;
    const touchedTeams = new Set();

    const write = (table, id, record, next) => {
      // Store.updateTask adds updatedAt, so write the exact JSON payload here to
      // keep every pre-existing field (especially merged task metadata) intact.
      store.db.prepare(`UPDATE ${table} SET data = ? WHERE id = ?`)
        .run(JSON.stringify(next), id);
      touchedTeams.add(record.teamId ?? record.id);
    };

    for (const team of store.listTeams(true)) {
      if (team.controlEpoch === undefined || team.controlEpoch === null) {
        const next = { ...team, controlEpoch: 0 };
        write('teams', team.id, team, next);
        teams += 1;
      }
    }
    for (const team of store.listTeams(true)) {
      for (const task of store.listTasks(team.id)) {
        const result = withDefaults(task, ['taskEpoch', 'controlEpoch']);
        if (result.changed) {
          write('tasks', task.id, task, result.next);
          tasks += 1;
        }
      }
      for (const attempt of store.listAttempts(team.id)) {
        const result = withDefaults(attempt, ['taskEpoch', 'controlEpoch']);
        if (result.changed) {
          write('attempts', attempt.id, attempt, result.next);
          attempts += 1;
        }
      }
    }

    const changed = teams + tasks + attempts > 0;
    if (changed) {
      for (const teamId of touchedTeams) {
        const alreadyRecorded = store.listEvents(teamId)
          .some((event) => event.type === EVENT_TYPE);
        if (!alreadyRecorded) store.addEvent(teamId, EVENT_TYPE, { phase: 0 });
      }
    }
    return { teams, tasks, attempts, changed };
  });
}
