import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  clearActiveWorkspace, hasTeamConfig, listDiscoveries, readActiveWorkspace,
  readLiveDiscoveryForWorkspace, resolveWorkspaceTarget, workspaceSummary, writeActiveWorkspace,
} from '../workspace-target.mjs';

function workspaceKey(value) {
  const path = resolve(value);
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

export function createWorkspaceSelection(options = {}) {
  const startupWorkspace = resolve(options.workspace ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
  const statePath = options.statePath;
  const injectedDiscoveries = options.discoveries;
  const callContext = new AsyncLocalStorage();
  let activeWorkspace;

  function targetFor(explicit) {
    return resolveWorkspaceTarget({
      explicit,
      envValue: process.env.AGENT_TEAMS_WORKSPACE,
      startupWorkspace,
      active: activeWorkspace,
      statePath,
      ...(injectedDiscoveries ? { discoveries: injectedDiscoveries } : {}),
    });
  }

  function workspaceForCall() {
    return callContext.getStore()?.workspace ?? targetFor().workspace;
  }

  function runForWorkspace(workspace, callback) {
    return callContext.run({ workspace }, callback);
  }

  const handlers = {
    async agent_teams_workspace(args) {
      const action = args.action ?? 'current';
      if (action === 'list') {
        const current = workspaceForCall();
        const discoveries = injectedDiscoveries ?? listDiscoveries();
        const seen = new Set();
        const workspaces = [];
        for (const item of discoveries) {
          const key = workspaceKey(item.workspace);
          if (seen.has(key)) continue;
          seen.add(key);
          workspaces.push(workspaceSummary(item.workspace, { discoveries, current }));
        }
        for (const candidate of [activeWorkspace, readActiveWorkspace(statePath), current, startupWorkspace]) {
          if (!candidate) continue;
          const key = workspaceKey(candidate);
          if (seen.has(key)) continue;
          seen.add(key);
          workspaces.push(workspaceSummary(candidate, { discoveries, current }));
        }
        workspaces.sort((left, right) => Number(right.current) - Number(left.current));
        return {
          current,
          source: targetFor().source,
          startupWorkspace,
          workspaces,
          hint: 'Use agent_teams_workspace use with a workspace path to switch projects; projects A and B can be switched back and forth in one session.',
        };
      }
      if (action === 'use') {
        if (!args.workspace) throw new Error('action=use requires a workspace directory');
        const selected = resolve(args.workspace);
        if (!existsSync(selected)) throw new Error(`workspace does not exist: ${selected}`);
        if (!hasTeamConfig(selected) && !readLiveDiscoveryForWorkspace(selected)) {
          throw new Error(`workspace ${selected} has no team config or live daemon. Run the install wizard/start the daemon in that directory first, or switch to a directory that already has teams.`);
        }
        // Persist first: a failed write must not leave the in-memory target
        // pointing at a workspace this process cannot remember.
        writeActiveWorkspace(selected, statePath);
        activeWorkspace = selected;
        return {
          ...workspaceSummary(selected, {
            current: selected,
            ...(injectedDiscoveries ? { discoveries: injectedDiscoveries } : {}),
          }),
          source: 'active',
          startupWorkspace,
          hint: 'Every subsequent team tool and the panel use this workspace; auto restores automatic selection.',
        };
      }
      if (action === 'auto') {
        activeWorkspace = undefined;
        clearActiveWorkspace(statePath);
        const target = targetFor();
        return {
          ...workspaceSummary(target.workspace, {
            ...(injectedDiscoveries ? { discoveries: injectedDiscoveries } : {}),
          }),
          source: target.source,
          fallback: target.fallback,
          startupWorkspace,
          hint: 'Manual selection cleared; the current workspace follows the session config or the most recent daemon.',
        };
      }
      if (action !== 'current') throw new Error(`unknown workspace action: ${action}`);
      const target = targetFor();
      return {
        ...workspaceSummary(target.workspace, {
          ...(injectedDiscoveries ? { discoveries: injectedDiscoveries } : {}),
        }),
        source: target.source,
        fallback: target.fallback,
        startupWorkspace,
        savedWorkspace: readActiveWorkspace(statePath) ?? null,
        activeWorkspace: activeWorkspace ?? null,
      };
    },
  };

  return {
    startupWorkspace,
    targetFor,
    workspaceForCall,
    runForWorkspace,
    handle: handlers.agent_teams_workspace,
  };
}
