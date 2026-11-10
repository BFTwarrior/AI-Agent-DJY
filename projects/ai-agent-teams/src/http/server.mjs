import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { readDiscovery, writeDiscovery } from '../discovery.mjs';
import { LEAD_CAPABILITY, SHADOW_CAPABILITY } from '../service/roles.mjs';
import { authenticate, leadMayManageRoute, memberCapabilities, uiCookieMatches } from './auth.mjs';
import { createSseRegistry } from './sse.mjs';
import { sendError, sendJson, readJson } from './response.mjs';
import { isLoopbackAddress } from './network.mjs';
import { createUiRoutes } from './ui-routes.mjs';

const MAX_TEAM_STREAMS = 64;
const MAX_UI_STREAMS = 64;
const TEAM_VIEW_PATH = new URL('../../assets/team-view.html', import.meta.url);
const PACKAGE_VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

export { readDiscovery, writeDiscovery, isLoopbackAddress };
export { writeSse } from './sse-write.mjs';

/**
 * @param {{ store: any, service: any, token: string, version?: string, workspace?: string, instanceId?: string, pid?: number, teamViewPath?: string|URL, uiToken?: string, uiAccessKey?: string, restrictUiToLoopback?: boolean }} input
 */
export function createApp({
  store,
  service,
  token,
  version = PACKAGE_VERSION,
  workspace,
  instanceId,
  pid = process.pid,
  teamViewPath = TEAM_VIEW_PATH,
  uiToken = randomBytes(24).toString('hex'),
  uiAccessKey = randomBytes(24).toString('hex'),
  restrictUiToLoopback = false,
  maxTeamStreams = MAX_TEAM_STREAMS,
  maxUiStreams = MAX_UI_STREAMS,
}) {
  const sse = createSseRegistry({ maxTeamStreams, maxUiStreams, sendError });
  const unsubscribe = store.subscribe((event) => sse.broadcast(event));
  const uiRoutes = createUiRoutes({
    store, service, version, token, uiToken, uiAccessKey, restrictUiToLoopback,
    teamViewPath,
    sendUiStream: (req, res) => sse.openUiStream(req, res),
  });

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/api/v1/health') {
        const loopback = isLoopbackAddress(req.socket.remoteAddress);
        sendJson(res, 200, {
          ok: true,
          data: {
            status: 'ok',
            version,
            ...(loopback && workspace ? { workspace } : {}),
            ...(loopback ? { pid } : {}),
            ...(loopback && instanceId ? { instanceId } : {}),
          },
          error: null,
        });
        return;
      }
      if (uiRoutes.handlePage(req, res, url)) return;
      if (uiRoutes.handleUiStream(req, res, url)) return;

      if (!url.pathname.startsWith('/api/v1/')) return sendError(res, 404, 'E_NOT_FOUND', 'not found');
      if (await uiRoutes.handlePatrol(req, res, url)) return;
      // The cookie is only accepted on the snapshot/console read routes. Every
      // other API path still requires a Bearer token; a valid UI cookie there
      // is refused as a read-only UI session instead of being used as auth.
      const uiReadRoute = url.pathname === '/api/v1/ui/snapshot' || url.pathname === '/api/v1/ui/console';
      const actor = authenticate(req, token, store, uiToken, { allowUiCookie: uiReadRoute });
      if (!actor) {
        if (uiCookieMatches(req, uiToken)) {
          return sendError(res, 403, 'E_FORBIDDEN', 'ui token is limited to snapshot/console/stream');
        }
        return sendError(res, 401, 'E_AUTH', 'unauthorized');
      }
      const isAdmin = actor.role === 'admin';
      const requireAdmin = () => {
        if (isAdmin) return true;
        sendError(res, 403, 'E_FORBIDDEN', 'captain/admin token required');
        return false;
      };
      const parts = url.pathname.split('/').filter(Boolean).slice(2);
      const method = req.method ?? 'GET';
      if (actor.role === 'contractor') {
        const allowed = parts[0] === 'teams' && parts[1]
          && decodeURIComponent(parts[1]) === actor.teamId
          && parts[2] === 'tasks' && parts[3]
          && parts[4] === 'continue' && method === 'POST';
        if (!allowed) {
          return sendError(res, 403, 'E_FORBIDDEN', 'contractor token is limited to tasks/:id/continue');
        }
      }
      if (uiRoutes.handleApi(parts, method, actor, res)) return;
      if (actor.role === 'ui') {
        return sendError(res, 403, 'E_FORBIDDEN', 'ui token is limited to snapshot/console/stream');
      }
      const isShadow = actor.role === 'member'
        && memberCapabilities(store, actor).includes(SHADOW_CAPABILITY);
      if (!isShadow && actor.role === 'member' && parts[0] === 'teams' && parts[1]
        && decodeURIComponent(parts[1]) !== actor.teamId) {
        return sendError(res, 403, 'E_FORBIDDEN', 'member token is scoped to one team');
      }
      const isLead = actor.role === 'member'
        && parts[0] === 'teams'
        && Boolean(parts[1])
        && decodeURIComponent(parts[1]) === actor.teamId
        && memberCapabilities(store, actor).includes(LEAD_CAPABILITY);
      // Members (including lead seats) may read a non-live team but must not
      // write it. A shadow is captain-equivalent for the control routes that
      // the specification grants it (plan approval/editing, halt/resume,
      // archive), so those routes are exempt while task/other writes remain
      // blocked. Admin tokens and internal service calls are exempt.
      if (actor.role === 'member' && method !== 'GET' && parts[0] === 'teams' && parts[1]) {
        const guardedTeam = store.getTeam(decodeURIComponent(parts[1]));
        const shadowControlRoute = isShadow && method === 'POST' && (
          (parts[2] === 'plan' && guardedTeam?.phase === 'staged')
          || (parts[2] === 'halt' && guardedTeam?.phase === 'running' && guardedTeam.control === 'active')
          || (parts[2] === 'resume' && guardedTeam?.phase === 'running' && guardedTeam.control === 'halted')
          || (parts[2] === 'archive' && guardedTeam?.phase !== 'archived')
        );
        const blockedPhase = ['staged', 'archived', 'halted'].includes(guardedTeam?.phase);
        if (guardedTeam && (blockedPhase || guardedTeam.control === 'halted') && !shadowControlRoute) {
          const state = blockedPhase ? guardedTeam.phase : 'halted';
          return sendError(res, 409, 'E_STATE', `team ${guardedTeam.id} is ${state}; captain/shadow control is required`);
        }
      }
      const adminOnly = (parts[0] === 'messages')
        || (parts[0] === 'model')
        || (parts[0] === 'teams' && parts.length === 1 && ['GET', 'POST'].includes(method))
        || (parts[2] && ['plan', 'halt', 'resume', 'archive', 'tick', 'audit', 'licenses', 'contractors', 'patrol', 'findings', 'lifecycle', 'soft-isolation'].includes(parts[2]))
        || (parts[2] === 'captain')
        || (parts[2] === 'members' && method !== 'GET')
        || (parts[2] === 'tasks' && parts.length === 3 && method === 'POST')
        || (parts[2] === 'tasks' && parts[4] && ['reassign', 'amend', 'merge', 'complete', 'release-hold', 'cancel', 'reopen', 'reconcile-publication'].includes(parts[4]));
      if (adminOnly && !isShadow && !(isLead && leadMayManageRoute(parts, method)) && !requireAdmin()) return;

      // A shadow acts with captain authority but keeps its own identity. It
      // must not be able to revoke its own license or delete its own seat;
      // only the real captain may retire the shadow. Resolve names to the
      // canonical member id first: the HTTP path accepts both.
      if (isShadow && parts[0] === 'teams' && parts[2] === 'members' && parts[3]
        && (method === 'DELETE' || parts[4] === 'relicense')) {
        const rawTarget = decodeURIComponent(parts[3]);
        const targetTeamId = decodeURIComponent(parts[1]);
        const target = store.getMember(rawTarget) ?? store.findMember(targetTeamId, rawTarget);
        if (target && target.id === actor.memberId) {
          return sendError(res, 403, 'E_FORBIDDEN', 'the shadow cannot change or remove its own seat');
        }
      }
      // `/captain/message` is the human→captain channel. A shadow must never
      // write there, otherwise it would impersonate the captain in the mailbox.
      if (isShadow && parts[0] === 'teams' && parts[2] === 'captain') {
        return sendError(res, 403, 'E_FORBIDDEN', 'the shadow cannot use the human→captain mailbox');
      }
      if (isShadow && method !== 'GET') {
        const auditTeamId = parts[0] === 'teams' && parts[1]
          ? decodeURIComponent(parts[1])
          : actor.teamId;
        if (store.getTeam(auditTeamId)) {
          store.addEvent(auditTeamId, 'shadow.action', {
            actor: actor.name, memberId: actor.memberId, method, path: url.pathname,
          });
          if (store.getMember(actor.memberId)) {
            store.updateMember(actor.memberId, { shadowLastActiveAt: service.now() });
          }
        }
      }

      if (parts.length === 1 && parts[0] === 'teams' && method === 'GET') {
        const archived = url.searchParams.get('archived') === '1';
        return sendJson(res, 200, { ok: true, data: store.listTeams(archived), error: null });
      }
      if (parts.length === 1 && parts[0] === 'teams' && method === 'POST') {
        const body = await readJson(req);
        if (!body.id || !body.name) return sendError(res, 400, 'E_INVALID', 'id and name are required');
        // Only the real captain may choose the initial phase/control. A shadow
        // or member principal creates a staged plan that must be approved;
        // otherwise a forged body could start a running team and skip review.
        const input = isAdmin
          ? body
          : {
            id: body.id,
            name: body.name,
            description: body.description,
            members: body.members ?? [],
            phase: 'staged',
            control: 'active',
          };
        return sendJson(res, 201, { ok: true, data: service.createTeam(input, { actor }), error: null });
      }
      if (parts[0] === 'messages' && parts[1] === 'pending' && method === 'GET') {
        return sendJson(res, 200, { ok: true, data: service.listPendingMessages(), error: null });
      }
      if (parts[0] === 'messages' && parts[1] && ['approve', 'reject'].includes(parts[2]) && method === 'POST') {
        const body = await readJson(req);
        const messageId = decodeURIComponent(parts[1]);
        const data = parts[2] === 'approve'
          ? service.approveMessage(messageId, actor.role === 'admin' ? 'captain' : actor.name)
          : service.rejectMessage(messageId, actor.role === 'admin' ? 'captain' : actor.name, body.reason);
        return sendJson(res, 200, { ok: true, data, error: null });
      }
      if (parts[0] === 'model' && parts.length === 1) {
        if (method === 'GET') {
          return sendJson(res, 200, { ok: true, data: service.modelStatus(), error: null });
        }
        if (method === 'POST') {
          const body = await readJson(req);
          const action = body.action ?? 'status';
          if (action === 'status') {
            return sendJson(res, 200, { ok: true, data: service.modelStatus(), error: null });
          }
          if (action === 'set') {
            return sendJson(res, 200, {
              ok: true,
              data: await service.setFixedModel({ model: body.model, reasoning: body.reasoning, actor: actor.name }),
              error: null,
            });
          }
          if (action === 'follow') {
            return sendJson(res, 200, { ok: true, data: await service.followHostModel({ actor: actor.name }), error: null });
          }
          return sendError(res, 400, 'E_INVALID', `unknown model action: ${action}`);
        }
        return sendError(res, 405, 'E_METHOD', 'method not allowed');
      }
      if (parts[0] === 'shadow') {
        if (parts.length === 1 && method === 'GET') {
          if (!isShadow && !requireAdmin()) return;
          return sendJson(res, 200, { ok: true, data: service.shadowStatus(), error: null });
        }
        if (parts[1] === 'start' && parts.length === 2 && method === 'POST') {
          if (!requireAdmin()) return;
          const body = await readJson(req);
          return sendJson(res, 200, { ok: true, data: await service.startShadow({ teamId: body.teamId }), error: null });
        }
        if (parts[1] === 'stop' && parts.length === 2 && method === 'POST') {
          if (!isShadow && !requireAdmin()) return;
          const body = await readJson(req);
          return sendJson(res, 200, { ok: true, data: await service.stopShadow({ reason: body.reason }), error: null });
        }
        return sendError(res, 404, 'E_NOT_FOUND', 'not found');
      }
      if (parts[0] !== 'teams' || !parts[1]) return sendError(res, 404, 'E_NOT_FOUND', 'not found');
      const teamId = decodeURIComponent(parts[1]);
      const team = store.getTeam(teamId);
      if (!team) return sendError(res, 404, 'E_NOT_FOUND', `unknown team ${teamId}`);

      if (parts.length === 2 && method === 'GET') {
        // Automatic red-box reviews are bookkeeping rows: keep them out of the
        // task list the captain reads, but summarize them so nothing is lost.
        const visibleTasks = store.listTasks(teamId).filter((task) => task.hidden !== true);
        return sendJson(res, 200, {
          ok: true,
          data: {
            ...team,
            members: store.listMembers(teamId),
            tasks: visibleTasks,
            redReviews: service.redReviewSummary(teamId),
            plan: store.getPlan(teamId),
            licenses: store.listLicenses(teamId),
            contractors: isAdmin ? store.listContractors(teamId) : undefined,
            findings: store.listFindings(teamId),
            lifecycle: service.lifecycleStats(teamId),
          },
          error: null,
        });
      }
      if (parts[2] === 'members' && parts.length === 3) {
        if (method === 'GET') return sendJson(res, 200, { ok: true, data: store.listMembers(teamId), error: null });
        if (method === 'POST') {
          const body = await readJson(req);
          if (!body.name) return sendError(res, 400, 'E_INVALID', 'name is required');
          return sendJson(res, 201, { ok: true, data: service.addMember(teamId, body), error: null });
        }
      }
      if (parts[2] === 'members' && parts[3] && method === 'DELETE') {
        return sendJson(res, 200, {
          ok: true,
          data: await service.removeMember(teamId, decodeURIComponent(parts[3]), { actor }),
          error: null,
        });
      }
      if (parts[2] === 'members' && parts[3] && parts[4] && method === 'POST') {
        const memberId = decodeURIComponent(parts[3]);
        const body = await readJson(req);
        if (parts[4] === 'relicense') {
          const result = await service.relicenseMember(teamId, memberId, body, { actor });
          return sendJson(res, result.ok ? 200 : 409, {
            ok: result.ok, data: result,
            error: result.ok ? null : { code: result.code ?? 'E_NOT_SETTLED', message: result.error },
          });
        }
        if (parts[4] === 'sleep') return sendJson(res, 200, { ok: true, data: await service.sleepMember(teamId, memberId, body), error: null });
        if (parts[4] === 'wake') return sendJson(res, 200, { ok: true, data: service.wakeMember(teamId, memberId), error: null });
        if (parts[4] === 'compact') return sendJson(res, 200, { ok: true, data: await service.compactMember(teamId, memberId, body), error: null });
      }
      if (parts[2] === 'members' && parts[3] && parts[4] === 'license-history' && method === 'GET') {
        return sendJson(res, 200, { ok: true, data: store.listLicenseHistory(teamId, decodeURIComponent(parts[3])), error: null });
      }
      if (parts[2] === 'licenses' && method === 'GET') {
        return sendJson(res, 200, { ok: true, data: store.listLicenses(teamId, url.searchParams.get('member') ?? undefined), error: null });
      }
      if (parts[2] === 'contractors' && parts.length === 3) {
        if (method === 'GET') {
          const slot = url.searchParams.get('slot') ?? undefined;
          if (slot && !['merge', 'patrol', 'main'].includes(slot)) {
            return sendError(res, 400, 'E_INVALID', 'contractor slot must be merge|patrol');
          }
          return sendJson(res, 200, { ok: true, data: store.listContractors(teamId, undefined, slot), error: null });
        }
        if (method === 'POST') {
          const body = await readJson(req);
          const input = {
            teamId,
            slot: body.slot,
            purpose: body.purpose,
            prompt: body.prompt,
            mode: body.mode,
            timeoutMs: body.timeoutMs,
            model: body.model,
            reasoning: body.reasoning,
          };
          return sendJson(res, 202, { ok: true, data: await service.submitContractor(input), error: null });
        }
      }
      if (parts[2] === 'contractors' && parts[3] && parts.length === 4 && method === 'GET') {
        const contractor = store.getContractor(decodeURIComponent(parts[3]));
        if (!contractor || contractor.teamId !== teamId) {
          return sendJson(res, 404, { ok: false, data: null, error: { code: 'E_NOT_FOUND', message: 'contractor not found' } });
        }
        return sendJson(res, 200, { ok: true, data: contractor, error: null });
      }
      if (parts[2] === 'contractors' && parts[3] && parts[4] === 'kill' && method === 'POST') {
        return sendJson(res, 200, { ok: true, data: await service.killContractor(teamId, decodeURIComponent(parts[3])), error: null });
      }
      if (parts[2] === 'patrol' && method === 'POST') {
        return sendJson(res, 200, { ok: true, data: await service.patrol(teamId), error: null });
      }
      if (parts[2] === 'findings' && method === 'GET') {
        return sendJson(res, 200, { ok: true, data: service.listFindings(teamId, url.searchParams.get('status') ?? undefined), error: null });
      }
      if (parts[2] === 'findings' && parts[3] && parts[4] === 'close' && method === 'POST') {
        const body = await readJson(req);
        return sendJson(res, 200, { ok: true, data: service.closeFinding(teamId, decodeURIComponent(parts[3]), body.reason), error: null });
      }
      if (parts[2] === 'soft-isolation' && method === 'GET') {
        return sendJson(res, 200, { ok: true, data: service.softIsolationReport(teamId), error: null });
      }
      if (parts[2] === 'lifecycle' && method === 'GET') {
        return sendJson(res, 200, { ok: true, data: service.lifecycleStats(teamId), error: null });
      }
      if (parts[2] === 'lifecycle' && parts[3] === 'tick' && method === 'POST') {
        const body = await readJson(req);
        return sendJson(res, 200, { ok: true, data: await service.lifecycleTick(teamId, body), error: null });
      }
      if (parts[2] === 'captain' && parts[3] === 'message' && method === 'POST') {
        const body = await readJson(req);
        return sendJson(res, 201, { ok: true, data: service.sendMessage(teamId, 'captain', body.to, body.content, body), error: null });
      }
      if (parts[2] === 'audit' && method === 'GET') {
        return sendJson(res, 200, { ok: true, data: service.audit(teamId), error: null });
      }
      if (parts[2] === 'tick' && method === 'POST') {
        return sendJson(res, 200, { ok: true, data: await service.tick(teamId), error: null });
      }
      if (parts[2] === 'plan' && parts[3] === 'approve' && method === 'POST') {
        return sendJson(res, 200, { ok: true, data: await service.approve(teamId, { actor }), error: null });
      }
      if (parts[2] === 'plan' && parts[3] === 'edit' && method === 'POST') {
        const body = await readJson(req);
        return sendJson(res, 200, { ok: true, data: service.editPlan(teamId, body), error: null });
      }
      if (parts[2] === 'plan' && parts[3] === 'discard' && method === 'POST') {
        const body = await readJson(req);
        return sendJson(res, 200, { ok: true, data: service.discardPlan(teamId, body.reason), error: null });
      }
      if (parts[2] === 'halt' && method === 'POST') {
        const body = await readJson(req);
        return sendJson(res, 200, { ok: true, data: await service.halt(teamId, body.reason ?? 'human halt'), error: null });
      }
      if (parts[2] === 'resume' && method === 'POST') {
        const body = await readJson(req);
        return sendJson(res, 200, { ok: true, data: await service.resume(teamId, body.reason), error: null });
      }
      if (parts[2] === 'archive' && method === 'POST') {
        return sendJson(res, 200, { ok: true, data: await service.archive(teamId), error: null });
      }

      if (parts[2] === 'tasks' && parts.length === 3) {
        if (method === 'GET') {
          const includeHidden = isAdmin && ['1', 'true'].includes(url.searchParams.get('includeHidden') ?? '');
          const tasks = store.listTasks(teamId).filter((task) => includeHidden || task.hidden !== true);
          return sendJson(res, 200, { ok: true, data: tasks, error: null });
        }
        if (method === 'POST') {
          const body = await readJson(req);
          return sendJson(res, 201, { ok: true, data: service.addTask(teamId, body, { actor }), error: null });
        }
      }
      if (parts[2] === 'tasks' && parts[3] && parts[4] === 'claim' && method === 'POST') {
        const body = await readJson(req);
        return sendJson(res, 200, { ok: true, data: service.claimTask(teamId, decodeURIComponent(parts[3]), body.member, body.attemptId, actor), error: null });
      }
      if (parts[2] === 'tasks' && parts[3] && parts[4] === 'heartbeat' && method === 'POST') {
        const body = await readJson(req);
        return sendJson(res, 200, { ok: true, data: service.heartbeatTask(teamId, decodeURIComponent(parts[3]), body.attemptId, actor), error: null });
      }
      if (parts[2] === 'tasks' && parts[3] && parts[4] === 'update' && method === 'POST') {
        const body = await readJson(req);
        const result = await service.updateTask(teamId, decodeURIComponent(parts[3]), body.attemptId, body, actor);
        return sendJson(res, result.ok ? 200 : 409, { ok: result.ok, data: result, error: result.ok ? null : { code: 'E_STATE', message: result.error } });
      }
      if (parts[2] === 'tasks' && parts[3] && parts[4] === 'continue' && method === 'POST') {
        const body = await readJson(req);
        if (!service.canContinueTask(teamId, actor)) {
          return sendError(res, 403, 'E_FORBIDDEN', 'continue_task requires a captain token or a reviewer license');
        }
        return sendJson(res, 200, {
          ok: true,
          data: await service.continueTask(teamId, decodeURIComponent(parts[3]), { actor, reason: body.reason }),
          error: null,
        });
      }
      if (parts[2] === 'tasks' && parts[3] && parts[4] === 'reassign' && method === 'POST') {
        const body = await readJson(req);
        const result = await service.reassignTask(teamId, decodeURIComponent(parts[3]), body.assignee, body.reason);
        return sendJson(res, result?.ok === false ? 409 : 200, {
          ok: result?.ok !== false,
          data: result,
          error: result?.ok === false ? { code: 'E_STATE', message: result.error } : null,
        });
      }
      if (parts[2] === 'tasks' && parts[3] && parts[4] === 'amend' && method === 'POST') {
        const body = await readJson(req);
        return sendJson(res, 200, { ok: true, data: service.amendTask(teamId, decodeURIComponent(parts[3]), body.fields ?? body, body.reason, actor), error: null });
      }
      if (parts[2] === 'tasks' && parts[3] && parts[4] === 'release-hold' && method === 'POST') {
        const body = await readJson(req);
        return sendJson(res, 200, {
          ok: true,
          data: service.releaseTaskHold(teamId, decodeURIComponent(parts[3]), {
            reason: body.reason,
            expectedReason: body.expectedReason ?? body.expected_reason,
            actor,
          }),
          error: null,
        });
      }
      if (parts[2] === 'tasks' && parts[3] && parts[4] === 'cancel' && method === 'POST') {
        const body = await readJson(req);
        return sendJson(res, 200, { ok: true, data: service.cancelTask(teamId, decodeURIComponent(parts[3]), {
          reason: body.reason, actor,
        }), error: null });
      }
      if (parts[2] === 'tasks' && parts[3] && parts[4] === 'reopen' && method === 'POST') {
        const body = await readJson(req);
        return sendJson(res, 200, { ok: true, data: service.reopenTask(teamId, decodeURIComponent(parts[3]), {
          reason: body.reason, actor,
        }), error: null });
      }
      if (parts[2] === 'tasks' && parts[3] && parts[4] === 'reconcile-publication' && method === 'POST') {
        const body = await readJson(req);
        return sendJson(res, 200, { ok: true, data: await service.reconcilePublication(teamId, decodeURIComponent(parts[3]), {
          applied: body.applied, publishedCommit: body.publishedCommit ?? body.published_commit, actor,
        }), error: null });
      }
      if (parts[2] === 'tasks' && parts[3] && parts[4] === 'merge' && method === 'POST') {
        return sendJson(res, 200, { ok: true, data: await service.mergeTask(teamId, decodeURIComponent(parts[3])), error: null });
      }
      if (parts[2] === 'tasks' && parts[3] && parts[4] === 'complete' && method === 'POST') {
        const body = await readJson(req);
        const result = await service.completeTask({
          teamId,
          taskId: decodeURIComponent(parts[3]),
          attemptId: body.attemptId,
          update: body,
          actor,
        });
        return sendJson(res, result.ok ? 200 : 409, { ok: result.ok, data: result, error: result.ok ? null : { code: 'E_STATE', message: result.error } });
      }
      if (parts[2] === 'messages') {
        if (method === 'GET') {
          const messages = store.listMessages(teamId).filter((message) => actor.role === 'admin'
            || !message.approvalState || ['approved', 'local'].includes(message.approvalState));
          return sendJson(res, 200, { ok: true, data: messages, error: null });
        }
        if (method === 'POST') {
          const body = await readJson(req);
          const from = actor.role === 'member' ? actor.name : (body.from ?? 'captain');
          return sendJson(res, 201, { ok: true, data: service.sendMessage(teamId, from, body.to, body.content, body), error: null });
        }
      }
      if (parts[2] === 'events' && method === 'GET') {
        const since = Number(url.searchParams.get('since') ?? 0);
        return sendJson(res, 200, { ok: true, data: store.listEvents(teamId, since), error: null });
      }
      if (parts[2] === 'usage' && method === 'GET') {
        return sendJson(res, 200, { ok: true, data: store.listUsage(teamId), error: null });
      }
      if (parts[2] === 'stream' && method === 'GET') {
        return sse.openTeamStream(teamId, req, res);
      }

      return sendError(res, 404, 'E_NOT_FOUND', 'not found');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      let status = error?.status;
      let code = error?.code;
      if (!status) {
        if (/unknown (team|contractor)|not found/i.test(message)) { status = 404; code = 'E_NOT_FOUND'; }
        else if (/^stale attempt/i.test(message)) { status = 409; code = 'E_STALE_ATTEMPT'; }
        else if (/^task is already terminal/i.test(message)) { status = 409; code = 'E_STATE'; }
        else if (/disabled|required|must|not configured|not allowed|invalid|positive/i.test(message)) { status = 400; code = 'E_INVALID'; }
        else { status = 500; code = 'E_UPSTREAM'; }
      }
      sendError(res, status, code, message);
    }
  });

  server.on('close', () => unsubscribe());

  return {
    server,
    token,
    version,
    listen(port = 0, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve(server.address().port);
        });
      });
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * Prefer a stable UI port, but never fail just because it is already occupied.
 * A fresh daemon should always come up on some loopback port and publish it in
 * the discovery file.
 */
export async function listenWithFallback(app, preferredPort = 0, host = '127.0.0.1') {
  try {
    return await app.listen(preferredPort, host);
  } catch (error) {
    if (preferredPort === 0 || error?.code !== 'EADDRINUSE') throw error;
    console.warn(`WARN port ${preferredPort} is in use; choosing a free port on ${host}`);
    return app.listen(0, host);
  }
}

export function generateToken() {
  return randomBytes(32).toString('hex');
}
