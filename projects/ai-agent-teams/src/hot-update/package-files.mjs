import { promises as fsp } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  MANIFEST_NAME,
  fail,
  hashBytes,
  lstatOrNull,
  normalizePosixPath,
  posixDirname,
  defaultSyncFile,
} from './support.mjs';

// Only these roots ship inside a runtime package. Everything else (docs,
// history, tests, build caches, the pointer itself) stays behind; the package
// is the runtime surface, not a copy of the repository.
//
// The plugin's own `runtime/` directory is excluded because it holds the
// pointer and installed versions, but `src/runtime/` is a real source module
// (container and loopback bridge) and must ship. That is why the build uses an
// allow-list instead of a repository-wide name blacklist: a directory name
// only excludes content when it is a genuine cache at any depth.
const COPY_ROOTS = ['src', 'assets', 'config'];
const COPY_FILES = ['package.json', 'VERSION'];
const CONFIG_EXCLUDED_FILES = new Set(['local.json']);
const RUNTIME_FILE_EXTENSIONS = new Set([
  '.mjs', '.js', '.cjs', '.json', '.html', '.css',
  '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico',
  '.woff', '.woff2', '.ttf', '.otf', '.map',
]);
// Cache/VCS directories are never runtime content. This list is deliberately
// small: names such as `runtime`, `build`, `test` or `docs` are not caches in
// general, and are only skipped (with a warning) when they are empty or when a
// file inside them does not match the runtime allow-list.
const CACHE_DIRECTORY_NAMES = new Set([
  'node_modules',
  '.git',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  'coverage',
  '.nyc_output',
  '.agent-teams',
  '.agent-teams-worktrees',
  '.agent-teams-homes',
  '.ai-agent-teams',
]);
// Names that only ever identify build output or local temporary state and
// therefore are also excluded (with a warning) when they would otherwise ship.
const BUILD_OUTPUT_DIRECTORY_NAMES = new Set(['dist', 'build', 'target', 'tmp', '.tmp']);
const EXCLUDED_FILE_NAMES = new Set(['.DS_Store', 'Thumbs.db']);

function isRuntimeAssetName(name) {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return false;
  return RUNTIME_FILE_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

function isRuntimeModuleName(name) {
  return name.endsWith('.mjs') || name.endsWith('.js') || name.endsWith('.cjs');
}

// A relative ESM specifier can name a file with or without its extension, or a
// directory index. Mirror Node's resolution order for the files a package can
// contain.
function importCandidates(importer, specifier) {
  const clean = specifier.split('?')[0].split('#')[0];
  const base = normalizePosixPath(`${posixDirname(importer)}/${clean}`);
  if (base === null || base === '') return [];
  return [
    base,
    `${base}.mjs`,
    `${base}.js`,
    `${base}.cjs`,
    `${base}.json`,
    `${base}/index.mjs`,
    `${base}/index.js`,
    `${base}/index.cjs`,
    `${base}/index.json`,
  ];
}

// Static import/export specifiers. `import './x.mjs'`, `import x from './x.mjs'`,
// `export * from './x.mjs'`, `export { x } from './x.mjs'` and dynamic
// `import('./x.mjs')` all name a relative path. Scanning is token based so a
// comment or string that merely contains an import example is not mistaken for
// a real dependency.
function tokenizeModuleSource(source) {
  const tokens = [];
  let index = 0;
  const isIdentStart = (char) => /[A-Za-z_$]/.test(char);
  const isIdent = (char) => /[A-Za-z0-9_$]/.test(char);
  while (index < source.length) {
    const char = source[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === '/' && source[index + 1] === '/') {
      index += 2;
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index += 1;
      index += 2;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      const quote = char;
      let value = '';
      index += 1;
      while (index < source.length) {
        const current = source[index];
        if (current === '\\') {
          value += source[index + 1] ?? '';
          index += 2;
          continue;
        }
        if (current === quote) {
          index += 1;
          break;
        }
        value += current;
        index += 1;
      }
      tokens.push({ type: 'string', value });
      continue;
    }
    if (isIdentStart(char)) {
      let value = '';
      while (index < source.length && isIdent(source[index])) {
        value += source[index];
        index += 1;
      }
      tokens.push({ type: 'ident', value });
      continue;
    }
    tokens.push({ type: 'punct', value: char });
    index += 1;
  }
  return tokens;
}

function collectRelativeSpecifiers(source) {
  const tokens = tokenizeModuleSource(source);
  const specifiers = new Set();
  const isString = (token) => token?.type === 'string';
  const addIfRelative = (token) => {
    if (isString(token) && token.value.startsWith('.')) specifiers.add(token.value);
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type !== 'ident' || (token.value !== 'import' && token.value !== 'export')) continue;
    // import './x.mjs'
    if (isString(tokens[index + 1])) {
      addIfRelative(tokens[index + 1]);
      continue;
    }
    // import('./x.mjs')
    if (tokens[index + 1]?.type === 'punct' && tokens[index + 1].value === '(') {
      addIfRelative(tokens[index + 2]);
      continue;
    }
    // import ... from './x.mjs' / export ... from './x.mjs'
    for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
      const current = tokens[cursor];
      if (current.type === 'punct' && current.value === ';') break;
      if (current.type === 'ident' && current.value === 'from') {
        addIfRelative(tokens[cursor + 1]);
        break;
      }
    }
  }
  return [...specifiers];
}

async function directoryHasEntries(path) {
  try {
    const entries = await fsp.readdir(path);
    return entries.length > 0;
  } catch {
    return false;
  }
}

async function copyFileInto({ sourceRoot, staging, relPath, syncFile }) {
  const data = await fsp.readFile(join(sourceRoot, ...relPath.split('/')));
  const target = join(staging, ...relPath.split('/'));
  await fsp.mkdir(dirname(target), { recursive: true });
  await fsp.writeFile(target, data, { mode: 0o644 });
  // Flush before the directory can be renamed into place: the rename is what
  // makes the package visible, so the bytes must already be on disk.
  await syncFile(target);
  return { path: relPath, sha256: hashBytes(data), size: data.length };
}

async function copyTree({ sourceRoot, staging, relDir, collected, warnings, syncFile }) {
  const absoluteDir = join(sourceRoot, ...relDir.split('/'));
  const entries = await fsp.readdir(absoluteDir, { withFileTypes: true });
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  for (const entry of entries) {
    const relPath = `${relDir}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      // A symlink can point anywhere on the machine; packaging it would either
      // smuggle outside files in or produce a package that breaks on install.
      fail('HOT_UPDATE_BUILD_FAILED', `refusing to package a symlink: ${relPath}`);
    }
    if (entry.isDirectory()) {
      if (CACHE_DIRECTORY_NAMES.has(entry.name) || BUILD_OUTPUT_DIRECTORY_NAMES.has(entry.name)) {
        // INV-048: never drop a non-empty directory silently. A cache name that
        // happens to be a real asset directory is still reported to the caller.
        if (await directoryHasEntries(join(absoluteDir, entry.name))) {
          warnings.push(`skipped non-empty directory: ${relPath} (build cache/VCS output)`);
        }
        continue;
      }
      await copyTree({ sourceRoot, staging, relDir: relPath, collected, warnings, syncFile });
      continue;
    }
    if (!entry.isFile()) continue;
    if (EXCLUDED_FILE_NAMES.has(entry.name)) continue;
    if (relDir.split('/')[0] === 'config' && CONFIG_EXCLUDED_FILES.has(entry.name)) continue;
    if (entry.name.endsWith('.tmp')) continue;
    if (!isRuntimeAssetName(entry.name)) {
      warnings.push(`skipped file without a runtime extension: ${relPath}`);
      continue;
    }
    collected.push(await copyFileInto({ sourceRoot, staging, relPath, syncFile }));
  }
}

/**
 * Copy the allow-listed runtime surface of `sourceRoot` into a staging
 * directory and return every copied file with its digest.
 *
 * @param {{ sourceRoot: string, staging: string, syncFile?: (path: string) => Promise<void> }} options
 * @returns {Promise<{ files: object[], warnings: string[] }>} `files` is sorted by POSIX path.
 */
export async function collectPackageFiles({ sourceRoot, staging, syncFile = defaultSyncFile }) {
  const collected = [];
  const warnings = [];
  for (const name of COPY_FILES) {
    const source = join(sourceRoot, name);
    const stat = await lstatOrNull(source);
    if (!stat) {
      if (name === 'package.json') fail('HOT_UPDATE_BUILD_FAILED', `package.json is missing from ${sourceRoot}`);
      continue;
    }
    if (!stat.isFile()) fail('HOT_UPDATE_BUILD_FAILED', `${name} must be a regular file in ${sourceRoot}`);
    collected.push(await copyFileInto({ sourceRoot, staging, relPath: name, syncFile }));
  }
  for (const root of COPY_ROOTS) {
    const source = join(sourceRoot, root);
    const stat = await lstatOrNull(source);
    if (!stat) {
      if (root === 'src') fail('HOT_UPDATE_BUILD_FAILED', `src/ is missing from ${sourceRoot}`);
      continue;
    }
    if (!stat.isDirectory()) fail('HOT_UPDATE_BUILD_FAILED', `${root} must be a directory in ${sourceRoot}`);
    await copyTree({ sourceRoot, staging, relDir: root, collected, warnings, syncFile });
  }
  collected.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return { files: collected, warnings };
}

// A runtime package is only usable if every relative import in every packaged
// module resolves inside the package. This is checked at build time because a
// package missing `src/runtime/container.mjs` still passes an
// `initialize` + `tools/list` probe (autostart is disabled) and only fails
// later when the daemon is actually started.
export async function assertImportClosure({ staging, files }) {
  const packaged = new Set(files.map((file) => file.path));
  const unresolved = [];
  for (const file of files) {
    if (!isRuntimeModuleName(file.path)) continue;
    const source = await fsp.readFile(join(staging, ...file.path.split('/')), 'utf8');
    for (const specifier of collectRelativeSpecifiers(source)) {
      const candidates = importCandidates(file.path, specifier);
      if (candidates.length === 0 || !candidates.some((candidate) => packaged.has(candidate))) {
        unresolved.push({ from: file.path, specifier, expected: candidates[0] ?? null });
      }
    }
  }
  if (unresolved.length > 0) {
    fail(
      'HOT_UPDATE_IMPORT_MISSING',
      `package is missing ${unresolved.length} relative import target(s)`,
      { imports: unresolved },
    );
  }
}

/**
 * Write `manifest.json` into the staging directory. `wx` is deliberate: a
 * pre-existing manifest would mean two writers built the same staging tree.
 *
 * @param {string} staging
 * @param {object} manifest
 * @param {(path: string) => Promise<void>} syncFile
 */
export async function writeManifest(staging, manifest, syncFile = defaultSyncFile) {
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  const target = join(staging, MANIFEST_NAME);
  await fsp.writeFile(target, text, { mode: 0o644, flag: 'wx' });
  await syncFile(target);
}
