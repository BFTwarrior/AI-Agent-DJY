import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, win32 } from 'node:path';
import { readDiscovery, readDiscoveryForWorkspace, discoveryPathForWorkspace, legacyDiscoveryPath } from './discovery.mjs';
import { sameWorkspace } from './domain/workspace.mjs';
import { readLiveDiscoveryForWorkspace } from './workspace-target.mjs';

export const DEFAULT_PANEL_PORT = 8779;
export const PANEL_PATH = '/ui#tasks';
export const PACKAGE_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

/**
 * Loopback URL of the read-only team panel. The access key is intentionally a
 * query parameter only for the first visit; the server sets an HttpOnly cookie
 * and the full API token is never placed in the URL.
 * @param {number|string} port
 * @param {string} [accessKey]
 * @returns {string}
 */
export function panelUrl(port = DEFAULT_PANEL_PORT, accessKey = '') {
  const value = Number(port);
  if (!Number.isInteger(value) || value <= 0 || value > 65535) {
    throw new Error(`invalid panel port: ${port}`);
  }
  const key = typeof accessKey === 'string' ? accessKey.trim() : '';
  return `http://127.0.0.1:${value}${PANEL_PATH.replace('#tasks', '')}${key ? `?key=${encodeURIComponent(key)}` : ''}#tasks`;
}

/**
 * Resolve the panel target. `running` stays false until checkPanel confirms a
 * daemon; `discovered` only means a discovery record was found.
 * @param {{ discovery?: any, workspace?: string, defaultPort?: number, baseUrl?: string, uiKey?: string }} [input]
 * @returns {{ discovered: boolean, running: boolean, port: number, url: string, discoveryPath: string, workspace?: string, version?: string, workspaceMatch: boolean, loopbackOnly: true }}
 */
export function panelInfo({ discovery, workspace, defaultPort = DEFAULT_PANEL_PORT, baseUrl, uiKey } = {}) {
  const active = discovery === undefined
    ? (workspace
      ? (readLiveDiscoveryForWorkspace(workspace) ?? readDiscoveryForWorkspace(workspace))
      : readDiscovery())
    : discovery;
  const fallback = Number(defaultPort);
  const safeFallback = Number.isInteger(fallback) && fallback > 0 && fallback <= 65535
    ? fallback
    : DEFAULT_PANEL_PORT;
  let explicitPort;
  if (baseUrl) {
    try {
      const parsed = new URL(baseUrl);
      explicitPort = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
    } catch {
      explicitPort = undefined;
    }
  }
  const candidate = Number(explicitPort ?? active?.port);
  const discovered = Boolean(active?.port) || Number.isInteger(explicitPort);
  const port = Number.isInteger(candidate) && candidate > 0 && candidate <= 65535
    ? candidate
    : safeFallback;
  const workspaceMatch = workspace
    ? (explicitPort ? true : Boolean(active?.workspace && sameWorkspace(active.workspace, workspace)))
    : true;
  const accessKey = active?.uiKey ?? uiKey;
  return {
    discovered,
    running: false,
    port,
    url: panelUrl(port, accessKey),
    discoveryPath: workspace ? discoveryPathForWorkspace(workspace) : legacyDiscoveryPath(),
    ...(active?.workspace ? { workspace: active.workspace } : {}),
    ...(active?.version ? { version: active.version } : {}),
    ...(accessKey ? { uiKey: accessKey } : {}),
    workspaceMatch,
    loopbackOnly: true,
  };
}

/**
 * Verify that the daemon still answers and belongs to the expected workspace.
 * A stale discovery file or another local service returning 200 is not enough.
 * @param {ReturnType<typeof panelInfo>} info
 * @param {{ fetchImpl?: Function, timeoutMs?: number, expectedVersion?: string, expectedWorkspace?: string }} [options]
 */
export async function checkPanel(info, {
  fetchImpl = fetch,
  timeoutMs = 1500,
  expectedVersion = PACKAGE_VERSION,
  expectedWorkspace = info.workspace,
} = {}) {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${info.port}/api/v1/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = await response.json();
    const data = payload?.data ?? payload;
    const versionOk = !expectedVersion || data?.version === expectedVersion;
    const workspaceOk = !expectedWorkspace
      || (typeof data?.workspace === 'string' && sameWorkspace(data.workspace, expectedWorkspace));
    const healthy = Boolean(response.ok && data?.status === 'ok' && versionOk && workspaceOk);
    return {
      ...info,
      healthy,
      running: healthy,
      ...(data?.version ? { version: data.version } : {}),
      ...(data?.workspace ? { workspace: data.workspace } : {}),
    };
  } catch {
    return { ...info, healthy: false, running: false };
  }
}

/**
 * Human-readable instructions shared by the CLI, daemon log, MCP initialize and
 * installer output. CLI/installer callers keep the localizable Chinese text;
 * MCP `initialize.instructions` passes `language: 'en'` because model-facing
 * instructions are English by rule.
 * @param {ReturnType<typeof panelInfo>} info
 * @param {{ includeAccessKey?: boolean, language?: 'zh'|'en' }} [options]
 * @returns {string}
 */
export function panelInstructions(info, { includeAccessKey = true, language = 'zh' } = {}) {
  const displayUrl = includeAccessKey
    ? info.url
    : String(info.url).replace(/\?key=[^#]*/, '');
  const english = language === 'en';
  const lines = english
    ? [
      `Team panel: ${displayUrl}`,
      'The panel listens on 127.0.0.1 only and is never exposed to the LAN; the URL carries only the local access key, never the API token.',
      'The browser stores an HttpOnly cookie after the first visit; CLI: node src/cli.mjs panel --open',
      'Standalone window (keeps running outside ZCode): node src/cli.mjs panel --window, or double-click open-panel.cmd in the project.',
      'Inside ZCode you can also ask to view the team, or call agent_teams_view; pass window=true for a standalone window.',
    ]
    : [
      `团队面板: ${displayUrl}`,
      '面板只监听 127.0.0.1，不暴露到局域网；URL 里只有本机访问 key，不包含 API token。',
      '首次打开后浏览器会保存 HttpOnly cookie；命令行打开: node src/cli.mjs panel --open',
      '独立窗口（可脱离 ZCode 常驻）: node src/cli.mjs panel --window，或双击项目里的 open-panel.cmd',
      'ZCode 内也可以直接说“查看团队”，或调用 agent_teams_view；需要独立窗口时传 window=true。',
    ];
  if (!info.discovered) {
    lines.push(english
      ? 'No daemon discovery file was found; run node src/bootstrap.mjs first, or call a team tool once so the plugin starts the daemon.'
      : '未找到 daemon discovery 文件；先执行 node src/bootstrap.mjs，或首次调用团队工具让插件自动拉起 daemon。');
  } else if (!info.workspaceMatch) {
    lines.push(english
      ? `Note: the current daemon belongs to another workspace ${info.workspace ?? '(unknown)'}; start the daemon for this workspace first.`
      : `注意: 当前 daemon 属于另一个工作区 ${info.workspace ?? '(unknown)'}；请先启动本工作区的 daemon。`);
  } else if (info.healthy === false) {
    lines.push(english
      ? 'The daemon failed its health check; run node src/bootstrap.mjs first, or call a team tool once so the plugin starts the daemon.'
      : 'daemon 未通过健康检查；先执行 node src/bootstrap.mjs，或首次调用团队工具让插件自动拉起 daemon。');
  }
  return lines.join('\n');
}

/**
 * Browser preference: Edge, then Chrome, then the OS default handler (the
 * host's configured priority). Linux uses absolute paths because existsSync
 * does not resolve PATH entries.
 * @param {string} [platform]
 * @param {Record<string, string|undefined>} [env]
 * @returns {Array<{ command: string, args: string[], browser: string }>}
 */
export function browserCandidates(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const programFiles = env.ProgramFiles ?? env.PROGRAMFILES ?? 'C:\\Program Files';
    const programFilesX86 = env['ProgramFiles(x86)'] ?? env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)';
    const programW6432 = env.ProgramW6432 ?? env.PROGRAMW6432 ?? programFiles;
    const localAppData = env.LOCALAPPDATA ?? env.LocalAppData ?? '';
    return [
      { command: win32.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), args: [], browser: 'edge' },
      { command: win32.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), args: [], browser: 'edge' },
      { command: win32.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'), args: [], browser: 'chrome' },
      { command: win32.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'), args: [], browser: 'chrome' },
      { command: win32.join(programW6432, 'Google', 'Chrome', 'Application', 'chrome.exe'), args: [], browser: 'chrome' },
      ...(localAppData ? [{ command: win32.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'), args: [], browser: 'chrome' }] : []),
    ];
  }
  if (platform === 'darwin') {
    return [
      { command: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', args: [], browser: 'edge' },
      { command: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: [], browser: 'chrome' },
    ];
  }
  return [
    { command: '/usr/bin/microsoft-edge', args: [], browser: 'edge' },
    { command: '/usr/bin/microsoft-edge-stable', args: [], browser: 'edge' },
    { command: '/usr/bin/google-chrome', args: [], browser: 'chrome' },
    { command: '/usr/bin/google-chrome-stable', args: [], browser: 'chrome' },
    { command: '/usr/bin/chromium', args: [], browser: 'chrome' },
    { command: '/usr/bin/chromium-browser', args: [], browser: 'chrome' },
  ];
}

function defaultHandler(platform, url) {
  if (platform === 'win32') {
    const systemRoot = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows';
    return { command: join(systemRoot, 'System32', 'cmd.exe'), args: ['/c', 'start', '', url], browser: 'default' };
  }
  if (platform === 'darwin') return { command: '/usr/bin/open', args: [url], browser: 'default' };
  return { command: '/usr/bin/xdg-open', args: [url], browser: 'default' };
}

/**
 * Open the panel in the preferred browser. Resolves only after the child emits
 * spawn/error, so a missing browser is reported instead of a false success.
 * @param {string} url
 * @param {{ platform?: string, env?: Record<string,string|undefined>, exists?: Function, spawnImpl?: Function, mode?: 'tab'|'window', windowSize?: string }} [options]
 */
export function openPanel(url, {
  platform = process.platform,
  env = process.env,
  exists = existsSync,
  spawnImpl = spawn,
  spawnTimeoutMs = 3000,
  mode = 'tab',
  windowSize = '1440,960',
} = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return Promise.resolve({ opened: false, error: `invalid panel URL: ${url}` });
  }
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsed.hostname)) {
    return Promise.resolve({ opened: false, error: `refusing non-loopback panel URL: ${url}` });
  }
  const candidate = browserCandidates(platform, env).find((item) => exists(item.command));
  const selected = candidate ?? defaultHandler(platform, url);
  if (!candidate && !exists(selected.command)) {
    return Promise.resolve({ opened: false, error: `no browser or default opener found: ${selected.command}` });
  }
  return new Promise((resolvePromise) => {
    let done = false;
    let timer;
    const finish = (result) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolvePromise(result);
    };
    let child;
    // Chromium's --app opens a chromeless window that works like a detached
    // panel and can be kept open independently of ZCode. A default handler
    // cannot honor that flag, so it only ever gets the plain URL.
    const appArgs = mode === 'window' && candidate
      ? [`--app=${url}`, `--window-size=${windowSize}`]
      : null;
    try {
      const args = appArgs ?? (candidate ? [...candidate.args, url] : selected.args);
      child = spawnImpl(selected.command, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch (error) {
      finish({ opened: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    child.once?.('error', (error) => {
      finish({ opened: false, error: error instanceof Error ? error.message : String(error) });
    });
    child.once?.('spawn', () => {
      child.unref?.();
      finish({
        opened: true,
        browser: selected.browser,
        command: selected.command,
        // A default handler cannot honor --app; report what actually opened.
        mode: appArgs ? 'window' : 'tab',
        appWindow: Boolean(appArgs),
      });
    });
    timer = setTimeout(() => {
      finish({ opened: false, error: `${selected.command} did not confirm spawn` });
    }, spawnTimeoutMs);
    timer.unref?.();
  });
}
