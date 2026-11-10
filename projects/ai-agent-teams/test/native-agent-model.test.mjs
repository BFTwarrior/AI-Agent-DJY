import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createNativeAgentModelReader, NativeAgentModelError } from '../src/native-agent-model.mjs';

const PLUGIN_ID = 'ai-agent-teams@test-market';
const AGENT_ID = `plugin:${PLUGIN_ID}:team-worker`;
const SELECTION = { providerId: 'custom-provider', modelId: 'deepseek-chat' };

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'native-agent-model-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const home = join(root, 'home');
  const pluginRoot = join(root, 'plugin');
  const storageRoot = join(home, '.zcode');
  const configPath = join(storageRoot, 'cli', 'config.json');
  const statePath = join(storageRoot, 'v2', 'agents-state.json');
  const installedPath = join(storageRoot, 'cli', 'plugins', 'installed_plugins.json');
  const manifestPath = join(pluginRoot, '.zcode-plugin', 'plugin.json');
  const entry = { id: PLUGIN_ID, name: 'ai-agent-teams', marketplace: 'test-market', installPath: pluginRoot, version: '0.1.9' };
  writeJson(manifestPath, { name: 'ai-agent-teams', version: '0.1.9' });
  writeJson(configPath, { plugins: { enabledPlugins: { [PLUGIN_ID]: true } } });
  writeJson(installedPath, { version: 1, plugins: [entry] });
  writeJson(statePath, { pluginAgentModelSelectionOverrides: { [AGENT_ID]: SELECTION } });
  const options = { homeDir: home, env: {}, cwd: root, pluginRoot };
  return { root, home, pluginRoot, storageRoot, configPath, statePath, installedPath, manifestPath, entry,
    read: (extra = {}) => createNativeAgentModelReader({ ...options, ...extra }).read(),
    reader: (extra = {}) => createNativeAgentModelReader({ ...options, ...extra }),
  };
}

function rejectsCode(fn, code) {
  assert.throws(fn, (error) => error instanceof NativeAgentModelError && error.code === `NATIVE_AGENT_${code}`);
}

test('native model reader returns the complete selection and leaves all input files untouched', (t) => {
  const f = fixture(t);
  const paths = [f.manifestPath, f.configPath, f.statePath, f.installedPath];
  const before = paths.map((path) => readFileSync(path));
  const value = f.read();
  assert.deepEqual(value, {
    source: 'native-agent', pluginId: PLUGIN_ID, agentId: AGENT_ID,
    modelSelection: SELECTION, model: 'custom-provider/deepseek-chat', reasoning: null,
    signature: value.signature,
  });
  assert.match(value.signature, /^[a-f0-9]{64}$/);
  paths.forEach((path, index) => assert.deepEqual(readFileSync(path), before[index]));
});

test('missing state and missing override restore inherit without requiring an installation', (t) => {
  const f = fixture(t);
  rmSync(f.statePath);
  rmSync(f.installedPath);
  const missing = f.read();
  assert.equal(missing.source, 'inherit');
  assert.equal(missing.pluginId, null);
  assert.equal(missing.agentId, null);
  assert.equal(missing.modelSelection, null);
  assert.equal(missing.model, null);
  assert.equal(missing.reasoning, null);
  writeJson(f.statePath, { pluginAgentModelSelectionOverrides: {} });
  assert.equal(f.read().signature, missing.signature);
  rmSync(f.configPath);
  assert.equal(f.read().signature, missing.signature);
});

test('override removal and reasoning-only edits are observed without restarting the reader', (t) => {
  const f = fixture(t);
  const reader = f.reader();
  const first = reader.read();
  writeJson(f.statePath, { pluginAgentModelSelectionOverrides: {
    [AGENT_ID]: { ...SELECTION, options: { reasoningLevel: 'high' } },
  } });
  const second = reader.read();
  assert.equal(second.reasoning, 'high');
  assert.notEqual(second.signature, first.signature);
  writeJson(f.statePath, { pluginAgentModelSelectionOverrides: { [AGENT_ID]: { ...SELECTION, modelId: 'deepseek-reasoner' } } });
  const third = reader.read();
  assert.equal(third.reasoning, null);
  assert.notEqual(third.signature, first.signature);
  writeJson(f.statePath, { pluginAgentModelSelectionOverrides: {} });
  assert.equal(reader.read().source, 'inherit');
  assert.notEqual(reader.read().signature, first.signature);
});

test('selection signatures ignore formatting, empty options and unrelated invalid profiles', (t) => {
  const f = fixture(t);
  const before = f.read();
  writeJson(f.statePath, { disabledAgentIds: ['plugin:unrelated@market:worker'], pluginAgentModelSelectionOverrides: {
    'plugin:unrelated@market:worker': null,
    [AGENT_ID]: { options: {}, modelId: ` ${SELECTION.modelId} `, providerId: ` ${SELECTION.providerId} ` },
  } });
  assert.deepEqual(f.read(), before);
  writeJson(f.statePath, { pluginAgentModelSelectionOverrides: { 'plugin:unrelated@market:worker': 42 } });
  assert.equal(f.read().source, 'inherit');
});

test('structured selection preserves slashes and dollar signs in model and provider identities', (t) => {
  const f = fixture(t);
  const selection = { providerId: 'custom/provider', modelId: 'vendor/model$literal', options: { reasoningLevel: 'medium' } };
  writeJson(f.statePath, { pluginAgentModelSelectionOverrides: { [AGENT_ID]: selection } });
  assert.deepEqual(f.read().modelSelection, selection);
});

test('malformed explicit selections fail closed instead of falling back to a host model', (t) => {
  const f = fixture(t);
  for (const selection of [null, [], 'provider/model', {}, { providerId: '', modelId: 'model' },
    { providerId: 1, modelId: 'model' }, { providerId: 'provider', modelId: null },
    { ...SELECTION, extra: true }, { ...SELECTION, options: null }, { ...SELECTION, options: [] },
    { ...SELECTION, options: { reasoningLevel: '' } }, { ...SELECTION, options: { reasoningLevel: false } },
    { ...SELECTION, options: { temperature: 1 } }]) {
    writeJson(f.statePath, { pluginAgentModelSelectionOverrides: { [AGENT_ID]: selection } });
    rejectsCode(() => f.read(), 'SELECTION_INVALID');
  }
});

test('malformed JSON and non-object state fail with sanitized stable diagnostics', (t) => {
  const f = fixture(t);
  const privateMarker = 'do-not-expose-invalid-document-content';
  writeFileSync(f.statePath, privateMarker);
  assert.throws(() => f.read(), (error) => {
    assert.equal(error.code, 'NATIVE_AGENT_STATE_INVALID');
    assert.equal(error.message.includes(privateMarker), false);
    assert.equal(error.message.includes(f.home), false);
    return true;
  });
  for (const state of [null, [], 1, false]) {
    writeJson(f.statePath, state);
    rejectsCode(() => f.read(), 'STATE_INVALID');
  }
  for (const map of [null, [], 1]) {
    writeJson(f.statePath, { pluginAgentModelSelectionOverrides: map });
    rejectsCode(() => f.read(), 'STATE_INVALID');
  }
});

test('unreadable state and config errors are visible instead of becoming inherit', (t) => {
  const f = fixture(t);
  rmSync(f.statePath);
  mkdirSync(f.statePath);
  rejectsCode(() => f.read(), 'STATE_READ_FAILED');
  writeFileSync(f.configPath, '{');
  rejectsCode(() => f.read(), 'CONFIG_INVALID');
});

test('legacy target maps require host migration and cannot override an existing modern map', (t) => {
  const f = fixture(t);
  const legacy = { pluginAgentModelOverrides: { [AGENT_ID]: 'provider/model' } };
  writeJson(f.statePath, legacy);
  rejectsCode(() => f.read(), 'STATE_LEGACY');
  writeJson(f.statePath, { pluginAgentThoughtLevelOverrides: { [AGENT_ID]: 'high' } });
  rejectsCode(() => f.read(), 'STATE_LEGACY');
  writeJson(f.statePath, { ...legacy, pluginAgentModelSelectionOverrides: {} });
  assert.equal(f.read().source, 'inherit');
  writeJson(f.statePath, { pluginAgentModelOverrides: { 'plugin:unrelated@market:worker': 'provider/model' } });
  assert.equal(f.read().source, 'inherit');
});

test('explicit plugin identity bypasses registry lookup but must match the manifest', (t) => {
  const f = fixture(t);
  rmSync(f.installedPath);
  assert.equal(f.read({ pluginId: PLUGIN_ID }).source, 'native-agent');
  for (const pluginId of ['other@test-market', 'ai-agent-teams', 'ai-agent-teams@', 'ai-agent-teams@one@two', null]) {
    rejectsCode(() => f.read({ pluginId }), 'IDENTITY_INVALID');
  }
  writeJson(f.statePath, { pluginAgentModelSelectionOverrides: {} });
  assert.equal(f.read({ pluginId: PLUGIN_ID }).agentId, AGENT_ID);
});

test('same-name installations use exact physical root rather than first matching name', (t) => {
  const f = fixture(t);
  const otherRoot = join(f.root, 'another-install');
  mkdirSync(otherRoot);
  writeJson(f.installedPath, { plugins: [
    { ...f.entry, id: 'ai-agent-teams@other-market', marketplace: 'other-market', installPath: otherRoot }, f.entry,
  ] });
  writeJson(f.statePath, { pluginAgentModelSelectionOverrides: {
    'plugin:ai-agent-teams@other-market:team-worker': { providerId: 'other', modelId: 'wrong' }, [AGENT_ID]: SELECTION,
  } });
  assert.equal(f.read().pluginId, PLUGIN_ID);
  assert.deepEqual(f.read().modelSelection, SELECTION);
});

test('a verified installation without its own selection does not borrow another marketplace pin', (t) => {
  const f = fixture(t);
  writeJson(f.statePath, { pluginAgentModelSelectionOverrides: {
    'plugin:ai-agent-teams@other-market:team-worker': SELECTION,
  } });
  const value = f.read();
  assert.equal(value.source, 'inherit');
  assert.equal(value.pluginId, PLUGIN_ID);
});

test('unknown source roots, missing registries and ambiguous identities fail closed when a pin exists', (t) => {
  const f = fixture(t);
  const otherRoot = join(f.root, 'other');
  mkdirSync(otherRoot);
  writeJson(f.installedPath, { plugins: [{ ...f.entry, installPath: otherRoot }] });
  rejectsCode(() => f.read(), 'IDENTITY_UNRESOLVED');
  rmSync(f.installedPath);
  rejectsCode(() => f.read(), 'IDENTITY_UNRESOLVED');
  writeJson(f.installedPath, { plugins: [f.entry, { ...f.entry, id: 'ai-agent-teams@other-market', marketplace: 'other-market' }] });
  rejectsCode(() => f.read(), 'IDENTITY_AMBIGUOUS');
});

test('invalid matching installation metadata is not used as an identity', (t) => {
  const f = fixture(t);
  writeJson(f.installedPath, { plugins: [null, { ...f.entry, marketplace: 'wrong' }] });
  rejectsCode(() => f.read(), 'IDENTITY_INVALID');
  writeJson(f.installedPath, { plugins: {} });
  rejectsCode(() => f.read(), 'REGISTRY_INVALID');
  writeJson(f.installedPath, { plugins: [null, {}, { ...f.entry, installPath: 'relative/path' },
    { ...f.entry, installPath: join(f.root, 'gone') }] });
  rejectsCode(() => f.read(), 'IDENTITY_UNRESOLVED');
});

test('directory junction or symlink aliases resolve to the same installed plugin identity', (t) => {
  const f = fixture(t);
  const alias = join(f.root, 'plugin-alias');
  symlinkSync(f.pluginRoot, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(f.read({ pluginRoot: alias }).pluginId, PLUGIN_ID);
});

test('runtime packages inherit only their verified stable-shell plugin identity', (t) => {
  const f = fixture(t);
  const runtimeRoot = join(f.pluginRoot, 'runtime', 'versions', '0.1.9-abc123');
  mkdirSync(runtimeRoot, { recursive: true });
  assert.equal(f.read({ pluginRoot: runtimeRoot }).pluginId, PLUGIN_ID);
  const arbitraryChild = join(f.pluginRoot, 'nested', 'copy');
  mkdirSync(arbitraryChild, { recursive: true });
  rejectsCode(() => f.read({ pluginRoot: arbitraryChild }), 'IDENTITY_MANIFEST_INVALID');
});

test('runtime parent junction or symlink escaping the installed plugin is rejected', (t) => {
  const f = fixture(t);
  const outsideVersions = join(f.root, 'outside-versions');
  mkdirSync(join(outsideVersions, '0.1.9-abc123'), { recursive: true });
  mkdirSync(join(f.pluginRoot, 'runtime'));
  symlinkSync(outsideVersions, join(f.pluginRoot, 'runtime', 'versions'), process.platform === 'win32' ? 'junction' : 'dir');
  rejectsCode(() => f.read({ pluginRoot: join(f.pluginRoot, 'runtime', 'versions', '0.1.9-abc123') }), 'IDENTITY_PATH_INVALID');
});

test('missing or malformed plugin manifests cannot manufacture an identity', (t) => {
  const f = fixture(t);
  rmSync(f.manifestPath);
  rejectsCode(() => f.read(), 'IDENTITY_MANIFEST_INVALID');
  writeJson(f.manifestPath, { name: '../wrong' });
  rejectsCode(() => f.read(), 'IDENTITY_MANIFEST_INVALID');
  rejectsCode(() => f.read({ agentName: '' }), 'IDENTITY_INVALID');
});

test('selected disabled agents and explicitly disabled plugins do not silently run a fallback', (t) => {
  const f = fixture(t);
  writeJson(f.statePath, { disabledAgentIds: [AGENT_ID], pluginAgentModelSelectionOverrides: { [AGENT_ID]: SELECTION } });
  rejectsCode(() => f.read(), 'DISABLED');
  writeJson(f.statePath, { pluginAgentModelSelectionOverrides: { [AGENT_ID]: SELECTION } });
  for (const plugins of [{ enabled: false }, { enabledPlugins: { [PLUGIN_ID]: false } }, { suppressedBuiltins: [PLUGIN_ID] }]) {
    writeJson(f.configPath, { plugins });
    rejectsCode(() => f.read(), 'DISABLED');
  }
});

test('storage.dir controls both native state and the installed registry including a cli root', (t) => {
  const f = fixture(t);
  for (const directory of ['~/custom-storage', 'relative-storage', join(f.root, 'absolute-storage'), join(f.root, 'custom', 'cli')]) {
    const storage = directory.startsWith('~/') ? join(f.home, directory.slice(2)) : resolve(f.root, directory);
    const cli = directory.endsWith('cli') ? storage : join(storage, 'cli');
    writeJson(f.configPath, { storage: { dir: directory } });
    writeJson(join(storage, 'v2', 'agents-state.json'), { pluginAgentModelSelectionOverrides: { [AGENT_ID]: SELECTION } });
    writeJson(join(cli, 'plugins', 'installed_plugins.json'), { plugins: [f.entry] });
    assert.equal(f.read().pluginId, PLUGIN_ID);
  }
});

test('changing storage.dir is observed by an existing reader', (t) => {
  const f = fixture(t);
  const reader = f.reader();
  assert.equal(reader.read().source, 'native-agent');
  writeJson(f.configPath, { storage: { dir: '~/new-empty-storage' } });
  assert.equal(reader.read().source, 'inherit');
});

test('home override precedence matches native Settings and ignores ZCODE_HOME', (t) => {
  const f = fixture(t);
  const emptyHome = join(f.root, 'empty-home');
  assert.equal(f.read({ env: { HOME: emptyHome, USERPROFILE: emptyHome, ZCODE_HOME: emptyHome } }).source, 'native-agent');
  assert.equal(f.read({ homeDir: undefined, env: { HOME: f.home, USERPROFILE: emptyHome, ZCODE_HOME: emptyHome } }).source, 'native-agent');
  assert.equal(f.read({ homeDir: undefined, env: { HOME: ' ', USERPROFILE: f.home, ZCODE_HOME: emptyHome } }).source, 'native-agent');
  assert.equal(f.read({ homeDir: undefined, env: { HOME: emptyHome, USERPROFILE: f.home, ZCODE_HOME: f.home } }).source, 'inherit');
});

test('explicit test paths isolate config, state and registry without reading real user files', (t) => {
  const f = fixture(t);
  const configPath = join(f.root, 'injected-config.json');
  const statePath = join(f.root, 'injected-state.json');
  const installedPluginsPath = join(f.root, 'injected-registry.json');
  writeJson(configPath, {});
  writeJson(statePath, { pluginAgentModelSelectionOverrides: { [AGENT_ID]: SELECTION } });
  writeJson(installedPluginsPath, { plugins: [f.entry] });
  rmSync(f.storageRoot, { recursive: true, force: true });
  assert.equal(f.read({ configPath, statePath, installedPluginsPath }).source, 'native-agent');
});
