import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'acorn';
import { TeamService } from '../src/scheduler-service.mjs';
import {
  adoptPendingCandidates,
  adoptPendingCandidatesUnlocked,
  recomputeTeamNeedsCaptain,
} from '../src/service/pending-adoption.mjs';

const schedulerSource = readFileSync(new URL('../src/scheduler-service.mjs', import.meta.url), 'utf8');
const adoptionSource = readFileSync(new URL('../src/service/pending-adoption.mjs', import.meta.url), 'utf8');

function parseModule(source) {
  return parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
}

test('pending adoption policy lives in its service module and keeps TeamService facades', () => {
  assert.match(adoptionSource, /export async function adoptPendingCandidates\(/);
  assert.match(adoptionSource, /export async function adoptPendingCandidatesUnlocked\(/);
  assert.match(adoptionSource, /export function recomputeTeamNeedsCaptain\(/);
  assert.match(schedulerSource, /adoptPendingCandidatesFrom\(this, options\)/);
  assert.match(schedulerSource, /adoptPendingCandidatesUnlockedFrom\(this, teams\)/);
  assert.match(schedulerSource, /recomputeTeamNeedsCaptainFrom\(this, teamId\)/);
  assert.doesNotMatch(schedulerSource, /const ADOPT_RETRY_(?:BASE_MS|MAX_MS|LIMIT)/);
  assert.doesNotMatch(schedulerSource, /const ADOPT_BLOCK_REASONS/);
  const ast = parseModule(adoptionSource);
  const exportedFunctions = ast.body
    .filter((node) => node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'FunctionDeclaration')
    .map((node) => node.declaration.id.name);
  assert.ok(exportedFunctions.includes('adoptPendingCandidates'));
  assert.ok(exportedFunctions.includes('adoptPendingCandidatesUnlocked'));
});

test('pending adoption facade preserves dynamic service seams and publication backoff', async () => {
  const service = Object.create(TeamService.prototype);
  const team = { id: 'alpha', control: 'active', phase: 'running' };
  const calls = [];
  service.store = {
    getTeam: (teamId) => teamId === team.id ? team : undefined,
    listTeams: () => [team],
    listTasks: () => [],
    listMembers: () => [],
    listContractors: () => [],
    updateTeam: (...args) => calls.push(['updateTeam', ...args]),
    addEvent: (...args) => calls.push(['addEvent', ...args]),
  };
  service.withClosedLoopLock = async (teamId, action) => {
    calls.push(['lock', teamId]);
    return action();
  };
  service.adoptPendingCandidatesUnlocked = async (teams) => {
    calls.push(['unlocked', teams.map((item) => item.id)]);
    return { adopted: ['task-1'], blocked: [], deferred: [] };
  };
  service.adoptPublicationBackoff = new Map();
  service.now = () => 1000;

  const result = await TeamService.prototype.adoptPendingCandidates.call(service, { teamId: 'alpha' });
  assert.deepEqual(result, { adopted: ['task-1'], blocked: [], deferred: [] });
  assert.deepEqual(calls.slice(0, 2), [['lock', 'alpha'], ['unlocked', ['alpha']]]);

  const recomputed = TeamService.prototype.recomputeTeamNeedsCaptain.call(service, 'alpha');
  assert.equal(recomputed, false);
  const blocked = TeamService.prototype.recordPublicationWriteBlocked.call(
    service, 'alpha', 'task-1', new Error('held'),
  );
  assert.equal(blocked.deferred, true);
  assert.equal(service.adoptPublicationBackoff.get('alpha:task-1').attempts, 1);
  const deferred = TeamService.prototype.recordPublicationWriteBlocked.call(
    service, 'alpha', 'task-1', new Error('held again'),
  );
  assert.equal(deferred.deferred, true);
  assert.equal(calls.filter(([name]) => name === 'addEvent').length, 1);

  assert.equal(typeof adoptPendingCandidates, 'function');
  assert.equal(typeof adoptPendingCandidatesUnlocked, 'function');
  assert.equal(typeof recomputeTeamNeedsCaptain, 'function');
});

test('recomputeTeamNeedsCaptain clears only an otherwise clean team alert', () => {
  const service = Object.create(TeamService.prototype);
  const updates = [];
  service.store = {
    getTeam: () => ({ id: 'alpha', needsCaptain: true }),
    listTasks: () => [],
    listMembers: () => [],
    listContractors: () => [],
    updateTeam: (...args) => updates.push(args),
  };
  assert.equal(service.recomputeTeamNeedsCaptain('alpha'), true);
  assert.deepEqual(updates, [['alpha', { needsCaptain: false }]]);
});
