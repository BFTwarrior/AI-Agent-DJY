import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allFindingsExcluded,
  deriveRepairScope,
  looksLikeFilePath,
  rawFindingPaths,
  repairScopeReport,
} from '../src/domain/repair-scope.mjs';

test('raw finding paths split declared files and strip line locations', () => {
  assert.deepEqual(rawFindingPaths({ file: 'STATUS.md,HANDOFF.md' }), ['STATUS.md', 'HANDOFF.md']);
  assert.deepEqual(rawFindingPaths({ file: 'src/x.mjs:49,244' }), ['src/x.mjs']);
  assert.deepEqual(rawFindingPaths({ problem: '更新 src/x.mjs:49,244 与 src/y.mjs:453' }), ['src/x.mjs', 'src/y.mjs']);
  assert.deepEqual(rawFindingPaths({ file: 'build/Makefile' }), ['build/Makefile']);
});

test('repair scope prefers finding paths and reports source fallback explicitly', () => {
  assert.deepEqual(repairScopeReport([{ file: 'src/repair.mjs' }], ['src/fallback.mjs']), {
    scope: ['src/repair.mjs'], source: 'findings', warnings: [],
  });
  const fallback = repairScopeReport([{ problem: 'No file path provided' }], ['src/fallback.mjs']);
  assert.equal(fallback.source, 'source');
  assert.deepEqual(fallback.scope, ['src/fallback.mjs']);
  assert.match(fallback.warnings[0], /fell back to the source task/);
  assert.deepEqual(deriveRepairScope([], ['src/fallback.mjs']), ['src/fallback.mjs']);
});

test('finding.path is treated as a declared path and default-excluded paths are filtered', () => {
  assert.deepEqual(rawFindingPaths({ path: 'src/from-path.mjs', problem: 'broken' }), ['src/from-path.mjs']);
  assert.deepEqual(repairScopeReport([{ file: '.env' }], ['src/fallback.mjs']).scope, ['src/fallback.mjs']);
  assert.equal(allFindingsExcluded([{ file: '.env' }, { file: 'secrets/key.pem' }]), true);
  assert.equal(allFindingsExcluded([{ file: '.env' }, { file: 'src/public.mjs' }]), false);
  assert.equal(allFindingsExcluded([]), false);
});

test('file-path recognition requires a known extension or directory marker', () => {
  assert.equal(looksLikeFilePath('src/module.mjs'), true);
  assert.equal(looksLikeFilePath('Makefile'), false);
  assert.equal(looksLikeFilePath('src/'), true);
  assert.equal(looksLikeFilePath('src/*.mjs'), false);
  assert.equal(looksLikeFilePath('更新/src/module.mjs'), false);
});
