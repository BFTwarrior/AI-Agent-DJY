import { readFileSync } from 'node:fs';
import { openPanel, panelInfo, panelInstructions } from '../panel.mjs';
import { AUTO_PANEL_ENV, PANEL_STARTUP_RULE } from '../domain/prompt-rules.mjs';
import { UI_RESOURCE_MIME, UI_RESOURCE_URI, TOOL_DEFINITIONS } from './tool-definitions.mjs';
import { assertToolAccess, toolsForPrincipal } from './tool-access.mjs';
import { createMcpApi } from './api-client.mjs';
import { createMcpToolHandlers } from './tool-handlers.mjs';
import { createWorkspaceSelection } from './workspace-selection.mjs';
import { hasTeamConfig, readLiveDiscoveryForWorkspace } from '../workspace-target.mjs';

const PACKAGE_VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
const PANEL_PATH = new URL('../../assets/team-panel.html', import.meta.url);

export { PANEL_STARTUP_RULE, TOOL_DEFINITIONS, UI_RESOURCE_MIME, UI_RESOURCE_URI };

/**
 * Create a JSON-RPC handler for the MCP stdio server.
 * @param {{ fetchImpl?: Function, baseUrl?: string, token?: string, uiKey?: string, defaultTeam?: string, defaultMember?: string, workspace?: string, ensureDaemon?: Function }} [options]
 */
export function createMcpHandler(options = {}) {
  const defaultTeam = options.defaultTeam ?? process.env.AGENT_TEAMS_TEAM;
  const defaultMember = options.defaultMember ?? process.env.AGENT_TEAMS_MEMBER;
  // A shadow is a member principal with the captain's control tools. The
  // daemon sets this flag only on the shadow session it creates; ordinary
  // member sessions never receive it.
  const shadowMember = options.shadowMember ?? process.env.AGENT_TEAMS_SHADOW === '1';
  const privilegedMember = !defaultMember || shadowMember;
  const selection = createWorkspaceSelection(options);
  const { api, connection, loadViewSnapshot } = createMcpApi({ options, defaultMember, workspaceForCall: selection.workspaceForCall });
  const handlers = {
    ...createMcpToolHandlers({
      api,
      loadViewSnapshot,
      workspaceForCall: selection.workspaceForCall,
      defaultTeam,
      defaultMember,
      openPanelImpl: options.openPanelImpl ?? openPanel,
    }),
    agent_teams_workspace: selection.handle,
  };
  const { targetFor, runForWorkspace } = selection;

  return async function handle(request) {
    const id = request?.id ?? null;
    try {
      if (request?.method === 'initialize') {
        let instructions;
        const target = targetFor();
        const workspace = target.workspace;
        if (!defaultMember) {
          try {
            const conn = connection(workspace);
            const info = panelInfo({ discovery: null, workspace, baseUrl: conn.baseUrl, uiKey: conn.uiKey });
            instructions = panelInstructions({
              ...info,
              discovered: Boolean(conn.baseUrl),
              running: Boolean(conn.baseUrl),
              workspaceMatch: true,
            }, { includeAccessKey: false, language: 'en' });
          } catch {
            try {
              instructions = panelInstructions(panelInfo({ workspace }), { includeAccessKey: false, language: 'en' });
            } catch {
              instructions = undefined;
            }
          }
        }
        if (instructions) {
          const hasTeam = hasTeamConfig(workspace) || Boolean(readLiveDiscoveryForWorkspace(workspace));
          const autoPanel = process.env[AUTO_PANEL_ENV] === '1';
          instructions = `${instructions}\n\nCurrent team workspace: ${workspace}\nCall agent_teams_workspace (list/use/auto) when you need to switch projects.${hasTeam ? '\n\nAutomatic team rule: before starting any non-trivial task, call agent_teams_route (independent_subtasks/review_angles/estimated_minutes/changed_files/code_task/simple_test). When it returns mode=team, create and approve the team without asking the user; when it returns mode=direct, finish single-threaded. Create a team when the work splits into 2 or more independent subtasks, needs multiple review perspectives, or is expected to take more than 10 minutes single-threaded; ordinary tests, Q&A and single small edits do not need a team.' : ''}${autoPanel ? `\n\n${PANEL_STARTUP_RULE}` : ''}`;
        }
        return {
          jsonrpc: '2.0', id,
          result: {
            protocolVersion: request.params?.protocolVersion ?? '2024-11-05',
            capabilities: { tools: {}, resources: {} },
            serverInfo: { name: 'ai-agent-teams', version: PACKAGE_VERSION },
            ...(instructions ? { instructions } : {}),
          },
        };
      }
      if (request?.method === 'notifications/initialized') return null;
      if (request?.method === 'tools/list') {
        const tools = toolsForPrincipal({ privilegedMember, shadowMember });
        return { jsonrpc: '2.0', id, result: { tools } };
      }
      if (request?.method === 'resources/list') {
        return {
          jsonrpc: '2.0', id,
          result: {
            resources: privilegedMember && !shadowMember ? [{
              uri: UI_RESOURCE_URI,
              name: 'team-panel',
              title: 'AI Agent Teams team panel',
              description: 'Live read-only team snapshot rendered as an MCP App.',
              mimeType: UI_RESOURCE_MIME,
            }] : [],
          },
        };
      }
      if (request?.method === 'resources/templates/list') {
        return { jsonrpc: '2.0', id, result: { resourceTemplates: [] } };
      }
      if (request?.method === 'resources/read') {
        const uri = request.params?.uri;
        if (!privilegedMember || shadowMember) {
          return { jsonrpc: '2.0', id, error: { code: -32602, message: 'team panel resource is only available to the captain/UI' } };
        }
        if (uri !== UI_RESOURCE_URI) {
          return { jsonrpc: '2.0', id, error: { code: -32602, message: `unknown resource: ${uri}` } };
        }
        const text = (() => {
          try {
            return readFileSync(PANEL_PATH, 'utf8');
          } catch {
            return undefined;
          }
        })();
        if (text === undefined) {
          return { jsonrpc: '2.0', id, error: { code: -32603, message: 'team panel resource is unavailable' } };
        }
        return {
          jsonrpc: '2.0', id,
          result: { contents: [{ uri, mimeType: UI_RESOURCE_MIME, text }] },
        };
      }
      if (request?.method === 'tools/call') {
        const name = request.params?.name;
        assertToolAccess(name, { privilegedMember, shadowMember });
        const handler = handlers[name];
        if (!handler) throw new Error(`unknown tool: ${name}`);
        const args = request.params?.arguments ?? {};
        const target = targetFor(args.workspace);
        const data = await runForWorkspace(target.workspace, () => handler(args));
        const isView = name === 'agent_teams_view' || name === 'agent_teams_view_snapshot';
        const windowNote = data?.window
          ? (data.window.opened
            ? (data.window.appWindow === true
              ? `\n\nStandalone window opened with ${data.window.browser}.`
              : `\n\nOpened with ${data.window.browser} as a tab/normal window (no Chromium --app available).`)
            : `\n\nStandalone window failed to open: ${data.window.error ?? 'unknown error'}`)
          : '';
        const text = isView && data?.viewUrl
          ? `Requested the team panel in the ZCode side pane. If it did not open automatically, use the link or command below.\n\n[Open full task view ↗](${data.viewUrl})\n\nCLI: node src/cli.mjs panel --open (standalone window: --window)${windowNote}`
          : JSON.stringify(data, null, 2);
        return {
          jsonrpc: '2.0', id,
          result: {
            content: [{ type: 'text', text }],
            ...(isView ? { structuredContent: data } : {}),
            isError: false,
          },
        };
      }
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method: ${request?.method}` } };
    } catch (error) {
      return {
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true },
      };
    }
  };

}
