import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { PANEL_STARTUP_RULE } from '../src/domain/prompt-rules.mjs';

const script = fileURLToPath(new URL('../scripts/session-start.mjs', import.meta.url));
const emptyDiscoveryBase = mkdtempSync(join(tmpdir(), 'ai-agent-teams-hook-discovery-'));
process.on('exit', () => rmSync(emptyDiscoveryBase, { recursive: true, force: true }));

function runHook(input, env = {}) {
  const result = spawnSync(process.execPath, [script], {
    input,
    encoding: 'utf8',
    env: {
      ...process.env,
      ZCODE_SESSION_ID: '',
      AI_AGENT_TEAMS_WORKER: '',
      AI_AGENT_TEAMS_AUTO_PANEL: '',
      AGENT_TEAMS_DISCOVERY_BASE: emptyDiscoveryBase,
      ...env,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function workspace(withState) {
  const dir = mkdtempSync(join(tmpdir(), 'ai-agent-teams-hook-'));
  if (withState) mkdirSync(join(dir, '.ai-agent-teams'));
  return dir;
}

test('SessionStart hook is silent by default even in a team workspace', () => {
  const team = workspace(true);
  const other = workspace(false);
  try {
    // A team config is not evidence that this request is a team task: a plain
    // "run the tests" message must not open the panel.
    assert.equal(runHook(JSON.stringify({ source: 'startup', cwd: team })), '');
    assert.equal(runHook(JSON.stringify({ source: 'clear', cwd: team })), '');
    assert.equal(runHook(JSON.stringify({ source: 'startup', cwd: other })), '');
  } finally {
    rmSync(team, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

test('SessionStart hook is silent by default even when a live daemon exists', () => {
  const base = mkdtempSync(join(tmpdir(), 'ai-agent-teams-hook-live-'));
  const team = workspace(true);
  const other = workspace(false);
  const discoveryPath = join(base, 'workspaces', 'a', 'runtime.json');
  mkdirSync(join(base, 'workspaces', 'a'), { recursive: true });
  writeFileSync(discoveryPath, JSON.stringify({
    port: 8779, token: 'token-a', pid: process.pid, version: '0.1.7',
    workspace: team, startedAt: Date.now(), apiVersion: 'v1',
  }), 'utf8');
  try {
    assert.equal(runHook(JSON.stringify({ source: 'startup', cwd: other }), { AGENT_TEAMS_DISCOVERY_BASE: base }), '');
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(team, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

test('SessionStart hook injects only with an explicit captain/UI opt-in', () => {
  const team = workspace(true);
  const other = workspace(false);
  try {
    const forced = runHook(JSON.stringify({ source: 'startup', cwd: other }), { AI_AGENT_TEAMS_AUTO_PANEL: '1' });
    const parsed = JSON.parse(forced);
    // The host schema is strict; an extra key would discard the whole payload.
    assert.deepEqual(Object.keys(parsed).sort(), ['additionalContext', 'hookEventName']);
    assert.equal(parsed.hookEventName, 'SessionStart');
    assert.match(parsed.additionalContext, /agent_teams_view/);
    // The payload reaches a model, so it is English only; the shared constant
    // is the single definition the MCP initialize response also uses.
    assert.equal(parsed.additionalContext, PANEL_STARTUP_RULE);
    assert.doesNotMatch(parsed.additionalContext, /[\u3400-\u9fff]/u);
    // clear is a new conversation and receives the same opt-in instruction.
    assert.match(JSON.parse(runHook(JSON.stringify({ source: 'clear', cwd: team }), { AI_AGENT_TEAMS_AUTO_PANEL: '1' })).additionalContext, /agent_teams_view/);
  } finally {
    rmSync(team, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

test('SessionStart hook stays silent on resume and in worker sessions even when opted in', () => {
  const team = workspace(true);
  try {
    assert.equal(runHook(JSON.stringify({ source: 'resume', cwd: team }), { AI_AGENT_TEAMS_AUTO_PANEL: '1' }), '');
    assert.equal(runHook(JSON.stringify({ source: 'compact', cwd: team }), { AI_AGENT_TEAMS_AUTO_PANEL: '1' }), '');
    assert.equal(runHook(JSON.stringify({ source: 'startup', cwd: team }), { AI_AGENT_TEAMS_AUTO_PANEL: '1', AI_AGENT_TEAMS_WORKER: '1' }), '');
  } finally {
    rmSync(team, { recursive: true, force: true });
  }
});

test('SessionStart hook fails closed on malformed input when opted in', () => {
  const team = workspace(true);
  try {
    assert.equal(runHook('not json', { AI_AGENT_TEAMS_AUTO_PANEL: '1' }), '');
    assert.equal(runHook(JSON.stringify({ source: 'startup', cwd: team }), { AI_AGENT_TEAMS_AUTO_PANEL: '0' }), '');
  } finally {
    rmSync(team, { recursive: true, force: true });
  }
});
