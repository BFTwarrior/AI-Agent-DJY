const str = { type: 'string' };
const num = { type: 'number' };
const bool = { type: 'boolean' };
const strArray = { type: 'array', items: str };
const obj = { type: 'object', additionalProperties: true };
const objArray = { type: 'array', items: obj };

export const UI_RESOURCE_URI = 'ui://ai-agent-teams/panel.html';
export const UI_RESOURCE_MIME = 'text/html;profile=mcp-app';
const UI_SURFACE = 'ai-agent-teams';

const viewMeta = (visibility = ['model', 'app'], preferredDisplayMode = 'fullscreen') => ({
  ui: {
    resourceUri: UI_RESOURCE_URI,
    surface: UI_SURFACE,
    visibility,
    // ZCode maps a fullscreen-display result with `surface` to its side-pane
    // opener. `showInline: true` would force a pinned inline card instead, so
    // it is deliberately absent; hosts without fullscreen support still get the
    // Markdown view link in the tool text.
    preferredDisplayMode,
  },
});

const WORKSPACE_PROP = {
  type: 'string',
  description: 'Optional project directory for this call; takes precedence over the directory selected in this session through agent_teams_workspace.',
};

function tool(name, description, properties, required = [], meta) {
  const props = name === 'agent_teams_workspace'
    ? properties
    : { ...properties, workspace: WORKSPACE_PROP };
  return {
    name,
    description,
    inputSchema: { type: 'object', properties: props, required, additionalProperties: true },
    ...(meta ? { _meta: meta } : {}),
  };
}

export const TOOL_DEFINITIONS = [
  tool('agent_teams_create', 'Create a staged team. The id must be one of the configured team ids (alpha/beta by default). The caller becomes captain; members are planned until approve.', {
    id: str, name: str, description: str, members: objArray,
  }, ['name']),
  tool('agent_teams_edit_plan', 'Atomically add members/tasks to a staged plan.', {
    team_id: str, members: objArray, tasks: objArray,
  }, ['team_id']),
  tool('agent_teams_approve', 'Approve and start a staged plan.', { team_id: str }, ['team_id']),
  tool('agent_teams_add_member', 'Add a member to a team roster.', {
    team_id: str, name: str, role: str, provider: str, model: str, reasoning: str, tool_policy: str,
  }, ['team_id', 'name']),
  tool('agent_teams_remove_member', 'Remove a member: revoke attempts, requeue tasks, stop session.', {
    team_id: str, member: str,
  }, ['team_id', 'member']),
  tool('agent_teams_create_task', 'Create a task with dependencies and an optional quality contract.', {
    team_id: str, id: str, subject: str, description: str, assignee: str, dependencies: strArray,
    kind: str, round: { type: 'number' }, objective: str, acceptance: strArray, inScope: strArray,
    outOfScope: strArray, verify: strArray, reviewedTaskId: str, sourceTaskId: str,
    findingSourceTaskIds: strArray,
    priority: { type: 'string', enum: ['critical', 'normal', 'low'], description: 'Critical-chain work preempts low priority.' },
    requiresVerification: { type: 'boolean', description: 'Fan out an independent verification when the task completes.' },
  }, ['team_id', 'subject']),
  tool('agent_teams_claim_task', 'Claim a task using the explicit attempt_id from the current task dispatch or continue message.', {
    team_id: str, task_id: str, attempt_id: str, member: str,
  }, ['team_id', 'task_id', 'attempt_id']),
  tool('agent_teams_update_task', 'Update a task using the explicit attempt_id from the current dispatch or continue message. Stale or missing ids are rejected.', {
    team_id: str, task_id: str, attempt_id: str, status: str, output: str, verdict: str,
    findings: objArray, changedPaths: strArray, acceptanceResults: objArray, commandsRun: objArray,
    evidence_note: str,
  }, ['team_id', 'task_id', 'attempt_id', 'status']),
  tool('agent_teams_reassign_task', 'Revoke the old attempt, reassign or retry a task. Use captain as assignee for takeover.', {
    team_id: str, task_id: str, assignee: str, reason: str,
  }, ['team_id', 'task_id', 'assignee']),
  tool('agent_teams_continue_task', 'Captain/reviewer only: continue a failed task by sending the continue instruction (the literal "继续" message) to its existing session. Resets the task to in_progress with a fresh three-continue budget; the task id and subject never change.', {
    team_id: str, task_id: str, reason: str,
  }, ['team_id', 'task_id']),
  tool('agent_teams_send_message', 'Send a durable message to a teammate/captain, or a cross-team message that waits for captain approval.', {
    team_id: str, from: str, to: str, to_team: str, content: str, task_id: str, attempt_id: str, urgent: { type: 'boolean' },
  }, ['team_id', 'to', 'content']),
  tool('agent_teams_pending_messages', 'List cross-team messages waiting for captain approval.', {}),
  tool('agent_teams_approve_message', 'Approve a pending cross-team message so the target team can receive it.', {
    message_id: str,
  }, ['message_id']),
  tool('agent_teams_reject_message', 'Reject a pending cross-team message; it will not be delivered.', {
    message_id: str, reason: str,
  }, ['message_id']),
  tool('agent_teams_status', 'Get team, members, tasks, plan and delivery audit.', { team_id: str }),
  tool('agent_teams_route', 'Captain-only deterministic routing: call before starting non-trivial work. Returns mode=team when the request has 2+ independent subtasks, 2+ review perspectives, an estimate over 10 minutes, or a multi-file code change; mode=direct for a simple test or one-shot task. When mode=team, create the team and approve it without asking the user.', {
    description: str,
    independent_subtasks: num,
    review_angles: num,
    estimated_minutes: num,
    changed_files: num,
    code_task: bool,
    simple_test: bool,
  }),
  tool('agent_teams_resume', 'Resume a halted team with a non-empty reason.', { team_id: str, reason: str }, ['team_id', 'reason']),
  tool('agent_teams_delete', 'Archive a team; history is retained.', { team_id: str }, ['team_id']),
  tool('agent_teams_amend_task', 'Captain-only contract amendment for a non-terminal task.', {
    team_id: str, task_id: str, fields: obj, reason: str,
  }, ['team_id', 'task_id', 'reason']),
  tool('agent_teams_relicense_member', 'Captain-only: revoke the current license and issue a new role/label. Requires the member to be settled.', {
    team_id: str, member: str, label: str, role: str, allowed_task_kinds: strArray,
    path_scope: strArray, tool_policy: str, reason: str,
  }, ['team_id', 'member']),
  tool('agent_teams_sleep_member', 'Put an idle member to cold storage after checkpointing its summary.', {
    team_id: str, member: str, reason: str,
  }, ['team_id', 'member']),
  tool('agent_teams_wake_member', 'Wake a cold member; the next task dispatch creates a fresh session.', {
    team_id: str, member: str,
  }, ['team_id', 'member']),
  tool('agent_teams_spawn_contractor', 'Submit a one-shot non-member contractor to the merge or main slot and return immediately. Poll contractor_status/result. No roster or mailbox.', {
    team_id: str, slot: str, purpose: str, prompt: str, mode: str, timeout_ms: { type: 'number' }, model: str, reasoning: str,
  }, ['team_id', 'prompt']),
  tool('agent_teams_contractor_status', 'Show a contractor slot, queue state, session and terminal state.', {
    team_id: str, contractor_id: str,
  }, ['team_id', 'contractor_id']),
  tool('agent_teams_contractor_result', 'Return a contractor result when terminal; otherwise return its current status.', {
    team_id: str, contractor_id: str,
  }, ['team_id', 'contractor_id']),
  tool('agent_teams_list_contractors', 'List contractors, optionally filtered by merge or main slot.', {
    team_id: str, slot: str,
  }, ['team_id']),
  tool('agent_teams_kill_contractor', 'Stop and close a queued or running contractor; the slot is released.', {
    team_id: str, contractor_id: str,
  }, ['team_id', 'contractor_id']),
  tool('agent_teams_merge_and_review', 'Merge a completed task and run the configured post-merge review; rejection rolls back.', {
    team_id: str, task_id: str,
  }, ['team_id', 'task_id']),
  tool('agent_teams_patrol', 'Wake the captain to patrol active work; if the captain is busy, a one-shot patrol contractor is used.', {
    team_id: str,
  }, ['team_id']),
  tool('agent_teams_lifecycle', 'Show hot/warm/cold counts, session budget and contractors.', { team_id: str }),
  tool('agent_teams_shadow_status', 'Captain/admin only: show the single shadow/secretary status: state, memberId, teamId, sessionId, timestamps and lastError.', {}),
  tool('agent_teams_shadow_start', 'Captain/admin only: start the single workspace shadow on demand. Idempotent when already active; creates the seat on first use. Use it when the captain is overloaded or working on a long-running problem.', {
    team_id: str,
  }),
  tool('agent_teams_shadow_stop', 'Stop the shadow session. Captain/admin or the shadow itself; keeps the seat for a later restart. Use it as soon as the delegated scope is closed.', {
    reason: str,
  }),
  tool('agent_teams_model', 'Captain/admin only: inspect or change the subagent model policy. action=status (default) returns the host session model, the policy and every member model; action=set pins a model/reasoning and hot-applies it to active sessions; action=follow resumes following the host session model. Member and contractor sessions cannot see or call this tool; the read-only UI token can only read the snapshot/stream.', {
    action: { type: 'string', enum: ['status', 'set', 'follow'], description: 'status/set/follow' },
    model: str, reasoning: str,
  }),
  tool('agent_teams_workspace', 'View or switch this session\'s team workspace. action=current shows the current target; list lists local projects with a daemon/team config; use switches to the given directory (you can move back and forth between projects A and B); auto clears the manual choice and falls back to the most recent daemon. After a switch, every team tool and the panel point at that directory.', {
    action: { type: 'string', enum: ['current', 'list', 'use', 'auto'], description: 'current/list/use/auto' },
    workspace: { type: 'string', description: 'Project directory to switch to when action=use (absolute path)' },
  }, ['action']),
  tool('agent_teams_view', 'Open the live AI Agent Teams panel in the ZCode side pane. Call this once at the start of a new captain/UI session, or whenever the user asks to view the team, open the team dashboard, or show team progress. Set window=true to also open a standalone chromeless window that can stay open independently of ZCode. Equivalent CLI: node src/cli.mjs panel --open / --window.', {
    window: { type: 'boolean', description: 'Also open the standalone window (Edge/Chrome app mode).' },
  }, [], viewMeta()),
  tool('agent_teams_view_snapshot', 'Return the read-only team snapshot used by the team panel. App-only; not for model tool calls.', {}, [], viewMeta(['app'], 'inline')),
];
