import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TeamService } from '../src/scheduler-service.mjs';
import { countControlSessions, countWorkspaceSessions } from '../src/service/session-occupancy.mjs';

function fixture({ teams = [], members = {}, contractors = [] } = {}) {
  const calls = [];
  const service = {
    store: {
      listTeams(archived) { calls.push(['teams', archived]); return teams; },
      listMembers(id) { calls.push(['members', id]); return members[id] ?? []; },
    },
    memberIsControl(member) { calls.push(['control', member.id]); return member.control; },
    activeContractors() { calls.push(['contractors']); return contractors; },
  };
  return { service, calls };
}

const controlCount = (service) => TeamService.prototype.controlSessionCount.call(service);
const workspaceCount = (service) => TeamService.prototype.workspaceSessionCount.call(service);

test('session occupancy deduplicates known sessions across teams, reservations and contractors', () => {
  const input = {
    teams: [
      {
        id: 'alpha', captainSessionId: 'shared',
        captainSessionStart: { state: 'starting', sessionId: 'shared' },
        captainSessionConflicts: [{ sessionId: 'shared' }, { sessionId: 'conflict' }],
        workerSessionConflicts: [{ sessionId: 'conflict', control: true }, { sessionId: 'worker-conflict' }],
      },
      { id: 'archived', archived: true, captainSessionId: 'shared' },
    ],
    members: {
      alpha: [
        { id: 'lead', control: true, sessionId: 'shared', workerSessionStart: { state: 'unknown', sessionId: 'conflict' } },
        { id: 'worker', sessionId: 'worker-session' },
      ],
      archived: [{ id: 'old-lead', status: 'removed', control: true, sessionId: 'old-session' }],
    },
    contractors: [{ id: 'same', sessionId: 'shared' }, { id: 'new', sessionId: 'contractor-session' }],
  };
  const before = structuredClone(input);
  const { service, calls } = fixture(input);
  assert.equal(controlCount(service), 3);
  assert.equal(workspaceCount(service), 6);
  assert.deepEqual(input, before);
  assert.deepEqual(calls.filter(([name]) => name === 'teams'), [['teams', true], ['teams', true]]);
  assert.deepEqual(calls.at(-1), ['contractors']);
});

test('session occupancy keeps unknown reservations without inventing termination proof', () => {
  const { service } = fixture({
    teams: [{
      id: 'alpha', captainSessionStart: { state: 'unknown', operationId: 'captain' },
      captainSessionConflicts: [{ operationId: 'conflict' }, { operationId: 'conflict' }],
      workerSessionConflicts: [{ operationId: 'control', control: true }, { operationId: 'ordinary' }],
    }],
    members: { alpha: [
      { id: 'shadow', control: true, shadowState: 'starting', shadowStartId: 'start', workerSessionStart: { state: 'unknown', operationId: 'worker' } },
      { id: 'ordinary', shadowState: 'starting', shadowStartId: 'start', workerSessionStart: { state: 'starting', operationId: 'ordinary' } },
      { id: 'finished', control: true, workerSessionStart: { state: 'finished', operationId: 'ignore' } },
    ] },
    contractors: [{ id: 'queued' }, { id: 'queued' }],
  });
  assert.equal(controlCount(service), 5);
  assert.equal(workspaceCount(service), 9);
});

test('control classification keeps its dynamic call order and workspace accounting never calls it', () => {
  const input = {
    teams: [{ id: 'alpha' }],
    members: { alpha: [
      { id: 'live', sessionId: 'live', control: true },
      { id: 'ordinary', sessionId: 'ordinary' },
      { id: 'cold', control: true },
    ] },
  };
  const { service, calls } = fixture(input);
  controlCount(service);
  assert.deepEqual(calls, [
    ['teams', true], ['members', 'alpha'],
    ['control', 'live'], ['control', 'live'],
    ['control', 'ordinary'], ['control', 'ordinary'], ['control', 'ordinary'],
    ['control', 'cold'], ['control', 'cold'],
  ]);
  calls.length = 0;
  service.memberIsControl = () => { throw new Error('workspace must not classify members'); };
  assert.equal(workspaceCount(service), 2);
  assert.deepEqual(calls, [['teams', true], ['members', 'alpha'], ['contractors']]);
});

test('session occupancy propagates store and classification failures without partial admission', () => {
  const failure = Object.assign(new Error('store unavailable'), { code: 'TEST_STORE' });
  for (const count of [controlCount, workspaceCount]) {
    const { service } = fixture();
    service.store.listTeams = () => { throw failure; };
    assert.throws(() => count(service), (error) => error === failure);
  }
  const { service, calls } = fixture({ teams: [{ id: 'alpha' }], members: { alpha: [{ id: 'lead' }] } });
  service.memberIsControl = () => { throw failure; };
  assert.throws(() => controlCount(service), (error) => error === failure);
  assert.ok(!calls.some(([name]) => name === 'contractors'));
});

test('session occupancy ignores malformed conflict collections and inactive starts', () => {
  const { service } = fixture({
    teams: [{ id: 'alpha', captainSessionStart: { state: 'done' }, captainSessionConflicts: {}, workerSessionConflicts: 'invalid' }],
    members: { alpha: [{ id: 'lead', control: true, workerSessionStart: { state: 'failed' }, shadowState: 'stopped' }] },
  });
  assert.equal(countControlSessions(service), 0);
  assert.equal(countWorkspaceSessions(service), 0);
});

test('session budget guards retain dynamic public count seams and inclusive ceilings', () => {
  const service = {
    config: { scheduler: { maxTotalSessions: 2, maxControlSessions: 2 } },
    workspaceSessionCount: () => 2,
    controlSessionCount: () => 2,
  };
  assert.throws(() => TeamService.prototype.assertWorkspaceSessionBudget.call(service),
    { message: 'workspace session budget is full (2)', status: 409, code: 'E_SESSION_CAP' });
  assert.throws(() => TeamService.prototype.assertControlBudget.call(service),
    (error) => error.status === 409 && error.code === 'E_CONTROL_CAP');
  service.workspaceSessionCount = () => 1;
  service.controlSessionCount = () => 1;
  TeamService.prototype.assertWorkspaceSessionBudget.call(service);
  TeamService.prototype.assertControlBudget.call(service);
});

test('session occupancy checks reject lost reservations, control filtering and contractor accounting', async () => {
  const source = readFileSync(new URL('../src/service/session-occupancy.mjs', import.meta.url), 'utf8');
  const check = ({ countControlSessions: control, countWorkspaceSessions: workspace }) => {
    const { service } = fixture({
      teams: [{ id: 'alpha', captainSessionId: 'same', captainSessionStart: { state: 'unknown', operationId: 'new' },
        workerSessionConflicts: [{ sessionId: 'worker-only' }] }],
      members: { alpha: [{ id: 'lead', control: true, sessionId: 'same' }] },
      contractors: [{ id: 'pending' }, { id: 'same', sessionId: 'same' }],
    });
    assert.equal(control(service), 2);
    assert.equal(workspace(service), 4);
  };
  check({ countControlSessions, countWorkspaceSessions });
  for (const [from, to] of [
    ["['starting', 'unknown']", "['starting']"],
    ['if (!controlOnly || conflict.control)', 'if (true)'],
    ['for (const contractor of service.activeContractors())', 'for (const contractor of [])'],
    ['if (member.sessionId) occupied.add(`session:${member.sessionId}`)', 'if (member.sessionId) occupied.add(`member:${member.sessionId}`)'],
  ]) {
    assert.ok(source.includes(from));
    const mutated = await import(`data:text/javascript;base64,${Buffer.from(source.replaceAll(from, to)).toString('base64')}`);
    assert.throws(() => check(mutated), { code: 'ERR_ASSERTION' });
  }
});

test('session occupancy has no I/O, mutable module state or facade back-edge', () => {
  const source = readFileSync(new URL('../src/service/session-occupancy.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^import\s/m);
  assert.doesNotMatch(source, /scheduler-service|\b(?:globalThis|process|setTimeout)\b/);
  assert.equal((source.match(/^export function /gm) ?? []).length, 2);
  assert.equal((source.match(/^function /gm) ?? []).length, 3);
  assert.doesNotMatch(source, /^(?:const|let|var)\s/m);
});
