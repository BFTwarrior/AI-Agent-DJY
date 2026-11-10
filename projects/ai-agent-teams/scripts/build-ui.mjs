import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { buildI18n } from './build-i18n.mjs';

const root = resolve('.');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
await buildI18n(root);
const result = await build({
  entryPoints: [join(root, 'ui-src', 'team-panel.js')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2022'],
  minify: true,
  write: false,
  legalComments: 'none',
});
const js = result.outputFiles[0].text.replaceAll('__PACKAGE_VERSION__', version);
if (js.includes('__PACKAGE_VERSION__')) throw new Error('Panel package version was not injected');
const css = readFileSync(join(root, 'ui-src', 'team-panel.css'), 'utf8');
const i18n = readFileSync(join(root, 'assets', 'team-view-i18n.js'), 'utf8').replace(/<\/script/gi, '<\\/script');
const html = `<!doctype html>
<html data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ai-Agent-Teams-Zcode</title>
<style>${css}</style>
</head>
<body>
<div class="shell">
  <header>
    <div class="brand">AT</div>
    <div class="title"><b>Ai-Agent-Teams-Zcode</b><small>实时团队面板</small></div>
    <div class="actions">
      <button id="openTasks" type="button" title="在浏览器打开团队任务">打开任务</button>
      <button id="refresh" type="button" title="刷新">刷新</button>
    </div>
  </header>
  <main>
    <div id="status">正在连接团队…</div>
    <div id="content"></div>
  </main>
  <footer>
    <button id="full" type="button">打开完整任务视图 ↗</button>
    <span id="updated"></span>
  </footer>
</div>
<script>${i18n}</script>
<script>document.documentElement.setAttribute('lang', window.AGT_I18N.locale);</script>
<script>${js}</script>
</body>
</html>
`;
writeFileSync(join(root, 'assets', 'team-panel.html'), html, 'utf8');
console.log(`BUILT assets/team-panel.html (${Buffer.byteLength(html)} bytes)`);
