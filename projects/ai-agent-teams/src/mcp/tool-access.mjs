import { CAPTAIN_ONLY_TOOL_NAMES } from '../domain/team-tools.mjs';
import { TOOL_DEFINITIONS } from './tool-definitions.mjs';

const SHADOW_UNAVAILABLE_TOOLS = new Set([
  'agent_teams_view',
  'agent_teams_view_snapshot',
  'agent_teams_shadow_start',
  'agent_teams_spawn_contractor',
]);

function withoutWorkspace(tool) {
  const { workspace: _workspace, ...properties } = tool.inputSchema.properties;
  return { ...tool, inputSchema: { ...tool.inputSchema, properties } };
}

export function toolsForPrincipal({ privilegedMember, shadowMember }) {
  if (privilegedMember) {
    return TOOL_DEFINITIONS.filter((tool) => !(shadowMember && SHADOW_UNAVAILABLE_TOOLS.has(tool.name)));
  }
  return TOOL_DEFINITIONS
    .filter((tool) => !CAPTAIN_ONLY_TOOL_NAMES.includes(tool.name))
    .map(withoutWorkspace);
}

export function assertToolAccess(name, { privilegedMember, shadowMember }) {
  if (!privilegedMember && CAPTAIN_ONLY_TOOL_NAMES.includes(name)) {
    throw new Error('captain/admin-only tools are not available to member sessions: team panel, workspace switch, routing and model policy (agent_teams_model)');
  }
  if (shadowMember && SHADOW_UNAVAILABLE_TOOLS.has(name)) {
    throw new Error(`${name} requires the captain/admin token; the shadow cannot start itself, open the captain panel, or spawn workspace contractors`);
  }
}
