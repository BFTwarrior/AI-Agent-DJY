/**
 * Shared task-graph vocabulary. Kept separate from scheduler algorithms so
 * validation and scheduling consume the same mutable public arrays.
 */
export const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'];
export const TASK_STATUSES = ['pending', 'claimed', 'in_progress', ...TERMINAL_STATUSES];

/** Dedicated kind for daemon-created automatic continue reviews. */
export const RED_REVIEW_KIND = 'red-auto-review';
export const TASK_KINDS = ['work', 'requirements', 'implementation', 'verification', 'review', 'repair', 'integration', RED_REVIEW_KIND];
export const TASK_PRIORITIES = ['critical', 'high', 'normal', 'low'];
