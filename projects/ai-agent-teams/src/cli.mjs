import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from './config.mjs';
import { allocateSlots, validateTaskGraph } from './domain/scheduler.mjs';
import { checkPanel, openPanel, panelInfo, panelInstructions } from './panel.mjs';
import { resolveWorkspaceTarget } from './workspace-target.mjs';

const [, , command, ...args] = process.argv;

function usage() {
  console.log(`ai-agent-teams CLI

Usage:
  node src/cli.mjs validate-config <config.json>
  node src/cli.mjs plan <config.json> <tasks.json>
  node src/cli.mjs panel [--open] [--window] [--json] [--port <port>] [--workspace <dir>]

The panel is loopback-only. "panel --open" opens Edge, then Chrome, then the
default browser; it refuses to open a URL when the daemon is not healthy.
"panel --window" opens the panel as a standalone chromeless app window.
Without --workspace, a folder without team state falls back to the newest
live daemon.
`);
}

function argValue(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith('--')
    ? args[index + 1]
    : fallback;
}

if (command === 'panel') {
  const explicitWorkspace = argValue('--workspace');
  const target = resolveWorkspaceTarget({
    explicit: explicitWorkspace,
    envValue: explicitWorkspace ? undefined : process.env.AGENT_TEAMS_WORKSPACE,
    startupWorkspace: resolve(process.cwd()),
  });
  const workspace = target.workspace;
  if (!args.includes('--json')) {
    console.log(`目标工作区: ${workspace}（${target.source}${target.fallback ? '，已回退' : ''}）`);
  }
  const defaultPort = Number(argValue('--port', process.env.AGENT_TEAMS_PORT ?? 8779));
  const info = await checkPanel(panelInfo({ workspace, defaultPort }), { expectedWorkspace: workspace });
  const instructions = panelInstructions(info);
  if (args.includes('--json')) {
    console.log(JSON.stringify({ ...info, target: { source: target.source, fallback: target.fallback }, instructions }, null, 2));
  } else {
    console.log(instructions);
  }
  const wantWindow = args.includes('--window');
  if (args.includes('--open') || wantWindow) {
    if (!info.discovered) {
      console.error('未找到本工作区的 daemon discovery，未打开面板。');
      process.exit(1);
    }
    if (!info.healthy) {
      console.error('daemon 不可用或工作区不一致，未打开面板。');
      process.exit(1);
    }
    if (!info.workspaceMatch) {
      console.error('daemon 属于另一个工作区，未打开面板。');
      process.exit(1);
    }
    const result = await openPanel(info.url, { mode: wantWindow ? 'window' : 'tab' });
    if (!result.opened) {
      console.error(`打开浏览器失败: ${result.error ?? 'unknown error'}`);
      process.exit(1);
    }
    const openedAsWindow = result.appWindow === true;
    console.log(`已用 ${result.browser} 以${openedAsWindow ? '独立窗口' : '标签页/普通窗口'}打开 ${info.url}`);
  }
  process.exit(0);
}


if (!command || command === '--help' || command === '-h') {
  usage();
  process.exit(0);
}

if (command === 'validate-config') {
  const path = args[0];
  if (!path) {
    console.error('validate-config requires a config path');
    process.exit(2);
  }
  try {
    const { warnings } = loadConfig(path);
    for (const warning of warnings) console.warn(`WARN ${warning}`);
    console.log(`OK ${path}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  process.exit(0);
}

if (command === 'plan') {
  const configPath = args[0];
  const tasksPath = args[1];
  if (!configPath || !tasksPath) {
    console.error('plan requires <config.json> <tasks.json>');
    process.exit(2);
  }
  try {
    const { config, warnings } = loadConfig(configPath);
    const raw = JSON.parse(readFileSync(tasksPath, 'utf8'));
    const tasks = Array.isArray(raw) ? raw : raw.tasks;
    if (!Array.isArray(tasks)) throw new Error('tasks file must contain an array or { tasks: [] }');

    const rosterPath = args[2] ?? 'config/roster.two-teams.json';
    const members = [];
    if (existsSync(rosterPath)) {
      const roster = JSON.parse(readFileSync(rosterPath, 'utf8'));
      for (const [teamId, list] of Object.entries(roster.teams ?? {})) {
        for (const member of list) members.push({ ...member, teamId });
      }
    }
    const graphErrors = validateTaskGraph(tasks, members, {
      teamIds: config.teams.map((team) => team.id),
    });
    if (graphErrors.length > 0) {
      console.error(`invalid task graph:\n- ${graphErrors.join('\n- ')}`);
      process.exit(1);
    }
    const plan = allocateSlots({ config, tasks, active: [] });
    console.log(JSON.stringify({
      ok: true,
      warnings,
      teams: config.teams.map((team) => ({
        id: team.id,
        defaultMembers: team.defaultMembers,
        maxMembers: team.maxMembers,
      })),
      activeWorkerSlots: config.scheduler.activeWorkerSlots,
      maxActivePerTeam: config.scheduler.maxActivePerTeam,
      rosterMembers: members.length,
      ...plan,
    }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  process.exit(0);
}

console.error(`unknown command: ${command}`);
usage();
process.exit(2);
