import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

async function git(args, cwd) {
  const result = await exec('git', args, { cwd, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  return result.stdout.trim();
}

async function statusFingerprint(worktree) {
  // Tracked changes, staged content and untracked paths + contents. The initial
  // dirty tree is allowed; a different dirty tree or a clean tree after commit
  // is what the fence can prove without claiming kernel-level exclusivity.
  const status = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], worktree);
  const diff = await git(['diff', '--binary', '--no-ext-diff', '--no-textconv'], worktree);
  const staged = await git(['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv'], worktree);
  const untracked = await git(['ls-files', '--others', '--exclude-standard', '-z'], worktree);
  const untrackedDigest = [];
  for (const path of untracked.split('\0').filter(Boolean).sort()) {
    try {
      const oid = await git(['hash-object', '--', path], worktree);
      untrackedDigest.push(`${path}\0${oid}`);
    } catch {
      untrackedDigest.push(`${path}\0unreadable`);
    }
  }
  return createHash('sha256').update(status).update('\0').update(diff).update('\0').update(staged)
    .update('\0').update(untrackedDigest.join('\0')).digest('hex');
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function canonicalPath(path) {
  try {
    const real = realpathSync.native(path);
    return process.platform === 'win32' ? real.toLowerCase() : real;
  } catch {
    return process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
  }
}

function lockPathFor(commonDir, input) {
  // The lock protects the physical worktree, not one attempt. Keying by
  // attempt/task let two writers acquire different lock files for the same
  // directory. Ownership details stay in the lock body.
  const key = createHash('sha256').update(canonicalPath(input.worktree)).digest('hex');
  return join(commonDir, 'agent-teams-fences', `${key}.json`);
}

function readLock(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

async function resolveCommonDir(worktree) {
  const raw = await git(['rev-parse', '--git-common-dir'], worktree);
  return resolve(worktree, raw);
}

/**
 * Daemon-level worktree fence provider.
 *
 * The provider takes an exclusive lock file in the repository's common git
 * directory, records the owner and a random proof, and verifies that the
 * worktree still matches either its acquisition fingerprint or a clean tree
 * after the commit. It is not a kernel lock: writers that do not call this
 * provider are caught by the service's post-commit inspection instead.
 *
 * @returns {{ acquire: (input: {worktree: string, base: string, teamId: string,
 *   taskId: string, attemptId: string}) => Promise<any> }}
 */
export function createWorktreeFenceProvider() {
  return {
    async acquire({ worktree, base, teamId, taskId, attemptId }) {
      if (typeof worktree !== 'string' || !worktree || !existsSync(worktree)) {
        throw Object.assign(new Error('worktree is missing'), { code: 'E_ARTIFACT_FENCE' });
      }
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(base ?? '')) {
        throw Object.assign(new Error('artifact base must be a full commit id'), { code: 'E_ARTIFACT_FENCE' });
      }
      const head = await git(['rev-parse', '--verify', `${base}^{commit}`], worktree);
      if (head !== base) {
        throw Object.assign(new Error('artifact base changed before the fence was acquired'), { code: 'E_ARTIFACT_FENCE' });
      }
      const commonDir = await resolveCommonDir(worktree);
      const lockDir = join(commonDir, 'agent-teams-fences');
      mkdirSync(lockDir, { recursive: true });
      const path = lockPathFor(commonDir, { worktree, teamId, taskId, attemptId });
      const token = randomBytes(32).toString('hex');
      const initialFingerprint = await statusFingerprint(worktree);

      const take = () => {
        const fd = openSync(path, 'wx', 0o600);
        writeSync(fd, JSON.stringify({
          token, pid: process.pid, createdAt: Date.now(), worktree, base, teamId, taskId, attemptId,
        }));
        return fd;
      };
      let fd;
      try {
        fd = take();
      } catch (error) {
        if (error?.code !== 'EEXIST') throw Object.assign(new Error(`cannot acquire worktree fence: ${error.message}`), { code: 'E_ARTIFACT_FENCE' });
        const existing = readLock(path);
        // A dead daemon must not leave a permanent lock. A live owner is a real
        // conflict and is never stolen. A half-written lock (JSON not visible
        // yet) is treated as live for a short grace period instead of being
        // unlinked from under the writer.
        if (existing && processAlive(existing.pid)) {
          throw Object.assign(new Error('worktree is already fenced by a live daemon'), { code: 'E_ARTIFACT_FENCE' });
        }
        if (!existing) {
          let ageMs = 0;
          try { ageMs = Date.now() - statSync(path).mtimeMs; } catch { /* racing removal */ }
          if (ageMs < 5000) {
            throw Object.assign(new Error('worktree fence is being acquired by another process'), { code: 'E_ARTIFACT_FENCE' });
          }
        }
        try { unlinkSync(path); } catch { /* another process may have removed it */ }
        try {
          fd = take();
        } catch (retryError) {
          throw Object.assign(new Error(`cannot acquire worktree fence: ${retryError.message}`), { code: 'E_ARTIFACT_FENCE' });
        }
      }
      let released = false;
      let expectedHead;
      const fence = {
        state: 'frozen',
        proof: token,
        worktree,
        teamId,
        taskId,
        attemptId,
        /**
         * Bind verification to the commit this attempt created. Without this,
         * any later clean tree was accepted after an external commit.
         */
        expectCommit(commit) {
          if (typeof commit !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) {
            throw Object.assign(new Error('expected fence commit must be a full commit id'), { code: 'E_ARTIFACT_FENCE' });
          }
          expectedHead = commit;
        },
        async verify() {
          if (released) return false;
          const current = readLock(path);
          if (!current || current.token !== token || current.pid !== process.pid) return false;
          if (!existsSync(worktree)) return false;
          try {
            const head = await git(['rev-parse', 'HEAD'], worktree);
            if (expectedHead && head !== expectedHead) return false;
            const ancestor = await git(['merge-base', '--is-ancestor', base, 'HEAD'], worktree).then(() => true).catch(() => false);
            if (!ancestor) return false;
            const fingerprint = await statusFingerprint(worktree);
            // The initial dirty tree is the member's artifact; a clean tree is
            // the post-commit state. Anything else means an external writer
            // changed the worktree while the fence was held.
            if (fingerprint === initialFingerprint) return true;
            const status = await git(['status', '--porcelain'], worktree);
            return status === '';
          } catch {
            return false;
          }
        },
        async release() {
          if (released) return;
          released = true;
          const current = readLock(path);
          if (current?.token === token) {
            try { unlinkSync(path); } catch { /* idempotent */ }
          }
          try { closeSync(fd); } catch { /* already closed */ }
        },
      };
      return fence;
    },
  };
}
