import { readDiscoveryForWorkspace } from './discovery.mjs';

function usage() {
  console.error(`team-cli commands:
  claim <taskId> <attemptId>
  update <taskId> <attemptId> <status> [jsonPayload]
  heartbeat <taskId> <attemptId>
  send <to> <message>
  status
Environment: AGENT_TEAMS_URL, AGENT_TEAMS_TOKEN, AGENT_TEAMS_TEAM, AGENT_TEAMS_MEMBER
Members must receive a member-scoped token; the discovery admin token is only used when AGENT_TEAMS_ROLE=admin.`);
}

const discovery = readDiscoveryForWorkspace(process.cwd());
const baseUrl = process.env.AGENT_TEAMS_URL ?? (discovery ? `http://127.0.0.1:${discovery.port}` : undefined);
const token = process.env.AGENT_TEAMS_TOKEN ?? (process.env.AGENT_TEAMS_ROLE === 'admin' ? discovery?.token : undefined);
const team = process.env.AGENT_TEAMS_TEAM;
const member = process.env.AGENT_TEAMS_MEMBER;

if (!baseUrl || !token || !team || !member) {
  console.error('missing AGENT_TEAMS_URL/TOKEN/TEAM/MEMBER and no discovery file');
  usage();
  process.exit(2);
}

async function api(path, init = {}) {
  const response = await fetch(`${baseUrl}/api/v1${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const body = await response.json();
  if (!response.ok || body.ok === false) {
    throw new Error(body?.error?.message ?? `HTTP ${response.status}`);
  }
  return body.data;
}

const [command, ...args] = process.argv.slice(2);
try {
  let result;
  if (command === 'claim') {
    result = await api(`/teams/${team}/tasks/${encodeURIComponent(args[0])}/claim`, {
      method: 'POST',
      body: JSON.stringify({ member, attemptId: args[1] }),
    });
  } else if (command === 'update') {
    const status = args[2];
    const extra = args[3] ? JSON.parse(args.slice(3).join(' ')) : {};
    result = await api(`/teams/${team}/tasks/${encodeURIComponent(args[0])}/update`, {
      method: 'POST',
      body: JSON.stringify({ member, attemptId: args[1], status, ...extra }),
    });
  } else if (command === 'heartbeat') {
    result = await api(`/teams/${team}/tasks/${encodeURIComponent(args[0])}/heartbeat`, {
      method: 'POST',
      body: JSON.stringify({ attemptId: args[1] }),
    });
  } else if (command === 'send') {
    result = await api(`/teams/${team}/messages`, {
      method: 'POST',
      body: JSON.stringify({ from: member, to: args[0], content: args.slice(1).join(' ') }),
    });
  } else if (command === 'status') {
    result = await api(`/teams/${team}`);
  } else {
    usage();
    process.exit(2);
  }
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
