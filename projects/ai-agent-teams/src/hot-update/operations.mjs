import { promises as fsp } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  DEFAULT_RUNTIME_ENTRY,
  VERSIONS_RELATIVE_PATH,
  fail,
  isInside,
  lstatOrNull,
  randomSuffix,
  resolveSyncFile,
  toPosixPath,
} from './support.mjs';
import { versionSlug, verifyPackage } from './manifest.mjs';
import { recoverRuntimeState, publishStaged } from './publish.mjs';
import { readPointerDocument, sanitizePointer, validatePointerTarget, writePointerAtomic } from './pointer.mjs';
import { assertHealth, describeIgnoredOverrides, runHealthCheck } from './health.mjs';
import { acquireRuntimeLock } from './lock.mjs';
import { listInstalledVersions, matchInstalledVersion } from './versions.mjs';
import { copyVerifiedPackage, warnAboutUncopiedFiles } from './install-copy.mjs';

/**
 * Turn a `recoverRuntimeState` result into caller-facing warnings. Shared so
 * `install`, `status` and `rollback` report the same recovery in the same
 * words — operators and the test suite both grep `recovery:`.
 *
 * @param {{ pluginRoot: string, recovery: { actions: object[], errors: string[] }, warnings: string[] }} options
 */
function describeRecovery({ pluginRoot, recovery, warnings }) {
  for (const error of recovery.errors) warnings.push(`recovery: ${error}`);
  for (const action of recovery.actions) {
    const what = action.target ?? action.path;
    warnings.push(`recovery: ${action.action}${what ? ` ${toPosixPath(relative(pluginRoot, what))}` : ''}`);
  }
}

/**
 * Install a package directory (or an already-built version) as the runtime the
 * stable shell should spawn next.
 *
 * The order is fixed: verify integrity, stage, publish, health check, and only
 * then atomically rewrite the pointer. Any failure leaves `runtime/current.json`
 * exactly as it was, so the shell keeps its current runtime and drains in-flight
 * requests on its own schedule.
 *
 * @param {{
 *   pluginRoot?: string, packagePath?: string, version?: string, force?: boolean,
 *   cwd?: string, env?: Record<string, string>, timeoutMs?: number,
 *   now?: number, healthCheck?: (context: { entry: string, label: string }) => Promise<{ ok: boolean, tools?: number, error?: string }>,
 * }} [options]
 * @returns {Promise<{ pointer: object, previous: object | null, health: object, versionDir: string, created: boolean, warnings: string[] }>}
 */
export async function installPackage(options = {}) {
  const pluginRoot = resolve(options.pluginRoot ?? process.cwd());
  const versionsRoot = join(pluginRoot, VERSIONS_RELATIVE_PATH);
  await fsp.mkdir(versionsRoot, { recursive: true });
  const warnings = [];
  const syncFile = resolveSyncFile(options.syncFile);
  let staging = null;
  let publish = null;
  // Once the pointer names the new version, undo would roll the *active*
  // runtime back, so the failure paths below must stop at that point. Today
  // nothing between `writePointerAtomic` and `commit()` throws (commit collects
  // its own failures), so this guard is defensive: it keeps a future step added
  // in that window from undoing a committed switch.
  let pointerWritten = false;
  // One process at a time may inspect versions, recover journals, publish and
  // rewrite the pointer. Without this lock two installs could both read the
  // old pointer and the second would silently overwrite the first one's
  // `previous` chain.
  const lock = await acquireRuntimeLock(pluginRoot, { timeoutMs: options.lockTimeoutMs });
  try {
    describeRecovery({ pluginRoot, recovery: await recoverRuntimeState(pluginRoot), warnings });
    let sourceDir;
    if (options.packagePath) {
      sourceDir = resolve(options.packagePath);
      const stat = await lstatOrNull(sourceDir);
      if (!stat || !stat.isDirectory()) {
        fail('HOT_UPDATE_PACKAGE_MISSING', `package directory does not exist: ${sourceDir}`);
      }
    } else if (options.version) {
      const versions = await listInstalledVersions(pluginRoot);
      sourceDir = matchInstalledVersion(versions, options.version).dir;
    } else {
      fail('HOT_UPDATE_PACKAGE_MISSING', 'install requires --package <dir> or --version <id>');
    }
    const withinVersions = isInside(versionsRoot, sourceDir);
    if (!withinVersions) {
      // Validate the draft before copying anything, then copy only the files
      // the manifest names. Extra files stay behind and are reported.
      const sourceVerified = await verifyPackage(sourceDir);
      staging = join(versionsRoot, `.install-${randomSuffix()}`);
      await fsp.mkdir(staging, { recursive: true });
      await copyVerifiedPackage({ sourceDir, verified: sourceVerified, staging, warnings, syncFile });
      await warnAboutUncopiedFiles({ sourceDir, verified: sourceVerified, warnings });
      const staged = await verifyPackage(staging);
      const target = join(versionsRoot, versionSlug(staged.manifest));
      const existing = await lstatOrNull(target);
      let reusable = false;
      if (existing) {
        // Re-installing the same bytes is idempotent, but an existing package
        // with different content is a conflict, never a silent overwrite.
        let existingManifest = null;
        let existingError = null;
        try {
          existingManifest = await verifyPackage(target);
        } catch (error) {
          // Keep the reason: a conflict report must say whether the installed
          // copy is different or simply broken.
          existingError = error;
        }
        reusable = existingManifest !== null
          && existingManifest.manifest.version === staged.manifest.version
          && existingManifest.manifest.gitCommit === staged.manifest.gitCommit
          && JSON.stringify(existingManifest.manifest.files) === JSON.stringify(staged.manifest.files);
        if (!reusable && !options.force) {
          const detail = existingError
            ? ` (the installed copy is invalid: ${existingError.code}: ${existingError.message})`
            : '';
          fail('HOT_UPDATE_VERSION_EXISTS', `runtime version already exists with different content: ${target}${detail} (pass --force to replace it)`);
        }
      }
      if (reusable) {
        await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
        staging = null;
        sourceDir = target;
      } else {
        publish = await publishStaged({
          staging, target, pluginRoot, versionsRoot, force: existing !== null,
        });
        staging = null;
        sourceDir = target;
      }
    }
    const verified = await verifyPackage(sourceDir);
    if (toPosixPath(relative(versionsRoot, sourceDir)) !== versionSlug(verified.manifest)) {
      fail(
        'HOT_UPDATE_PACKAGE_INVALID',
        `package directory ${sourceDir} must be named ${versionSlug(verified.manifest)} under ${versionsRoot}`,
      );
    }
    const entryPath = join(sourceDir, ...verified.manifest.entry.split('/'));
    const health = await assertHealth(entryPath, options, `runtime ${versionSlug(verified.manifest)}`);
    warnings.push(...describeIgnoredOverrides(health));
    const previousDoc = await readPointerDocument(pluginRoot);
    if (previousDoc.error) warnings.push(previousDoc.error.message);
    const pointer = {
      version: verified.manifest.version,
      entry: toPosixPath(relative(pluginRoot, entryPath)),
      apiVersion: verified.manifest.apiVersion,
      sha256: verified.entrySha256,
      gitCommit: verified.manifest.gitCommit,
      installedAt: Number.isFinite(options.now) ? options.now : Date.now(),
    };
    if (previousDoc.pointer && typeof previousDoc.pointer === 'object' && !Array.isArray(previousDoc.pointer)) {
      const previous = sanitizePointer(previousDoc.pointer);
      // Re-installing the active version must not point `previous` at itself;
      // keep the older rollback target instead.
      if (previous.entry !== pointer.entry) {
        pointer.previous = previous;
      } else if (previousDoc.pointer.previous && typeof previousDoc.pointer.previous === 'object') {
        pointer.previous = sanitizePointer(previousDoc.pointer.previous);
      }
    }
    // The pointer carries the id of the publish it commits, so recovery can tell
    // a switched pointer from bytes that were published but never activated.
    if (publish) pointer.swapId = publish.swapId;
    await writePointerAtomic(pluginRoot, pointer);
    pointerWritten = true;
    if (publish) {
      const committed = await publish.commit();
      warnings.push(...(committed?.warnings ?? []));
    }
    return {
      pointer,
      previous: pointer.previous ?? null,
      health,
      versionDir: sourceDir,
      created: publish !== null,
      warnings,
    };
  } catch (error) {
    // A package that failed before the pointer switch must not stay behind as
    // an installable (but broken) version. A failed undo is reported instead of
    // swallowed: the caller has to know that the versions directory needs the
    // next recovery pass, and the pointer still names the previous runtime.
    if (publish && !pointerWritten) {
      try {
        const undone = await publish.undo();
        if (undone?.warnings?.length && error && typeof error === 'object') {
          error.details = { ...(error.details ?? {}), undoWarnings: undone.warnings };
        }
      } catch (undoError) {
        const message = undoError instanceof Error ? undoError.message : String(undoError);
        if (error && typeof error === 'object') {
          error.details = {
            ...(error.details ?? {}),
            undoError: { code: undoError?.code ?? null, message },
          };
          error.message = `${error.message} (and undoing the published version failed: ${message}; the recovery journal is kept for the next recovery pass)`;
        }
      }
    }
    if (staging) await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    await lock.release();
  }
}

/**
 * Report the pointer, the installed versions and (optionally) the live health
 * of the runtime the pointer selects.
 *
 * @param {{ pluginRoot?: string, checkHealth?: boolean, cwd?: string, env?: Record<string, string>, timeoutMs?: number }} [options]
 */
export async function getStatus(options = {}) {
  const pluginRoot = resolve(options.pluginRoot ?? process.cwd());
  const warnings = [];
  // Status performs recovery under the same lock as build/install/rollback.
  // Recovery defaults to no age delay; callers may request an older cutoff.
  let recovery = { actions: [], errors: [] };
  try {
    const lock = await acquireRuntimeLock(pluginRoot, { timeoutMs: options.lockTimeoutMs ?? 500 });
    try {
      // Every build/install/rollback holds the same lock while its staging
      // directory or recovery journal exists, so anything found after this
      // process acquired the lock is a crash leftover, not live work.
      const minAgeMs = Number.isFinite(options.recoveryMinAgeMs) && options.recoveryMinAgeMs >= 0
        ? options.recoveryMinAgeMs
        : 0;
      recovery = await recoverRuntimeState(pluginRoot, { minAgeMs });
    } finally {
      await lock.release();
    }
  } catch (error) {
    if (error?.code === 'HOT_UPDATE_LOCK_TIMEOUT') warnings.push(`recovery skipped: ${error.message}`);
    else warnings.push(`recovery failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  describeRecovery({ pluginRoot, recovery, warnings });
  const pointerDoc = await readPointerDocument(pluginRoot);
  const versions = await listInstalledVersions(pluginRoot);
  const rawPointer = pointerDoc.pointer && typeof pointerDoc.pointer === 'object' && !Array.isArray(pointerDoc.pointer)
    ? pointerDoc.pointer
    : null;
  // A missing pointer is not an error: the shell deliberately falls back to the
  // packaged runtime. Only a present-but-unusable pointer is reported.
  const pointerError = pointerDoc.error
    ?? (pointerDoc.text && !rawPointer
      ? { code: 'HOT_UPDATE_POINTER_INVALID', message: 'runtime pointer is not a JSON object' }
      : null);
  const previousPointer = rawPointer?.previous && typeof rawPointer.previous === 'object' && !Array.isArray(rawPointer.previous)
    ? sanitizePointer(rawPointer.previous)
    : null;
  const current = rawPointer ? { ...sanitizePointer(rawPointer), previous: previousPointer } : null;
  const target = rawPointer
    ? await validatePointerTarget(pluginRoot, rawPointer)
    : { valid: false, entryPath: null, sha256: null, error: null };
  const currentId = current?.entry && current.entry.startsWith(`${VERSIONS_RELATIVE_PATH}/`)
    ? current.entry.split('/')[2]
    : null;
  // The compiler is only as honest as its checks: validate every byte of the
  // current version, not just that its entry exists.
  let verification = { checked: false, ok: null, error: null, note: null };
  if (target.valid) {
    const record = versions.find((version) => version.entryPresent && version.id === currentId);
    if (!record) {
      verification = {
        checked: false,
        ok: null,
        error: null,
        note: `current pointer is not an installed version under ${VERSIONS_RELATIVE_PATH}; only the entry was checked`,
      };
    } else {
      try {
        await verifyPackage(record.dir);
        verification = { checked: true, ok: true, error: null, note: null };
      } catch (error) {
        verification = {
          checked: true,
          ok: false,
          error: { code: error.code ?? 'HOT_UPDATE_PACKAGE_INVALID', message: error.message },
          note: null,
        };
      }
    }
  }
  const currentValid = target.valid && verification.ok !== false;
  let health = { checked: false, ok: null, tools: null, error: null, durationMs: 0 };
  if (options.checkHealth !== false && currentValid) {
    health = { checked: true, ...(await runHealthCheck({ entry: target.entryPath, cwd: options.cwd, env: options.env, timeoutMs: options.timeoutMs })) };
  }
  return {
    pluginRoot,
    pointerPath: pointerDoc.pointerPath,
    current: current
      ? {
        ...current,
        id: currentId,
        entryValid: target.valid,
        verified: verification.ok === true,
        verification,
        valid: currentValid,
        error: target.error,
      }
      : null,
    pointerError,
    health,
    recovery,
    warnings,
    fallbackEntry: join(pluginRoot, DEFAULT_RUNTIME_ENTRY),
    versions: versions.map((version) => ({
      ...version,
      current: version.entryPresent && version.entry === current?.entry,
      verified: version.id === currentId ? verification.ok : null,
    })),
  };
}

/**
 * Switch back to the previously installed runtime (or to an explicit version).
 * The candidate is verified and health-checked before the pointer moves, and
 * the pointer it replaces is recorded as `previous` so rollback is reversible.
 *
 * @param {{
 *   pluginRoot?: string, version?: string, cwd?: string, env?: Record<string, string>,
 *   timeoutMs?: number, now?: number,
 *   healthCheck?: (context: { entry: string, label: string }) => Promise<{ ok: boolean, tools?: number, error?: string }>,
 * }} [options]
 */
export async function rollbackPackage(options = {}) {
  const pluginRoot = resolve(options.pluginRoot ?? process.cwd());
  const warnings = [];
  const lock = await acquireRuntimeLock(pluginRoot, { timeoutMs: options.lockTimeoutMs });
  try {
    describeRecovery({ pluginRoot, recovery: await recoverRuntimeState(pluginRoot), warnings });
    const pointerDoc = await readPointerDocument(pluginRoot);
    if (pointerDoc.error || !pointerDoc.pointer || typeof pointerDoc.pointer !== 'object' || Array.isArray(pointerDoc.pointer)) {
      fail(
        'HOT_UPDATE_POINTER_INVALID',
        `cannot roll back without a valid runtime pointer: ${pointerDoc.error?.message ?? 'the pointer is missing'}`,
      );
    }
    const current = sanitizePointer(pointerDoc.pointer);
    const versions = await listInstalledVersions(pluginRoot);
    const installed = versions.filter((version) => version.entryPresent);
    let candidate = null;
    if (options.version) {
      candidate = matchInstalledVersion(versions, options.version);
    } else {
      // Never guess. Falling back to "any other installed version" would switch
      // the host to a runtime the operator never selected, so a missing or
      // no-longer-installed `previous` is an error that says what to do instead.
      const previousEntry = typeof pointerDoc.pointer.previous?.entry === 'string'
        ? pointerDoc.pointer.previous.entry
        : null;
      if (!previousEntry || previousEntry === current.entry) {
        fail(
          'HOT_UPDATE_NO_ROLLBACK_TARGET',
          `the runtime pointer records no usable previous version (current ${current.entry ?? 'unknown'}); pass an explicit version`,
          { available: installed.map((version) => version.id) },
        );
      }
      candidate = installed.find((version) => version.entry === previousEntry) ?? null;
      if (!candidate) {
        fail(
          'HOT_UPDATE_PREVIOUS_MISSING',
          `the recorded previous runtime ${previousEntry} is no longer installed; pass an explicit version`,
          { previous: previousEntry, available: installed.map((version) => version.id) },
        );
      }
    }
    if (candidate.entry === current.entry) {
      fail('HOT_UPDATE_ALREADY_CURRENT', `${candidate.id} is already the current runtime`);
    }
    const verified = await verifyPackage(candidate.dir);
    const entryPath = join(candidate.dir, ...verified.manifest.entry.split('/'));
    const health = await assertHealth(entryPath, options, `runtime ${candidate.id}`);
    warnings.push(...describeIgnoredOverrides(health));
    const pointer = {
      version: verified.manifest.version,
      entry: candidate.entry,
      apiVersion: verified.manifest.apiVersion,
      sha256: verified.entrySha256,
      gitCommit: verified.manifest.gitCommit,
      installedAt: Number.isFinite(options.now) ? options.now : Date.now(),
      previous: current,
    };
    await writePointerAtomic(pluginRoot, pointer);
    return { pointer, previous: current, health, versionDir: candidate.dir, created: false, warnings };
  } finally {
    await lock.release();
  }
}
