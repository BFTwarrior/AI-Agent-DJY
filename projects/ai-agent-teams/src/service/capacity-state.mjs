import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Scale the per-team cap with the global worker pool. At the configured
 * ceiling the original per-team cap is restored exactly.
 */
export function computeMaxActivePerTeam(slots, ceiling, maxCeiling) {
  if (slots >= ceiling) return maxCeiling;
  const scaled = Math.ceil(maxCeiling * (slots / ceiling));
  return Math.max(1, Math.min(maxCeiling, scaled));
}

/**
 * Read and validate the workspace throttle file. Invalid, corrupt, or
 * configuration-mismatched state is ignored instead of blocking startup.
 *
 * @param {string | undefined} path
 * @param {{ ceiling: number, maxCeiling: number, recoveryMs: number, recoverySuccesses: number, now: number }} options
 */
export function readCapacityState(path, { ceiling, maxCeiling, recoveryMs, recoverySuccesses, now }) {
  if (!path || !existsSync(path)) return undefined;
  try {
    const state = JSON.parse(readFileSync(path, 'utf8'));
    if (Number(state.version) !== 1) return undefined;
    if (Number(state.configuredWorkerSlots) !== ceiling) return undefined;
    const slots = Number(state.activeWorkerSlots);
    if (!Number.isInteger(slots) || slots < 1 || slots > ceiling) return undefined;
    const successes = Math.max(0, Math.trunc(Number(state.successes) || 0));
    const hint = Number(state.nextRecoveryAt);
    return {
      activeWorkerSlots: slots,
      maxActivePerTeam: computeMaxActivePerTeam(slots, ceiling, maxCeiling),
      successes: Math.min(recoverySuccesses - 1, successes),
      reducedAt: Math.max(0, Number(state.reducedAt) || 0),
      nextRecoveryAt: Number.isFinite(hint)
        ? Math.min(Math.max(0, hint), now + recoveryMs)
        : now + recoveryMs,
    };
  } catch {
    return undefined;
  }
}

/**
 * Persist the throttle best-effort; a read-only disk must not stop scheduling.
 */
export function writeCapacityState(path, state) {
  if (!path) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ version: 1, ...state }, null, 2)}\n`, 'utf8');
  } catch {
    // Persistence is best-effort.
  }
}
