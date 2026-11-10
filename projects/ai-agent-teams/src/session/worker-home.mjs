import { chmodSync, chownSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { sameWorkspace } from '../domain/workspace.mjs';
import { restrictWindowsAcl } from '../fs-permissions.mjs';

const SEED_FILES = ['credentials.json', 'provider_config.json', 'setting.json'];

// The container CLI cannot run team-cli.mjs when Bash is denied (read-only
// members run in `plan` mode). It gets the same member-scoped MCP server that
// protocol sessions receive, loaded from the user-level CLI config.
import { MEMBER_MCP_SERVER_NAME } from '../domain/team-tools.mjs';
import { rewriteProviderBaseUrl } from './provider-config.mjs';

export { MEMBER_MCP_SERVER_NAME };
export const MEMBER_MCP_SERVER_PATH = '/opt/agent-teams/src/mcp-server.mjs';
const MEMBER_MCP_TIMEOUT_MS = 30000;

/**
 * The host ZCode profile directory that contains the CLI login and provider
 * configuration. Workers get a copy; the host directory is never mounted.
 * @returns {string}
 */
export function defaultWorkerSeedDir() {
  return join(homedir(), '.zcode', 'v2');
}

/**
 * Normalize the model selection shape used by provider_config.json and
 * session/model_selection entries.
 * @param {{ providerId: string, modelId: string, reasoningLevel?: string, options?: object } | null | undefined} model
 * @returns {{ providerId: string, modelId: string, options?: object } | undefined}
 */
export function normalizeWorkerModel(model) {
  if (!model || typeof model !== 'object') return undefined;
  const providerId = typeof model.providerId === 'string' ? model.providerId.trim() : '';
  const modelId = typeof model.modelId === 'string' ? model.modelId.trim() : '';
  if (!providerId || !modelId) return undefined;
  const reasoningLevel = model.reasoningLevel ?? model.options?.reasoningLevel;
  const options = {
    ...(model.options && typeof model.options === 'object' ? model.options : {}),
    ...(typeof reasoningLevel === 'string' && reasoningLevel.trim()
      ? { reasoningLevel: reasoningLevel.trim() }
      : {}),
  };
  return {
    providerId,
    modelId,
    ...(Object.keys(options).length > 0 ? { options } : {}),
  };
}

function ensureSafeDir(dir, mode = 0o700) {
  try {
    const info = lstatSync(dir);
    if (info.isSymbolicLink()) throw new Error(`refusing symlink directory: ${dir}`);
    if (!info.isDirectory()) throw new Error(`not a directory: ${dir}`);
    try {
      chmodSync(dir, mode);
      restrictWindowsAcl(dir, { directory: true });
    } catch {
      // POSIX mode changes are best effort; Windows ACL failures remain fatal.
      if (process.platform === 'win32') throw new Error(`cannot restrict worker directory permissions: ${dir}`);
    }
  } catch (error) {
    if (error?.code === 'ENOENT') {
      mkdirSync(dir, { mode });
      try {
        chmodSync(dir, mode);
      } catch {
        // best effort on Windows
      }
      restrictWindowsAcl(dir, { directory: true });
      return;
    }
    throw error;
  }
}

function ensurePrivateFileTarget(target) {
  try {
    const info = lstatSync(target);
    if (info.isSymbolicLink()) throw new Error(`refusing symlink file: ${target}`);
    if (!info.isFile()) throw new Error(`not a regular file: ${target}`);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
}

function chownForContainer(path) {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return;
  try { chownSync(path, 10001, 10001); } catch { /* best effort on filesystems without POSIX ownership */ }
}

function writePrivateJson(target, value) {
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
      chmodSync(temp, 0o600);
    } catch {
      // best effort on Windows
    }
    restrictWindowsAcl(temp);
    chownForContainer(temp);
    renameSync(temp, target);
    restrictWindowsAcl(target);
    chownForContainer(target);
  } catch (error) {
    try { rmSync(temp, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

function copyPrivate(source, target) {
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  copyFileSync(source, temp);
  try {
    restrictWindowsAcl(temp);
    chmodSync(temp, 0o600);
    // Root-run hosts use the image's uid 10001; other POSIX hosts run the
    // container as the invoking user so the 0600 file is already readable.
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      chownSync(temp, 10001, 10001);
    }
    renameSync(temp, target);
  } catch (error) {
    try { rmSync(temp, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

/**
 * Seed a container member home with the host ZCode CLI profile. Only a fixed
 * whitelist is copied; session databases, logs and project files are excluded.
 * The provider config gets the worker's explicit default model selection so a
 * headless container turn never depends on an interactive model picker.
 *
 * `seeded` means credentials.json was copied. `modelInjected` is separate so a
 * provider-only copy cannot be mistaken for an authenticated worker.
 * @param {string} home
 * @param {{ seedDir?: string, model?: { providerId: string, modelId: string, reasoningLevel?: string, options?: object } | null, providerBaseUrl?: string }} [options]
 * @returns {{ seeded: boolean, copied: string[], credentialsCopied: boolean, modelInjected: boolean, providerUrlRewritten: boolean, modelSelection?: object, reason?: string }}
 */
export function seedWorkerHome(home, { seedDir = defaultWorkerSeedDir(), model = null, providerBaseUrl = '' } = {}) {
  if (!home) throw new Error('worker home is required');
  if (!seedDir || !existsSync(seedDir)) {
    return {
      seeded: false,
      copied: [],
      credentialsCopied: false,
      modelInjected: false,
      providerUrlRewritten: false,
      reason: `ZCode profile directory not found: ${seedDir}`,
    };
  }
  const targetDir = join(home, '.zcode', 'v2');
  try {
    ensureSafeDir(home);
    ensureSafeDir(join(home, '.zcode'));
    ensureSafeDir(targetDir);
    chownForContainer(home);
    chownForContainer(join(home, '.zcode'));
    chownForContainer(targetDir);
  } catch (error) {
    return {
      seeded: false,
      copied: [],
      credentialsCopied: false,
      modelInjected: false,
      providerUrlRewritten: false,
      reason: `unsafe worker home: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const copied = [];
  try {
    for (const name of SEED_FILES) {
      const source = join(seedDir, name);
      if (!existsSync(source)) continue;
      copyPrivate(source, join(targetDir, name));
      copied.push(name);
    }
  } catch (error) {
    return {
      seeded: false,
      copied,
      credentialsCopied: false,
      modelInjected: false,
      providerUrlRewritten: false,
      reason: `cannot copy ZCode profile into ${targetDir}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  let credentialsCopied = copied.includes('credentials.json');
  if (credentialsCopied) {
    try {
      JSON.parse(readFileSync(join(targetDir, 'credentials.json'), 'utf8'));
    } catch (error) {
      credentialsCopied = false;
      return {
        seeded: false,
        copied,
        credentialsCopied,
        modelInjected: false,
        providerUrlRewritten: false,
        reason: `credentials.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  if (!copied.length) {
    return {
      seeded: false,
      copied,
      credentialsCopied,
      modelInjected: false,
      providerUrlRewritten: false,
      reason: `no ZCode profile files found in ${seedDir}`,
    };
  }

  const modelSelection = normalizeWorkerModel(model);
  const providerOverride = typeof providerBaseUrl === 'string' ? providerBaseUrl.trim() : '';
  let modelInjected = false;
  let providerUrlRewritten = false;
  let reason;
  if (modelSelection || providerOverride) {
    const providerPath = join(targetDir, 'provider_config.json');
    if (!copied.includes('provider_config.json')) {
      reason = `provider_config.json is missing from ${seedDir}; worker model selection was not injected`;
    } else {
      try {
        const provider = JSON.parse(readFileSync(providerPath, 'utf8'));
        if (!provider || typeof provider !== 'object' || Array.isArray(provider)
          || !provider.config || typeof provider.config !== 'object' || Array.isArray(provider.config)) {
          throw new Error('provider_config.json root and config must be objects');
        }
        if (modelSelection) {
          provider.config.defaultModelSelection = modelSelection;
          modelInjected = true;
        }
        if (providerOverride) {
          const rewrite = rewriteProviderBaseUrl(provider, modelSelection?.providerId, providerOverride);
          providerUrlRewritten = rewrite.rewritten;
          if (!rewrite.rewritten) {
            reason = `worker provider URL was not rewritten: ${rewrite.reason ?? 'unknown reason'}`;
          }
        }
        if (modelInjected || providerUrlRewritten) {
          writeFileSync(providerPath, `${JSON.stringify(provider, null, 2)}\n`, 'utf8');
          try {
            chmodSync(providerPath, 0o600);
          } catch {
            // best effort on Windows
          }
        }
      } catch (error) {
        const detail = `cannot apply worker provider config ${providerPath}: ${error instanceof Error ? error.message : String(error)}`;
        reason = reason ? `${reason}; ${detail}` : detail;
      }
    }
  }
  if (!credentialsCopied) {
    reason = `${reason ? `${reason}; ` : ''}credentials.json is missing from ${seedDir}; worker home is not authenticated`;
  }
  return {
    seeded: credentialsCopied,
    copied,
    credentialsCopied,
    modelInjected,
    providerUrlRewritten,
    ...(modelInjected ? { modelSelection } : {}),
    ...(reason ? { reason } : {}),
  };
}

/**
 * Write the user-level ZCode CLI config for a persistent container member so
 * the CLI starts exactly one stdio MCP server: the member-scoped team server.
 * Only `home/.zcode/cli/config.json` is touched. The file is written
 * atomically with mode 0600, its directory 0700, and it never receives a host
 * or admin token - only the member token supplied by the caller.
 *
 * @param {string} home
 * @param {{ baseUrl?: string, token?: string, teamId?: string, memberName?: string, shadow?: boolean }} [options]
 * @returns {{ written: boolean, path?: string, serverName?: string, reason?: string }}
 */
export function writeMemberMcpConfig(home, { baseUrl, token, teamId, memberName, shadow = false } = {}) {
  if (!home) throw new Error('worker home is required');
  const context = {
    baseUrl: typeof baseUrl === 'string' ? baseUrl.trim() : '',
    token: typeof token === 'string' ? token.trim() : '',
    teamId: typeof teamId === 'string' ? teamId.trim() : '',
    memberName: typeof memberName === 'string' ? memberName.trim() : '',
  };
  const missing = Object.entries(context).filter(([, value]) => !value).map(([key]) => key);
  if (missing.length > 0) {
    return { written: false, reason: `member MCP config requires ${missing.join(', ')}` };
  }
  if (!context.token.startsWith('mt_')) {
    return { written: false, reason: 'member MCP config requires a member token (mt_...), not an admin token' };
  }
  const hostHome = resolve(homedir());
  const homePath = resolve(home);
  const comparableHome = process.platform === 'win32' ? homePath.toLowerCase() : homePath;
  const comparableHost = process.platform === 'win32' ? hostHome.toLowerCase() : hostHome;
  const hostZcode = process.platform === 'win32' ? resolve(join(hostHome, '.zcode')).toLowerCase() : resolve(join(hostHome, '.zcode'));
  if (comparableHome === comparableHost || comparableHome === hostZcode) {
    return { written: false, reason: 'refusing to write member MCP config into the host ZCode home' };
  }
  const targetDir = join(home, '.zcode', 'cli');
  const target = join(targetDir, 'config.json');
  try {
    ensureSafeDir(home);
    ensureSafeDir(join(home, '.zcode'));
    ensureSafeDir(targetDir);
    chownForContainer(join(home, '.zcode'));
    chownForContainer(targetDir);
    ensurePrivateFileTarget(target);
  } catch (error) {
    return {
      written: false,
      reason: `unsafe worker home: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  // ZCode's user config schema is `mcp.servers.<name>` (server entries are
  // strict objects; the map key is the server name, so no `name` field).
  const config = {
    mcp: {
      servers: {
        [MEMBER_MCP_SERVER_NAME]: {
          type: 'stdio',
          command: 'node',
          args: [MEMBER_MCP_SERVER_PATH],
          timeoutMs: MEMBER_MCP_TIMEOUT_MS,
          env: {
            AGENT_TEAMS_AUTOSTART: '0',
            AGENT_TEAMS_URL: context.baseUrl,
            AGENT_TEAMS_TOKEN: context.token,
            AGENT_TEAMS_TEAM: context.teamId,
            AGENT_TEAMS_MEMBER: context.memberName,
            ...(shadow ? { AGENT_TEAMS_SHADOW: '1' } : {}),
          },
        },
      },
    },
  };
  try {
    writePrivateJson(target, config);
  } catch (error) {
    return {
      written: false,
      reason: `cannot write member MCP config ${target}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return { written: true, path: target, serverName: MEMBER_MCP_SERVER_NAME };
}

const HOME_OWNER_FILE = '.agent-teams-workspace.json';
const MEMBER_DIRECTORY = /^member_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function assertUnlinkedAncestors(path) {
  let current = resolve(path);
  while (true) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('member home path contains a link');
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

export function ensureOwnedMemberHome(home, workspace) {
  assertUnlinkedAncestors(home);
  mkdirSync(join(home, 'tmp'), { recursive: true });
  const marker = join(home, HOME_OWNER_FILE);
  try {
    writeFileSync(marker, JSON.stringify({ workspace: resolve(workspace) }), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (lstatSync(marker).isSymbolicLink()) throw new Error('home owner marker is a link');
    const owner = JSON.parse(readFileSync(marker, 'utf8'));
    if (!sameWorkspace(owner.workspace, workspace)) throw new Error('member home belongs to another workspace');
  }
}

export function reclaimMemberHomes({ root, workspace, hasMember, onEvent, remove = rmSync }) {
  const report = { removed: [], errors: [], retained: 0 };
  if (!existsSync(root)) return report;
  assertUnlinkedAncestors(root);
  for (const team of readdirSync(root, { withFileTypes: true })) {
    if (!team.isDirectory() || team.isSymbolicLink()) continue;
    const teamRoot = join(root, team.name);
    let entries;
    try { entries = readdirSync(teamRoot, { withFileTypes: true }); }
    catch (error) {
      report.errors.push({ path: teamRoot, error: error.message });
      onEvent(team.name, 'member.home_cleanup_failed', { home: teamRoot, error: error.message });
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !MEMBER_DIRECTORY.test(entry.name)) continue;
      const home = join(teamRoot, entry.name);
      if (hasMember(entry.name)) { report.retained += 1; continue; }
      const marker = join(home, HOME_OWNER_FILE);
      if (!existsSync(marker)) { report.retained += 1; continue; }
      try {
        if (lstatSync(marker).isSymbolicLink()) throw new Error('home owner marker is a link');
        const owner = JSON.parse(readFileSync(marker, 'utf8'));
        if (!sameWorkspace(owner.workspace, workspace)) { report.retained += 1; continue; }
        // Re-read membership at the deletion boundary. No await between this check and removal.
        if (hasMember(entry.name)) { report.retained += 1; continue; }
        remove(home, { recursive: true, force: true });
        report.removed.push(home);
        onEvent(team.name, 'member.home_reclaimed', { memberId: entry.name, home });
      } catch (error) {
        report.errors.push({ path: home, error: error.message });
        onEvent(team.name, 'member.home_cleanup_failed', { memberId: entry.name, home, error: error.message });
      }
    }
  }
  return report;
}
