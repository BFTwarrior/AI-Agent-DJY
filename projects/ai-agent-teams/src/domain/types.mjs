/**
 * Domain typedefs. Runtime validation lives in `src/config.mjs` and the
 * scheduler/gate modules; these types keep the handoff readable.
 */

/**
 * @typedef {'pending'|'claimed'|'in_progress'|'completed'|'failed'|'cancelled'} TaskStatus
 * @typedef {'work'|'requirements'|'implementation'|'verification'|'review'|'repair'|'integration'} TaskKind
 * @typedef {'pass'|'needs_revision'|'reject'} ReviewVerdict
 * @typedef {'low'|'medium'|'high'|'blocker'} FindingSeverity
 * @typedef {'unspawned'|'starting'|'idle'|'working'|'stopping'|'removed'|'lost'} MemberStatus
 * @typedef {'queue'|'claimed'|'delivered'|'read'|'discarded'} MessageState
 */

/**
 * @typedef {Object} Finding
 * @property {string} id
 * @property {FindingSeverity} severity
 * @property {string} [file]
 * @property {string} [path]
 * @property {number} [line]
 * @property {string} problem
 * @property {string} requiredFix
 * @property {boolean} [resolved]
 */

/**
 * @typedef {Object} AcceptanceResult
 * @property {string} criterion
 * @property {'passed'|'failed'} status
 * @property {string} [evidence]
 */

/**
 * @typedef {Object} CommandResult
 * @property {string} command
 * @property {'passed'|'failed'} status
 * @property {number} [exitCode]
 * @property {string} [evidence]
 */

/**
 * @typedef {Object} ArtifactDigest
 * @property {string} path
 * @property {boolean} present
 * @property {string} [sha256]
 * @property {number} [size]
 * @property {number} [mtimeMs]
 * @property {boolean} [unreadable]
 * @property {string} [reason]
 */

/**
 * @typedef {Object} Task
 * @property {string} id
 * @property {string} teamId
 * @property {string} subject
 * @property {TaskStatus} status
 * @property {TaskKind} [kind]
 * @property {string} [assignee]
 * @property {string[]} dependencies
 * @property {number} [attempt]
 * @property {string} [attemptId]
 * @property {string} [handoffId]
 * @property {boolean} [reassigning]
 * @property {number} [round]
 * @property {string} [objective]
 * @property {string[]} [inScope]
 * @property {string[]} [outOfScope]
 * @property {string[]} [acceptance]
 * @property {string[]} [verify]
 * @property {ReviewVerdict} [verdict]
 * @property {Finding[]} [findings]
 * @property {string[]} [changedPaths]
 * @property {AcceptanceResult[]} [acceptanceResults]
 * @property {CommandResult[]} [commandsRun]
 * @property {string} [reviewedTaskId]
 * @property {number} [reviewedAttempt]
 * @property {string} [reviewedAttemptId]
 * @property {string} [sourceTaskId]
 * @property {string[]} [sourceFindingIds]
 * @property {string[]} [findingSourceTaskIds]
 * @property {ArtifactDigest[]} [reviewedArtifacts]
 * @property {string[]} [reviewedScope]
 * @property {string[]} [reviewedDuringDrift]
 * @property {'none'|'pending'|'merged'|'conflict'|'failed'} [mergeState]
 */

/**
 * @typedef {Object} Member
 * @property {string} id
 * @property {string} teamId
 * @property {string} name
 * @property {string} [role]
 * @property {string} [sessionId]
 * @property {string} [provider]
 * @property {string} [model]
 * @property {string} [reasoning]
 * @property {string} [toolPolicy]
 * @property {MemberStatus} status
 * @property {string} [spawnError]
 */

/**
 * @typedef {Object} Team
 * @property {string} id
 * @property {string} name
 * @property {'draft'|'staged'|'running'|'completed'|'archived'} phase
 * @property {'active'|'halted'|'escalated'} control
 * @property {'awaiting_review'|'awaiting_feedback'|'approved'|'discarded'} [planReviewState]
 * @property {Member[]} members
 * @property {Task[]} tasks
 */

/**
 * @typedef {Object} DeliveryResult
 * @property {boolean} ok
 * @property {string[]} blockers
 * @property {string[]} warnings
 */

export {};
