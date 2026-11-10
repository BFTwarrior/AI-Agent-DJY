import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildUiConsole } from './ui-console.mjs';
import {
  bearer,
  cookieValue,
  isLoopbackHostHeader,
  isSameOriginRequest,
  matchesToken,
  uiCookieMatches,
  uiCookieName,
  uiPatrolCookieMatches,
  uiPatrolCookieName,
  uiSessionCookieName,
} from './auth.mjs';
import { isLoopbackAddress } from './network.mjs';
import { sendError, sendJson } from './response.mjs';
import { buildUiSnapshot } from './ui-snapshot.mjs';

const UI_SESSION_COOKIE_PREFIX = 'agent_teams_ui';
const TEAM_VIEW_ASSETS = [
  'team-view.css',
  'team-view.light.css',
  'team-view.dark.css',
  'team-view-theme-boot.js',
  'team-view-live.js',
  'team-view-app.js',
  'team-view-patrol.js',
  'team-view-stream.js',
  'team-view-theme.js',
];

function inlineTeamViewAssets(html, teamViewPath) {
  let result = html;
  for (const name of TEAM_VIEW_ASSETS) {
    const css = name.endsWith('.css');
    const tag = css
      ? `<link rel="stylesheet" href="./${name}">`
      : `<script src="./${name}"></script>`;
    if (!result.includes(tag)) continue;
    const file = teamViewPath instanceof URL
      ? new URL(name, teamViewPath)
      : join(dirname(teamViewPath), name);
    const content = readFileSync(file, 'utf8');
    if (content.includes(css ? '</style' : '</script')) {
      throw new Error(`team view asset cannot be inlined: ${name}`);
    }
    result = result.replace(tag, () => (css ? `<style>${content}</style>` : `<script>${content}</script>`));
    if (result.includes(tag)) throw new Error(`duplicate team view asset reference: ${name}`);
  }
  return result;
}

function appendSetCookie(res, cookie) {
  const current = res.getHeader('set-cookie');
  if (current == null) {
    res.setHeader('set-cookie', cookie);
    return;
  }
  const list = Array.isArray(current) ? current : [String(current)];
  res.setHeader('set-cookie', [...list, cookie]);
}

export function createUiRoutes({
  store,
  service,
  version,
  token,
  uiToken,
  uiAccessKey,
  restrictUiToLoopback,
  teamViewPath,
  sendUiStream,
}) {
  const snapshot = () => buildUiSnapshot({ store, service, version });
  const patrolTokenFor = (teamId) => createHmac('sha256', uiToken).update(`patrol:${teamId}`).digest('hex');

  async function handlePatrol(req, res, url) {
    if (req.method !== 'POST' || req.headers.authorization) return false;
    const route = url.pathname.match(/^\/api\/v1\/teams\/([^/]+)\/patrol$/u);
    if (!route) return false;
    let teamId;
    try {
      teamId = decodeURIComponent(route[1]);
    } catch {
      return false;
    }
    const cookie = cookieValue(req.headers.cookie, uiPatrolCookieName(req, teamId));
    if (!uiToken || !cookie) return false;
    if (!uiPatrolCookieMatches(req, teamId, patrolTokenFor(teamId))
      || !isLoopbackHostHeader(String(req.headers.host ?? ''))
      || (restrictUiToLoopback && !isLoopbackAddress(req.socket.remoteAddress))
      || !isSameOriginRequest(req)) {
      sendError(res, 403, 'E_FORBIDDEN', 'valid same-origin loopback patrol session required');
      return true;
    }
    if (!store.getTeam(teamId)) {
      sendError(res, 404, 'E_NOT_FOUND', 'team not found');
      return true;
    }
    sendJson(res, 200, { ok: true, data: await service.patrol(teamId), error: null });
    return true;
  }

  function handlePage(req, res, url) {
    if (url.pathname !== '/ui' && url.pathname !== '/ui/') return false;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendError(res, 405, 'E_METHOD', 'method not allowed');
      return true;
    }
    if (!isLoopbackHostHeader(String(req.headers.host ?? ''))) {
      sendError(res, 403, 'E_FORBIDDEN', 'team view host is not loopback');
      return true;
    }
    if (restrictUiToLoopback && !isLoopbackAddress(req.socket.remoteAddress)) {
      sendError(res, 403, 'E_FORBIDDEN', 'team view is loopback-only');
      return true;
    }
    if (uiAccessKey) {
      const cookieName = uiCookieName(req);
      const cookieKey = cookieValue(req.headers.cookie, cookieName);
      const queryKey = url.searchParams.get('key') ?? '';
      if (!matchesToken(cookieKey, uiAccessKey) && !matchesToken(queryKey, uiAccessKey)) {
        sendError(res, 403, 'E_FORBIDDEN', 'team view access key required');
        return true;
      }
      if (matchesToken(queryKey, uiAccessKey)) {
        res.setHeader('set-cookie', `${cookieName}=${uiAccessKey}; HttpOnly; SameSite=Strict; Path=/ui; Max-Age=86400`);
      }
    }
    // Keep console projection failures separate from template failures so the page can still bootstrap.
    let consolePayload;
    try {
      consolePayload = buildUiConsole({ store, service, version });
    } catch {
      consolePayload = undefined;
    }
    try {
      let html = readFileSync(teamViewPath, 'utf8');
      html = inlineTeamViewAssets(html, teamViewPath);
      const bootstrap = JSON.stringify({ version, snapshot: snapshot(), console: consolePayload }).replace(/</g, '\\u003c');
      html = html.replace(
        '<!-- AGENT_TEAMS_UI_BOOTSTRAP -->',
        () => `<script>window.__AGENT_TEAMS_UI__=${bootstrap}</script>`,
      );
      if (uiToken) {
        // The cookie conveys only the viewer role and stays scoped away from API write routes.
        appendSetCookie(res, `${uiSessionCookieName(req)}=${uiToken}; HttpOnly; SameSite=Strict; Path=/api/v1/ui; Max-Age=86400`);
        for (const team of store.listTeams().slice(0, 2)) {
          const path = `/api/v1/teams/${encodeURIComponent(team.id)}/patrol`;
          appendSetCookie(res, `${uiPatrolCookieName(req, team.id)}=${patrolTokenFor(team.id)}; HttpOnly; SameSite=Strict; Path=${path}; Max-Age=86400`);
        }
      }
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      });
      res.end(req.method === 'HEAD' ? undefined : html);
    } catch {
      sendError(res, 404, 'E_NOT_FOUND', 'team view not found');
    }
    return true;
  }

  function handleUiStream(req, res, url) {
    if (url.pathname !== '/api/v1/ui/stream' || req.method !== 'GET') return false;
    // Prefer explicit credentials, then the scoped cookie, retaining the old query token for existing clients.
    const supplied = bearer(req);
    let authorized = false;
    if (supplied) {
      authorized = Boolean((token && matchesToken(supplied, token))
        || (uiToken && matchesToken(supplied, uiToken)));
    } else if (uiCookieMatches(req, uiToken, UI_SESSION_COOKIE_PREFIX)) {
      authorized = true;
    } else {
      const legacy = url.searchParams.get('token') ?? '';
      authorized = Boolean((uiToken && matchesToken(legacy, uiToken))
        || (token && matchesToken(legacy, token)));
    }
    if (!authorized) {
      sendError(res, 401, 'E_AUTH', 'unauthorized');
      return true;
    }
    sendUiStream(req, res);
    return true;
  }

  function handleApi(parts, method, actor, res) {
    if (method !== 'GET') return false;
    if (parts[0] === 'ui' && parts[1] === 'snapshot') {
      if (actor.role !== 'ui' && actor.role !== 'admin') {
        sendError(res, 403, 'E_FORBIDDEN', 'ui/admin token required');
      } else {
        sendJson(res, 200, { ok: true, data: snapshot(), error: null });
      }
      return true;
    }
    if (parts[0] === 'ui' && parts[1] === 'console') {
      if (actor.role !== 'ui' && actor.role !== 'admin') {
        sendError(res, 403, 'E_FORBIDDEN', 'ui/admin token required');
      } else {
        sendJson(res, 200, { ok: true, data: buildUiConsole({ store, service, version }), error: null });
      }
      return true;
    }
    return false;
  }

  return { handlePage, handleUiStream, handleApi, handlePatrol, snapshot };
}
