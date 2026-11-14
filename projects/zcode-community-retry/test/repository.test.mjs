import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { test } from 'node:test'

test('published marketplace resolves both plugins and Retry metadata to this repository', () => {
  const market = JSON.parse(fs.readFileSync('marketplace.json', 'utf8'))
  const pkg = JSON.parse(fs.readFileSync('community/package.json', 'utf8'))
  for (const entry of market.plugins) {
    const manifest = JSON.parse(fs.readFileSync(`${entry.source}/.zcode-plugin/plugin.json`, 'utf8'))
    assert.equal(entry.name, manifest.name)
    assert.equal(entry.version, manifest.version)
  }
  assert.equal(market.name, 'tangyixiao-zcode-community')
  assert.equal(pkg.version, market.plugins.find(p => p.name === 'zcode-community-retry').version)
  assert.equal(pkg.repository.url, 'https://github.com/tangyixiao/zcode-community-retry.git')
})

test('native Retry package ships the selected repository artwork and attribution', { timeout: 30000 }, () => {
  const sha256 = data => createHash('sha256').update(data).digest('hex')
  const selectedLogo = fs.readFileSync('assets/logo.webp')
  const selectedNotice = fs.readFileSync('assets/NOTICE.md')
  assert.equal(sha256(fs.readFileSync('community/assets/logo.webp')), sha256(selectedLogo), 'native source logo must match the selected repository logo')
  assert.deepEqual(fs.readFileSync('community/assets/NOTICE.md'), selectedNotice, 'native source must retain the selected artwork attribution')
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-package-'))
  try {
    const npmCandidates = (process.env.PATH ?? '').split(path.delimiter).flatMap(directory => [path.join(directory, 'node_modules/npm/bin/npm-cli.js'), path.join(directory, '../lib/node_modules/npm/bin/npm-cli.js')])
    const npmCli = [process.env.npm_execpath, ...npmCandidates].find(candidate => candidate && fs.existsSync(candidate))
    assert.ok(npmCli, 'npm CLI entry is required for the native package smoke test')
    const packed = spawnSync(process.execPath, [npmCli, 'pack', './community', '--ignore-scripts', '--json', '--pack-destination', temporary], { encoding: 'utf8', windowsHide: true, timeout: 20000 })
    assert.equal(packed.status, 0, packed.stderr)
    const archive = path.join(temporary, JSON.parse(packed.stdout)[0].filename)
    for (const [entry, expected] of [['package/assets/logo.webp', selectedLogo], ['package/assets/NOTICE.md', selectedNotice]]) {
      const unpacked = spawnSync('tar', ['-xOf', archive, entry], { windowsHide: true, timeout: 5000 })
      assert.equal(unpacked.status, 0, unpacked.stderr?.toString())
      assert.equal(sha256(unpacked.stdout), sha256(expected), `${entry} must match the selected artwork`)
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})
