import { randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { restrictWindowsAcl } from './fs-permissions.mjs';

const DB_DIRECTORY_MODE = 0o700;
const DB_FILE_MODE = 0o600;

// chmod on Windows only toggles the read-only flag (and may fail on exotic
// filesystems); private permissions are a POSIX hardening step, so a failure
// must never stop the daemon from opening its database.
function chmodPrivate(path) {
  try {
    chmodSync(path, DB_FILE_MODE);
  } catch {
    // Best effort only.
  }
}

function chmodDirectoryPrivate(path) {
  try {
    chmodSync(path, DB_DIRECTORY_MODE);
  } catch {
    // Best effort only.
  }
}

function prepareWindowsDatabasePaths(path) {
  if (process.platform !== 'win32') return;
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      writeFileSync(file, Buffer.alloc(0), { flag: 'wx', mode: DB_FILE_MODE });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    const info = lstatSync(file);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`refusing non-regular database file: ${file}`);
    }
    restrictWindowsAcl(file);
  }
}

function eventFromRow(row) {
  return {
    id: row.id,
    type: row.type,
    createdAt: row.created_at,
    ...JSON.parse(row.data),
  };
}

/**
 * SQLite-backed team state. The daemon is the only writer.
 * Rows keep an indexed team/status column plus a JSON data column so the
 * prototype can evolve without a migration per field.
 */
export class Store {
  constructor(path = ':memory:') {
    if (path !== ':memory:') {
      const resolvedPath = resolve(path);
      const directory = dirname(resolvedPath);
      mkdirSync(directory, { recursive: true, mode: DB_DIRECTORY_MODE });
      if (process.platform === 'win32') {
        if (directory !== resolve(process.cwd())) restrictWindowsAcl(directory, { directory: true });
        prepareWindowsDatabasePaths(resolvedPath);
      }
    }
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout = 5000');
    if (path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL');
    // Recorded so callers can tell a throwaway test database from real workspace
    // state. The worktree reclaimer refuses to sweep orphan directories when the
    // store is in-memory: a test harness builds a service with
    // `new Store(':memory:')` and `cwd: process.cwd()`, and an unscoped orphan
    // sweep there would delete the operator's real checkouts.
    this.path = path;
    this.persistent = path !== ':memory:';
    this.listeners = new Set();
    this.txEvents = null;
    this.inTransaction = false;
    this.migrate();
    if (path !== ':memory:') {
      this.restrictFilePermissions(path);
      if (process.platform === 'win32') prepareWindowsDatabasePaths(resolve(path));
    }
  }

  /**
   * Best-effort 0700 on the database directory and 0600 on the database and
   * its WAL sidecars. Runs after migrate() so the files SQLite creates while
   * opening the database are covered too. The directory chmod also tightens a
   * directory created by an older version or an external tool.
   * @param {string} path
   */
  restrictFilePermissions(path) {
    const resolvedPath = resolve(path);
    const directory = dirname(resolvedPath);
    // A database placed directly in a shared workspace would otherwise chmod
    // the whole checkout to 0700. Only tighten a dedicated data directory.
    if (directory !== resolve(process.cwd())) chmodDirectoryPrivate(directory);
    chmodPrivate(resolvedPath);
    chmodPrivate(`${resolvedPath}-wal`);
    chmodPrivate(`${resolvedPath}-shm`);
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS teams (
        id TEXT PRIMARY KEY,
        phase TEXT NOT NULL,
        control TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        archived_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS members (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        status TEXT NOT NULL,
        assignee TEXT,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS attempts (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        to_agent TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        team_id TEXT NOT NULL,
        type TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS usage (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS plans (
        team_id TEXT PRIMARY KEY,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS licenses (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        status TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS license_history (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS contractors (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        slot TEXT,
        status TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS summaries (
        member_id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS findings (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        status TEXT NOT NULL,
        member_id TEXT,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS merge_reviews (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        status TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS member_tokens (
        member_id TEXT PRIMARY KEY,
        token TEXT NOT NULL UNIQUE
      );
      CREATE INDEX IF NOT EXISTS idx_members_team ON members(team_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_team_status ON tasks(team_id, status);
      CREATE INDEX IF NOT EXISTS idx_attempts_team ON attempts(team_id);
      CREATE INDEX IF NOT EXISTS idx_messages_team_to ON messages(team_id, to_agent);
      CREATE INDEX IF NOT EXISTS idx_events_team ON events(team_id, id);
      CREATE INDEX IF NOT EXISTS idx_usage_team ON usage(team_id);
      CREATE INDEX IF NOT EXISTS idx_licenses_team_member ON licenses(team_id, member_id);
      CREATE INDEX IF NOT EXISTS idx_license_history_member ON license_history(member_id);
      CREATE INDEX IF NOT EXISTS idx_contractors_team_status ON contractors(team_id, status);
      CREATE INDEX IF NOT EXISTS idx_findings_team_status ON findings(team_id, status);
      CREATE INDEX IF NOT EXISTS idx_merge_reviews_task ON merge_reviews(task_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_member_tokens_token ON member_tokens(token);
    `);
    const contractorColumns = this.db.prepare('PRAGMA table_info(contractors)').all();
    if (!contractorColumns.some((column) => column.name === 'slot')) {
      this.db.exec('ALTER TABLE contractors ADD COLUMN slot TEXT');
    }
    // Slots are global, not per team: one merge and one main contractor at a time.
    // Old rows may predate the slot column; infer them and orphan stale active rows.
    const legacy = this.db.prepare('SELECT id, status, data FROM contractors WHERE slot IS NULL').all();
    for (const row of legacy) {
      let data;
      try { data = JSON.parse(row.data); } catch { continue; }
      const purpose = String(data.purpose ?? 'task');
      const slot = /^(post_merge_review|merge_verify|merge_review|merge)(?::|$)/.test(purpose) ? 'merge' : 'main';
      const active = ['starting', 'running', 'cancelling'].includes(row.status);
      data.slot = slot;
      if (active) {
        data.status = 'orphaned';
        data.error = 'orphaned while migrating contractor slots';
        data.endedAt = data.endedAt ?? Date.now();
      }
      this.db.prepare('UPDATE contractors SET slot = ?, status = ?, data = ? WHERE id = ?')
        .run(slot, data.status, JSON.stringify(data), row.id);
    }
    const activeRows = this.db.prepare("SELECT id, slot, status, data FROM contractors WHERE status IN ('starting', 'running', 'cancelling', 'cleanup_error') ORDER BY rowid ASC").all();
    const seenSlots = new Set();
    for (const row of activeRows) {
      if (!row.slot) continue;
      if (seenSlots.has(row.slot)) {
        let data;
        try { data = JSON.parse(row.data); } catch { data = {}; }
        data.status = 'orphaned';
        data.error = 'duplicate active contractor slot during migration';
        data.endedAt = data.endedAt ?? Date.now();
        this.db.prepare('UPDATE contractors SET status = ?, data = ? WHERE id = ?')
          .run('orphaned', JSON.stringify(data), row.id);
      } else {
        seenSlots.add(row.slot);
      }
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_contractors_team_slot_status ON contractors(team_id, slot, status);
      DROP INDEX IF EXISTS idx_contractors_active_slot;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_contractors_active_slot
        ON contractors(slot)
        WHERE status IN ('starting', 'running', 'cancelling', 'cleanup_error') AND slot IS NOT NULL;
    `);
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  _emit(event) {
    // Inside Store.transaction() listeners must not observe uncommitted state
    // (or state that is about to be rolled back): buffer and flush on commit.
    if (this.txEvents) {
      this.txEvents.push(event);
      return;
    }
    this._notify(event);
  }

  _notify(event) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A broken SSE client must not break the store.
      }
    }
  }

  _parse(row) {
    if (!row) return undefined;
    return JSON.parse(row.data);
  }

  createTeam(team) {
    if (!this.inTransaction) return this.transaction(() => this.createTeam(team));
    if (!team?.id) throw new Error('team.id is required');
    this.assertPublicationWritable(team.id);
    if (this.getTeam(team.id)) throw new Error(`team already exists: ${team.id}`);
    const data = { ...team, phase: team.phase ?? 'draft', control: team.control ?? 'active', createdAt: team.createdAt ?? Date.now() };
    this.db.prepare('INSERT INTO teams (id, phase, control, data, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(data.id, data.phase, data.control, JSON.stringify(data), data.createdAt);
    this._emit({ type: 'team.created', teamId: data.id, data });
    return data;
  }

  getTeam(id) {
    return this._parse(this.db.prepare('SELECT data FROM teams WHERE id = ?').get(id));
  }

  listTeams(includeArchived = false) {
    const rows = includeArchived
      ? this.db.prepare('SELECT data FROM teams ORDER BY created_at ASC').all()
      : this.db.prepare('SELECT data FROM teams WHERE archived_at IS NULL ORDER BY created_at ASC').all();
    return rows.map((row) => JSON.parse(row.data));
  }

  getPublicationGuard(teamId) {
    const teams = this.listTeams(true);
    void teamId;
    return teams.find((team) => team.publicationGuard)?.publicationGuard;
  }

  assertPublicationWritable(teamId, owner) {
    // The guard protects the shared repository, so it intentionally spans
    // teams. Every failure/recovery path must release it instead of leaving a
    // global permanent lock.
    const guard = this.getPublicationGuard(teamId);
    if (guard && guard.operationId !== owner) {
      throw Object.assign(new Error('team publication is in progress or requires reconciliation'), { status: 409, code: 'E_PUBLICATION_HELD' });
    }
  }

  updateTeam(id, patch, { publicationOwner } = {}) {
    if (!this.inTransaction) return this.transaction(() => this.updateTeam(id, patch, { publicationOwner }));
    const current = this.getTeam(id);
    if (!current) throw new Error(`unknown team: ${id}`);
    this.assertPublicationWritable(id, publicationOwner);
    const data = { ...current, ...patch };
    const archivedAt = data.archivedAt ?? (data.phase === 'archived' ? Date.now() : null);
    this.db.prepare('UPDATE teams SET phase = ?, control = ?, data = ?, archived_at = ? WHERE id = ?')
      .run(data.phase, data.control, JSON.stringify(data), archivedAt, id);
    this._emit({ type: 'team.updated', teamId: id, data });
    return data;
  }

  archiveTeam(id) {
    const team = this.updateTeam(id, { phase: 'archived', archivedAt: Date.now() });
    this.addEvent(id, 'team.archived', {});
    return team;
  }

  addMember(member) {
    if (!this.inTransaction) return this.transaction(() => this.addMember(member));
    if (!member?.teamId || !member?.name) throw new Error('member.teamId and member.name are required');
    this.assertPublicationWritable(member.teamId);
    const existing = this.findMember(member.teamId, member.name);
    if (existing) throw new Error(`duplicate member name in team: ${member.name}`);
    const data = {
      ...member,
      id: member.id ?? `member_${randomUUID()}`,
      status: member.status ?? 'unspawned',
      joinedAt: member.joinedAt ?? Date.now(),
    };
    this.db.prepare('INSERT INTO members (id, team_id, name, status, data) VALUES (?, ?, ?, ?, ?)')
      .run(data.id, data.teamId, data.name, data.status, JSON.stringify(data));
    this._emit({ type: 'member.added', teamId: data.teamId, data });
    return data;
  }

  getMember(id) {
    return this._parse(this.db.prepare('SELECT data FROM members WHERE id = ?').get(id));
  }

  listMembers(teamId) {
    return this.db.prepare('SELECT data FROM members WHERE team_id = ? ORDER BY name ASC').all(teamId)
      .map((row) => JSON.parse(row.data));
  }

  findMember(teamId, name) {
    return this._parse(this.db.prepare('SELECT data FROM members WHERE team_id = ? AND name = ?').get(teamId, name));
  }

  updateMember(id, patch) {
    if (!this.inTransaction) return this.transaction(() => this.updateMember(id, patch));
    const current = this.getMember(id);
    if (!current) throw new Error(`unknown member: ${id}`);
    this.assertPublicationWritable(current.teamId);
    const data = { ...current, ...patch };
    this.db.prepare('UPDATE members SET name = ?, status = ?, data = ? WHERE id = ?')
      .run(data.name, data.status, JSON.stringify(data), id);
    this._emit({ type: 'member.updated', teamId: data.teamId, data });
    return data;
  }

  removeMember(id) {
    const current = this.getMember(id);
    if (!current) throw new Error(`unknown member: ${id}`);
    const data = { ...current, status: 'removed', removedAt: Date.now() };
    this.updateMember(id, data);
    this._emit({ type: 'member.removed', teamId: data.teamId, data });
    return data;
  }

  addTask(task) {
    if (!this.inTransaction) return this.transaction(() => this.addTask(task));
    if (!task?.id || !task?.teamId) throw new Error('task.id and task.teamId are required');
    this.assertPublicationWritable(task.teamId);
    if (this.getTask(task.id)) throw new Error(`task already exists: ${task.id}`);
    const data = {
      ...task,
      status: task.status ?? 'pending',
      dependencies: task.dependencies ?? [],
      createdAt: task.createdAt ?? Date.now(),
      updatedAt: task.updatedAt ?? Date.now(),
    };
    this.db.prepare('INSERT INTO tasks (id, team_id, status, assignee, data) VALUES (?, ?, ?, ?, ?)')
      .run(data.id, data.teamId, data.status, data.assignee ?? null, JSON.stringify(data));
    this._emit({ type: 'task.created', teamId: data.teamId, data });
    return data;
  }

  getTask(id) {
    return this._parse(this.db.prepare('SELECT data FROM tasks WHERE id = ?').get(id));
  }

  listTasks(teamId) {
    return this.db.prepare('SELECT data FROM tasks WHERE team_id = ? ORDER BY rowid ASC')
      .all(teamId).map((row) => JSON.parse(row.data));
  }

  updateTask(id, patch, { publicationOwner } = {}) {
    if (!this.inTransaction) return this.transaction(() => this.updateTask(id, patch, { publicationOwner }));
    const current = this.getTask(id);
    if (!current) throw new Error(`unknown task: ${id}`);
    this.assertPublicationWritable(current.teamId, publicationOwner);
    const data = { ...current, ...patch, updatedAt: Date.now() };
    this.db.prepare('UPDATE tasks SET status = ?, assignee = ?, data = ? WHERE id = ?')
      .run(data.status, data.assignee ?? null, JSON.stringify(data), id);
    this._emit({ type: 'task.updated', teamId: data.teamId, data });
    return data;
  }

  addAttempt(attempt) {
    if (!this.inTransaction) return this.transaction(() => this.addAttempt(attempt));
    if (!attempt?.id || !attempt?.teamId || !attempt?.taskId) {
      throw new Error('attempt.id, attempt.teamId and attempt.taskId are required');
    }
    this.assertPublicationWritable(attempt.teamId);
    const data = {
      ...attempt,
      status: attempt.status ?? 'claimed',
      taskEpoch: Number.isInteger(attempt.taskEpoch) ? attempt.taskEpoch : 0,
      controlEpoch: Number.isInteger(attempt.controlEpoch) ? attempt.controlEpoch : 0,
      startedAt: attempt.startedAt ?? Date.now(),
    };
    this.db.prepare('INSERT INTO attempts (id, team_id, task_id, data) VALUES (?, ?, ?, ?)')
      .run(data.id, data.teamId, data.taskId, JSON.stringify(data));
    return data;
  }

  getAttempt(id) {
    return this._parse(this.db.prepare('SELECT data FROM attempts WHERE id = ?').get(id));
  }

  listAttempts(teamId) {
    return this.db.prepare('SELECT data FROM attempts WHERE team_id = ? ORDER BY rowid ASC')
      .all(teamId).map((row) => JSON.parse(row.data));
  }

  updateAttempt(id, patch) {
    if (!this.inTransaction) return this.transaction(() => this.updateAttempt(id, patch));
    const current = this.getAttempt(id);
    if (!current) throw new Error(`unknown attempt: ${id}`);
    this.assertPublicationWritable(current.teamId);
    const data = { ...current, ...patch };
    this.db.prepare('UPDATE attempts SET data = ? WHERE id = ?').run(JSON.stringify(data), id);
    return data;
  }

  addMessage(message) {
    if (!message?.teamId || !message?.to) throw new Error('message.teamId and message.to are required');
    const data = {
      ...message,
      id: message.id ?? `msg_${randomUUID()}`,
      from: message.from ?? 'captain',
      ts: message.ts ?? Date.now(),
    };
    this.db.prepare('INSERT INTO messages (id, team_id, to_agent, data) VALUES (?, ?, ?, ?)')
      .run(data.id, data.teamId, data.to, JSON.stringify(data));
    if (data.crossTeam && data.approvalState === 'pending_captain') {
      // The target team must not receive the content through SSE before approval.
      this._emit({
        type: 'message.cross_team_pending',
        teamId: data.teamId,
        data: { id: data.id, teamId: data.teamId, to: data.to, approvalState: 'pending_captain', fromTeamId: data.fromTeamId },
      });
    } else {
      this._emit({ type: 'message.created', teamId: data.teamId, data });
    }
    return data;
  }

  listMessages(teamId, to) {
    const rows = to
      ? this.db.prepare('SELECT data FROM messages WHERE team_id = ? AND to_agent = ? ORDER BY rowid ASC').all(teamId, to)
      : this.db.prepare('SELECT data FROM messages WHERE team_id = ? ORDER BY rowid ASC').all(teamId);
    return rows.map((row) => JSON.parse(row.data));
  }

  listAllMessages() {
    return this.db.prepare('SELECT data FROM messages ORDER BY rowid ASC').all()
      .map((row) => JSON.parse(row.data));
  }

  getMessage(id) {
    const row = this.db.prepare('SELECT data FROM messages WHERE id = ?').get(id);
    return row ? JSON.parse(row.data) : undefined;
  }

  updateMessage(id, patch) {
    const row = this.db.prepare('SELECT data FROM messages WHERE id = ?').get(id);
    if (!row) throw new Error(`unknown message: ${id}`);
    const data = { ...JSON.parse(row.data), ...patch };
    this.db.prepare('UPDATE messages SET data = ? WHERE id = ?').run(JSON.stringify(data), id);
    return data;
  }

  addEvent(teamId, type, payload = {}) {
    const createdAt = Date.now();
    this.db.prepare('INSERT INTO events (team_id, type, created_at, data) VALUES (?, ?, ?, ?)')
      .run(teamId, type, createdAt, JSON.stringify(payload));
    const event = { teamId, type, createdAt, ...payload };
    this._emit({ type: 'event', teamId, data: event });
    return event;
  }

  listEvents(teamId, sinceId = 0) {
    return this.db.prepare('SELECT id, type, created_at, data FROM events WHERE team_id = ? AND id > ? ORDER BY id ASC')
      .all(teamId, sinceId)
      .map(eventFromRow);
  }

  listRecentEvents(teamId, limit = 60) {
    const capped = Math.max(1, Math.min(500, Number(limit) || 60));
    return this.db.prepare('SELECT id, type, created_at, data FROM events WHERE team_id = ? ORDER BY id DESC LIMIT ?')
      .all(teamId, capped)
      .reverse()
      .map(eventFromRow);
  }

  /**
   * Cap the append-only event log. Only runs once the non-archived tail
   * grows past the limit, and then drops the oldest non-archived rows so the
   * newest `maxRows` survive. Archived teams are exempt: their history is
   * kept even when that means the physical table exceeds the cap. Selecting
   * the cutoff from non-archived rows keeps archived volume from starving the
   * live retention window. Existing history is never touched while the
   * non-archived tail is under the cap.
   * @param {number} [maxRows]
   * @returns {number} number of deleted rows
   */
  pruneEvents(maxRows = 50000) {
    if (!Number.isInteger(maxRows) || maxRows < 1) {
      throw new Error('pruneEvents(maxRows) requires a positive integer');
    }
    const cutoff = this.db.prepare(`
      SELECT id FROM events
      WHERE team_id NOT IN (SELECT id FROM teams WHERE phase = 'archived')
      ORDER BY id DESC LIMIT 1 OFFSET ?
    `).get(maxRows);
    if (!cutoff) return 0;
    const info = this.db.prepare(`
      DELETE FROM events
      WHERE id <= ?
        AND team_id NOT IN (SELECT id FROM teams WHERE phase = 'archived')
    `).run(cutoff.id);
    return Number(info.changes ?? 0);
  }

  compactAfterPrune(deletedRows, { minDeletedRows = 1000, minFreeBytes = 1024 * 1024 } = {}) {
    if (!this.persistent) return false;
    if (this.inTransaction) throw new Error('database compaction requires a committed transaction');
    const freePages = Number(this.db.prepare('PRAGMA freelist_count').get().freelist_count);
    const pageSize = Number(this.db.prepare('PRAGMA page_size').get().page_size);
    if (deletedRows < minDeletedRows && freePages * pageSize < minFreeBytes) return false;
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    this.db.exec('VACUUM');
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return true;
  }

  recordUsage(usage) {
    if (!usage?.teamId) throw new Error('usage.teamId is required');
    const data = { ...usage, id: usage.id ?? `usage_${randomUUID()}`, createdAt: usage.createdAt ?? Date.now() };
    this.db.prepare('INSERT INTO usage (id, team_id, data) VALUES (?, ?, ?)')
      .run(data.id, data.teamId, JSON.stringify(data));
    this._emit({ type: 'usage.recorded', teamId: data.teamId, data });
    return data;
  }

  listUsage(teamId) {
    return this.db.prepare('SELECT data FROM usage WHERE team_id = ? ORDER BY rowid ASC')
      .all(teamId).map((row) => JSON.parse(row.data));
  }

  savePlan(teamId, plan) {
    const data = { ...plan, teamId, version: plan.version ?? 1, updatedAt: Date.now() };
    this.db.prepare('INSERT INTO plans (team_id, data) VALUES (?, ?) ON CONFLICT(team_id) DO UPDATE SET data = excluded.data')
      .run(teamId, JSON.stringify(data));
    this._emit({ type: 'plan.updated', teamId, data });
    return data;
  }

  getPlan(teamId) {
    return this._parse(this.db.prepare('SELECT data FROM plans WHERE team_id = ?').get(teamId));
  }

  setMemberToken(memberId, token) {
    this.db.prepare('INSERT INTO member_tokens (member_id, token) VALUES (?, ?) ON CONFLICT(member_id) DO UPDATE SET token = excluded.token')
      .run(memberId, token);
    return token;
  }

  getMemberToken(memberId) {
    const row = this.db.prepare('SELECT token FROM member_tokens WHERE member_id = ?').get(memberId);
    return row?.token;
  }

  revokeMemberToken(memberId) {
    return this.db.prepare('DELETE FROM member_tokens WHERE member_id = ?').run(memberId).changes > 0;
  }

  findMemberByToken(token) {
    if (!token) return undefined;
    const row = this.db.prepare('SELECT member_id FROM member_tokens WHERE token = ?').get(token);
    if (!row) return undefined;
    return this.getMember(row.member_id);
  }

  addLicense(license) {
    if (!this.inTransaction) return this.transaction(() => this.addLicense(license));
    if (!license?.id || !license?.teamId || !license?.memberId) {
      throw new Error('license.id, teamId and memberId are required');
    }
    this.assertPublicationWritable(license.teamId);
    const data = { ...license, status: license.status ?? 'active', issuedAt: license.issuedAt ?? Date.now() };
    this.db.prepare('INSERT INTO licenses (id, team_id, member_id, status, data) VALUES (?, ?, ?, ?, ?)')
      .run(data.id, data.teamId, data.memberId, data.status, JSON.stringify(data));
    this.addLicenseHistory({ teamId: data.teamId, memberId: data.memberId, action: 'issued', license: data });
    this._emit({ type: 'license.issued', teamId: data.teamId, data });
    return data;
  }

  getLicense(id) {
    return this._parse(this.db.prepare('SELECT data FROM licenses WHERE id = ?').get(id));
  }

  listLicenses(teamId, memberId) {
    const rows = memberId
      ? this.db.prepare('SELECT data FROM licenses WHERE team_id = ? AND member_id = ? ORDER BY rowid ASC').all(teamId, memberId)
      : this.db.prepare('SELECT data FROM licenses WHERE team_id = ? ORDER BY rowid ASC').all(teamId);
    return rows.map((row) => JSON.parse(row.data));
  }

  updateLicense(id, patch) {
    if (!this.inTransaction) return this.transaction(() => this.updateLicense(id, patch));
    const current = this.getLicense(id);
    if (!current) throw new Error(`unknown license: ${id}`);
    this.assertPublicationWritable(current.teamId);
    const data = { ...current, ...patch };
    this.db.prepare('UPDATE licenses SET status = ?, data = ? WHERE id = ?')
      .run(data.status, JSON.stringify(data), id);
    this._emit({ type: 'license.updated', teamId: data.teamId, data });
    return data;
  }

  addLicenseHistory(entry) {
    const data = {
      ...entry,
      id: entry.id ?? `lic_hist_${randomUUID()}`,
      at: entry.at ?? Date.now(),
    };
    this.db.prepare('INSERT INTO license_history (id, team_id, member_id, data) VALUES (?, ?, ?, ?)')
      .run(data.id, data.teamId, data.memberId, JSON.stringify(data));
    return data;
  }

  listLicenseHistory(teamId, memberId) {
    const rows = this.db.prepare('SELECT data FROM license_history WHERE team_id = ? AND member_id = ? ORDER BY rowid ASC')
      .all(teamId, memberId);
    return rows.map((row) => JSON.parse(row.data));
  }

  addContractor(contractor) {
    if (!contractor?.id || !contractor?.teamId) throw new Error('contractor.id and teamId are required');
    const data = { ...contractor, status: contractor.status ?? 'queued', createdAt: contractor.createdAt ?? Date.now() };
    this.db.prepare('INSERT INTO contractors (id, team_id, slot, status, data) VALUES (?, ?, ?, ?, ?)')
      .run(data.id, data.teamId, data.slot ?? null, data.status, JSON.stringify(data));
    this._emit({ type: 'contractor.queued', teamId: data.teamId, data });
    return data;
  }

  getContractor(id) {
    return this._parse(this.db.prepare('SELECT data FROM contractors WHERE id = ?').get(id));
  }

  listContractors(teamId, status, slot) {
    let sql = 'SELECT data FROM contractors WHERE team_id = ?';
    const params = [teamId];
    if (status) { sql += ' AND status = ?'; params.push(status); }
    if (slot) { sql += ' AND slot = ?'; params.push(slot); }
    sql += ' ORDER BY rowid ASC';
    return this.db.prepare(sql).all(...params).map((row) => JSON.parse(row.data));
  }

  listAllContractors(status, slot) {
    let sql = 'SELECT data FROM contractors';
    const clauses = [];
    const params = [];
    if (status) { clauses.push('status = ?'); params.push(status); }
    if (slot) { clauses.push('slot = ?'); params.push(slot); }
    if (clauses.length) sql += ` WHERE ${clauses.join(' AND ')}`;
    sql += ' ORDER BY rowid ASC';
    return this.db.prepare(sql).all(...params).map((row) => JSON.parse(row.data));
  }

  updateContractor(id, patch) {
    const current = this.getContractor(id);
    if (!current) throw new Error(`unknown contractor: ${id}`);
    const data = { ...current, ...patch };
    this.db.prepare('UPDATE contractors SET slot = ?, status = ?, data = ? WHERE id = ?')
      .run(data.slot ?? current.slot ?? null, data.status, JSON.stringify(data), id);
    this._emit({ type: 'contractor.updated', teamId: data.teamId, data });
    return data;
  }

  saveSummary(memberId, teamId, summary) {
    const data = { ...summary, memberId, teamId, savedAt: summary.savedAt ?? Date.now() };
    this.db.prepare('INSERT INTO summaries (member_id, team_id, data) VALUES (?, ?, ?) ON CONFLICT(member_id) DO UPDATE SET data = excluded.data')
      .run(memberId, teamId, JSON.stringify(data));
    return data;
  }

  getSummary(memberId) {
    return this._parse(this.db.prepare('SELECT data FROM summaries WHERE member_id = ?').get(memberId));
  }

  listSummaries(teamId) {
    return this.db.prepare('SELECT data FROM summaries WHERE team_id = ? ORDER BY rowid ASC').all(teamId)
      .map((row) => JSON.parse(row.data));
  }

  addFinding(finding) {
    if (!this.inTransaction) return this.transaction(() => this.addFinding(finding));
    if (!finding?.id || !finding?.teamId) throw new Error('finding.id and teamId are required');
    this.assertPublicationWritable(finding.teamId);
    const data = { ...finding, status: finding.status ?? 'open', createdAt: finding.createdAt ?? Date.now() };
    this.db.prepare('INSERT INTO findings (id, team_id, status, member_id, data) VALUES (?, ?, ?, ?, ?)')
      .run(data.id, data.teamId, data.status, data.memberId ?? null, JSON.stringify(data));
    this._emit({ type: 'finding.created', teamId: data.teamId, data });
    return data;
  }

  getFinding(id) {
    return this._parse(this.db.prepare('SELECT data FROM findings WHERE id = ?').get(id));
  }

  listFindings(teamId, status, memberId) {
    let rows;
    if (status && memberId) {
      rows = this.db.prepare('SELECT data FROM findings WHERE team_id = ? AND status = ? AND member_id = ? ORDER BY rowid ASC').all(teamId, status, memberId);
    } else if (status) {
      rows = this.db.prepare('SELECT data FROM findings WHERE team_id = ? AND status = ? ORDER BY rowid ASC').all(teamId, status);
    } else if (memberId) {
      rows = this.db.prepare('SELECT data FROM findings WHERE team_id = ? AND member_id = ? ORDER BY rowid ASC').all(teamId, memberId);
    } else {
      rows = this.db.prepare('SELECT data FROM findings WHERE team_id = ? ORDER BY rowid ASC').all(teamId);
    }
    return rows.map((row) => JSON.parse(row.data));
  }

  updateFinding(id, patch) {
    if (!this.inTransaction) return this.transaction(() => this.updateFinding(id, patch));
    const current = this.getFinding(id);
    if (!current) throw new Error(`unknown finding: ${id}`);
    this.assertPublicationWritable(current.teamId);
    const data = { ...current, ...patch };
    this.db.prepare('UPDATE findings SET status = ?, data = ? WHERE id = ?')
      .run(data.status, JSON.stringify(data), id);
    this._emit({ type: 'finding.updated', teamId: data.teamId, data });
    return data;
  }

  addMergeReview(review) {
    if (!this.inTransaction) return this.transaction(() => this.addMergeReview(review));
    if (!review?.id || !review?.teamId || !review?.taskId) throw new Error('merge review id, teamId and taskId are required');
    this.assertPublicationWritable(review.teamId);
    const data = { ...review, status: review.status ?? 'pending', createdAt: review.createdAt ?? Date.now() };
    this.db.prepare('INSERT INTO merge_reviews (id, team_id, task_id, status, data) VALUES (?, ?, ?, ?, ?)')
      .run(data.id, data.teamId, data.taskId, data.status, JSON.stringify(data));
    this._emit({ type: 'merge_review.created', teamId: data.teamId, data });
    return data;
  }

  listMergeReviews(teamId, taskId) {
    const rows = taskId
      ? this.db.prepare('SELECT data FROM merge_reviews WHERE team_id = ? AND task_id = ? ORDER BY rowid ASC').all(teamId, taskId)
      : this.db.prepare('SELECT data FROM merge_reviews WHERE team_id = ? ORDER BY rowid ASC').all(teamId);
    return rows.map((row) => JSON.parse(row.data));
  }

  updateMergeReview(id, patch) {
    if (!this.inTransaction) return this.transaction(() => this.updateMergeReview(id, patch));
    const row = this.db.prepare('SELECT data FROM merge_reviews WHERE id = ?').get(id);
    if (!row) throw new Error(`unknown merge review: ${id}`);
    const current = JSON.parse(row.data);
    this.assertPublicationWritable(current.teamId);
    const data = { ...current, ...patch, updatedAt: Date.now() };
    this.db.prepare('UPDATE merge_reviews SET status = ?, data = ? WHERE id = ?')
      .run(data.status, JSON.stringify(data), id);
    return data;
  }

  /**
   * Run a synchronous callback in one transaction. The callback must not
   * return a promise: awaiting inside it would put later writes outside the
   * transaction, so a thenable is rejected instead of silently committing.
   * @param {() => any} fn
   */
  transaction(fn) {
    if (this.inTransaction) throw new Error('store.transaction() is not reentrant');
    this.db.exec('BEGIN IMMEDIATE');
    this.inTransaction = true;
    this.txEvents = [];
    let result;
    try {
      result = fn();
      if (result && typeof result.then === 'function') {
        throw new Error('store.transaction() callback must be synchronous');
      }
      this.db.exec('COMMIT');
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // ignore rollback failure
      }
      this.txEvents = null;
      this.inTransaction = false;
      throw error;
    }
    const events = this.txEvents;
    this.txEvents = null;
    this.inTransaction = false;
    // Notify after COMMIT so subscribers can never observe rolled-back state.
    for (const event of events) this._notify(event);
    return result;
  }

  close() {
    this.db.close();
  }
}
