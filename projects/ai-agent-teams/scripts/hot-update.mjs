#!/usr/bin/env node
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { HotUpdateError, buildPackage, getStatus, installPackage, rollbackPackage } from '../src/hot-update.mjs';

// CLI for the hot-update packager/installer. `build` writes a versioned
// runtime package, `install`/`rollback` switch `runtime/current.json` only
// after the candidate passed its initialize + tools/list health check, and
// `status` reports the pointer, the health of the selected runtime and every
// installed version.
const DEFAULT_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

function usage() {
  return [
    'Usage: node scripts/hot-update.mjs <command> [options]',
    '',
    'Commands:',
    '  build                     Package the current git commit into runtime/versions/<version>-<sha>/',
    '  install [<package|id>]    Verify, health-check and activate a package (or an installed version)',
    '  status                    Show the pointer, its health and the installed versions',
    '  rollback [<version>]      Switch back to the previous (or a named) installed version',
    '',
    'Options:',
    '  --root <dir>       Plugin root that owns runtime/ (default: the repository root)',
    '  --versions <dir>   Override the versions directory for build (default: <root>/runtime/versions)',
    '  --package <dir>    Package directory to install (default: resolve the positional id)',
    '  --version <value>  Version or package id for build/install/rollback',
    '  --commit <sha>     Git commit for build (default: git rev-parse HEAD)',
    '  --force            Replace an existing version directory',
    '  --json             Print machine-readable JSON',
    '  --no-health        Skip the spawn health check in status',
    '  --timeout <ms>     Health-check timeout (default: 15000)',
  ].join('\n');
}

function parseArgs(argv) {
  const parsed = { command: null, positional: [], root: DEFAULT_ROOT };
  const takesValue = new Set(['--root', '--versions', '--package', '--version', '--commit', '--timeout']);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      parsed.help = true;
      continue;
    }
    if (takesValue.has(argument)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${argument} requires a value`);
      }
      parsed[argument.slice(2)] = value;
      index += 1;
      continue;
    }
    switch (argument) {
      case '--force':
        parsed.force = true;
        break;
      case '--json':
        parsed.json = true;
        break;
      case '--no-health':
        parsed.noHealth = true;
        break;
      default:
        if (argument.startsWith('-')) throw new Error(`unknown option: ${argument}`);
        if (!parsed.command) parsed.command = argument;
        else parsed.positional.push(argument);
    }
  }
  return parsed;
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function formatTime(epochMs) {
  if (!Number.isFinite(epochMs)) return 'unknown';
  return new Date(epochMs).toISOString();
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function printBuild(result) {
  console.log(`built ${result.id}`);
  console.log(`  directory: ${result.dir}`);
  console.log(`  commit:    ${result.manifest.gitCommit}`);
  console.log(`  apiVersion:${result.manifest.apiVersion}`);
  console.log(`  files:     ${result.manifest.fileCount} (${formatBytes(result.manifest.totalBytes)})`);
  for (const warning of result.warnings) console.log(`  warning:   ${warning}`);
}

function printInstall(result) {
  console.log(`installed ${result.pointer.version} (${result.pointer.gitCommit.slice(0, 7)}) at ${result.versionDir}`);
  console.log(`  entry:   ${result.pointer.entry}`);
  console.log(`  sha256:  ${result.pointer.sha256}`);
  console.log(`  health:  ok (${result.health.tools ?? 'unknown'} tools, ${result.health.durationMs}ms)`);
  for (const key of result.health.envOverrides ?? []) {
    console.log(`  warning:   health check used the explicit environment override ${key}`);
  }
  if (result.previous) console.log(`  previous: ${result.previous.version} (kept for rollback)`);
  for (const warning of result.warnings) console.log(`  warning: ${warning}`);
}

function printRollback(result) {
  console.log(`rolled back to ${result.pointer.version} (${result.pointer.gitCommit?.slice(0, 7) ?? 'unknown'})`);
  console.log(`  entry:   ${result.pointer.entry}`);
  console.log(`  health:  ok (${result.health.tools ?? 'unknown'} tools, ${result.health.durationMs}ms)`);
  if (result.previous) console.log(`  previous: ${result.previous.version ?? 'unknown'} (now the rollback target)`);
  for (const warning of result.warnings) console.log(`  warning: ${warning}`);
}

function printStatus(status) {
  console.log(`plugin root: ${status.pluginRoot}`);
  console.log(`pointer:     ${status.pointerPath}`);
  if (status.pointerError) {
    console.log(`pointer error: ${status.pointerError.code}: ${status.pointerError.message}`);
  }
  if (!status.current) {
    console.log(`current:     none (the shell uses the packaged runtime ${status.fallbackEntry})`);
  } else {
    console.log(`current:     ${status.current.version} (${status.current.gitCommit?.slice(0, 7) ?? 'unknown'})`);
    console.log(`entry:       ${status.current.entry}`);
    if (status.current.entryValid) {
      console.log('entry check: ok (inside the plugin root, sha256 matches)');
    } else {
      console.log(`entry check: FAILED ${status.current.error?.code ?? ''}: ${status.current.error?.message ?? 'unknown'}`);
    }
    if (status.current.verification?.checked) {
      console.log(status.current.verification.ok
        ? 'package check: ok (every manifest file matches its sha256)'
        : `package check: FAILED ${status.current.verification.error?.code ?? ''}: ${status.current.verification.error?.message ?? 'unknown'}`);
    } else {
      console.log(`package check: skipped (${status.current.verification?.note ?? 'not an installed version'})`);
    }
    if (status.health.checked) {
      console.log(status.health.ok
        ? `health:      ok (${status.health.tools} tools, ${status.health.durationMs}ms)`
        : `health:      FAILED ${status.health.error}`);
    } else {
      console.log('health:      skipped');
    }
  }
  for (const warning of status.warnings ?? []) console.log(`warning:     ${warning}`);
  console.log(`versions (${status.versions.length}, entry presence only unless marked verified):`);
  if (status.versions.length === 0) {
    console.log('  (none — run `node scripts/hot-update.mjs build`)');
  }
  for (const version of status.versions) {
    if (!version.entryPresent) {
      console.log(`  ${version.id}  INVALID ${version.error.code}: ${version.error.message}`);
      continue;
    }
    const marker = version.current ? '*' : ' ';
    const verified = version.verified === true ? '  verified' : '';
    console.log(`  ${marker} ${version.id}  api=${version.apiVersion}  files=${version.fileCount ?? '?'}  created=${formatTime(version.createdAt)}${verified}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.command) {
    console.log(usage());
    process.exitCode = args.help ? 0 : 1;
    return;
  }
  const root = resolve(args.root);
  const versionsRoot = args.versions ? resolve(args.versions) : undefined;
  const timeoutMs = args.timeout === undefined ? undefined : Number(args.timeout);
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new Error('--timeout must be a positive number of milliseconds');
  }
  switch (args.command) {
    case 'build': {
      const result = await buildPackage({
        sourceRoot: root,
        pluginRoot: root,
        versionsRoot,
        version: args.version,
        gitCommit: args.commit,
        force: args.force === true,
      });
      if (args.json) printJson(result);
      else printBuild(result);
      return;
    }
    case 'install': {
      const positional = args.positional[0];
      let packagePath = args.package;
      let version = args.version;
      if (!packagePath && !version && positional) {
        // A separator or a leading dot signals path intent. A bare token is a
        // version id, so a typo such as `my-build` is still looked up as a
        // version; `./my-build` or `builds\v2` reports PACKAGE_MISSING instead
        // of the misleading VERSION_UNKNOWN.
        const pathIntent = /[\\/]/.test(positional) || positional.startsWith('.');
        if (pathIntent) {
          packagePath = resolve(positional);
          if (!isDirectory(packagePath)) {
            throw new HotUpdateError(
              'HOT_UPDATE_PACKAGE_MISSING',
              `package directory does not exist: ${packagePath} (a bare version id must not contain a path separator)`,
            );
          }
        } else {
          version = positional;
        }
      }
      const result = await installPackage({
        pluginRoot: root,
        packagePath,
        version,
        force: args.force === true,
        timeoutMs,
      });
      if (args.json) printJson(result);
      else printInstall(result);
      return;
    }
    case 'rollback': {
      const result = await rollbackPackage({
        pluginRoot: root,
        version: args.version ?? args.positional[0],
        timeoutMs,
      });
      if (args.json) printJson(result);
      else printRollback(result);
      return;
    }
    case 'status': {
      const status = await getStatus({ pluginRoot: root, checkHealth: args.noHealth !== true, timeoutMs });
      if (args.json) printJson(status);
      else printStatus(status);
      return;
    }
    default:
      throw new Error(`unknown command: ${args.command}\n\n${usage()}`);
  }
}

main().catch((error) => {
  const code = error?.code ? `${error.code}: ` : '';
  console.error(`hot-update failed: ${code}${error instanceof Error ? error.message : String(error)}`);
  if (error?.details && Object.keys(error.details).length > 0) {
    console.error(JSON.stringify(error.details, null, 2));
  }
  process.exitCode = 1;
});
