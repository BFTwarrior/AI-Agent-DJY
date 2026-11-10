import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const live = readFileSync(new URL('../assets/team-view-live.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../assets/team-view-app.js', import.meta.url), 'utf8');
const stream = readFileSync(new URL('../assets/team-view-stream.js', import.meta.url), 'utf8');
const patrol = readFileSync(new URL('../assets/team-view-patrol.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../assets/team-view.html', import.meta.url), 'utf8');

function run(boot) {
  const window = { __AGENT_TEAMS_UI__: boot };
  vm.runInNewContext(live, { window });
  return window.__AGENT_TEAMS_LIVE_MODEL__;
}

test('live model uses the read-only console projection instead of invented demo values', () => {
  const model = run({
    token: 'ui-token',
    version: '0.1.8',
    snapshot: { teams: [] },
    console: {
      version: '0.1.8',
      capacity: { workerSlots: 8 },
      model: { policy: { mode: 'follow-host' } },
      shadow: { exists: false, status: 'stopped', active: false },
      teams: [{
        id: 'alpha', name: 'Alpha', phase: 'running', control: 'active',
        capacity: { workerSlots: 8, activeWorkers: 1 },
        contractorSlots: [{ slot: 'merge', cap: 1, active: 0, queued: 0 }, { slot: 'main', cap: 1, active: 1, queued: 0 }],
        members: [{
          id: 'm1', name: 'worker', label: 'A-01', role: 'engineer', status: 'working',
          residency: 'warm', hasSession: true, sessionState: 'active', currentTask: 't1',
          taskCount: 2, doneCount: 1, license: { label: 'A-01', roleKey: 'engineer', status: 'active' },
          settlement: { settled: true, blockerCount: 0, blockers: [] },
        }],
        tasks: [{
          id: 't1', subject: 'work', status: 'completed', kind: 'implementation',
          dependencies: [], assignee: 'worker', acceptance: ['ok'], inScope: ['src/'],
          mergeState: 'review_pending', mergeCommit: 'abc123', integrationBranch: 'integration/alpha/t1',
          review: { verdict: 'pass', overall: 4.6, code: 4.5, evidence: 'review evidence' },
          commandsRun: [{ command: 'npm test', status: 'passed', exitCode: 0 }],
        }],
        contractors: [{ id: 'c1', slot: 'main', status: 'running', purpose: 'patrol' }],
        mergeQueue: [{ id: 't1', subject: 'work', assignee: 'worker', kind: 'implementation', mergeState: 'review_pending', review: { verdict: 'pass' }, commandsRun: [{ status: 'passed' }] }],
        mailbox: [{ id: 'msg1', from: 'a', to: 'captain', content: 'pending' }],
        findings: [{ id: 'f1', severity: 'P2', problem: 'problem' }],
        events: [{ id: 1, type: 'task.completed', createdAt: 1000, teamId: 'alpha', data: { taskId: 't1' } }],
        patrol: { enabled: true, intervalMinutes: 15, lastAt: 1000, nextAt: 901000, pending: false, inFlight: false },
        redReviews: { enabled: true, total: 0 },
      }],
    },
  });

  assert.equal(model.workerCapacity, 8);
  assert.equal(model.contractorCapacity, 2);
  assert.equal(model.memberList[0].hasSession, true);
  assert.equal(model.memberData.live_alpha_0.context, '会话 · active · 已结算');
  assert.equal(model.taskDetails.t1.merge.includes('review_pending'), true);
  assert.equal(model.taskDetails.t1.verdict, 'pass');
  assert.equal(model.taskDetails.t1.upstream, '—');
  assert.equal(model.mergeQueue.length, 1);
  assert.equal(model.mailbox.length, 1);
  assert.equal(model.events.length, 1);
  assert.equal(model.teamMeta[0].phase, 'running');
});

test('live model keeps the snapshot fallback when the console projection is absent', () => {
  const model = run({
    token: 'ui-token',
    version: '0.1.8',
    snapshot: {
      teams: [{
        id: 'alpha', name: 'Alpha', phase: 'running',
        members: [{ id: 'm1', name: 'worker', role: 'engineer', status: 'unspawned' }],
        tasks: [{ id: 't1', subject: 'work', status: 'pending', dependencies: [] }],
        contractors: [],
      }],
    },
  });
  assert.equal(model.workerCapacity, null);
  assert.equal(model.memberList[0].hasSession, false);
  assert.equal(model.taskDetails.t1.merge, '—');
  assert.equal(model.mergeQueue, null);
  assert.equal(model.degraded, true, 'the fallback is marked as degraded so the UI does not claim “no session”');
});

test('live UI allows only the scoped patrol action and hides other write controls', () => {
  assert.equal(/\bfetch\s*\(/.test(app), false, 'app.js must not open write channels');
  assert.equal(/XMLHttpRequest|sendBeacon/.test(app + patrol), false, 'the UI must not open ad-hoc write channels');
  assert.match(patrol, /fetch\(`\/api\/v1\/teams\/\$\{encodeURIComponent\(team\.id\)\}\/patrol`/u);
  assert.match(patrol, /credentials:\s*'same-origin'/u);
  assert.match(patrol, /Promise\.all\(teams\.map/u, 'the top action dispatches patrol for each visible team');
  assert.doesNotMatch(patrol, /authorization|localStorage|sessionStorage/u, 'the action never handles credentials in JavaScript');
  const selector = app.match(/const READ_ONLY_HIDDEN_SELECTOR = '([^']+)'/)?.[1];
  assert.ok(selector, 'the read-only selector is a named constant');
  for (const control of ['#merge-approve', '#merge-reject', '#change-badge', '#pause-toggle', '#hard-stop', '#task-create', '[data-mail-approve]', '[data-mail-reject]', '[data-run-mode]', '#max-worker-slots']) {
    assert.ok(selector.includes(control), `the read-only guard covers ${control}`);
  }
  assert.ok(!selector.includes('#top-patrol'), 'only the server-authorized patrol button opts out of the read-only guard');
  assert.match(selector, /\[data-toast\]:not\(\[data-readonly\]\)/, 'read-only view buttons stay visible');
  assert.match(app, /queued: '排队'/, 'queued tasks have their own label');
  assert.match(app, /slotActive\('patrol'\) \+ slotActive\('main'\)/, 'the patrol card counts the main alias');
  assert.equal(app.includes("['captain', 'lead', 'shadow'].includes(String(member.role"), false, 'capacity counting reuses isControlMember instead of a stale raw-role list');
  assert.ok((app.match(/isControlMember\(member\) \? '控制席'/g) ?? []).length >= 2, 'workforce and pool rows label control seats consistently');
  assert.match(app, /hasSession: !cold/, 'demo rows carry a session flag so warm demo members are not rendered as “no session”');
});

test('overview waiting keeps its value on dependency waits and queues in the footnote', () => {
  assert.match(app, /setText\('#overview-waiting', String\(waitingTasks\.length\)\)/u,
    'the stat value counts waiting tasks only');
  assert.match(app, /等待 \$\{waitingTasks\.length\}/u, 'the footnote names the waiting bucket');
  assert.match(app, /排队 \$\{queuedTasks\.length\}/u, 'the footnote names the queued bucket');
  assert.doesNotMatch(app, /setText\('#overview-waiting', String\([^)]*queued/iu,
    'queued tasks must not inflate the waiting value');
});

test('live card subtitles rebuild their truncation suffix instead of appending it', () => {
  assert.equal((app.match(/仅显示前/gu) ?? []).length, 1, 'the truncation suffix has one assignment site');
  assert.doesNotMatch(app, /textContent\s*\+=[^;\n]*仅显示前/u, 'the suffix is never appended');
  assert.doesNotMatch(app, /subtitle\.textContent\s*\+=/u, 'the subtitle is assigned once per render');
  assert.match(app, /subtitle\.textContent = tasks\.length > rows\.length[\s\S]{0,120}仅显示前 \$\{rows\.length\} 条/u,
    'the complete subtitle is computed before assignment');
});

test('the live stream uses the HttpOnly session cookie instead of a token query', () => {
  assert.match(stream, /new EventSource\('\/api\/v1\/ui\/stream'\)/);
  assert.doesNotMatch(stream, /\?token=/, 'the SSE URL must not carry a token');
  assert.doesNotMatch(stream, /boot\.token/, 'the stream client does not read a bootstrap token');
});

test('read-only member actions describe the console boundary instead of opening views', () => {
  assert.doesNotMatch(html, /已打开成员会话|已打开号牌历史/u,
    'read-only buttons no longer claim to open a view');
  assert.match(html, /data-toast="会话内容由系统提供，控制台只展示任务与事件数据"[^>]*data-readonly/u);
  assert.match(html, /data-toast="号牌历史由系统维护，控制台只读展示"[^>]*data-readonly/u);
  assert.equal(/\bfetch\s*\(/.test(html), false, 'the copy change adds no write request');
});
