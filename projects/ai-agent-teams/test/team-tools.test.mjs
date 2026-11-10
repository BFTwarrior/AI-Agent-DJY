import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MEMBER_MCP_SERVER_NAME,
  PLUGIN_MCP_TOOL_PREFIX,
  TEAM_TOOL_NAMES,
  contractorToolDenylist,
  pluginTeamToolDenylist,
} from '../src/domain/team-tools.mjs';

test('contractor denylist covers every host tool-name shape', () => {
  const names = contractorToolDenylist();
  assert.equal(names.length, TEAM_TOOL_NAMES.length * 4);
  for (const name of TEAM_TOOL_NAMES) {
    assert.ok(names.includes(name));
    assert.ok(names.includes(`mcp__agent-teams__${name}`));
    assert.ok(names.includes(`mcp__${MEMBER_MCP_SERVER_NAME}__${name}`));
    assert.ok(names.includes(`${PLUGIN_MCP_TOOL_PREFIX}${name}`));
  }
});

test('member denylist blocks the plugin admin server but keeps the member server', () => {
  const names = pluginTeamToolDenylist();
  assert.equal(names.length, TEAM_TOOL_NAMES.length * 3);
  assert.ok(names.every((name) => !name.startsWith(`mcp__${MEMBER_MCP_SERVER_NAME}__`)));
  for (const name of TEAM_TOOL_NAMES) {
    assert.ok(names.includes(`${PLUGIN_MCP_TOOL_PREFIX}${name}`));
  }
});
