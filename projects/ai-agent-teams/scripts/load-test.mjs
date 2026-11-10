import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/config.mjs';
import { FakeSessionAdapter } from '../src/session/adapter.mjs';
import { TeamService } from '../src/scheduler-service.mjs';
import { Store } from '../src/store.mjs';

const args = process.argv.slice(2);
const workers = Number(args[args.indexOf('--workers') + 1] ?? 6);
const v06 = args.includes('--v06');
const teams = 2;
const { config } = loadConfig(v06 ? 'config/example.v06.json' : 'config/example.two-teams.json');
if (v06) {
  config.scheduler.activeWorkerSlots = workers;
  config.scheduler.maxActivePerTeam = Math.ceil(workers / teams);
  config.scheduler.maxTotalSessions = workers + 6;
  config.zcode.maxConcurrentSessions = Math.max(workers, config.zcode.maxConcurrentSessions);
}
const roster = v06 ? { alpha: [], beta: [] } : JSON.parse(readFileSync('config/roster.two-teams.json', 'utf8')).teams;
const store = new Store(':memory:');
const adapter = new FakeSessionAdapter();
const service = new TeamService({ store, adapter, config, cwd: process.cwd(), now: () => Date.now(), roster });
const perTeam = Math.ceil(workers / teams);
const started = Date.now();

for (const teamId of ['alpha', 'beta']) {
  service.createTeam({ id: teamId, name: teamId, phase: 'running' });
  for (let index = 1; index <= perTeam; index += 1) {
    const member = v06 ? undefined : roster[teamId][(index - 1) % roster[teamId].length].name;
    service.addTask(teamId, {
      id: `${teamId}-${index}`, subject: `task ${index}`, kind: 'work',
      ...(v06 ? { assigneeRole: 'engineer' } : { assignee: member }),
    });
  }
}

let dispatched = 0;
let completed = 0;
let guard = 0;
while (guard < 100) {
  guard += 1;
  const before = dispatched;
  const ticked = await service.tickAll();
  dispatched += ticked.reduce((sum, item) => sum + item.dispatched, 0);
  for (const teamId of ['alpha', 'beta']) {
    for (const task of store.listTasks(teamId)) {
      if (task.status !== 'in_progress' || !task.attemptId) continue;
      const result = await service.completeTask({
        teamId, taskId: task.id, attemptId: task.attemptId,
        update: { status: 'completed', output: 'load-test' },
      });
      if (result.ok) completed += 1;
    }
  }
  const remaining = ['alpha', 'beta'].flatMap((teamId) => store.listTasks(teamId))
    .some((task) => !['completed', 'failed', 'cancelled'].includes(task.status));
  if (!remaining) break;
  if (dispatched === before && completed === 0) break;
}

const audits = Object.fromEntries(['alpha', 'beta'].map((teamId) => [teamId, service.audit(teamId)]));
console.log(JSON.stringify({
  workers,
  teams,
  membersPerTeam: v06 ? store.listMembers('alpha').length : roster.alpha.length,
  mode: v06 ? 'v06-lazy' : 'legacy',
  tasks: perTeam * teams,
  dispatched,
  completed,
  audits,
  elapsedMs: Date.now() - started,
}, null, 2));
store.close();
