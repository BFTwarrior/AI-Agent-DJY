import { timingSafeEqual } from 'node:crypto';

function matchesToken(supplied, expected) {
  if (typeof supplied !== 'string' || typeof expected !== 'string' || supplied.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
  } catch {
    return false;
  }
}

export function bearer(req) {
  const header = String(req.headers.authorization ?? '');
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

export function matchesBearer(header, expected) {
  const value = `Bearer ${expected}`;
  if (header.length !== value.length) return false;
  try {
    return timingSafeEqual(Buffer.from(header), Buffer.from(value));
  } catch {
    return false;
  }
}

export function cookieValue(header, name) {
  for (const part of String(header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return '';
}

export function isLoopbackHostHeader(host) {
  if (!host) return false;
  try {
    const hostname = new URL(`http://${host}`).hostname;
    return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostname);
  } catch {
    return false;
  }
}

export function uiCookieName(req) {
  const port = Number(req.socket?.localPort);
  return Number.isInteger(port) && port > 0 ? `at_ui_${port}` : 'at_ui';
}

export function uiSessionCookieName(req, prefix = 'agent_teams_ui') {
  const port = Number(req.socket?.localPort);
  return Number.isInteger(port) && port > 0 ? `${prefix}_${port}` : prefix;
}

export function uiPatrolCookieName(req, teamId) {
  const port = Number(req.socket?.localPort);
  const portSuffix = Number.isInteger(port) && port > 0 ? `_${port}` : '';
  const teamSuffix = Buffer.from(String(teamId)).toString('base64url');
  return `agent_teams_patrol${portSuffix}_${teamSuffix}`;
}

export function uiPatrolCookieMatches(req, teamId, patrolToken) {
  if (!patrolToken) return false;
  const cookie = cookieValue(req.headers.cookie, uiPatrolCookieName(req, teamId));
  return matchesToken(cookie, patrolToken);
}

export function isSameOriginRequest(req) {
  const origin = String(req.headers.origin ?? '');
  const host = String(req.headers.host ?? '');
  if (!origin || !host) return false;
  try {
    const parsed = new URL(origin);
    return ['http:', 'https:'].includes(parsed.protocol)
      && parsed.origin === origin
      && parsed.host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

export function uiCookieMatches(req, uiToken, prefix = 'agent_teams_ui') {
  if (!uiToken) return false;
  return matchesToken(cookieValue(req.headers.cookie, uiSessionCookieName(req, prefix)), uiToken);
}

function licenseActive(license, now) {
  if (!license || license.status !== 'active') return false;
  if (license.expiresAt == null) return true;
  const numeric = typeof license.expiresAt === 'number' ? license.expiresAt : Number(license.expiresAt);
  const expiresAt = Number.isFinite(numeric) ? numeric : Date.parse(license.expiresAt);
  return Number.isFinite(expiresAt) ? expiresAt > now : false;
}

function licenseUsable(store, member, now = Date.now()) {
  // Check both the member snapshot and the license row: revocation or expiry in either view must fail closed.
  const current = member.licenseId ? store.getLicense(member.licenseId) : undefined;
  // A missing referenced row cannot be kept alive by a stale member snapshot.
  if (member.licenseId && !current) return false;
  if (!member.license && !current) return false;
  return (!member.license || licenseActive(member.license, now))
    && (!current || licenseActive(current, now));
}

export function authenticate(req, token, store, uiToken, { allowUiCookie = false } = {}) {
  const supplied = bearer(req);
  const header = String(req.headers.authorization ?? '');
  if (token && matchesBearer(header, token)) return { role: 'admin', name: 'captain' };
  if (uiToken && matchesBearer(header, uiToken)) return { role: 'ui', name: 'viewer' };
  if (allowUiCookie && uiCookieMatches(req, uiToken)) return { role: 'ui', name: 'viewer' };
  if (!supplied) return undefined;
  const member = store.findMemberByToken(supplied);
  if (member && member.status !== 'removed') {
    if (member.sessionRecoveryState === 'unknown' || member.workerSessionStart?.state === 'unknown') return undefined;
    if (!licenseUsable(store, member)) return undefined;
    return { role: 'member', memberId: member.id, teamId: member.teamId, name: member.name, licenseId: member.licenseId };
  }
  const contractor = store.listAllContractors().find((item) => item.status === 'running'
    && matchesToken(supplied, store.getMemberToken(item.id) ?? ''));
  if (contractor) {
    return {
      role: 'contractor',
      contractorId: contractor.id,
      teamId: contractor.teamId,
      name: `contractor:${contractor.id}`,
    };
  }
  return undefined;
}

export function memberCapabilities(store, actor) {
  if (actor?.role !== 'member') return [];
  const member = (actor.memberId ? store.getMember(actor.memberId) : undefined)
    ?? (actor.teamId && actor.name ? store.findMember(actor.teamId, actor.name) : undefined);
  const license = member?.license ?? (member?.licenseId ? store.getLicense(member.licenseId) : undefined);
  return Array.isArray(license?.capabilities) ? license.capabilities : [];
}

export function leadMayManageRoute(parts, method) {
  if (parts[0] !== 'teams' || !parts[1]) return false;
  const section = parts[2];
  if (section === 'tasks') {
    if (parts.length === 3 && method === 'POST') return true;
    if (parts[3] && ['reassign', 'amend', 'merge', 'complete', 'continue'].includes(parts[4]) && method === 'POST') return true;
  }
  if (section === 'members' && parts[3] && parts[4] && ['sleep', 'wake'].includes(parts[4]) && method === 'POST') return true;
  if (section === 'patrol' && method === 'POST') return true;
  if (section === 'tick' && method === 'POST') return true;
  if (section === 'audit' && method === 'GET') return true;
  if (section === 'findings' && method === 'GET') return true;
  if (section === 'lifecycle' && method === 'GET') return true;
  return false;
}

export { matchesToken };
