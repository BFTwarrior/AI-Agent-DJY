import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  DEFAULT_RUNTIME_ENTRY,
  HOT_UPDATE_API_VERSION,
  MANIFEST_SCHEMA_VERSION,
  VERSIONS_RELATIVE_PATH,
  HotUpdateError,
  fail,
  normalizeCommit,
  randomSuffix,
  readJson,
  resolveSyncFile,
  validateVersion,
} from './support.mjs';
import { assertImportClosure, collectPackageFiles, writeManifest } from './package-files.mjs';
import { verifyPackage } from './manifest.mjs';
import { acquireRuntimeLock } from './lock.mjs';
import { publishStaged } from './publish.mjs';

// Strip inherited GIT_* overrides so packaging reads the repository that
// contains `sourceRoot`, not whichever repository the caller's shell points at.
function gitEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === 'GIT_DIR' || key === 'GIT_WORK_TREE' || key === 'GIT_INDEX_FILE' || key.startsWith('GIT_CONFIG')) {
      delete env[key];
    }
  }
  return env;
}

async function execGit(args, cwd) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile('git', args, { cwd, env: gitEnvironment(), windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || error.message).trim();
        rejectPromise(new HotUpdateError('HOT_UPDATE_GIT_FAILED', `git ${args.join(' ')} failed in ${cwd}: ${detail}`));
        return;
      }
      resolvePromise(String(stdout).trim());
    });
  });
}

// `git status` can fail (no repository, no git on PATH). That is not fatal for
// a build that names its commit, but it must be reported: silently assuming a
// clean tree would hide that the package content is not the recorded commit.
async function readDirtyState(sourceRoot) {
  try {
    return {
      dirty: (await execGit(['status', '--porcelain', '--untracked-files=no'], sourceRoot)) !== '',
      dirtyError: null,
    };
  } catch (error) {
    return { dirty: false, dirtyError: error instanceof Error ? error.message : String(error) };
  }
}

async function resolveGitState(sourceRoot) {
  const gitCommit = normalizeCommit(await execGit(['rev-parse', 'HEAD'], sourceRoot));
  return { gitCommit, ...(await readDirtyState(sourceRoot)) };
}

// `--commit <sha>` names the commit a package claims to contain, which must not
// hide that the working tree carries uncommitted tracked changes: the packaged
// bytes would then not be that commit. The repository is therefore asked for its
// status in both cases; `gitDirty: true` lets a caller that already knows the
// tree is dirty force the warning.
async function resolveBuildGitState(sourceRoot, options) {
  if (!options.gitCommit) return resolveGitState(sourceRoot);
  const gitCommit = normalizeCommit(options.gitCommit);
  const state = await readDirtyState(sourceRoot);
  return { gitCommit, dirty: options.gitDirty === true || state.dirty, dirtyError: state.dirtyError };
}

async function readPackageJson(sourceRoot) {
  const path = join(sourceRoot, 'package.json');
  const parsed = await readJson(path, 'HOT_UPDATE_BUILD_FAILED');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('HOT_UPDATE_BUILD_FAILED', `${path} must contain a JSON object`);
  }
  return parsed;
}

/**
 * Build a versioned runtime package from the current git commit.
 *
 * @param {{
 *   sourceRoot?: string, pluginRoot?: string, versionsRoot?: string,
 *   version?: string, gitCommit?: string, gitDirty?: boolean, force?: boolean,
 *   now?: number,
 * }} [options]
 * @returns {Promise<{ id: string, dir: string, manifest: object, warnings: string[] }>}
 */
export async function buildPackage(options = {}) {
  const sourceRoot = resolve(options.sourceRoot ?? process.cwd());
  const pluginRoot = resolve(options.pluginRoot ?? sourceRoot);
  const versionsRoot = resolve(options.versionsRoot ?? join(pluginRoot, VERSIONS_RELATIVE_PATH));
  const packageJson = await readPackageJson(sourceRoot);
  const version = validateVersion(options.version ?? packageJson.version);
  const gitState = await resolveBuildGitState(sourceRoot, options);
  const syncFile = resolveSyncFile(options.syncFile);
  const shortCommit = gitState.gitCommit.slice(0, 7);
  const id = `${version}-${shortCommit}`;
  const target = join(versionsRoot, id);
  const warnings = [];
  if (gitState.dirty) {
    warnings.push('source tree has uncommitted tracked changes; the package content is not exactly the recorded commit');
  }
  if (gitState.dirtyError) {
    warnings.push(`cannot tell whether the source tree is dirty: ${gitState.dirtyError}`);
  }
  await fsp.mkdir(versionsRoot, { recursive: true });
  // The lock covers staging too: `install`/`status` recovery deletes
  // `.staging-*` directories, and it must never mistake an in-progress build
  // for a crash leftover.
  const lock = await acquireRuntimeLock(pluginRoot, { timeoutMs: options.lockTimeoutMs });
  const staging = join(versionsRoot, `.staging-${id}-${randomSuffix()}`);
  try {
    await fsp.mkdir(staging, { recursive: true });
    const { files, warnings: copyWarnings } = await collectPackageFiles({ sourceRoot, staging, syncFile });
    warnings.push(...copyWarnings);
    if (!files.some((file) => file.path === DEFAULT_RUNTIME_ENTRY)) {
      fail('HOT_UPDATE_ENTRY_MISSING', `package does not contain the runtime entry ${DEFAULT_RUNTIME_ENTRY}`);
    }
    await assertImportClosure({ staging, files });
    const manifest = {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      name: typeof packageJson.name === 'string' ? packageJson.name : 'ai-agent-teams',
      version,
      gitCommit: gitState.gitCommit,
      shortCommit,
      apiVersion: HOT_UPDATE_API_VERSION,
      entry: DEFAULT_RUNTIME_ENTRY,
      createdAt: Number.isFinite(options.now) ? options.now : Date.now(),
      fileCount: files.length,
      totalBytes: files.reduce((total, file) => total + file.size, 0),
      files,
    };
    await writeManifest(staging, manifest, syncFile);
    // Verify the bytes we are about to publish before publishing them.
    await verifyPackage(staging);
    const published = await publishStaged({
      staging, target, pluginRoot, versionsRoot, force: options.force === true,
    });
    const committed = await published.commit();
    warnings.push(...(committed?.warnings ?? []));
    return { id, dir: published.target, manifest, warnings };
  } catch (error) {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    await lock.release();
  }
}
