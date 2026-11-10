import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { UI_RESOURCE_URI } from '../src/mcp/handler.mjs';
import { DESCRIPTION_I18N, SURFACE_TITLE_I18N, marketplaceDocument } from '../src/plugin-metadata.mjs';

const manifest = JSON.parse(readFileSync(new URL('../.zcode-plugin/plugin.json', import.meta.url), 'utf8'));
const repoMarketplace = JSON.parse(readFileSync(new URL('../marketplace.json', import.meta.url), 'utf8'));

// `description_i18n` keys follow the host convention: the bare `en`, not
// `en-US`. A missing or blank translation renders an empty card in the plugin
// browser, so every key must be present and non-empty.
const DESCRIPTION_KEYS = ['en', 'zh-CN', 'ja-JP', 'ko-KR'];
const TITLE_KEYS = ['zh-CN', 'en-US', 'ja-JP', 'ko-KR'];

function assertCompleteTranslations(value, keys, label) {
  assert.ok(value && typeof value === 'object', `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} keys`);
  for (const key of keys) {
    assert.equal(typeof value[key], 'string', `${label}[${key}] must be a string`);
    assert.ok(value[key].trim().length > 0, `${label}[${key}] must not be empty`);
  }
}

test('plugin manifest exposes the team panel as a session UI surface', () => {
  const surfaces = manifest.ui?.surfaces;
  assert.ok(Array.isArray(surfaces), 'ui.surfaces must be an array');
  assert.equal(surfaces.length, 1, 'exactly one team surface is expected');
  const surface = surfaces.find((item) => item.id === 'ai-agent-teams');
  assert.ok(surface, 'ai-agent-teams surface must exist');
  assert.equal(surface.availability, 'session');
  assert.equal(surface.resourceUri, UI_RESOURCE_URI);
  assert.match(surface.resourceUri, /^ui:\/\//);
  assert.equal(surface.server, 'agent-teams');
  assert.ok(manifest.mcpServers?.[surface.server], 'surface server must be declared in mcpServers');
  assert.ok(surface.title?.['zh-CN'], 'surface needs a zh-CN title');
  assert.ok(surface.title?.['en-US'], 'surface needs an en-US title');
  assert.ok(surface.icon, 'surface needs an icon');
  assert.equal(new Set(surfaces.map((item) => item.id)).size, surfaces.length, 'surface ids must be unique');
});

test('plugin and marketplace metadata carry four languages', () => {
  assertCompleteTranslations(manifest.description_i18n, DESCRIPTION_KEYS, 'plugin.json description_i18n');
  assertCompleteTranslations(manifest.ui.surfaces[0].title, TITLE_KEYS, 'plugin.json ui.surfaces[0].title');
  assert.equal(manifest.ui.surfaces[0].title['zh-CN'], SURFACE_TITLE_I18N['zh-CN']);

  const entry = repoMarketplace.plugins.find((item) => item.name === 'ai-agent-teams');
  assert.ok(entry, 'marketplace.json has no ai-agent-teams entry');
  assertCompleteTranslations(entry.description_i18n, DESCRIPTION_KEYS, 'marketplace.json description_i18n');
  assert.ok(entry.displayName_i18n?.['zh-CN'], 'marketplace displayName_i18n keeps zh-CN');
  // The English description is the manifest `description`, so a viewer that
  // ignores `_i18n` shows the same sentence as an English catalog entry.
  assert.equal(entry.description_i18n.en, entry.description);
  assert.equal(manifest.description_i18n.en, manifest.description);
});

test('the packaged marketplace entry is built with the same four languages', () => {
  const document = marketplaceDocument({ version: '9.9.9', source: './ai-agent-teams-v9.9.9' });
  const entry = document.plugins[0];
  assert.equal(document.name, 'ai-agent-teams-local');
  assert.equal(entry.version, '9.9.9');
  assert.equal(entry.source, './ai-agent-teams-v9.9.9');
  assertCompleteTranslations(entry.description_i18n, DESCRIPTION_KEYS, 'packaged description_i18n');
  assert.deepEqual(entry.description_i18n, DESCRIPTION_I18N);
  // The product name is never translated; only a localized display name is added.
  assert.equal(entry.displayName, manifest.displayName);
  assert.equal(entry.title, undefined, 'a marketplace entry has no UI surface');
});


test('plugin exposes one shared native worker model entry with an English prompt', () => {
  assert.equal(manifest.agents, './agents');
  const template = readFileSync(new URL('../agents/team-worker.md', import.meta.url), 'utf8');
  assert.match(template, /^---\r?\nname: team-worker\r?\n/);
  assert.match(template, /^description: .+Settings \/ Subagents/m);
  assert.doesNotMatch(template, /[\u3400-\u9fff]/u);
  assert.doesNotMatch(template.split('---')[1], /^model:/m, 'inherit the host selection by default');
  assert.match(template, /not a second scheduler/);
  assert.match(template, /current attempt ID/i);
});

test('plugin manifest declares an existing SessionStart hook', () => {
  assert.equal(manifest.hooks, './hooks/hooks.json');
  const hooks = JSON.parse(readFileSync(new URL('../hooks/hooks.json', import.meta.url), 'utf8'));
  const sessionStart = hooks.hooks?.SessionStart;
  assert.ok(Array.isArray(sessionStart) && sessionStart.length > 0);
  const command = sessionStart[0].hooks?.[0];
  assert.equal(command?.type, 'command');
  assert.match(command.command, /session-start\.mjs/);
  assert.match(command.command, /\$\{CLAUDE_PLUGIN_ROOT\}/);
  // The referenced script must exist inside the plugin, not only in the source tree.
  assert.ok(readFileSync(new URL('../scripts/session-start.mjs', import.meta.url), 'utf8').includes('hookEventName'));
});
