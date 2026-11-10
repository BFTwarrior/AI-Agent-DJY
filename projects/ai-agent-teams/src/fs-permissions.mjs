import { spawnSync } from 'node:child_process';

let cachedWindowsUserSid;

export function windowsUserSid() {
  if (process.platform !== 'win32') return undefined;
  if (cachedWindowsUserSid) return cachedWindowsUserSid;
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
  ], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  const sid = result.stdout?.trim();
  if (result.error || result.status !== 0 || !/^S-1-\d+(?:-\d+)+$/u.test(sid ?? '')) {
    throw new Error(`cannot determine current Windows user SID${result.error ? `: ${result.error.message}` : ''}`);
  }
  cachedWindowsUserSid = sid;
  return sid;
}

/**
 * Remove inherited Windows access and grant access only to the running user and
 * LocalSystem. POSIX permission bits continue to be applied by the call site.
 * @param {string} path
 * @param {{ directory?: boolean }} [options]
 */
export function restrictWindowsAcl(path, { directory = false } = {}) {
  if (process.platform !== 'win32') return;
  const inheritance = directory ? '(OI)(CI)F' : 'F';
  const grants = [
    `*${windowsUserSid()}:${inheritance}`,
    `*S-1-5-18:${inheritance}`,
  ];
  runIcalcs(path, ['/reset']);
  runIcalcs(path, ['/inheritance:r', '/grant:r', ...grants]);
  assertRestrictedAcl(path);
}

export function readWindowsAcl(path) {
  if (process.platform !== 'win32') return [];
  const script = [
    '$acl = Get-Acl -LiteralPath $env:AGENT_TEAMS_ACL_PATH',
    'foreach ($entry in $acl.Access) {',
    '  $sid = $entry.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value',
    '  $rights = [int]$entry.FileSystemRights',
    '  Write-Output ($sid + "|" + $entry.AccessControlType + "|" + $rights + "|" + $entry.IsInherited)',
    '}',
  ].join('; ');
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command', script,
  ], {
    encoding: 'utf8', windowsHide: true, timeout: 10000,
    env: { ...process.env, AGENT_TEAMS_ACL_PATH: path },
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr?.trim() ?? `exit code ${result.status}`;
    throw new Error(`cannot read Windows ACL for ${path}: ${detail}`);
  }
  return result.stdout.trim().split(/\r?\n/u).filter(Boolean).map((line) => {
    const [sid, type, rights, inherited] = line.split('|');
    return { sid, type, rights, inherited: inherited === 'True' };
  });
}

function assertRestrictedAcl(path) {
  const expectedSids = new Set([windowsUserSid(), 'S-1-5-18']);
  const entries = readWindowsAcl(path);
  if (entries.length !== expectedSids.size) {
    throw new Error(`unexpected Windows ACL entry count for ${path}: ${entries.length}`);
  }
  for (const entry of entries) {
    if (!expectedSids.has(entry.sid)
      || entry.type !== 'Allow'
      || entry.inherited
      || Number(entry.rights) !== 2032127) {
      throw new Error(`unexpected Windows ACL entry for ${path}: ${entry.sid}|${entry.type}|${entry.rights}|${entry.inherited}`);
    }
    expectedSids.delete(entry.sid);
  }
  if (expectedSids.size > 0) {
    throw new Error(`Windows ACL is missing required principals for ${path}`);
  }
}

function runIcalcs(path, args) {
  const result = spawnSync('icacls.exe', [path, ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 10000,
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr?.trim() ?? `exit code ${result.status}`;
    throw new Error(`cannot restrict Windows ACL for ${path}: ${detail}`);
  }
}
