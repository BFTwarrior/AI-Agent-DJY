import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { marketplaceDocument } from '../src/plugin-metadata.mjs';

const root = resolve('.');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const version = pkg.version;
const iconData = `data:image/png;base64,${readFileSync('assets/icon.png').toString('base64')}`;
const dist = resolve('dist');
const stageRoot = join(dist, '_stage');
const folder = `ai-agent-teams-v${version}`;
const stage = join(stageRoot, folder);
const zip = join(dist, `${folder}.zip`);
const marketFolder = `ai-agent-teams-marketplace-v${version}`;
const marketRoot = join(dist, '_market');
const marketStage = join(marketRoot, marketFolder);
const marketZip = join(dist, `${marketFolder}.zip`);

// Every entry inside both ZIPs carries this timestamp so the archive is a pure
// function of the sources. See the call site in writeZip.
const FIXED_MTIME = new Date(Date.UTC(1980, 0, 1, 0, 0, 0));

function dosDateTime(date) {
  const d = date instanceof Date && Number.isFinite(date.getTime())
    ? new Date(Math.max(date.getTime(), Date.UTC(1980, 0, 1)))
    : new Date(Date.UTC(1980, 0, 1));
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function listZipEntries(source) {
  const entries = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const name = relative(source, full).split(sep).join('/');
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        entries.push({ full, name: `${name}/`, directory: true });
        walk(full);
      } else if (entry.isFile()) {
        entries.push({ full, name, directory: false });
      }
    }
  };
  walk(source);
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

// Compress-Archive writes OEM-codepage names and backslash separators on
// Windows, which makes Chinese folders unreadable to many ZIP clients. Build
// the archive ourselves with UTF-8 names and forward slashes so the same ZIP
// is readable by models, GitHub, macOS/Linux tools and Windows Explorer.
function writeZip(source, target) {
  const entries = listZipEntries(source);
  if (entries.length > 0xffff) throw new Error('ZIP64 is not supported: too many entries');
  const rootName = basename(source);
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = `${rootName}/${entry.name}`;
    const nameBuf = Buffer.from(name, 'utf8');
    // Use one fixed timestamp for every entry (1980-01-01, the ZIP epoch) rather
    // than the file's mtime. With mtimes, two builds of identical sources differ
    // in bytes: staging copies get "now", and directory mtimes change whenever a
    // sibling is created, so the published SHA256 could not be reproduced by
    // anyone else and a re-pack silently invalidated the release notes.
    const { time, date } = dosDateTime(FIXED_MTIME);
    const data = entry.directory ? Buffer.alloc(0) : readFileSync(entry.full);
    let method = 0;
    let compressed = data;
    if (!entry.directory && data.length > 0) {
      const candidate = deflateRawSync(data, { level: 9 });
      if (candidate.length < data.length) {
        method = 8;
        compressed = candidate;
      }
    }
    const checksum = crc32(data) >>> 0;
    const flags = 0x0800;
    const version = 20;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(version, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(version, 4);
    central.writeUInt16LE(version, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    const mode = entry.directory ? 0o040755 : 0o100644;
    central.writeUInt32LE(((((mode << 16) >>> 0) | (entry.directory ? 0x10 : 0)) >>> 0), 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + compressed.length;
  }

  const centralOffset = offset;
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);
  writeFileSync(target, Buffer.concat([...locals, ...centrals, eocd]));
}

function writeDigest(target, name) {
  const digest = createHash('sha256').update(readFileSync(target)).digest('hex');
  writeFileSync(`${target}.sha256`, `${digest}  ${name}\n`);
  return digest;
}

mkdirSync(dist, { recursive: true });
rmSync(stageRoot, { recursive: true, force: true });
rmSync(marketRoot, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

const skip = new Set(['dist', 'node_modules', '.git', '.tmp', '.ai-agent-teams', '.zcode-agent-teams', '.agent-teams', '.agent-teams-worktrees', '.agent-teams-homes', '文档', '逻辑图', '历史', '归档', '参考']);
for (const entry of readdirSync(root, { withFileTypes: true })) {
  if (skip.has(entry.name)) continue;
  if (entry.isFile() && statSync(join(root, entry.name)).size === 0) {
    throw new Error(`refusing to package an empty root file: ${entry.name}`);
  }
  if (!/^[\x20-\x7E]+$/.test(entry.name)) {
    throw new Error(`refusing to package a non-ASCII root entry: ${entry.name}`);
  }
  cpSync(join(root, entry.name), join(stage, entry.name), { recursive: true });
}
// Workspace-specific model/isolation settings must never ship in the ZIP.
rmSync(join(stage, 'config', 'local.json'), { force: true });
// Internal status/handoff notes carry review history and host paths; they are
// not part of a release. The empty hot-update runtime pointer is also local.
rmSync(join(stage, 'docs', 'status'), { recursive: true, force: true });
rmSync(join(stage, 'runtime'), { recursive: true, force: true });

// Strip the operator's workspace root from the two shipped guidance files so
// the package is portable and does not disclose a local directory layout.
const sanitizeReleaseText = (relPath, replacements) => {
  const file = join(stage, relPath);
  const original = readFileSync(file, 'utf8');
  let sanitized = original;
  for (const [pattern, value] of replacements) sanitized = sanitized.replaceAll(pattern, value);
  if (sanitized !== original) writeFileSync(file, sanitized);
};
sanitizeReleaseText('AGENTS.md', [[/[A-Za-z]:[\\/](?![\\/])[^\s`)"']+/g, '<workspace>']]);
sanitizeReleaseText('docs/guides/MIGRATION.md', [[/[A-Za-z]:[\\/](?![\\/])[^\s`)"']+/g, '<workspace>']]);
sanitizeReleaseText('docs/verification.md', [
  [/\b172\.29\.32\.1\b/g, '<wsl-gateway>'],
  [/[A-Za-z]:[\\/](?![\\/])[^\s`)"']+/g, '<workspace>'],
]);

writeZip(stage, zip);

mkdirSync(marketStage, { recursive: true });
cpSync(stage, join(marketStage, folder), { recursive: true });
writeFileSync(join(marketStage, 'marketplace.json'), `${JSON.stringify(
  marketplaceDocument({ version, source: `./${folder}`, icon: iconData }),
  null,
  2,
)}\n`);

writeZip(marketStage, marketZip);

const digest = writeDigest(zip, `${folder}.zip`);
const marketDigest = writeDigest(marketZip, `${marketFolder}.zip`);
rmSync(stageRoot, { recursive: true, force: true });
rmSync(marketRoot, { recursive: true, force: true });
console.log(`PACKAGED ${zip}`);
console.log(`SHA256 ${digest}`);
console.log(`PACKAGED ${marketZip}`);
console.log(`SHA256 ${marketDigest}`);
