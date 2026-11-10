import test from 'node:test';
import assert from 'node:assert/strict';
import { ALLOW_RULES, isAllowlisted } from '../scripts/i18n-allow.mjs';

test('only the A/B task-reference prefix regex is exempt from translation', () => {
  // A broad team-label rule used to swallow a real untranslated UI label.
  // Only the non-UI regex literal stays exempt.
  const hits = [];
  assert.equal(isAllowlisted('A队 A-T', (hit) => hits.push(hit)), true);
  assert.equal(isAllowlisted('B队 B-T'), true);
  assert.equal(hits.length, 1);
  assert.match(hits[0].reason, /regex replacement prefix/u);

  for (const value of ['A队 · 工程师', 'A队 · 审核', 'B队 · 交付', 'A队 · 项目基线对齐', '青', '外', 'T-099 优惠券金额格式化', 'A-T2 跨队输入汇总']) {
    assert.equal(isAllowlisted(value), false, `${value} must not be exempt`);
  }
});

test('every allow rule carries a reason for review', () => {
  assert.ok(ALLOW_RULES.length >= 1);
  for (const rule of ALLOW_RULES) {
    assert.ok(rule.pattern instanceof RegExp);
    assert.equal(typeof rule.reason, 'string');
    assert.ok(rule.reason.trim().length > 10, rule.reason);
  }
});
