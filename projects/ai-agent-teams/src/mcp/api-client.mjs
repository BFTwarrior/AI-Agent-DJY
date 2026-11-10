import { hasTeamConfig, readLiveDiscoveryForWorkspace } from '../workspace-target.mjs';

export function createMcpApi({ options = {}, defaultMember, workspaceForCall }) {
  const explicitBaseUrl = options.baseUrl ?? process.env.AGENT_TEAMS_URL;
  const explicitToken = options.token ?? process.env.AGENT_TEAMS_TOKEN;
  const explicitUiKey = options.uiKey ?? process.env.AGENT_TEAMS_UI_KEY;
  const ensureDaemon = options.ensureDaemon;
  const fetchImpl = options.fetchImpl ?? fetch;

  function connection(workspace = workspaceForCall()) {
    if (defaultMember && !explicitBaseUrl) {
      throw new Error('member MCP server requires AGENT_TEAMS_URL');
    }
    // A member session must authenticate as that member. Falling back to the
    // discovery record would hand it the daemon's admin token and silently
    // escalate a scoped member into the captain. Fail closed instead.
    if (defaultMember && !explicitToken) {
      throw new Error('member MCP server requires AGENT_TEAMS_TOKEN; the discovery admin token is never used for a member session');
    }
    // Only a live process may serve a workspace; a stale discovery would make
    // the caller fail instead of falling back or auto-starting.
    const discovery = explicitBaseUrl && explicitToken ? undefined : readLiveDiscoveryForWorkspace(workspace);
    return {
      baseUrl: explicitBaseUrl ?? (discovery ? `http://127.0.0.1:${discovery.port}` : undefined),
      token: explicitToken ?? discovery?.token,
      uiKey: explicitUiKey ?? discovery?.uiKey,
      workspace,
    };
  }

  function errorChain(error) {
    const chain = [];
    let current = error;
    for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
      chain.push(current);
      current = current.cause;
    }
    return chain;
  }

  function isTimeout(error) {
    const timeoutCodes = new Set([
      'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT', 'ABORT_ERR', 'ABORT_ERR_TIMEOUT',
    ]);
    for (const item of errorChain(error)) {
      if (timeoutCodes.has(item?.code)) return true;
      if (['AbortError', 'TimeoutError'].includes(item?.name)) return true;
      const message = typeof item?.message === 'string' ? item.message : '';
      if (/timed out|timeout|aborted/i.test(message)) return true;
    }
    return false;
  }

  function neverReachedDaemon(error) {
    const unreachableCodes = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);
    for (const item of errorChain(error)) {
      if (unreachableCodes.has(item?.code)) return true;
      const message = typeof item?.message === 'string' ? item.message : '';
      if (/not configured|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(message)) return true;
    }
    return false;
  }


  async function request(conn, method, path, body) {
    const { baseUrl, token } = conn;
    if (!baseUrl || !token) throw new Error('AgentTeams daemon is not configured; start it and set AGENT_TEAMS_URL/AGENT_TEAMS_TOKEN');
    const response = await fetchImpl(`${baseUrl}/api/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await response.json();
    if (!response.ok || payload.ok === false) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`);
    return payload.data;
  }

  async function loadViewSnapshot(workspace) {
    let conn;
    let snapshot;
    try {
      conn = connection(workspace);
      snapshot = await request(conn, 'GET', '/ui/snapshot');
    } catch (error) {
      if (!ensureDaemon || isTimeout(error) || !neverReachedDaemon(error)) throw error;
      if (!hasTeamConfig(workspace)) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}; workspace ${workspace} has no team config. Use agent_teams_workspace to switch to a project that already has teams, or run the install wizard in that directory first.`);
      }
      try {
        await ensureDaemon({ workspace });
        conn = connection(workspace);
        snapshot = await request(conn, 'GET', '/ui/snapshot');
      } catch (restartError) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}; daemon auto-start failed: ${restartError instanceof Error ? restartError.message : String(restartError)}`);
      }
    }
    return { conn, snapshot };
  }

  async function api(method, path, body, conn) {
    const workspace = conn?.workspace ?? workspaceForCall();
    let active;
    try {
      active = conn ?? connection(workspace);
      return await request(active, method, path, body);
    } catch (error) {
      // Only a request that never reached the daemon may auto-start it. A
      // timeout/generic fetch failure may already have been accepted, so it is
      // reported instead of probing or killing a possibly slow daemon.
      if (!ensureDaemon || isTimeout(error) || !neverReachedDaemon(error)) throw error;
      if (!hasTeamConfig(workspace)) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}; workspace ${workspace} has no team config. Use agent_teams_workspace to switch to a project that already has teams, or run the install wizard in that directory first.`);
      }
      let restarted;
      try {
        restarted = await ensureDaemon({ workspace });
      } catch (restartError) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}; daemon auto-start failed: ${restartError instanceof Error ? restartError.message : String(restartError)}`);
      }
      // A timed-out write may already have been accepted. Only retry a
      // non-idempotent request when the daemon really was down and a new
      // process was started; never replay it against an already-healthy daemon.
      const safeToRetry = method === 'GET'
        || (neverReachedDaemon(error) && restarted?.started === true);
      if (!safeToRetry) throw error;
      active = connection(workspace);
      return await request(active, method, path, body);
    }
  }


  return { connection, api, loadViewSnapshot };
}
