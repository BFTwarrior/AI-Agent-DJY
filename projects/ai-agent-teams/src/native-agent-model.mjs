import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url));
const NAME = /^[a-z0-9][a-z0-9._-]*$/i;
const own = (value, key) => Object.hasOwn(value, key);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' ? value.trim() : '';

export class NativeAgentModelError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NativeAgentModelError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new NativeAgentModelError(`NATIVE_AGENT_${code}`, message);
}

// Never include JSON contents, parser messages or user paths in diagnostics.
function readJson(path, kind) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    fail(`${kind}_READ_FAILED`, `Cannot read native agent ${kind.toLowerCase()}.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail(`${kind}_INVALID`, `Native agent ${kind.toLowerCase()} is not valid JSON.`);
  }
  if (!record(parsed)) fail(`${kind}_INVALID`, `Native agent ${kind.toLowerCase()} must be an object.`);
  return parsed;
}

function realPath(path, optional = false) {
  try {
    return realpathSync.native(path);
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    fail('IDENTITY_PATH_INVALID', 'Cannot verify the native agent plugin path.');
  }
}

function samePath(left, right) {
  return relative(left, right) === '';
}

function runtimeRelative(path) {
  const parts = path.split(/[\\/]/);
  return parts.length === 3 && parts[0] === 'runtime' && parts[1] === 'versions' && NAME.test(parts[2]);
}

function pluginContext(pluginRoot) {
  const codeRoot = resolve(pluginRoot);
  let root = codeRoot;
  let manifest = readJson(join(root, '.zcode-plugin', 'plugin.json'), 'MANIFEST');
  // Runtime packages intentionally do not include plugin metadata. Only this
  // exact layout may inherit the stable shell's identity, never an arbitrary ancestor.
  if (!manifest) {
    const shellRoot = dirname(dirname(dirname(codeRoot)));
    if (runtimeRelative(relative(shellRoot, codeRoot))) {
      root = shellRoot;
      manifest = readJson(join(root, '.zcode-plugin', 'plugin.json'), 'MANIFEST');
    }
  }
  if (!manifest || !NAME.test(manifest.name ?? '')) {
    fail('IDENTITY_MANIFEST_INVALID', 'The native agent plugin manifest is missing or invalid.');
  }
  const physicalRoot = realPath(root);
  const physicalCode = realPath(codeRoot);
  if (!samePath(root, codeRoot) && !runtimeRelative(relative(physicalRoot, physicalCode))) {
    fail('IDENTITY_PATH_INVALID', 'The native agent runtime is outside the installed plugin.');
  }
  return { root: physicalRoot, name: manifest.name };
}

function validPluginId(id, name) {
  if (typeof id !== 'string') return false;
  const parts = id.split('@');
  return parts.length === 2 && parts[0] === name && NAME.test(parts[1]);
}

function resolveIdentity({ explicitId, context, installedPath, required }) {
  if (explicitId !== undefined) {
    if (!validPluginId(explicitId, context.name)) {
      fail('IDENTITY_INVALID', 'The explicit native agent plugin identity does not match its manifest.');
    }
    return explicitId;
  }
  if (!required) return null;
  const installed = readJson(installedPath, 'REGISTRY');
  if (installed && !Array.isArray(installed.plugins)) {
    fail('REGISTRY_INVALID', 'The native agent installed plugin registry must contain a plugins array.');
  }
  const matches = new Set();
  for (const entry of installed?.plugins ?? []) {
    if (!record(entry) || !validPluginId(entry.id, context.name) || !text(entry.installPath)) continue;
    if (!isAbsolute(entry.installPath)) continue;
    const physical = realPath(entry.installPath, true);
    if (!physical || !samePath(context.root, physical)) continue;
    if ((entry.name !== undefined && entry.name !== context.name)
        || (entry.marketplace !== undefined && entry.id !== `${context.name}@${entry.marketplace}`)) {
      fail('IDENTITY_INVALID', 'The matching native agent installation has inconsistent metadata.');
    }
    matches.add(entry.id);
  }
  if (matches.size > 1) fail('IDENTITY_AMBIGUOUS', 'Multiple native agent plugin identities match this installation.');
  if (matches.size === 0) fail('IDENTITY_UNRESOLVED', 'Cannot associate the native agent selection with this plugin installation.');
  return [...matches][0];
}

function parseSelection(value) {
  if (!record(value) || Object.keys(value).some((key) => !['providerId', 'modelId', 'options'].includes(key))
      || !text(value.providerId) || !text(value.modelId)) {
    fail('SELECTION_INVALID', 'The native agent model selection must contain providerId and modelId.');
  }
  const selection = { providerId: value.providerId.trim(), modelId: value.modelId.trim() };
  if (own(value, 'options')) {
    if (!record(value.options) || Object.keys(value.options).some((key) => key !== 'reasoningLevel')
        || (own(value.options, 'reasoningLevel') && !text(value.options.reasoningLevel))) {
      fail('SELECTION_INVALID', 'The native agent model selection has invalid options.');
    }
    // Empty options and absent options have identical execution semantics.
    if (own(value.options, 'reasoningLevel')) selection.options = { reasoningLevel: value.options.reasoningLevel.trim() };
  }
  return selection;
}

function result(pluginId, agentName, selection = null) {
  const value = {
    source: selection ? 'native-agent' : 'inherit',
    pluginId,
    agentId: pluginId ? `plugin:${pluginId}:${agentName}` : null,
    modelSelection: selection,
    // Display/legacy compatibility only: IDs may themselves contain slashes.
    // Execution must use modelSelection, not split this string back into IDs.
    model: selection ? `${selection.providerId}/${selection.modelId}` : null,
    reasoning: selection?.options?.reasoningLevel ?? null,
  };
  return { ...value, signature: createHash('sha256').update(JSON.stringify(value)).digest('hex') };
}

function configPathValue(value, home, cwd) {
  return resolve(cwd, value.startsWith('~/') ? join(home, value.slice(2)) : value);
}

/**
 * Read ZCode Settings -> Subagents without modifying state or loading provider
 * credentials. Every read observes the current file, including deleted overrides.
 * ZCODE_HOME is deliberately not used: the native Settings storage resolver uses
 * homeDir/HOME/USERPROFILE and ~/.zcode/cli/config.json's storage.dir instead.
 *
 * @param {{ pluginRoot?: string, pluginId?: string, agentName?: string,
 *   homeDir?: string, env?: object, cwd?: string, configPath?: string,
 *   statePath?: string, installedPluginsPath?: string }} [options]
 */
export function createNativeAgentModelReader(options = {}) {
  const env = options.env ?? process.env;
  const cwd = resolve(options.cwd ?? process.cwd());
  const home = resolve(cwd, text(options.homeDir) || text(env.HOME) || text(env.USERPROFILE) || homedir());
  const agentName = text(options.agentName ?? 'team-worker').toLowerCase();
  if (!NAME.test(agentName)) fail('IDENTITY_INVALID', 'The native agent name is invalid.');
  const pluginRoot = resolve(cwd, options.pluginRoot ?? DEFAULT_PLUGIN_ROOT);
  const configPath = resolve(cwd, options.configPath ?? join(home, '.zcode', 'cli', 'config.json'));
  return {
    read() {
      const config = readJson(configPath, 'CONFIG') ?? {};
      const storageDir = text(config.storage?.dir) || '~/.zcode';
      const storageRoot = configPathValue(storageDir, home, cwd);
      const cliRoot = basename(storageRoot) === 'cli' ? storageRoot : join(storageRoot, 'cli');
      const statePath = resolve(cwd, options.statePath ?? join(storageRoot, 'v2', 'agents-state.json'));
      const installedPath = resolve(cwd, options.installedPluginsPath ?? join(cliRoot, 'plugins', 'installed_plugins.json'));
      const state = readJson(statePath, 'STATE') ?? {};
      const context = pluginContext(pluginRoot);
      const prefix = `plugin:${context.name}@`;
      const suffix = `:${agentName}`;
      const relevant = (key) => key.startsWith(prefix) && key.endsWith(suffix);
      const hasMap = own(state, 'pluginAgentModelSelectionOverrides');
      if (hasMap && !record(state.pluginAgentModelSelectionOverrides)) {
        fail('STATE_INVALID', 'The native agent model selection map must be an object.');
      }
      // The host migrates old maps. Do not write user state or guess a legacy
      // model string, and never resurrect legacy values once the new map exists.
      if (!hasMap && ['pluginAgentModelOverrides', 'pluginAgentThoughtLevelOverrides']
        .some((key) => record(state[key]) && Object.keys(state[key]).some(relevant))) {
        fail('STATE_LEGACY', 'Open native Subagents settings to migrate the legacy model selection.');
      }
      const overrides = state.pluginAgentModelSelectionOverrides ?? {};
      const pluginId = resolveIdentity({
        explicitId: options.pluginId, context, installedPath,
        required: Object.keys(overrides).some(relevant),
      });
      const agentId = pluginId ? `plugin:${pluginId}:${agentName}` : null;
      if (!agentId || !own(overrides, agentId)) return result(pluginId, agentName);
      if (config.plugins?.enabled === false || config.plugins?.enabledPlugins?.[pluginId] === false
          || (Array.isArray(state.disabledAgentIds) && state.disabledAgentIds.includes(agentId))
          || (Array.isArray(config.plugins?.suppressedBuiltins) && config.plugins.suppressedBuiltins.includes(pluginId))) {
        fail('DISABLED', 'The selected native agent or its plugin is disabled.');
      }
      return result(pluginId, agentName, parseSelection(overrides[agentId]));
    },
  };
}
