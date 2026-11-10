import { routeTask } from '../team-policy.mjs';

function slug(value) {
  return String(value ?? 'team').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'team';
}

export function createMcpToolHandlers({ api, loadViewSnapshot, workspaceForCall, defaultTeam, defaultMember, openPanelImpl }) {
  async function memberId(teamId, member) {
    const team = await api('GET', `/teams/${teamId}`);
    const found = (team.members ?? []).find((item) => item.id === member || item.name === member);
    if (!found) throw new Error(`unknown member: ${member}`);
    return found.id;
  }


  async function viewSnapshot() {
    const workspace = workspaceForCall();
    const { conn, snapshot } = await loadViewSnapshot(workspace);
    let viewUrl = null;
    if (conn.baseUrl) {
      const url = new URL(conn.baseUrl);
      url.pathname = '/ui';
      url.search = conn.uiKey ? `?key=${encodeURIComponent(conn.uiKey)}` : '';
      url.hash = 'tasks';
      viewUrl = url.toString();
    }
    return { ...snapshot, viewUrl };
  }

  const handlers = {
    async agent_teams_create(args) {
      const id = args.id ?? slug(args.name);
      return api('POST', '/teams', {
        id, name: args.name, description: args.description, members: args.members ?? [],
      });
    },
    async agent_teams_edit_plan(args) {
      const teamId = args.team_id ?? defaultTeam;
      return api('POST', `/teams/${teamId}/plan/edit`, { members: args.members ?? [], tasks: args.tasks ?? [] });
    },
    async agent_teams_approve(args) {
      return api('POST', `/teams/${args.team_id ?? defaultTeam}/plan/approve`, {});
    },
    async agent_teams_add_member(args) {
      const teamId = args.team_id ?? defaultTeam;
      return api('POST', `/teams/${teamId}/members`, {
        name: args.name, role: args.role, provider: args.provider, model: args.model, reasoning: args.reasoning, tool_policy: args.tool_policy,
      });
    },
    async agent_teams_remove_member(args) {
      const teamId = args.team_id ?? defaultTeam;
      const id = await memberId(teamId, args.member);
      return api('DELETE', `/teams/${teamId}/members/${id}`);
    },
    async agent_teams_create_task(args) {
      const teamId = args.team_id ?? defaultTeam;
      // `workspace` is an MCP routing control, not part of the task contract.
      const { workspace: _workspace, team_id: _teamId, ...task } = args;
      return api('POST', `/teams/${teamId}/tasks`, task);
    },

    async agent_teams_claim_task(args) {
      if (typeof args.attempt_id !== 'string' || !args.attempt_id.trim()) throw new Error('attempt_id is required');
      const teamId = args.team_id ?? defaultTeam;
      return api('POST', `/teams/${teamId}/tasks/${args.task_id}/claim`, {
        attemptId: args.attempt_id, member: args.member ?? defaultMember,
      });
    },
    async agent_teams_update_task(args) {
      if (typeof args.attempt_id !== 'string' || !args.attempt_id.trim()) throw new Error('attempt_id is required');
      const teamId = args.team_id ?? defaultTeam;
      const {
        workspace: _workspace, team_id: _teamId, task_id: _taskId, attempt_id, ...fields
      } = args;
      return api('POST', `/teams/${teamId}/tasks/${args.task_id}/update`, {
        ...fields, attemptId: attempt_id, member: args.member ?? defaultMember,
      });
    },
    async agent_teams_reassign_task(args) {
      const teamId = args.team_id ?? defaultTeam;
      return api('POST', `/teams/${teamId}/tasks/${args.task_id}/reassign`, {
        assignee: args.assignee, reason: args.reason,
      });
    },
    async agent_teams_continue_task(args) {
      const teamId = args.team_id ?? defaultTeam;
      return api('POST', `/teams/${teamId}/tasks/${args.task_id}/continue`, { reason: args.reason });
    },
    async agent_teams_send_message(args) {
      const teamId = args.team_id ?? defaultTeam;
      return api('POST', `/teams/${teamId}/messages`, {
        from: args.from ?? defaultMember ?? 'captain', to: args.to, toTeam: args.to_team, content: args.content,
        task_id: args.task_id, attempt_id: args.attempt_id, urgent: args.urgent,
      });
    },
    async agent_teams_pending_messages() {
      return api('GET', '/messages/pending');
    },
    async agent_teams_approve_message(args) {
      return api('POST', `/messages/${encodeURIComponent(args.message_id)}/approve`, {});
    },
    async agent_teams_reject_message(args) {
      return api('POST', `/messages/${encodeURIComponent(args.message_id)}/reject`, { reason: args.reason });
    },
    async agent_teams_route(args) {
      return routeTask({
        description: args.description,
        independentSubtasks: args.independent_subtasks,
        reviewAngles: args.review_angles,
        estimatedMinutes: args.estimated_minutes,
        changedFiles: args.changed_files,
        codeTask: args.code_task,
        simpleTest: args.simple_test,
      });
    },
    async agent_teams_status(args) {
      const teamId = args.team_id ?? defaultTeam;
      if (!teamId) return api('GET', '/teams');
      const team = await api('GET', `/teams/${teamId}`);
      // Member tokens intentionally cannot read the captain-only audit.
      if (defaultMember) return team;
      const audit = await api('GET', `/teams/${teamId}/audit`);
      return { ...team, audit };
    },
    async agent_teams_resume(args) {
      return api('POST', `/teams/${args.team_id ?? defaultTeam}/resume`, { reason: args.reason });
    },
    async agent_teams_delete(args) {
      return api('POST', `/teams/${args.team_id ?? defaultTeam}/archive`, {});
    },
    async agent_teams_amend_task(args) {
      const teamId = args.team_id ?? defaultTeam;
      return api('POST', `/teams/${teamId}/tasks/${args.task_id}/amend`, { fields: args.fields ?? {}, reason: args.reason });
    },
    async agent_teams_relicense_member(args) {
      const teamId = args.team_id ?? defaultTeam;
      const id = await memberId(teamId, args.member);
      return api('POST', `/teams/${teamId}/members/${id}/relicense`, {
        label: args.label, roleKey: args.role, allowedTaskKinds: args.allowed_task_kinds,
        pathScope: args.path_scope, toolPolicy: args.tool_policy, reason: args.reason,
      });
    },
    async agent_teams_sleep_member(args) {
      const teamId = args.team_id ?? defaultTeam;
      const id = await memberId(teamId, args.member);
      return api('POST', `/teams/${teamId}/members/${id}/sleep`, { reason: args.reason });
    },
    async agent_teams_wake_member(args) {
      const teamId = args.team_id ?? defaultTeam;
      const id = await memberId(teamId, args.member);
      return api('POST', `/teams/${teamId}/members/${id}/wake`, {});
    },
    async agent_teams_spawn_contractor(args) {
      const teamId = args.team_id ?? defaultTeam;
      return api('POST', `/teams/${teamId}/contractors`, {
        slot: args.slot, purpose: args.purpose, prompt: args.prompt, mode: args.mode,
        timeoutMs: args.timeout_ms, model: args.model, reasoning: args.reasoning,
      });
    },
    async agent_teams_contractor_status(args) {
      const teamId = args.team_id ?? defaultTeam;
      return api('GET', `/teams/${teamId}/contractors/${encodeURIComponent(args.contractor_id)}`);
    },
    async agent_teams_contractor_result(args) {
      const teamId = args.team_id ?? defaultTeam;
      return api('GET', `/teams/${teamId}/contractors/${encodeURIComponent(args.contractor_id)}`);
    },
    async agent_teams_list_contractors(args) {
      const teamId = args.team_id ?? defaultTeam;
      const query = args.slot ? `?slot=${encodeURIComponent(args.slot)}` : '';
      return api('GET', `/teams/${teamId}/contractors${query}`);
    },
    async agent_teams_kill_contractor(args) {
      const teamId = args.team_id ?? defaultTeam;
      return api('POST', `/teams/${teamId}/contractors/${encodeURIComponent(args.contractor_id)}/kill`, {});
    },
    async agent_teams_merge_and_review(args) {
      const teamId = args.team_id ?? defaultTeam;
      return api('POST', `/teams/${teamId}/tasks/${args.task_id}/merge`, {});
    },
    async agent_teams_patrol(args) {
      return api('POST', `/teams/${args.team_id ?? defaultTeam}/patrol`, {});
    },
    async agent_teams_lifecycle(args) {
      return api('GET', `/teams/${args.team_id ?? defaultTeam}/lifecycle`);
    },
    async agent_teams_shadow_status() {
      return api('GET', '/shadow');
    },
    async agent_teams_shadow_start(args) {
      return api('POST', '/shadow/start', { teamId: args.team_id });
    },
    async agent_teams_shadow_stop(args) {
      return api('POST', '/shadow/stop', { reason: args.reason });
    },
    async agent_teams_model(args) {
      const action = args.action ?? 'status';
      if (action === 'status') return api('GET', '/model');
      if (action === 'set') {
        return api('POST', '/model', { action: 'set', model: args.model, reasoning: args.reasoning });
      }
      if (action === 'follow') return api('POST', '/model', { action: 'follow' });
      throw new Error(`unknown model action: ${action}`);
    },
    async agent_teams_view(args) {
      const data = await viewSnapshot();
      if (!args?.window) return data;
      const opened = await openPanelImpl(data.viewUrl, { mode: 'window' });
      return { ...data, window: opened };
    },
    async agent_teams_view_snapshot() {
      return viewSnapshot();
    },
  };
  return handlers;
}
