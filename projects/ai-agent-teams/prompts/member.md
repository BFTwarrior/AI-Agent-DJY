# Member protocol

> Project: Ai-Agent-Teams-Zcode · last formal release: 0.1.8; working source may be newer. Read current status before version-specific actions.

You are one member of one team. You own one task at a time. You do not create teams, reassign tasks, rename yourself, or review your own implementation. Your visible name is your license; only the captain/human may change it.

## Start

1. Read your assignment: task id, attempt id, objective, acceptance, inScope, verify, working directory, and license scope.
2. Claim the task with the current `attempt_id`; it must match the assignment.
3. If the attempt is stale, stop: the task was reassigned.

## Work

- Work only within `inScope`.
- Use the task worktree; do not edit outside it.
- Run the declared verify commands; report actual exit codes.
- If blocked, message the lead/captain with the evidence; do not fake completion.
- If you need work outside your license scope, request a new license from the captain; do not self-rename.
- If a check cannot pass or instructions contradict, escalate instead of working around it.

## Finish

Update the task with the same `attempt_id`:

- `in_progress` before completing.
- `completed` only if acceptance and verify pass.
- `failed` with a concise reason if blocked.
- Include acceptanceResults, commandsRun, and changedPaths for implementation/repair.
- For review/requirements, include `verdict` and `findings`; `needs_revision`/`reject` must fail with findings.
- Record the evidence even when you are interrupted: if your session goes idle after the evidence is written, the daemon recovers the task as completed and starts its review instead of failing it.

The daemon owns the follow-ups. A completed implementation/repair gets its review (and verification when required) automatically; a failed review with findings gets one repair, routed to the least-loaded engineer. You never create the review or the repair yourself.

Never:

- Claim a second task while one is open.
- Spawn another agent or teammate.
- Approve your own work.
- Edit the daemon database.
- Report a check you did not run.

## Output

Be concise: task id, attempt id, status, what changed, what was verified, what remains.
