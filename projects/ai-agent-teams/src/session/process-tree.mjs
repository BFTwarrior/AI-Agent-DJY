import { spawnSync } from 'node:child_process';

// A headless ZCode run is a Node wrapper that starts an app-server grandchild.
// `child.kill()` only signals the wrapper and leaves the app-server running, so
// every timeout/stop path kills the whole tree.
//
// POSIX callers must spawn the process with `detached: true` so it owns a
// process group; a negative pid then signals the group. On Windows `taskkill
// /T /F` walks the tree. Both paths report failure instead of swallowing it so
// a cleanup failure can become a visible `cleanup_error`.
function killError(error) {
  return error instanceof Error ? error.message : String(error);
}

export function killProcessTree(child) {
  if (!child || child.pid === undefined) return { ok: false, status: 'unknown', error: 'process identity unavailable' };
  try {
    if (process.platform === 'win32') {
      if (child.exitCode !== null) return { ok: false, status: 'unknown', error: 'wrapper exited; descendant process state is not verifiable' };
      const result = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      if (result.status === 0) return { ok: false, status: 'unknown', signalSent: true, error: 'taskkill accepted the tree termination request; process-tree exit was not verified' };
      const stderr = result.stderr ? result.stderr.toString().trim() : '';
      // A missing wrapper cannot prove that previously spawned descendants
      // are gone; retain the reservation even if taskkill says not found.
      return { ok: false, status: 'unknown', error: (stderr || `taskkill exited ${result.status ?? 'null'}`).slice(0, 500) };
    }
    if (child.exitCode !== null) {
      try {
        process.kill(-child.pid, 0);
        return { ok: false, status: 'unknown', error: 'wrapper exited but its process group still exists' };
      } catch (probeError) {
        if (probeError?.code === 'ESRCH') return { ok: true, status: 'exited', alreadyExited: true };
        return { ok: false, status: 'unknown', error: killError(probeError) };
      }
    }
    try {
      process.kill(-child.pid, 'SIGKILL');
      // Signal delivery is not proof of exit. Probe the entire owned process
      // group; ESRCH is the only portable POSIX evidence that it is gone.
      try {
        process.kill(-child.pid, 0);
        return { ok: false, status: 'unknown', signalSent: true, processGroup: true, error: 'process group still exists after SIGKILL' };
      } catch (probeError) {
        if (probeError?.code === 'ESRCH') return { ok: true, status: 'exited', processGroup: true };
        return { ok: false, status: 'unknown', signalSent: true, error: killError(probeError) };
      }
    } catch (groupError) {
      // No process group (caller did not detach, or it already exited): fall
      // back to the direct child before reporting a failure.
      try {
        child.kill('SIGKILL');
        return { ok: false, status: 'unknown', signalSent: true, error: 'only the direct child was signalled; descendants were not verified' };
      } catch (error) {
        if (groupError?.code === 'ESRCH') return { ok: true, status: 'exited', alreadyExited: true };
        return { ok: false, status: 'unknown', error: killError(error) };
      }
    }
  } catch (error) {
    return { ok: false, status: 'unknown', error: killError(error) };
  }
}
