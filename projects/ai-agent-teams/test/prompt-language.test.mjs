import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PANEL_STARTUP_RULE } from '../src/domain/prompt-rules.mjs';
import { redReviewEscalationText } from '../src/domain/scheduler.mjs';
import {
  buildCaptainPrompt,
  buildMemberPrompt,
  buildPostMergePrompt,
  buildShadowPrompt,
  buildTaskPrompt,
  SHADOW_START_MESSAGE,
} from '../src/service/prompts.mjs';

/**
 * Text that reaches a model must be English. Two kinds of CJK are still
 * legitimate inside such text: literal protocol identifiers (`继续`) and the
 * real directory names a workspace uses as data (`文档/`, `逻辑图/`, `归档/`,
 * and `归档/历史/文档/`). Everything else is prose and
 * must not be Chinese, otherwise a rebuilt conversation surfaces it again.
 */
const ALLOWED = ['归档/历史/文档/', '归档/历史/逻辑图/', '文档/', '逻辑图/', '归档/', '继续'];

const CJK = /[\u3400-\u9fff]/u;

function withoutAllowed(text) {
  let rest = String(text);
  for (const token of ALLOWED) rest = rest.split(token).join('');
  return rest;
}

function assertEnglish(text, label) {
  const rest = withoutAllowed(text);
  assert.doesNotMatch(rest, CJK, `${label} contains Chinese prose: ${JSON.stringify(rest.slice(0, 200))}`);
}

test('quality-gate modules keep model-facing objectives and findings text English', () => {
  const directory = new URL('../src/domain/gates/', import.meta.url);
  const files = readdirSync(directory).filter((name) => name.endsWith('.mjs'));
  assert.ok(files.length > 0);
  for (const file of [new URL('../src/domain/gates.mjs', import.meta.url),
    ...files.map((name) => new URL(name, directory))]) {
    assertEnglish(readFileSync(file, 'utf8'), file.pathname);
  }
});

test('the panel startup rule is English and shared verbatim', () => {
  assert.match(PANEL_STARTUP_RULE, /^Session startup rule:/);
  assert.match(PANEL_STARTUP_RULE, /agent_teams_view/);
  assertEnglish(PANEL_STARTUP_RULE, 'PANEL_STARTUP_RULE');
});

test('the red-review escalation body is English apart from its literal title', () => {
  const text = redReviewEscalationText({
    taskId: 't1',
    subject: 'build broke',
    error: 'read ECONNRESET',
    count: 3,
    sessionId: 'sess_1',
    reason: 'max-continues',
  });
  assert.match(text, /^\[自动继续审查上报\]/);
  assert.match(text, /automatic continues: 3/);
  assert.match(text, /last error: read ECONNRESET/);
  assert.match(text, /agent_teams_continue_task/);
  // The whole body except the bracketed title must be ASCII-safe. Strip only
  // that title, because the token list above covers protocol values and data.
  assertEnglish(text.replace('[自动继续审查上报]', ''), 'redReviewEscalationText');
});

test('the escalation body omits optional lines without leaving Chinese text', () => {
  const minimal = redReviewEscalationText({ taskId: 't2', count: 1 });
  assert.match(minimal, /\(none\)/);
  assert.match(minimal, /\(unknown\)/);
  assert.doesNotMatch(minimal, /undefined/);
  assertEnglish(minimal.replace('[自动继续审查上报]', ''), 'redReviewEscalationText minimal');
});

test('the shadow initial send message is English', () => {
  assert.equal(SHADOW_START_MESSAGE, 'Begin your shadow coordination duties.');
  assertEnglish(SHADOW_START_MESSAGE, 'SHADOW_START_MESSAGE');
});

test('member, task, captain, shadow and post-merge prompts are English', () => {
  const store = { getSummary: () => undefined };
  const team = { name: 'alpha', description: 'ship the release' };
  const member = { name: 'impl', role: 'engineer', toolPolicy: 'workspace-write' };
  const task = {
    id: 't1',
    subject: 'wire the route',
    kind: 'work',
    objective: 'add the endpoint',
    acceptance: ['returns 200'],
    inScope: ['src/'],
    verify: ['npm test'],
    mode: 'bound',
  };
  const prompts = [
    ['buildMemberPrompt', buildMemberPrompt(store, team, member)],
    ['buildTaskPrompt', buildTaskPrompt(team, task, 'att_1')],
    ['buildPostMergePrompt', buildPostMergePrompt(task, 'abc1234')],
    ['buildCaptainPrompt', buildCaptainPrompt(team)],
    ['buildShadowPrompt', buildShadowPrompt(team)],
  ];
  for (const [label, text] of prompts) {
    assert.ok(text.length > 0, label);
    assertEnglish(text, label);
  }
});
