// Team-control MCP tool names. Contractors must never receive these: a one-shot
// contractor is not a captain and must not create/approve/delete/merge teams.
//
// The member MCP server itself does not shrink its catalog per role: a member
// session lists the full member catalog minus the captain/UI tools and a
// contractor session lists the same catalog. The enforcement points are the
// host tool denylist built below and the HTTP token scope in src/http/server.mjs
// (403 outside the allowed routes). Read "denied" below as "denied by the
// denylist", not "absent from tools/list".
export const TEAM_TOOL_NAMES = [
  'agent_teams_create',
  'agent_teams_edit_plan',
  'agent_teams_approve',
  'agent_teams_add_member',
  'agent_teams_remove_member',
  'agent_teams_create_task',
  'agent_teams_claim_task',
  'agent_teams_update_task',
  'agent_teams_reassign_task',
  'agent_teams_continue_task',
  'agent_teams_send_message',
  'agent_teams_pending_messages',
  'agent_teams_approve_message',
  'agent_teams_reject_message',
  'agent_teams_status',
  'agent_teams_resume',
  'agent_teams_delete',
  'agent_teams_amend_task',
  'agent_teams_relicense_member',
  'agent_teams_sleep_member',
  'agent_teams_wake_member',
  'agent_teams_spawn_contractor',
  'agent_teams_contractor_status',
  'agent_teams_contractor_result',
  'agent_teams_list_contractors',
  'agent_teams_kill_contractor',
  'agent_teams_merge_and_review',
  'agent_teams_patrol',
  'agent_teams_lifecycle',
  'agent_teams_shadow_status',
  'agent_teams_shadow_start',
  'agent_teams_shadow_stop',
  'agent_teams_view',
  'agent_teams_view_snapshot',
  'agent_teams_workspace',
  'agent_teams_route',
];

// Contractor permission modes. `read-only` and `review` are headless-safe
// read-only execution: file-writing tools stay denied, shell commands stay
// available so a reviewer can run the tests it must judge. `workspace-write`
// keeps file writes and exists only for explicit implementation contractors.
export const CONTRACTOR_MODES = ['read-only', 'review', 'workspace-write'];

// Purposes whose whole job is judging someone else's work. They can never be
// promoted to `workspace-write`: a reviewer that can edit the patch it reviews
// is not a reviewer. The list covers every merge-slot purpose (see
// `resolveContractorSlot`) plus the daemon's own red auto-review contractor and
// patrol, so no merge contractor can ever write the tree it is merging.
export const CONTRACTOR_REVIEW_PURPOSES = [
  'post_merge_review',
  'merge_verify',
  'merge_review',
  'merge',
  'red_auto_review',
  'patrol',
];

// File-writing tools that stay denied to read-only/review contractors. Bash is
// deliberately absent: a headless session cannot answer a permission prompt,
// so `mode=plan` + a Bash denylist stalls every post-merge review until its
// lifetime expires. The write barrier is this denylist plus the team-tool
// denylist below; the shell is what lets the reviewer run `npm test` and
// `git diff` at all.
export function contractorWriteDenylist() {
  return ['Edit', 'Write', 'MultiEdit', 'ApplyPatch', 'apply_patch', 'NotebookEdit'];
}

/** Whether a purpose belongs to a reviewer role (never writable). */
export function isContractorReviewPurpose(purpose) {
  return CONTRACTOR_REVIEW_PURPOSES.includes(String(purpose ?? '').split(':')[0]);
}

/**
 * Resolve the stored contractor mode from the requested permission and the
 * purpose. Review purposes always resolve to `review` and reject
 * `workspace-write`; anything else keeps the requested/default permission.
 *
 * @param {{ purpose?: string, requestedMode?: string, defaultPermission?: string }} input
 * @returns {'read-only' | 'review' | 'workspace-write'}
 */
export function resolveContractorMode({ purpose, requestedMode, defaultPermission = 'read-only' } = {}) {
  const requested = requestedMode ?? defaultPermission ?? 'read-only';
  if (!CONTRACTOR_MODES.includes(requested)) {
    throw Object.assign(
      new Error('contractor mode must be read-only|review|workspace-write'),
      { status: 400, code: 'E_INVALID' },
    );
  }
  if (isContractorReviewPurpose(purpose)) {
    if (requested === 'workspace-write') {
      throw Object.assign(
        new Error(`contractor purpose ${purpose} cannot use workspace-write mode`),
        { status: 400, code: 'E_INVALID' },
      );
    }
    return 'review';
  }
  return requested;
}

// Tools only the captain/UI MCP server may expose. The member catalog filters
// this list and tools/call rejects it; one list drives both checks.
export const MODEL_POLICY_TOOL_NAME = 'agent_teams_model';
export const CAPTAIN_ONLY_TOOL_NAMES = [
  'agent_teams_view',
  'agent_teams_view_snapshot',
  'agent_teams_workspace',
  'agent_teams_route',
  'agent_teams_shadow_status',
  'agent_teams_shadow_start',
  'agent_teams_shadow_stop',
  MODEL_POLICY_TOOL_NAME,
];

// `agent_teams_model` changes the global model policy. It stays captain-only
// and is denied to member/contractor sessions in every name shape.
export function modelPolicyToolDenylist() {
  return [
    MODEL_POLICY_TOOL_NAME,
    `mcp__agent-teams__${MODEL_POLICY_TOOL_NAME}`,
    `mcp__${MEMBER_MCP_SERVER_NAME}__${MODEL_POLICY_TOOL_NAME}`,
    `${PLUGIN_MCP_TOOL_PREFIX}${MODEL_POLICY_TOOL_NAME}`,
  ];
}

// The plugin server and the explicit member server are different MCP servers.
// ZCode exposes the plugin server as `plugin:<plugin>:<server>`, which becomes
// `mcp__plugin_<plugin>_<server>__<tool>` in the model tool namespace.
export const MEMBER_MCP_SERVER_NAME = 'agent-teams-member';
export const PLUGIN_MCP_TOOL_PREFIX = 'mcp__plugin_ai-agent-teams_agent-teams__';

// Tools that can only be reached through the plugin's admin-token MCP server.
// Member sessions must deny these while keeping their own `agent-teams-member`
// server available; otherwise the plugin server would bypass the member token.
export function pluginTeamToolDenylist() {
  return TEAM_TOOL_NAMES.flatMap((name) => [
    name,
    `mcp__agent-teams__${name}`,
    `${PLUGIN_MCP_TOOL_PREFIX}${name}`,
  ]);
}

// Contractors get no explicit AgentTeams MCP server at all. Deny every name
// shape, including a member server if a host ever injects one.
export function contractorToolDenylist() {
  return TEAM_TOOL_NAMES.flatMap((name) => [
    name,
    `mcp__agent-teams__${name}`,
    `mcp__${MEMBER_MCP_SERVER_NAME}__${name}`,
    `${PLUGIN_MCP_TOOL_PREFIX}${name}`,
  ]);
}

// The one exception: a contractor session that receives a contractor-scoped
// token may call agent_teams_continue_task through the member server. Every
// other team tool stays denied by the denylist on every server shape, including
// the member server, so the contractor cannot claim/update/reassign/merge. The
// member server still lists those tools (the catalog is not filtered), but a
// call is denied by the host before it reaches the daemon, and the contractor
// token's HTTP scope would reject it anyway. The plugin admin server's continue
// tool is still denied: only the contractor token may use it.
export function contractorContinueDenylist() {
  return TEAM_TOOL_NAMES.flatMap((name) => {
    const shapes = [`mcp__agent-teams__${name}`, `${PLUGIN_MCP_TOOL_PREFIX}${name}`];
    if (name !== 'agent_teams_continue_task') {
      shapes.push(name, `mcp__${MEMBER_MCP_SERVER_NAME}__${name}`);
    }
    return shapes;
  });
}

/**
 * Build the session mode and tool denylist for a contractor run.
 *
 * Every contractor runs in the host's headless worker mode (`yolo` by default):
 * `plan` blocks Bash behind an approval prompt that a headless session can
 * never answer. Read-only/review contractors keep the write barrier through
 * the write-tool denylist, and every contractor keeps the team-tool and model
 * policy denylists. The returned mode is never `review` — that value is a
 * stored policy mode, not a ZCode session mode.
 *
 * @param {{ mode: string, headlessMode: string, supportsMemberMcp?: boolean }} input
 * @returns {{ mode: string, disallowedTools: string[] }}
 */
export function contractorExecutionPolicy({ mode, headlessMode, supportsMemberMcp = false }) {
  const restricted = mode !== 'workspace-write';
  return {
    mode: headlessMode,
    disallowedTools: [
      ...(restricted ? contractorWriteDenylist() : []),
      ...(supportsMemberMcp ? contractorContinueDenylist() : contractorToolDenylist()),
      ...modelPolicyToolDenylist(),
    ],
  };
}
