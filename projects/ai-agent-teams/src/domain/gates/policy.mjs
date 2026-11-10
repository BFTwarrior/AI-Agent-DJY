/** Shared task-state vocabulary and closed-loop ceilings. Keep each mutable constant owned once. Pure logic; no I/O. */

export const QUALITY_KINDS = ['requirements', 'implementation', 'verification', 'review', 'repair', 'integration'];

export const TERMINAL = ['completed', 'failed', 'cancelled'];

export const TRANSITIONS = {
  pending: ['claimed', 'cancelled'],
  claimed: ['in_progress', 'failed', 'cancelled'],
  in_progress: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

export const CLOSED_LOOP_REVIEW_KINDS = ['implementation', 'repair'];

export const CLOSED_LOOP_DEFAULT_MAX_ROUNDS = 3;

export const CLOSED_LOOP_DEFAULT_MAX_REPAIRS = 2;

export function repairAttemptLimit(policy = {}) {
  const configured = policy.maxRepairAttempts;
  return Number.isInteger(configured) && configured > 0
    ? configured
    : CLOSED_LOOP_DEFAULT_MAX_REPAIRS;
}
